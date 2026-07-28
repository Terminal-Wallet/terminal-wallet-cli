import {
  RailgunNFTAmountRecipient,
  NFTTokenType,
  EVMGasType,
  NetworkName,
  RailgunERC20Amount,
  RailgunERC20Recipient,
  SelectedBroadcaster,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import { Contract, ContractTransaction, parseUnits } from "ethers";
import { RelayAdapt__factory } from "@railgun-community/engine";
import { getGasEstimates, getGasFeeSelection, maxFeeFor } from "../gas/gas-fee";
import { GasOverride } from "../gas/gas-selection";
import {
  EphemeralKeyManager,
  fullWalletForID,
  gasEstimateForUnprovenCrossContractCalls7702,
  generateCrossContractCallsProof7702,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import {
  getChainForName,
  getProviderForChain,
  getWrappedTokenInfoForChain,
} from "../network/network-util";
import {
  getERC20TokenInfosForChain,
  getTokenInfo,
} from "../balance/token-util";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "./wallet-util";
import { getEphemeralAddressForIndex } from "./ephemeral-util";
import { withEphemeralOverride } from "./ephemeral-override";
import { getCurrentEthersWallet } from "./public-utils";
import {
  getBroadcasterTranaction,
  getTransactionGasDetails,
} from "../transaction/private/private-tx";
import { getOutputGasEstimate } from "../transaction/private/unshield-tx";
import { PrivateGasDetails } from "../../models/transaction-models";
import { describeNFT } from "../balance/nft-util";
import { fxPositionCollections } from "../transaction/fx/position";
import { NO_CROSS_CONTRACT_GAS_FLOOR } from "../transaction/cross-contract";
import { mapLimited } from "../../util/concurrency";

// EIP-7702 ephemeral accounts are per-op and never intended to hold a balance, but a partial
// or failed relay-adapt (or a swap whose bought token wasn't shielded) can strand assets at a
// prior ephemeral address. Recovery discovers and moves those out. Discovery is PER ADDRESS —
// every recovery function takes an explicit ephemeral address, never "the current index".

/** The gas tier a recovery was told to use, if the user picked one. */
export type RecoveryGasChoice = GasOverride | "keep" | undefined;

export type RecoverableERC20 = {
  tokenAddress: string;
  symbol: string;
  decimals: number;
  balance: bigint;
};

/**
 * A stranded ERC-721.
 *
 * A partly-failed batch can leave a protocol position at an ephemeral address —
 * an f(x) position NFT is the position, so losing track of it loses the
 * collateral behind it, not just a collectible.
 */
export type RecoverableNFT = {
  nftAddress: string;
  tokenSubID: string;
  /** Named where the collection is recognised; see balance/nft-util. */
  label: string;
};

export type EphemeralAssetScan = {
  address: string;
  nativeWei: bigint;
  erc20s: RecoverableERC20[];
  nfts: RecoverableNFT[];
  // "logs": curated list PLUS any token that sent a Transfer to the ephemeral in the recent
  // window (eth_getLogs). "tokenlist": curated list only (getLogs unavailable/capped) — can miss
  // arbitrary tokens; surface this.
  method: "logs" | "tokenlist";
  /**
   * How many balance reads the RPC refused to answer.
   *
   * A read that fails is not a balance of zero, and the difference decides
   * whether an account is safe to walk away from. Counted rather than thrown
   * on, because a scan that found five tokens and could not read a sixth is
   * still worth showing — it just must not be presented as complete.
   */
  unreadable: number;
};

/**
 * Fan-out width for the balance reads behind one scan.
 *
 * A scan is a dozen-plus independent `balanceOf`/`ownerOf` calls and, run one
 * after another, took long enough that the screen looked hung. Concurrent, but
 * bounded: the public endpoints this talks to rate-limit a flood, and a
 * throttled read comes back as a failure — which, before `unreadable` existed,
 * was indistinguishable from an empty account.
 */
const SCAN_CONCURRENCY = 6;

const ERC20_BALANCE_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

/**
 * `balanceOf`, allowed to fail loudly.
 *
 * The shared `getERC20Balance` maps any RPC error to 0n, which is right for a
 * portfolio figure and wrong here: this scan decides whether funds are stranded,
 * and "the node would not answer" must never render as "there is nothing here".
 */
const readERC20Balance = async (
  chainName: NetworkName,
  tokenAddress: string,
  owner: string,
): Promise<bigint> => {
  const contract = new Contract(
    tokenAddress,
    ERC20_BALANCE_ABI,
    getProviderForChain(chainName),
  );
  return (await contract.balanceOf(owner)) as bigint;
};

// keccak256("Transfer(address,address,uint256)")
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Token symbols come from arbitrary (possibly airdropped/malicious) contracts and are rendered
// to the terminal + the selection menu that drives a fund-moving decision. Strip C0/C1 control
// and ANSI-escape bytes and clamp length so a hostile symbol can't spoof the display.
const sanitizeSymbol = (symbol: string): string => {
  let cleaned = "";
  for (const ch of symbol) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0 controls (< 0x20), DEL (0x7f), C1 controls (0x80-0x9f), and Unicode bidi/RTL
    // override codepoints (which can visually reorder the symbol to spoof the display).
    const isBidi =
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    const printable =
      code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f) && !isBidi;
    if (printable) {
      cleaned += ch;
    }
    if (cleaned.length >= 16) {
      break;
    }
  }
  return cleaned.length > 0 ? cleaned : "???";
}

