/**
 * Running a batch as a chosen ephemeral account instead of the current one.
 *
 * Almost everything this wallet does uses a FRESH ephemeral account and then
 * ratchets past it, which is what keeps one relay-adapt batch unlinkable from
 * the next. Two things legitimately need to act as a PAST or RESERVED account
 * instead: rescuing assets stranded at an earlier index, and managing a
 * position that some protocol has keyed to an address.
 *
 * The override is process-wide — it replaces the signer the SDK derives from —
 * so two of them running at once would build each other's transactions. This
 * serialises them, refuses re-entry, and always clears.
 *
 * It deliberately does NOT move the persisted index. A caller that overrides
 * must not ratchet afterwards: the ratchet belongs to the account that was
 * actually consumed, and an override consumed a different one.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { NetworkName } from "@railgun-community/shared-models";
import { EphemeralKeyManager, fullWalletForID } from "@railgun-community/wallet";
import { getChainForName } from "../network/network-util";
import { getCurrentRailgunID } from "./wallet-util";
import { createLogger } from "../../platform/logger";

const log = createLogger("ephemeral-override");

/**
 * The index every read should report while an override is active.
 *
 * Without this the wallet reports a torn pair: the index from the persisted
 * counter and the address through the override, which are different accounts.
 * Five call sites bake that address into recipe calldata, so a torn pair is not
 * a cosmetic logging problem — it is a batch built for one account and executed
 * as another.
 */
let activeIndex: number | undefined;

/** The index reads should use: the override if one is installed, else undefined. */
export const overriddenEphemeralIndex = (): number | undefined => activeIndex;

/**
 * Serialises overrides across the whole process.
 *
 * A promise chain rather than a boolean: callers queue instead of failing when
 * something else is mid-build, and the window is a whole estimate → prove →
 * populate sequence, which is far too long to ask a caller to retry around.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Depth guard — an override inside an override would clear the outer one early.
 *
 * Async-context scoped, because the thing being guarded against is NESTING and
 * a plain boolean cannot tell nesting from concurrency. Module-global, it was
 * true for the whole duration of any override, so a second CALLER — a recovery
 * while a swap was mid-build — was rejected outright rather than queued, which
 * is the opposite of what the queue directly above it promises. A store is set
 * only inside the callback, so it is present exactly when the call really is
 * within another override's own stack.
 */
const nested = new AsyncLocalStorage<true>();

export class EphemeralOverrideReentry extends Error {
  constructor() {
    super(
      "An ephemeral override is already active on this call stack; nesting them would clear the outer one early.",
    );
    this.name = "EphemeralOverrideReentry";
  }
}

/**
 * Run `fn` with the wallet signing as `index`.
 *
 * The override is installed inside the try so any throw still clears it, and
 * cleared in `finally` so a rejected build cannot leave the wallet signing as
 * the wrong account for everything that follows.
 */
export const withEphemeralOverride = async <T>(
  chainName: NetworkName,
  encryptionKey: string,
  index: number,
  fn: (address: string) => Promise<T>,
): Promise<T> => {
  // Nesting is refused; concurrency queues. A nested call cannot simply wait
  // its turn — it would be waiting on the override that is waiting on it.
  if (nested.getStore()) throw new EphemeralOverrideReentry();

  const run = async (): Promise<T> => {
    const wallet = fullWalletForID(getCurrentRailgunID());
    const keyManager = new EphemeralKeyManager(wallet, encryptionKey);
    const account = await keyManager.getAccount(
      BigInt(getChainForName(chainName).id),
      index,
    );
    try {
      await wallet.setCurrentEphemeralWallet(account.signer);
      activeIndex = index;
      log.debug(`acting as ephemeral [${index}] ${account.address}`);
      return await nested.run(true, () => fn(account.address));
    } finally {
      activeIndex = undefined;
      // The engine clears the override when handed undefined; its type only
      // admits a wallet, so this is cast rather than widened.
      await (
        wallet.setCurrentEphemeralWallet as (w?: unknown) => Promise<void>
      )(undefined).catch((err) =>
        // Leaving the override installed would sign every later batch as this
        // account, so a failure here is worth shouting about even though there
        // is nothing to do but report it.
        log.error("failed to clear the ephemeral override", err),
      );
    }
  };

  // Chain onto whatever is queued, but do not inherit its failure.
  const mine = queue.then(run, run);
  queue = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
};
