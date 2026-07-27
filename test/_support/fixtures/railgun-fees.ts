/**
 * The cookbook's shield/unshield fee basis points.
 *
 * Every recipe wraps its steps in a RAILGUN unshield and shield, and both refuse
 * to build until the fees are known — an unprimed recipe fails with "Unshield
 * (Default) step is invalid.", which names neither the fee nor the cause. The
 * engine sets these at boot; a test has no engine, so it sets them here.
 *
 * The cookbook holds them in module state shared by the whole test process, so
 * this is idempotent and safe to call from every test that needs it.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { setRailgunFees } from "@railgun-community/cookbook";

/** Mainnet's actual 0.25% shield and unshield fees. */
export const SHIELD_FEE_BPS = 25n;
export const UNSHIELD_FEE_BPS = 25n;

const primed = new Set<NetworkName>();

export const primeRailgunFees = (
  networkName: NetworkName = NetworkName.Ethereum,
): void => {
  if (primed.has(networkName)) return;
  setRailgunFees(networkName, SHIELD_FEE_BPS, UNSHIELD_FEE_BPS);
  primed.add(networkName);
};