// balanceOf over the chain's curated token list. Portable to any RPC, but only sees
// tokens on the list — an arbitrary swap output could be missed. Flagged via scan.method.
const scanViaTokenList = async (
  chainName: NetworkName,
  address: string,
): Promise<{ erc20s: RecoverableERC20[]; unreadable: number }> => {
  const infos = await getERC20TokenInfosForChain(chainName);
  const read = await mapLimited(infos, SCAN_CONCURRENCY, async (info) => {
    try {
      return { info, balance: await readERC20Balance(chainName, info.tokenAddress, address) };
    } catch {
      return { info, balance: undefined };
    }
  });
  const out: RecoverableERC20[] = [];
  let unreadable = 0;
  for (const { info, balance } of read) {
    if (balance === undefined) {
      unreadable++;
      continue;
    }
    if (balance > 0n) {
      out.push({
        tokenAddress: info.tokenAddress,
        symbol: sanitizeSymbol(info.symbol),
        decimals: Number(info.decimals),
        balance,
      });
    }
  }
  return { erc20s: out, unreadable };
};

// Portable best-effort discovery: any token contract that sent an ERC20 Transfer TO the
// ephemeral in the recent block window (eth_getLogs, topic-filtered on recipient). Complements
// the curated list so an arbitrary stranded token isn't missed. Bounded range + catches failures
// (public RPCs cap getLogs), so it degrades to nothing rather than throwing.
const scanViaLogs = async (
  chainName: NetworkName,
  address: string,
): Promise<{
  erc20s: RecoverableERC20[];
  nftCandidates: { nftAddress: string; tokenSubID: string }[];
  /** Whether the log query itself ran. False means the curated list is all there was. */
  ok: boolean;
  unreadable: number;
}> => {
  try {
    const provider = getProviderForChain(chainName);
    const latest = await provider.getBlockNumber();
    const LOOKBACK = 10_000;
    const fromBlock = Math.max(0, latest - LOOKBACK);
    const paddedRecipient =
      "0x" + address.slice(2).toLowerCase().padStart(64, "0");
    const logs = await provider.getLogs({
      fromBlock,
      toBlock: latest,
      topics: [ERC20_TRANSFER_TOPIC, null, paddedRecipient],
    });
    // ERC-20 and ERC-721 share the Transfer topic and are told apart by shape:
    // ERC-721 indexes the token id, so it carries a fourth topic. Without this
    // split an incoming NFT was scanned as a token, and `balanceOf` — which on
    // an ERC-721 returns how many you hold — made it look like a balance of 1
    // wei of some unnamed token.
    const erc721Logs = logs.filter((l) => l.topics.length === 4);
    const erc20Logs = logs.filter((l) => l.topics.length === 3);
    const tokenAddresses = [
      ...new Set(erc20Logs.map((l) => l.address.toLowerCase())),
    ];
    const nftCandidates = new Map<string, { nftAddress: string; tokenSubID: string }>();
    for (const l of erc721Logs) {
      const [, , , tokenSubID] = l.topics;
      nftCandidates.set(`${l.address.toLowerCase()}:${tokenSubID}`, {
        nftAddress: l.address,
        tokenSubID,
      });
    }
    const read = await mapLimited(
      tokenAddresses,
      SCAN_CONCURRENCY,
      async (tokenAddress) => {
        try {
          const balance = await readERC20Balance(chainName, tokenAddress, address);
          if (balance <= 0n) return undefined;
          let symbol = "???";
          let decimals = 18;
          try {
            const info = await getTokenInfo(chainName, tokenAddress);
            symbol = sanitizeSymbol(info.symbol);
            decimals = Number(info.decimals);
          } catch {
            // keep placeholder
          }
          return { tokenAddress, symbol, decimals, balance };
        } catch {
          // A token the logs say arrived, whose balance the node would not
          // report. Counted, never silently dropped.
          return null;
        }
      },
    );
    return {
      erc20s: read.filter((t): t is RecoverableERC20 => t != null),
      nftCandidates: [...nftCandidates.values()],
      ok: true,
      unreadable: read.filter((t) => t === null).length,
    };
  } catch {
    return { erc20s: [], nftCandidates: [], ok: false, unreadable: 0 };
  }
};

