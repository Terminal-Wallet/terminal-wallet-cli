import { SignerId } from "../../../models/wallet-models";
import { ExternalSignerBackend } from "../types";

export type SignerBackendDefinition = {
  id: SignerId;
  label: string;
  /** Optional npm package — when absent, backend is always treated as available. */
  npmPackage?: string;
  /**
   * Loads the backend module. MUST use a string-literal dynamic import so
   * esbuild bundles the backend into the shipped binary — a variable import
   * path is left unbundled and fails at runtime in the caxa bundle.
   */
  load: () => Promise<{ backend: ExternalSignerBackend }>;
};

/** Add new external signers here and implement backends/<id>/. */
export const SIGNER_BACKEND_DEFINITIONS: SignerBackendDefinition[] = [];
