/**
 * Seam-based fee-mode collector for private-spend transactions. Lets the user
 * pay via a BROADCASTER (relay, fee in a shielded token) or SELF-SIGN (public
 * wallet pays gas). The broadcaster path only offers fee tokens that actually
 * have broadcasters available, defaults to the best one, and a "compare" step
 * opens a modal listing every broadcaster with its computed fee (gas ×
 * feePerUnitGas via the SDK), reliability, and wallet count.
 *
 * Fees here are APPROXIMATE — computed against a nominal gas limit at selection
 * time; the exact fee is recomputed against the real estimate at confirm/send.
 */
import {
  EVMGasType,
  NetworkName,
  SelectedBroadcaster,
  TransactionGasDetails,
} from "@railgun-community/shared-models";
import { calculateBroadcasterFeeERC20Amount } from "@railgun-community/wallet";
import { formatUnits } from "ethers";
import { getInputProvider, InputChoice } from "../../core/input";
import { FeeMode } from "../spec";
import { selfSignFee } from "./tx-input";
import { getDefaultFeeModePref } from "../../railgun/wallet/wallet-util";
import { getPrivateERC20BalancesForChain } from "../../railgun/balance/balance-util";
import { getTokenInfo } from "../../railgun/balance/token-util";
import { getChainForName } from "../../railgun/network/network-util";
import { getWakuClient, isWakuConnected } from "../../railgun/waku/connect-waku";
import { getGasEstimates } from "../../railgun/gas/gas-fee";
import { evmGasTypeForChain } from "../../railgun/gas/gas-selection";
import { hasExternalSigners, listExternalSigners } from "../../railgun/wallet/external-signers";
import { RailgunDisplayBalance } from "../../models/balance-models";
import {
  rankBroadcasters,
  bonusPct,
  cheapestFee,
  favoriteRank,
  preferredFavorite,
  moveInList,
  BroadcasterRow,
} from "../broadcaster-rank";
import {
  getBroadcasterFavorites,
  getBroadcasterBlocklist,
  getBroadcasterPref,
  setBroadcasterPref,
  moveBroadcasterFavorite,
  BroadcasterPref,
} from "../../railgun/wallet/broadcaster-prefs";