/**
 * Which of the NFTs that were once sent here are still here.
 *
 * A log says an NFT arrived, not that it stayed — the batch that stranded one
 * may have been retried, or the position closed. `ownerOf` is the only answer
 * that is true now, and it reverts for a burnt token, which is exactly the
 * case a fully-closed position leaves behind.
 */
const stillOwned = async (
  chainName: NetworkName,
  address: string,
  candidates: { nftAddress: string; tokenSubID: string }[],
): Promise<RecoverableNFT[]> => {
  if (!candidates.length) return [];
  const provider = getProviderForChain(chainName);
  const known = fxPositionCollections();
  const owned = await mapLimited(
    candidates,
    SCAN_CONCURRENCY,
    async (candidate): Promise<RecoverableNFT | undefined> => {
      try {
        const contract = new Contract(
          candidate.nftAddress,
          ["function ownerOf(uint256) view returns (address)"],
          provider,
        );
        const owner: string = await contract.ownerOf(BigInt(candidate.tokenSubID));
        if (owner.toLowerCase() !== address.toLowerCase()) return undefined;
        return {
          nftAddress: candidate.nftAddress,
          tokenSubID: candidate.tokenSubID,
          label: describeNFT(
            {
              nftAddress: candidate.nftAddress,
              tokenSubID: candidate.tokenSubID,
              nftTokenType: NFTTokenType.ERC721,
              amount: 1n,
            },
            known,
          ).label,
        };
      } catch {
        // Burnt, not an ERC-721, or an RPC that will not say — either way it is
        // not something this can move.
        return undefined;
      }
    },
  );
  return owned.filter((n): n is RecoverableNFT => n !== undefined);
};

