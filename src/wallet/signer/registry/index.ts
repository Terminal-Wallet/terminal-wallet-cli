import { createRequire } from "node:module";
import { SignerId } from "../../../models/wallet-models";
import { ExternalSignerBackend } from "../types";
import {
  SIGNER_BACKEND_DEFINITIONS,
  SignerBackendDefinition,
} from "./definitions";

const nodeRequire = createRequire(__filename);

// Set by the ship build (esbuild `define`) to the comma-separated ids of signer
// backends compiled into the binary. Empty in dev — there we fall back to
// require.resolve. The shipped bundle strips node_modules, so require.resolve
// can't see the package even though the backend is bundled in; this list is the
// reliable "was it shipped" signal.
const BUNDLED_SIGNER_IDS = (process.env.TW_BUNDLED_SIGNERS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const HARDWARE_WALLET_INSTALL_HINT =
  "Hardware wallet support is not installed. Run: npm run installdeps:hardware";

const backendCache: Partial<Record<SignerId, ExternalSignerBackend>> = {};

const getDefinition = (id: SignerId): SignerBackendDefinition | undefined =>
  SIGNER_BACKEND_DEFINITIONS.find((def) => def.id === id);

const isSignerBackendInstalled = (def: SignerBackendDefinition): boolean => {
  // Compiled into the shipped binary — authoritative; node_modules is gone.
  if (BUNDLED_SIGNER_IDS.includes(def.id)) {
    return true;
  }
  if (!def.npmPackage) {
    return true;
  }
  try {
    nodeRequire.resolve(def.npmPackage);
    return true;
  } catch {
    return false;
  }
};

const listInstalledBackendDefinitions = (): SignerBackendDefinition[] =>
  SIGNER_BACKEND_DEFINITIONS.filter(isSignerBackendInstalled);

const loadBackend = async (
  def: SignerBackendDefinition,
): Promise<ExternalSignerBackend> => {
  if (!isSignerBackendInstalled(def)) {
    throw new Error(HARDWARE_WALLET_INSTALL_HINT);
  }
  const mod = await def.load();
  return mod.backend as ExternalSignerBackend;
};

export const getSignerBackend = async (
  id: SignerId,
): Promise<ExternalSignerBackend> => {
  if (backendCache[id]) {
    return backendCache[id] as ExternalSignerBackend;
  }

  const def = getDefinition(id);
  if (!def) {
    throw new Error(`Unknown external signer: ${id}`);
  }

  const backend = await loadBackend(def);
  backendCache[id] = backend;
  return backend;
};

export const listExternalSignerBackends = async (): Promise<
  ExternalSignerBackend[]
> => {
  const installed = listInstalledBackendDefinitions();
  return Promise.all(installed.map((def) => getSignerBackend(def.id)));
};

export const disposeExternalSigners = async (): Promise<void> => {
  await Promise.all(
    Object.values(backendCache).map((backend) => backend?.dispose()),
  );
  for (const id of Object.keys(backendCache) as SignerId[]) {
    delete backendCache[id];
  }
};