const short = (a: string) => (a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/** A nominal TransactionGasDetails for approximating fees before the real estimate. */
const nominalGasDetails = async (
  chainName: NetworkName,
  gasUnits: bigint,
  relayAdapt = false,
): Promise<TransactionGasDetails | undefined> => {
  try {
    // A relay-adapt transaction is submitted as type 4 and priced by
    // maxFeePerGas, so the fee preview must be shaped the same way — on a
    // legacy-default chain the chain type would price it by gasPrice.
    const evmGasType = relayAdapt ? EVMGasType.Type4 : evmGasTypeForChain(chainName);
    const est = await getGasEstimates(chainName);
    return (
      evmGasType === EVMGasType.Type2 || evmGasType === EVMGasType.Type4
        ? {
            evmGasType,
            gasEstimate: gasUnits,
            maxFeePerGas: est.maxFeePerGas,
            maxPriorityFeePerGas: est.maxPriorityFeePerGas,
          }
        : { evmGasType, gasEstimate: gasUnits, gasPrice: est.gasPrice }
    ) as TransactionGasDetails;
  } catch {
    return undefined;
  }
};

/** Compute a broadcaster's fee in the token (amount + readable; undefined if it can't). */
const computeFee = async (
  b: SelectedBroadcaster,
  decimals: number,
  gasDetails: TransactionGasDetails | undefined,
): Promise<{ amount?: bigint; readable: string }> => {
  if (!gasDetails) return { readable: "~?" };
  try {
    const res = await calculateBroadcasterFeeERC20Amount(
      { tokenAddress: b.tokenAddress, feePerUnitGas: BigInt(b.tokenFee.feePerUnitGas) },
      gasDetails,
    );
    return {
      amount: res.amount,
      readable: Number(formatUnits(res.amount, decimals)).toLocaleString("en-US", {
        maximumFractionDigits: 6,
      }),
    };
  } catch {
    return { readable: "~?" };
  }
};

const broadcasterHint = async (
  b: SelectedBroadcaster,
  symbol: string,
  decimals: number,
  gasDetails: TransactionGasDetails | undefined,
): Promise<string> => {
  const { readable } = await computeFee(b, decimals, gasDetails);
  const rel = Math.round((b.tokenFee.reliability ?? 0) * 100);
  return `~${readable} ${symbol} · rel ${rel}% · ${b.tokenFee.availableWallets}w`;
};

/**
 * The broadcaster a new send starts with.
 *
 * A ranked favourite wins if any of them is reachable and serves one of your
 * spendable fee tokens — that ranking is the user saying "use this one", and
 * the default is where it has to take effect. Blocked broadcasters are excluded
 * outright. Otherwise fall back to the network's best.
 *
 * Precedence is checked across ALL your fee tokens before falling back, so a
 * favourite that only serves your second token still beats an auto-pick on the
 * first.
 */
const autoBestBroadcaster = async (
  chainName: NetworkName,
  relayAdapt: boolean,
): Promise<SelectedBroadcaster | undefined> => {
  if (!isWakuConnected()) return undefined;
  const waku = getWakuClient();
  const chain = getChainForName(chainName);
  const balances = await getPrivateERC20BalancesForChain(chainName); // Spendable
  const blocked = new Set(getBroadcasterBlocklist());

  const reachable: SelectedBroadcaster[] = [];
  let fallback: SelectedBroadcaster | undefined;
  for (const b of balances) {
    try {
      const token = b.tokenAddress.toLowerCase();
      for (const candidate of waku.findBroadcastersForToken(chain, token, relayAdapt, relayAdapt) ?? []) {
        if (!blocked.has(candidate.railgunAddress)) reachable.push(candidate);
      }
      if (!fallback) {
        const best = waku.findBestBroadcaster(chain, token, relayAdapt, relayAdapt);
        if (best && !blocked.has(best.railgunAddress)) fallback = best;
      }
    } catch {
      /* skip token */
    }
  }

  const favoriteAddress = preferredFavorite(
    getBroadcasterFavorites(),
    reachable.map((b) => b.railgunAddress),
  );
  const favorite = reachable.find((b) => b.railgunAddress === favoriteAddress);
  return favorite ?? fallback;
};

/**
 * The DEFAULT fee mode applied to a new private send. Default preference is
 * BROADCASTER — auto-pick the best one across your spendable tokens; if waku
 * isn't connected or no broadcaster is found, fall back to self-send. An
 * explicit "self-signer" / "external:<label>" preference is honored.
 */
export const resolveDefaultFeeAsync = async (
  chainName: NetworkName,
  relayAdapt: boolean,
): Promise<FeeMode> => {
  const pref = getDefaultFeeModePref();
  if (pref.startsWith("external:")) {
    const label = pref.slice("external:".length);
    if (listExternalSigners().some((s) => s.label === label)) {
      return { kind: "external-signer", label };
    }
    return selfSignFee();
  }
  if (pref === "self-signer") return selfSignFee();
  // "broadcaster" (the default) → auto-best, else self-send.
  const best = await autoBestBroadcaster(chainName, relayAdapt);
  return best ? { kind: "broadcaster", broadcaster: best } : selfSignFee();
};

/**
 * Approximate the broadcaster's fee in its fee token (amount + symbol/decimals)
 * for a nominal gas limit — for the review/builder preview. Exact fee is recomputed
 * against the real estimate at send.
 */
export const approxBroadcasterFee = async (
  b: SelectedBroadcaster,
  chainName: NetworkName,
  gasUnits: bigint,
  relayAdapt = false,
): Promise<{ amount: bigint; symbol: string; decimals: number } | undefined> => {
  const gasDetails = await nominalGasDetails(chainName, gasUnits, relayAdapt);
  if (!gasDetails) return undefined;
  try {
    const res = await calculateBroadcasterFeeERC20Amount(
      { tokenAddress: b.tokenAddress, feePerUnitGas: BigInt(b.tokenFee.feePerUnitGas) },
      gasDetails,
    );
    const { symbol, decimals } = await getTokenInfo(chainName, b.tokenAddress);
    return { amount: res.amount, symbol, decimals };
  } catch {
    return undefined;
  }
};

/** Collect a FeeMode for a private-spend tx. Returns undefined on cancel/no-change. */
/**
 * Favourite / rank / block / clear broadcasters; persists. Loops until "Done".
 *
 * Favourites are listed in precedence order ahead of everything else, because
 * their order is the thing being edited — showing them in discovery order while
 * asking the user to rank them would be its own puzzle.
 */
const manageBroadcasterPrefs = async (computed: BroadcasterRow[]): Promise<void> => {
  const provider = getInputProvider();
  for (;;) {
    const favorites = getBroadcasterFavorites();
    const ordered = rankBroadcasters(computed, { favorites });
    const rows: InputChoice[] = ordered.map((r) => {
      const pref = getBroadcasterPref(r.address);
      const rank = favoriteRank(favorites, r.address);
      const mark =
        pref === "blocked"
          ? "x "
          : rank === Number.POSITIVE_INFINITY
            ? "  "
            : `#${rank + 1}`;
      return {
        label: `${mark} ${short(r.address)}`,
        value: r.address,
        // Only the top favourite is actually the default, so only it says so.
        hint: rank === 0 ? "default for new sends" : undefined,
      };
    });
    rows.push({ label: "← Done", value: "__done" });
    const pick = await provider.select("Favorites, order & blocklist", rows);
    if (!pick || pick === "__done") return;

    const rank = favoriteRank(favorites, pick);
    const isFavorite = rank !== Number.POSITIVE_INFINITY;
    const actions = [
      ...(isFavorite
        ? []
        : [{ label: "Favorite", value: "favorite", hint: "adds to the end" }]),
      ...(isFavorite && rank > 0
        ? [{ label: "Move up", value: "up", hint: `to #${rank}` }]
        : []),
      ...(isFavorite && rank < favorites.length - 1
        ? [{ label: "Move down", value: "down", hint: `to #${rank + 2}` }]
        : []),
      ...(isFavorite && rank > 0
        ? [{ label: "Make default", value: "top", hint: "to #1" }]
        : []),
      { label: "Block", value: "blocked", hint: "hide it" },
      { label: "Clear", value: "none" },
    ];
    const action = await provider.select(short(pick), actions);
    if (!action) continue;
    if (action === "up") moveBroadcasterFavorite(pick, -1);
    else if (action === "down") moveBroadcasterFavorite(pick, 1);
    else if (action === "top") moveBroadcasterFavorite(pick, -favorites.length);
    else setBroadcasterPref(pick, action as BroadcasterPref);
  }
};

export const collectFeeMode = async (
  chainName: NetworkName,
  relayAdapt: boolean,
  gasUnits: bigint,
): Promise<FeeMode | undefined> => {
  const provider = getInputProvider();
  // Fee modes: relay via a broadcaster, OR self-sign with either your own public
  // wallet (self-send) or an external signer. External-signer wiring lands in
  // phase 002 (registry + encrypted keychain); stubbed here so the shape is set.
  const mode = await provider.select("Transaction fee", [
    { label: "Broadcaster", value: "broadcaster", hint: "relay · pay in-token" },
    { label: "Self-send", value: "self", hint: "your public wallet pays gas" },
    { label: "External signer", value: "external", hint: "another key pays gas" },
  ]);
  if (!mode) return undefined;
  if (mode === "self") return selfSignFee();
  if (mode === "external") {
    if (!hasExternalSigners()) {
      provider.notify("No external signers — import one in Signers.");
      return undefined;
    }
    const label = await provider.select(
      "External signer (pays gas)",
      listExternalSigners().map((s) => ({
        label: s.label,
        value: s.label,
        hint: short(s.address),
      })),
    );
    return label ? { kind: "external-signer", label } : undefined;
  }

  // --- Broadcaster path ---
  if (!isWakuConnected()) {
    provider.notify("Broadcasters unavailable (waku not connected) — use self-sign.");
    return undefined;
  }
  const waku = getWakuClient();
  const chain = getChainForName(chainName);

  // Only offer fee tokens that actually have broadcasters.
  //
  // For a relay-adapt flow the lookups below are already restricted to
  // 7702-capable broadcasters, so a token no such broadcaster advertises is a
  // dead end: it would list, and then finding a broadcaster for it would return
  // nothing. Intersect up front with what the 7702 set actually accepts.
  const balances = await getPrivateERC20BalancesForChain(chainName); // Spendable only
  const accepted = relayAdapt
    ? new Set(
        (waku.findAllBroadcastersForChain(chain, true, true) ?? []).map((b) =>
          b.tokenAddress.toLowerCase(),
        ),
      )
    : undefined;
  const withBrokers: RailgunDisplayBalance[] = [];
  for (const b of balances) {
    if (accepted && !accepted.has(b.tokenAddress.toLowerCase())) continue;
    try {
      // The client returns undefined rather than an empty list when it knows of
      // no broadcasters for a token, so treat that as "none" explicitly.
      if (
        (waku.findBroadcastersForToken(
          chain,
          b.tokenAddress.toLowerCase(),
          relayAdapt,
          relayAdapt,
        ) ?? []).length
      )
        withBrokers.push(b);
    } catch { /* skip token */ }
  }
  if (!withBrokers.length) {
    provider.notify("No broadcasters available for your tokens — use self-sign.");
    return undefined;
  }

  const tokenAddr = await provider.select(
    "Fee token (broadcaster-supported)",
    withBrokers.map((b) => ({
      label: b.symbol,
      value: b.tokenAddress,
      hint: formatUnits(b.amount, b.decimals),
    })),
  );
  if (!tokenAddr) return undefined;
  const token = withBrokers.find((b) => b.tokenAddress === tokenAddr);
  if (!token) {
    return undefined;
  }

  const gasDetails = await nominalGasDetails(chainName, gasUnits, relayAdapt);
  const best = waku.findBestBroadcaster(
    chain,
    tokenAddr.toLowerCase(),
    relayAdapt,
    relayAdapt,
  );
  if (!best) {
    provider.notify(`No broadcaster found for ${token.symbol}.`);
    return undefined;
  }

  // Your highest-precedence favourite, if one of them serves this token right
  // now. Offered FIRST and chosen by default: having ranked them, being asked
  // again every time defeats the point of ranking them.
  const forToken =
    waku.findBroadcastersForToken(
      chain,
      tokenAddr.toLowerCase(),
      relayAdapt,
      relayAdapt,
    ) ?? [];
  const favoriteAddress = preferredFavorite(
    getBroadcasterFavorites(),
    forToken.map((b) => b.railgunAddress),
  );
  const favorite = forToken.find((b) => b.railgunAddress === favoriteAddress);

  const options = [];
  if (favorite) {
    options.push({
      label: `Use favorite (#1) — ${short(favorite.railgunAddress)}`,
      value: "favorite",
      hint: await broadcasterHint(favorite, token.symbol, token.decimals, gasDetails),
    });
  }
  // Suppressed when they are the same broadcaster: two identical rows reading
  // differently is a worse answer than one.
  if (favorite?.railgunAddress !== best.railgunAddress) {
    options.push({
      label: `Use best — ${short(best.railgunAddress)}`,
      value: "best",
      hint: await broadcasterHint(best, token.symbol, token.decimals, gasDetails),
    });
  }
  options.push({ label: "Compare all broadcasters…", value: "compare" });

  const choice = await provider.select(`Broadcaster for ${token.symbol}`, options);
  if (!choice) return undefined;
  if (choice === "favorite" && favorite) {
    return { kind: "broadcaster", broadcaster: favorite };
  }
  if (choice === "best") return { kind: "broadcaster", broadcaster: best };

  // Comparison modal — broadcasters for THIS fee token: blocked hidden,
  // favorites first, then cheapest. Loops so managing prefs refreshes the list.
  const all =
    waku.findBroadcastersForToken(
      chain,
      tokenAddr.toLowerCase(),
      relayAdapt,
      relayAdapt,
    ) ?? [];
  const computed: BroadcasterRow[] = await Promise.all(
    all.map(async (b) => {
      const { amount, readable } = await computeFee(b, token.decimals, gasDetails);
      return {
        address: b.railgunAddress,
        feeAmount: amount,
        feeReadable: readable,
        reliability: b.tokenFee.reliability ?? 0,
        wallets: b.tokenFee.availableWallets ?? 0,
      };
    }),
  );
  for (;;) {
    const favorites = getBroadcasterFavorites();
    const blocked = new Set(getBroadcasterBlocklist());
    const ranked = rankBroadcasters(computed, { favorites, blocked });
    if (!ranked.length) {
      provider.notify(`No broadcasters for ${token.symbol} (all blocked?).`);
      return undefined;
    }
    // The cheapest ROW, not the first one — the top of this list is now the
    // highest-precedence favourite, which is frequently not the cheapest.
    const cheapest = cheapestFee(ranked);
    const rows = ranked.map((r) => {
      const bonus = bonusPct(r.feeAmount, cheapest);
      const bonusText = r.feeAmount === undefined ? "  —  " : bonus === 0 ? " best " : `+${bonus.toFixed(1)}%`;
      const rel = Math.round(r.reliability * 100);
      const rank = favoriteRank(favorites, r.address);
      // The precedence number is the point: "#1" is the one that gets used.
      const star = rank === Number.POSITIVE_INFINITY ? "  " : `#${rank + 1}`;
      const label =
        `${star} ${short(r.address).padEnd(15)}` +
        `${r.feeReadable.padStart(11)} ${token.symbol.padEnd(5)}` +
        `${bonusText.padStart(7)}  rel ${String(rel).padStart(3)}%  ${r.wallets}w`;
      return { label, value: r.address };
    });
    rows.push({ label: "Favorites, order & blocklist…", value: "__manage" });
    const picked = await provider.select(
      `Broadcasters · ${token.symbol} · by precedence, then cheapest`,
      rows,
    );
    if (!picked) return undefined;
    if (picked === "__manage") {
      await manageBroadcasterPrefs(computed);
      continue;
    }
    const broadcaster = all.find((b) => b.railgunAddress === picked);
    return broadcaster ? { kind: "broadcaster", broadcaster } : undefined;
  }
};