// Discover every recoverable asset sitting at an ephemeral address: native gas token + all
// ERC20s. The curated token list UNION eth_getLogs recipient discovery, so arbitrary tokens are
// still found where the RPC allows it.
export const scanEphemeralAssets = async (
  chainName: NetworkName,
  address: string,
): Promise<EphemeralAssetScan> => {
  const provider = getProviderForChain(chainName);
  const nativeWei = await provider.getBalance(address);

  const [viaLogs, viaTokenList] = await Promise.all([
    scanViaLogs(chainName, address),
    scanViaTokenList(chainName, address),
  ]);
  const deduped = new Map<string, RecoverableERC20>();
  for (const t of [...viaLogs.erc20s, ...viaTokenList.erc20s]) {
    deduped.set(t.tokenAddress.toLowerCase(), t);
  }
  return {
    address,
    nativeWei,
    erc20s: [...deduped.values()],
    nfts: await stillOwned(chainName, address, viaLogs.nftCandidates),
    // Whether the log query RAN, not whether it happened to find an ERC-20.
    // Keyed on the find, an account whose only arrival was a position NFT
    // reported "log scan unavailable" and warned about missed tokens — a scan
    // that had in fact worked perfectly, crying wolf on the one screen whose
    // job is to say whether anything is left behind.
    method: viaLogs.ok ? "logs" : "tokenlist",
    unreadable: viaLogs.unreadable + viaTokenList.unreadable,
  };
};

// --- Recovery builder ---------------------------------------------------------------------
// Bring stranded assets at a PRIOR ephemeral index back into RAILGUN as a 7702 relay-adapt
// batch. ERC20s are shielded directly; native ETH is wrapped (custom `wrapBase` call, mirroring
// the SDK's createShieldBaseTokenActionData7702 — cookbook base steps aren't rc.1-ready) and its
// WETH shielded. Nothing is transferred to a public wallet. The signer is overridden to the
// target index for the whole build (setCurrentEphemeralWallet), so the persisted index is never
// moved and the recovery MUST NOT ratchet afterward.

/**
 * The smallest gas estimate a recovery is allowed to be built from.
 *
 * Sized from two real failures rather than a guess. A recovery shields
 * everything it finds in one batch — two ERC-20s and a position NFT, in the
 * case that produced these numbers — and that shield has been observed needing
 * more than 881,920 on top of roughly a million for the transact half.
 *
 * The carried limit is this x1.2 (`calculateGasLimit`), so this is deliberately
 * the estimate rather than the limit. Generous on purpose: unused gas is
 * refunded, while a recovery that runs out leaves the funds exactly where they
 * were and costs another fee to try again.
 */
export const RECOVERY_GAS_ESTIMATE_FLOOR = 3_400_000n;

export type RecoverySelection = {
  erc20s: RecoverableERC20[]; // stranded ERC20s to reshield (may be empty)
  nativeWei?: bigint; // stranded native ETH to wrap+reshield (omit/0n to skip)
  nfts?: RecoverableNFT[]; // stranded positions to reshield (may be empty)
};

export type Proved7702RelayAdapt = {
  transaction: ContractTransaction;
  nullifiers: string[];
  preTransactionPOIsPerTxidLeafPerList: unknown;
  feesID?: string;
  sendWithPublicWallet: boolean;
  estimatedCost: number; // fee cost in feeSymbol units (broadcaster fee, or gas cost self-signed)
  feeSymbol: string;
};

type RelayAdaptBatch = {
  unshieldERC20Amounts: RailgunERC20Amount[];
  shieldRecipients: RailgunERC20Recipient[];
  /** Positions to bring back. Empty for an ERC20-only recovery. */
  shieldNFTRecipients?: RailgunNFTAmountRecipient[];
  crossContractCalls: ContractTransaction[];
};

