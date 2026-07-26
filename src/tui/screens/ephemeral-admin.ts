/**
 * The 7702 ephemeral account console.
 *
 * Relay-adapt transactions (unshield-to-base, private swaps, base shields)
 * execute from a throwaway account derived at an index the wallet ratchets
 * forward after each successful send. Almost always that is invisible. It stops
 * being invisible when a send half-fails and leaves assets sitting at an
 * address the wallet has already moved past — which is what `recover` is for.
 *
 * Password-gated on entry, because three of its verbs mutate the persisted
 * index and one of them moves funds.
 *
 * Tiering, from the console this replaces: `show`, `balances` and `history` are
 * read-only; `sync`, `advance` and `set` change the index locally; `recover`
 * broadcasts. Only the last two categories confirm, and the guard wording lives
 * in `format/ephemeral.ts` where it is tested.
 */
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import { DeckContext } from "../context";
import { getInputProvider } from "../../core/input";
import { setState } from "../store";
import { tag } from "../format/tags";
import { showText } from "./popout";
import {
  parseIndex,
  rewindsIndex,
  rewindWarning,
  advanceWarning,
  balanceLines,
  historyLines,
  recoverySummaryLines,
} from "../format/ephemeral";
import {
  advanceEphemeralIndex,
  getCurrentEphemeralInfo,
  getEphemeralAddressForIndex,
  getEphemeralHistory,
  setEphemeralIndex,
  syncEphemeralIndexFromHistory,
} from "../../railgun/wallet/ephemeral-util";
import {
  getProvedEphemeralRecoveryTransaction,
  scanEphemeralAssets,
  submitRecoveryTransaction,
  RecoverableERC20,
} from "../../railgun/wallet/ephemeral-recovery";
import { collectFeeMode } from "../../flows/collect/fee";
import { runGasTierPrompt } from "./gas-tier";
import { clearGasFeeSelection } from "../../railgun/gas/gas-fee";
import { getTransactionURLForChain } from "../../railgun/network/network-util";
import { getSaltedPassword } from "../../railgun/wallet/wallet-password";
import { getCurrentNetwork } from "../../railgun/engine/engine";

/** Nominal gas units for a relay-adapt recovery bundle, for the fee preview. */
const RECOVERY_GAS_UNITS = 2_800_000n;

/** The native asset's sentinel in the reshield picker. */
const NATIVE = "__native__";

const MENU = [
  { label: "Show current ephemeral", value: "show", hint: "index · address" },
  { label: "Show on-chain balances (current index)", value: "balances", hint: "read-only" },
  { label: "Recover stranded funds (reshield)", value: "recover", hint: "moves funds" },
  { label: "Show history", value: "history", hint: "used ephemerals" },
  { label: "Sync index from history", value: "sync", hint: "realign" },
  { label: "Advance to next ephemeral (ratchet +1)", value: "advance", hint: "skips current" },
  { label: "Set / reset current index", value: "set", hint: "DANGER — can strand funds" },
];

/**
 * Pick which stranded assets to reshield. Everything is pre-selected, because
 * the usual answer is "all of it" and the picker exists for the exception.
 */
const pickAssets = async (
  nativeWei: bigint,
  erc20s: RecoverableERC20[],
): Promise<{ native: boolean; erc20s: RecoverableERC20[] } | undefined> => {
  const choices = [
    ...(nativeWei > 0n
      ? [
          {
            label: `ETH   ${formatUnits(nativeWei, 18)}`,
            value: NATIVE,
            hint: "wrap → WETH → shield",
          },
        ]
      : []),
    ...erc20s.map((token) => ({
      label: `${token.symbol.padEnd(8)} ${formatUnits(token.balance, token.decimals)}`,
      value: token.tokenAddress,
    })),
  ];
  const picked = await getInputProvider().multiSelect(
    "Select assets to reshield",
    choices,
    { initial: choices.map((c) => c.value) },
  );
  if (!isDefined(picked) || picked.length === 0) return undefined;
  return {
    native: picked.includes(NATIVE),
    erc20s: erc20s.filter((t) => picked.includes(t.tokenAddress)),
  };
};

