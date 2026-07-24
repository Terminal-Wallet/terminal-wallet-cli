import {
  EVMGasType,
  NetworkName,
  RailgunERC20Amount,
  RailgunERC20Recipient,
  SelectedBroadcaster,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import { ContractTransaction, parseUnits } from "ethers";
import { RelayAdapt__factory } from "@railgun-community/engine";
import { getGasEstimates, getGasFeeSelection } from "../gas/gas-fee";
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
  getERC20Balance,
  getERC20TokenInfosForChain,
  getTokenInfo,
} from "../balance/token-util";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "./wallet-util";
import { getEphemeralAddressForIndex } from "./ephemeral-util";
import { getCurrentEthersWallet } from "./public-utils";
import {
  getBroadcasterTranaction,
  getTransactionGasDetails,
} from "../transaction/private/private-tx";
import { getOutputGasEstimate } from "../transaction/private/unshield-tx";
import { PrivateGasDetails } from "../models/transaction-models";
import { ProgressBar } from "../ui/progressBar-ui";

// EIP-7702 ephemeral accounts are per-op and never intended to hold a balance, but a partial
// or failed relay-adapt (or a swap whose bought token wasn't shielded) can strand assets at a
// prior ephemeral address. Recovery discovers and moves those out. Discovery is PER ADDRESS —
// every recovery function takes an explicit ephemeral address, never "the current index".

export type RecoverableERC20 = {
  tokenAddress: string;
  symbol: string;
  decimals: number;
  balance: bigint;
};

export type EphemeralAssetScan = {
  address: string;
  nativeWei: bigint;
  erc20s: RecoverableERC20[];
  // "logs": curated list PLUS any token that sent a Transfer to the ephemeral in the recent
  // window (eth_getLogs). "tokenlist": curated list only (getLogs unavailable/capped) — can miss
  // arbitrary tokens; surface this.
  method: "logs" | "tokenlist";
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
): Promise<RecoverableERC20[]> => {
  const infos = await getERC20TokenInfosForChain(chainName);
  const out: RecoverableERC20[] = [];
  for (const info of infos) {
    const balance = await getERC20Balance(chainName, info.tokenAddress, address);
    if (balance > 0n) {
      out.push({
        tokenAddress: info.tokenAddress,
        symbol: sanitizeSymbol(info.symbol),
        decimals: Number(info.decimals),
        balance,
      });
    }
  }
  return out;
};

// Portable best-effort discovery: any token contract that sent an ERC20 Transfer TO the
// ephemeral in the recent block window (eth_getLogs, topic-filtered on recipient). Complements
// the curated list so an arbitrary stranded token isn't missed. Bounded range + catches failures
// (public RPCs cap getLogs), so it degrades to nothing rather than throwing.
const scanViaLogs = async (
  chainName: NetworkName,
  address: string,
): Promise<RecoverableERC20[]> => {
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
    const tokenAddresses = [
      ...new Set(logs.map((l) => l.address.toLowerCase())),
    ];
    const out: RecoverableERC20[] = [];
    for (const tokenAddress of tokenAddresses) {
      const balance = await getERC20Balance(chainName, tokenAddress, address);
      if (balance <= 0n) {
        continue;
      }
      let symbol = "???";
      let decimals = 18;
      try {
        const info = await getTokenInfo(chainName, tokenAddress);
        symbol = sanitizeSymbol(info.symbol);
        decimals = Number(info.decimals);
      } catch {
        // keep placeholder
      }
      out.push({ tokenAddress, symbol, decimals, balance });
    }
    return out;
  } catch {
    return [];
  }
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
  for (const t of [...viaLogs, ...viaTokenList]) {
    deduped.set(t.tokenAddress.toLowerCase(), t);
  }
  return {
    address,
    nativeWei,
    erc20s: [...deduped.values()],
    method: viaLogs.length > 0 ? "logs" : "tokenlist",
  };
};

// --- Recovery builder ---------------------------------------------------------------------
// Bring stranded assets at a PRIOR ephemeral index back into RAILGUN as a 7702 relay-adapt
// batch. ERC20s are shielded directly; native ETH is wrapped (custom `wrapBase` call, mirroring
// the SDK's createShieldBaseTokenActionData7702 — cookbook base steps aren't rc.1-ready) and its
// WETH shielded. Nothing is transferred to a public wallet. The signer is overridden to the
// target index for the whole build (setCurrentEphemeralWallet), so the persisted index is never
// moved and the recovery MUST NOT ratchet afterward.