// Core: build + prove a 7702 relay-adapt batch executed AS a chosen ephemeral index (recovery
// shields stranded assets back INTO RAILGUN). Kept generic over unshield/shield/cross-contract
// so the fund path is defined once and audited once.
// The ephemeral signer is overridden to targetIndex for the whole build (set INSIDE the try so
// any throw still clears it in finally); the persisted index is never touched, so callers MUST
// NOT ratchet after submit. overallBatchMinGasPrice is pinned 0n (type-4 maxFeePerGas governs).
const buildProved7702Batch = async (
  chainName: NetworkName,
  encryptionKey: string,
  targetIndex: number,
  batch: RelayAdaptBatch,
  broadcasterSelection?: SelectedBroadcaster,
  onProgress?: (pct: number, note?: string) => void,
  gasChoice?: RecoveryGasChoice,
): Promise<Proved7702RelayAdapt> => {
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const railgunWalletID = getCurrentRailgunID();
  const chainId = BigInt(getChainForName(chainName).id);
  const {
    unshieldERC20Amounts,
    shieldRecipients,
    shieldNFTRecipients = [],
    crossContractCalls,
  } = batch;

  const gasDetailsResult = (await getTransactionGasDetails(
    chainName,
    broadcasterSelection,
    true, // 7702 -> keep Type4 gas details
  )) as PrivateGasDetails | undefined;
  if (!gasDetailsResult) {
    throw new Error("Failed to get gas details for 7702 relay-adapt batch.");
  }
  const {
    originalGasDetails,
    feeTokenDetails,
    feeTokenInfo,
    sendWithPublicWallet,
    overallBatchMinGasPrice,
  } = gasDetailsResult;

  // Gas PRICE.
  //
  // This used to say "if the user picked a tier the details already reflect it,
  // so only apply a default otherwise" — and then gate that on
  // `getGasFeeSelection`. The premise was false. `closeBuilder()` calls
  // `clearGasFeeSelection()` BEFORE the submit is awaited, so by the time this
  // runs there is never a selection: the guard was always true, the default
  // always won, and the tier chosen on the gas row did nothing at all. Every
  // other flow survives that teardown because it passes the choice through
  // `applyGasDetailsConfirm`; recovery offered the row and dropped the answer.
  //
  // The default it always fell back to was the SLOW tier, which floors at
  // MIN_PRIORITY_FEE — 0.025 gwei. A broadcaster asked to carry ~4M gas for a
  // tip at the very bottom of the distribution rejects it outright as an
  // unmineable tip, and raising the tier in the UI changed nothing, so it
  // failed identically every time.
  //
  // So: honour the choice when there is one, and when there is not, bid the
  // top of the market rather than the bottom.
  //
  // `fast` (the 75th-percentile tip) rather than a hardcoded floor, because a
  // constant ages badly and this has to track conditions. It is the right
  // trade for a RESCUE specifically: a broadcaster advertises no minimum
  // anywhere in its fee payload, so there is nothing to pre-check against and
  // the only way to find the threshold is to be refused by it. That refusal
  // happens before anything is submitted, so a rejected attempt costs nothing
  // — while an accepted one that sat unmined would leave the funds stranded
  // for another round. The tip is only paid if the batch is included.
  const g = originalGasDetails as unknown as {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };
  if (isDefined(g.maxFeePerGas)) {
    if (gasChoice && gasChoice !== "keep" && gasChoice.evmGasType === EVMGasType.Type2) {
      g.maxFeePerGas = gasChoice.maxFeePerGas;
      g.maxPriorityFeePerGas = gasChoice.maxPriorityFeePerGas;
    } else if (!isDefined(getGasFeeSelection(chainName))) {
      try {
        const { baseFeePerGas, fast } = await getGasEstimates(chainName);
        g.maxPriorityFeePerGas = fast;
        g.maxFeePerGas = maxFeeFor(fast, baseFeePerGas);
      } catch {
        // Keep the default gas details if the estimate call fails.
      }
    }
  }

  // No on-chain gas floor, as every cross-contract call uses. The SDK's default
  // is baked into the action data as `require(gasleft() > minGasLimit)`, which
  // forces the tx to CARRY that much gas and over-provisions the limit the
  // broadcaster charges on. Without it the estimate reflects actual execution
  // and the submitted limit is that estimate x1.2.
  //
  // That last sentence is only true when the batch SUCCEEDS. See
  // RECOVERY_GAS_FLOOR below for why it is not enough on its own.
  const recoveryMinGasLimit = NO_CROSS_CONTRACT_GAS_FLOOR;

  // The override is process-wide for the whole estimate -> prove -> populate
  // window; withEphemeralOverride serialises them, refuses nesting, and always
  // clears. The persisted index is untouched, so callers MUST NOT ratchet.
  return withEphemeralOverride(chainName, encryptionKey, targetIndex, async () => {
    const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls7702(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      unshieldERC20Amounts,
      [], // nothing is unshielded: recovery moves what is already at the account
      shieldRecipients,
      shieldNFTRecipients,
      crossContractCalls,
      originalGasDetails,
      feeTokenDetails,
      sendWithPublicWallet,
      recoveryMinGasLimit,
    );

    // The estimate cannot be trusted to size this batch. Relay-adapt builds its
    // action data with `requireSuccess = false`, so when the shield reverts
    // during estimation the estimate measures a batch that did NOT shield —
    // and every figure derived from it, including the carried limit of
    // estimate x1.2, is then too small for the batch that does. It is
    // self-consistently wrong, so retrying at the same size fails identically.
    //
    // Observed twice on mainnet: the first fx mint (0x252155ef…) gave the
    // shield's inner call 780,728, the first recovery attempt (0xef3e9dd2…)
    // gave it 881,920. Both reverted with no revert data after consuming 98.4%
    // of what they were given.
    //
    // Floored HERE rather than on the populated transaction so the broadcaster
    // fee is quoted from the same figure the transaction will carry — flooring
    // afterwards would have them price a batch smaller than the one submitted.
    // Unused gas is refunded, so an over-large floor costs nothing; being under
    // it costs the whole attempt and leaves the funds where they were.
    const flooredEstimate =
      gasEstimate < RECOVERY_GAS_ESTIMATE_FLOOR
        ? RECOVERY_GAS_ESTIMATE_FLOOR
        : gasEstimate;

    const privateGasEstimate = await getOutputGasEstimate(
      originalGasDetails,
      flooredEstimate,
      feeTokenInfo,
      feeTokenDetails,
      broadcasterSelection,
      overallBatchMinGasPrice,
    );
    if (!privateGasEstimate) {
      throw new Error("Failed to compute 7702 gas estimate.");
    }
    const { broadcasterFeeERC20Recipient, estimatedGasDetails } =
      privateGasEstimate;

    const batchMinGasPrice = 0n;

    await generateCrossContractCallsProof7702(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      unshieldERC20Amounts,
      [],
      shieldRecipients,
      shieldNFTRecipients,
      crossContractCalls,
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      batchMinGasPrice,
      recoveryMinGasLimit,
      // Reported to the CALLER, not straight onto the bus. Whoever emits
      // progress owes the UI a terminating event that clears it, and this
      // module cannot promise one — it does not know whether the send
      // succeeded. Emitting here is what left the bar frozen at 100%.
      (progress: number) => onProgress?.(progress, "Generating 7702 recovery proof"),
    );

    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedCrossContractCalls(
        txIDVersion,
        chainName,
        railgunWalletID,
        unshieldERC20Amounts,
        [],
        shieldRecipients,
        shieldNFTRecipients,
        crossContractCalls,
        broadcasterFeeERC20Recipient,
        sendWithPublicWallet,
        batchMinGasPrice,
        estimatedGasDetails,
      );
    transaction.type = EVMGasType.Type4;

    return {
      transaction,
      nullifiers: nullifiers ?? [],
      preTransactionPOIsPerTxidLeafPerList,
      feesID: broadcasterSelection?.tokenFee?.feesID,
      sendWithPublicWallet,
      estimatedCost: privateGasEstimate.estimatedCost,
      feeSymbol: privateGasEstimate.symbol,
    };
  });
};