const runRecover = async (
  ctx: DeckContext,
  chainName: NetworkName,
  encryptionKey: string,
  currentIndex: number,
): Promise<void> => {
  const provider = getInputProvider();
  // Start from a clean slate: a tier left over from an earlier operation would
  // silently price this one.
  clearGasFeeSelection();
  try {
    const raw = await provider.input("Recover from ephemeral index", {
      hint: `current is ${currentIndex}`,
    });
    const parsed = parseIndex(raw);
    if (!parsed.ok) {
      if (parsed.message !== "Cancelled.") provider.notify(parsed.message);
      return;
    }
    const targetIndex = parsed.index;

    const address = await getEphemeralAddressForIndex(
      chainName,
      encryptionKey,
      targetIndex,
    );
    setState({ status: `Scanning ephemeral [${targetIndex}]…` });
    const scan = await scanEphemeralAssets(chainName, address);
    if (scan.nativeWei === 0n && scan.erc20s.length === 0) {
      provider.notify("Nothing stranded at this ephemeral.");
      return;
    }
    if (scan.method === "tokenlist") {
      provider.notify(
        "Curated-list scan only — arbitrary tokens may be missed.",
      );
    }

    const selection = await pickAssets(scan.nativeWei, scan.erc20s);
    if (!selection) {
      provider.notify("Nothing selected.");
      return;
    }

    // Who pays: a broadcaster relays it, or the public wallet self-broadcasts.
    // Never assumed — this is a real transaction with a real cost.
    const funding = await collectFeeMode(chainName, true, RECOVERY_GAS_UNITS);
    if (!funding) return;
    const broadcaster =
      funding.kind === "broadcaster" ? funding.broadcaster : undefined;
    const fundingLabel = broadcaster
      ? `broadcaster (fee token ${broadcaster.tokenAddress})`
      : "self-broadcast (your public wallet pays gas)";

    await runGasTierPrompt(chainName, RECOVERY_GAS_UNITS);

    setState({ status: "Building recovery proof…" });
    const proved = await getProvedEphemeralRecoveryTransaction(
      chainName,
      encryptionKey,
      targetIndex,
      {
        erc20s: selection.erc20s,
        nativeWei: selection.native ? scan.nativeWei : undefined,
      },
      broadcaster,
    );

    const assets = [
      ...(selection.native ? [`${formatUnits(scan.nativeWei, 18)} ETH`] : []),
      ...selection.erc20s.map(
        (t) => `${formatUnits(t.balance, t.decimals)} ${t.symbol}`,
      ),
    ].join(", ");
    const lines = recoverySummaryLines({
      assets,
      index: targetIndex,
      funding: fundingLabel,
      gasLimit: proved.transaction.gasLimit ?? 0n,
      maxFeePerGas: proved.transaction.maxFeePerGas ?? undefined,
      estimatedCost: `${proved.estimatedCost}`,
      feeSymbol: proved.feeSymbol,
    });
    await showText(ctx, "recovery · review", lines.join("\n"), "yellow");
    if (!(await provider.confirm("Send this recovery?"))) return;

    setState({ status: "Submitting recovery…" });
    const txHash = await submitRecoveryTransaction(chainName, proved, broadcaster);
    setState({
      status: `Recovery submitted: ${getTransactionURLForChain(chainName, txHash)}`,
    });
    void ctx.refreshBalances();
    void ctx.refreshHistory();
  } catch (err) {
    setState({ status: `Recovery failed: ${(err as Error).message}` });
  } finally {
    // Every exit path, including a declined confirm and every early return
    // above, so a tier picked here can never price a later transaction.
    clearGasFeeSelection();
  }
};

