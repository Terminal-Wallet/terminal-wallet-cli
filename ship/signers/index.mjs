import { trezorSignerShip } from "./trezor.mjs";

/** Register each external signer ship module here (mirrors src/wallet/signer/registry/definitions.ts). */
export const SIGNER_SHIPPERS = [trezorSignerShip];

const createStubPlugin = (shipper, repoRoot) => ({
  name: `${shipper.id}-backend-stub`,
  setup(build) {
    build.onResolve({ filter: shipper.backendBundlePattern }, () => ({
      path: shipper.stubPath(repoRoot),
    }));
  },
});

/**
 * @param {import("./types.mjs").SignerShipContext} context
 * @returns {{ plugins: import("esbuild").Plugin[], logs: string[], bundledSignerIds: string[] }}
 */
export const collectSignerShipSteps = (context) => {
  const plugins = [];
  const logs = [];
  const bundledSignerIds = [];

  for (const shipper of SIGNER_SHIPPERS) {
    if (shipper.isInstalled(context.repoRoot)) {
      logs.push(`Signer ship: ${shipper.id} (${shipper.npmPackage} detected)`);
      const { plugins: shipPlugins } = shipper.setup(context);
      plugins.push(...shipPlugins);
      bundledSignerIds.push(shipper.id);
    } else {
      logs.push(
        `Signer ship: ${shipper.id} skipped (${shipper.npmPackage ?? shipper.id} not installed)`,
      );
      plugins.push(createStubPlugin(shipper, context.repoRoot));
    }
  }

  if (
    SIGNER_SHIPPERS.length > 0 &&
    logs.every((line) => line.includes("skipped"))
  ) {
    logs.push("To ship with hardware wallets: npm run installdeps:hardware");
  }

  return { plugins, logs, bundledSignerIds };
};