// funding: pass a broadcasterSelection to have a broadcaster pay gas (fee in its token), or
// undefined to self-broadcast from the user's public wallet. Ephemeral self-send is a future
// mode — see the self-signer idea. Neither funding mode is the SOURCE of the moved assets.
export const getProvedEphemeralRecoveryTransaction = async (
  chainName: NetworkName,
  encryptionKey: string,
  targetIndex: number,
  selection: RecoverySelection,
  broadcasterSelection?: SelectedBroadcaster,
  onProgress?: (pct: number, note?: string) => void,
  gasChoice?: RecoveryGasChoice,
): Promise<Proved7702RelayAdapt> => {
  const railgunAddress = getCurrentRailgunAddress();
  const { wrappedAddress } = getWrappedTokenInfoForChain(chainName);

  const hasNative = isDefined(selection.nativeWei) && selection.nativeWei > 0n;
  const nfts = selection.nfts ?? [];
  if (selection.erc20s.length === 0 && !hasNative && nfts.length === 0) {
    throw new Error("Nothing selected to recover.");
  }
  const targetAddress = await getEphemeralAddressForIndex(
    chainName,
    encryptionKey,
    targetIndex,
  );

  // Shield every stranded ERC20 into the user's own RAILGUN address; add WETH when recovering
  // native ETH (it becomes WETH via the wrap call below).
  const shieldRecipients: RailgunERC20Recipient[] = selection.erc20s.map((t) => ({
    tokenAddress: t.tokenAddress,
    recipientAddress: railgunAddress,
  }));
  const crossContractCalls: ContractTransaction[] = [];
  if (hasNative) {
    shieldRecipients.push({
      tokenAddress: wrappedAddress,
      recipientAddress: railgunAddress,
    });
    // wrapBase(0) wraps the ENTIRE native ETH balance at the ephemeral (0 = "all present"),
    // matching the SDK's relay-adapt convention — robust to any dust drift vs the scanned amount.
    const relayAdaptInterface = RelayAdapt__factory.createInterface();
    crossContractCalls.push({
      to: targetAddress,
      data: relayAdaptInterface.encodeFunctionData("wrapBase", [0n]),
      value: 0n,
    });
  }

  // A position comes back as itself — one indivisible ERC-721 — rather than as
  // an amount, so it is shielded by id.
  const shieldNFTRecipients: RailgunNFTAmountRecipient[] = nfts.map((nft) => ({
    nftAddress: nft.nftAddress,
    tokenSubID: nft.tokenSubID,
    nftTokenType: NFTTokenType.ERC721,
    amount: 1n,
    recipientAddress: railgunAddress,
  }));

  return buildProved7702Batch(
    chainName,
    encryptionKey,
    targetIndex,
    {
      unshieldERC20Amounts: [],
      shieldRecipients,
      shieldNFTRecipients,
      crossContractCalls,
    },
    broadcasterSelection,
    onProgress,
    gasChoice,
  );
};

// Submit a proved 7702 recovery bundle. Funding mirrors the build: a
// broadcaster when one is selected, else self-broadcast from the user's public wallet. CRITICAL:
// the build targeted an overridden ephemeral, so — unlike normal relay-adapt sends — this MUST
// NOT ratchet the live ephemeral index afterward.
export const submitRecoveryTransaction = async (
  chainName: NetworkName,
  proved: Proved7702RelayAdapt,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<string> => {
  if (isDefined(broadcasterSelection)) {
    const relayTx = await getBroadcasterTranaction(
      {
        ...proved,
        feesID: broadcasterSelection.tokenFee.feesID,
        selectedBroadcasterAddress: broadcasterSelection.railgunAddress,
      },
      chainName,
      true, // relay-adapt
    );
    return relayTx.send();
  }
  const ethersWallet = getCurrentEthersWallet();
  const txResult = await ethersWallet.sendTransaction(proved.transaction);
  return txResult.hash;
};
