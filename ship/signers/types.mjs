/**
 * @typedef {object} SignerShipConfig
 * @property {string} id
 * @property {string} [npmPackage]
 * @property {RegExp} backendBundlePattern
 * @property {(repoRoot: string) => string} stubPath
 * @property {(repoRoot: string) => boolean} isInstalled
 * @property {(ctx: SignerShipContext) => { plugins: import("esbuild").Plugin[] }} setup
 */

/**
 * @typedef {object} SignerShipContext
 * @property {string} repoRoot
 * @property {string} buildDir
 * @property {string} buildNodeModules
 * @property {string} platform
 * @property {string} arch
 * @property {string[]} preserveNodeModules
 */

export {};