export type RecoverySelection = {
  erc20s: RecoverableERC20[]; // stranded ERC20s to reshield (may be empty)
  nativeWei?: bigint; // stranded native ETH to wrap+reshield (omit/0n to skip)
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
): Promise<Proved7702RelayAdapt> => {
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const railgunWalletID = getCurrentRailgunID();
  const chainId = BigInt(getChainForName(chainName).id);
  const { unshieldERC20Amounts, shieldRecipients, crossContractCalls } = batch;

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

  // Gas PRICE: if the user picked a tier via the gas matrix, getTransactionGasDetails already
  // reflects it — respect that. Otherwise apply a conservative default, because the shared 80th-
  // percentile fallback massively overpays at low congestion (observed ~0.73 gwei vs ~0.13 base):
  // slow (60th) tip with a small inclusion floor + a base-fee buffer for drift.
  if (!isDefined(getGasFeeSelection(chainName))) {
    try {
      const { baseFeePerGas, slow } = await getGasEstimates(chainName);
      const minTip = parseUnits("0.02", "gwei");
      const priority = slow > minTip ? slow : minTip;
      const conservativeMaxFee = (baseFeePerGas * 5n) / 4n + priority;
      const g = originalGasDetails as unknown as {
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
      };
      if (isDefined(g.maxFeePerGas)) {
        g.maxFeePerGas = conservativeMaxFee;
        g.maxPriorityFeePerGas = priority;
      }
    } catch {
      // Keep the default gas details if the estimate call fails.
    }
  }

  // minGasLimit = 0n: the SDK's default cross-contract floor (3.2M) is baked into the action
  // data's on-chain `require(gasleft() > minGasLimit)`, which forces the tx to CARRY that much
  // gas into the call even though these deterministic relay-adapt ops (unshield/shield + at most
  // a wrap/unwrap) only use ~1.7M — over-provisioning the limit the broadcaster charges on.
  // Pinning 0n lets the estimate reflect actual execution. Safe here (unlike the swap, whose
  // variable external call under-estimates and needs a real floor).
  const recoveryMinGasLimit = 0n;

  const wallet = fullWalletForID(railgunWalletID);
  const keyManager = new EphemeralKeyManager(wallet, encryptionKey);
  const targetAccount = await keyManager.getAccount(chainId, targetIndex);

  let progressBar: ProgressBar | undefined;
  try {
    // The override is process-global for the whole proof window. INVARIANT: no other fund flow
    // may run concurrently with a recovery build (the recover prompt is modal; only read-only
    // balance pollers run alongside, which don't touch the ephemeral signer).
    await wallet.setCurrentEphemeralWallet(targetAccount.signer);
    progressBar = new ProgressBar("Starting 7702 Proof");

    const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls7702(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      unshieldERC20Amounts,
      [], // relayAdaptUnshieldNFTAmounts
      shieldRecipients,
      [], // relayAdaptShieldNFTRecipients
      crossContractCalls,
      originalGasDetails,
      feeTokenDetails,
      sendWithPublicWallet,
      recoveryMinGasLimit,
    );

    const privateGasEstimate = await getOutputGasEstimate(
      originalGasDetails,
      gasEstimate,
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
      [],
      crossContractCalls,
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      batchMinGasPrice,
      recoveryMinGasLimit,
      (progress: number) =>
        progressBar?.updateProgress("7702 Proof", progress),
    ).finally(() => progressBar?.complete());

    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedCrossContractCalls(
        txIDVersion,
        chainName,
        railgunWalletID,
        unshieldERC20Amounts,
        [],
        shieldRecipients,
        [],
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
  } finally {
    // Always clear the override so normal flows resume on the live index. The engine clears the
    // override when passed undefined at runtime; its type only admits HDNodeWallet, so cast.
    await (
      wallet.setCurrentEphemeralWallet as (w?: unknown) => Promise<void>
    )(undefined);
  }
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
): Promise<Proved7702RelayAdapt> => {
  const railgunAddress = getCurrentRailgunAddress();
  const { wrappedAddress } = getWrappedTokenInfoForChain(chainName);

  const hasNative = isDefined(selection.nativeWei) && selection.nativeWei > 0n;
  if (selection.erc20s.length === 0 && !hasNative) {
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

  return buildProved7702Batch(
    chainName,
    encryptionKey,
    targetIndex,
    { unshieldERC20Amounts: [], shieldRecipients, crossContractCalls },
    broadcasterSelection,
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