const dispatch = async (
  ctx: DeckContext,
  verb: string,
  chainName: NetworkName,
  encryptionKey: string,
  info: { index: number; address: string },
): Promise<void> => {
  const provider = getInputProvider();
  switch (verb) {
    case "show":
      await showText(
        ctx,
        "7702 ephemeral · current",
        [
          `index   ${tag(`${info.index}`, "cyan")}`,
          `address ${tag(info.address, "green")}`,
        ].join("\n"),
      );
      break;

    case "balances":
      try {
        setState({ status: "Scanning ephemeral balances…" });
        const scan = await scanEphemeralAssets(chainName, info.address);
        setState({ status: "Ephemeral balances loaded." });
        await showText(
          ctx,
          "7702 ephemeral · balances",
          balanceLines(info.index, info.address, scan).join("\n"),
        );
      } catch (err) {
        provider.notify(`Balance lookup failed: ${(err as Error).message}`);
      }
      break;

    case "recover":
      await runRecover(ctx, chainName, encryptionKey, info.index);
      break;

    case "history":
      try {
        const { currentIndex, earlierOmitted, entries } = await getEphemeralHistory(
          chainName,
          encryptionKey,
        );
        await showText(
          ctx,
          `7702 ephemeral · history — ${chainName}`,
          historyLines(currentIndex, earlierOmitted, entries).join("\n"),
        );
      } catch (err) {
        provider.notify(`History unavailable: ${(err as Error).message}`);
      }
      break;

    case "sync":
      try {
        const { before, after } = await syncEphemeralIndexFromHistory(
          chainName,
          encryptionKey,
        );
        provider.notify(
          before === after
            ? `Index already in sync at ${after}.`
            : `Index realigned ${before} → ${after}.`,
        );
      } catch (err) {
        provider.notify(`Sync failed: ${(err as Error).message}`);
      }
      break;

    case "advance":
      if (!(await provider.confirm(advanceWarning(info.index, info.address)))) {
        return;
      }
      try {
        const { before, after } = await advanceEphemeralIndex(chainName);
        provider.notify(`Ephemeral index ${before} → ${after}.`);
      } catch (err) {
        provider.notify(`Advance failed: ${(err as Error).message}`);
      }
      break;

    case "set": {
      const raw = await provider.input("Set ephemeral index to", {
        hint: `current is ${info.index}`,
      });
      const parsed = parseIndex(raw);
      if (!parsed.ok) {
        if (parsed.message !== "Cancelled.") provider.notify(parsed.message);
        return;
      }
      // Rewinding can point the wallet back at an already-spent account, whose
      // nonce-0 7702 authorization the network will reject.
      if (
        rewindsIndex(info.index, parsed.index) &&
        !(await provider.confirm(rewindWarning(info.index)))
      ) {
        return;
      }
      try {
        await setEphemeralIndex(chainName, parsed.index);
        provider.notify(`Ephemeral index set to ${parsed.index}.`);
      } catch (err) {
        provider.notify(`Set failed: ${(err as Error).message}`);
      }
      break;
    }

    default:
      break;
  }
};

/**
 * Password-gated because the console can mutate the persisted ephemeral index
 * and move funds. Loops until dismissed, re-reading the index each pass so the
 * header reflects any change the previous verb made.
 */
export const openEphemeralAdmin = async (ctx: DeckContext): Promise<void> => {
  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) return;

  const chainName = getCurrentNetwork();
  const provider = getInputProvider();

  for (;;) {
    let info: { index: number; address: string };
    try {
      info = await getCurrentEphemeralInfo(chainName, encryptionKey);
    } catch (err) {
      provider.notify(`Could not read ephemeral state: ${(err as Error).message}`);
      return;
    }

    const verb = await provider.select(
      `7702 Ephemeral — ${chainName} · index ${info.index} · ${info.address}`,
      MENU,
    );
    if (!isDefined(verb)) return;
    await dispatch(ctx, verb, chainName, encryptionKey, info);
  }
};
