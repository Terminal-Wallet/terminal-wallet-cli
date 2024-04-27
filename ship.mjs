import FS from "node:fs";
import Path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify as p } from "node:util";
import { exec } from "node:child_process";
import os from "node:os";
import { mkdirpSync } from "mkdirp";
import { rimrafSync } from "rimraf";
import * as FSE from "fs-extra/esm";
import * as esbuild from "esbuild";
import caxa from "caxa";

const __filename = fileURLToPath(import.meta.url);
const __dirname = Path.dirname(__filename);

const BUILD_NAME = "terminal-wallet-cli";

const DIST_DIR = Path.join(__dirname, "dist");
const BUILD_DIR = Path.join(__dirname, "build");
const SOURCE_NODE_MODULES = Path.join(__dirname, "node_modules");
const BUILD_NODE_MODULES = Path.join(BUILD_DIR, "node_modules");
const SOURCE_PACKAGE_JSON = Path.join(__dirname, "package.json");
const BUILD_PACKAGE_JSON = Path.join(BUILD_DIR, "package.json");
const ENTRY = Path.join(BUILD_DIR, "main.js");
const BUNDLE = Path.join(BUILD_DIR, "bundle.js");
const SHIPPED = Path.join(BUILD_DIR, BUILD_NAME);

const clean = process.argv.includes("--clean");

const POSIEDON_HASH_WASM = Path.join(
  BUILD_NODE_MODULES,
  "@railgun-community",
  "poseidon-hash-rsjs",
  "index.node",
);
const POSIEDON_HASH_WASM_BUILD = Path.join(BUILD_DIR, "index.node");

const preserveNodeModules = [
  Path.join(
    BUILD_NODE_MODULES,
    "@railgun-community",
    "curve25519-scalarmult-rsjs",
    "index.node",
  ),
  POSIEDON_HASH_WASM_BUILD,
];

(async function ship() {
  if (clean) {
    // Reset build folder
    console.log('Cleaning "build" folder...');
    rimrafSync(BUILD_DIR);
    mkdirpSync(BUILD_DIR);
  }

  // Move transpiled source
  console.log("Copying transpiled source...");
  FSE.copySync(DIST_DIR, BUILD_DIR);

  // Npm install
  console.log("Copying node_modules...");
  FSE.copySync(SOURCE_NODE_MODULES, BUILD_NODE_MODULES);
  FSE.copySync(SOURCE_PACKAGE_JSON, BUILD_PACKAGE_JSON);
  FSE.copySync(POSIEDON_HASH_WASM, POSIEDON_HASH_WASM_BUILD);

  // Apply patches to dependencies so they work with the bundled version
  console.log("Applying patches...");
  const { stderr } = await p(exec)(
    process.platform === "win32"
      ? `cd ${BUILD_DIR} && ..\\node_modules\\.bin\\patch-package --error-on-fail --patch-dir ../build-patches`
      : `cd ${BUILD_DIR} && ../node_modules/.bin/patch-package --error-on-fail --patch-dir ../build-patches`,
  );
  if (stderr) {
    console.error(stderr);
    process.exit(1);
  }

  console.log("Applying custom patches to use leveldown prebuilds...");
  const arch = os.arch();
  const platform = os.platform();
  const leveldownBindingJS = Path.join(
    BUILD_DIR,
    "node_modules",
    "leveldown",
    "binding.js",
  );
  rimrafSync(leveldownBindingJS);
  let leveldownNodeFile;
  if (platform === "darwin") {
    leveldownNodeFile = ["darwin-x64+arm64", "node.napi.node"];
  } else if (platform === "linux" && arch === "x64") {
    leveldownNodeFile = ["linux-x64", "node.napi.glibc.node"];
  } else if (platform === "linux" && arch === "arm64") {
    leveldownNodeFile = ["linux-arm64", "node.napi.glibc.node"];
  } else if (platform === "win32" && arch === "x64") {
    leveldownNodeFile = ["win32-x64", "node.napi.node"];
  } else if (platform === "win32" && arch === "ia32") {
    leveldownNodeFile = ["win32-ia32", "node.napi.node"];
  }
  if (!leveldownNodeFile) {
    console.error("ERR Unsupported os/arch, no leveldown prebuilds found");
    process.exit(1);
  }
  const expanded = leveldownNodeFile.map((str) => `'${str}'`).join(", ");
  FS.writeFileSync(
    leveldownBindingJS,
    `const path = require('path');\n` +
      `module.exports = require(path.join(` +
      `__dirname, 'node_modules', 'leveldown', 'prebuilds', ${expanded}` +
      `));`,
  );
  preserveNodeModules.push(
    Path.join(
      BUILD_NODE_MODULES,
      "leveldown",
      "prebuilds",
      ...leveldownNodeFile,
    ),
  );

  // Create a single bundled JavaScript file
  console.log("Bundling with esbuild...");
  rimrafSync(BUNDLE);
  await esbuild.build({
    entryPoints: [ENTRY],
    absWorkingDir: BUILD_DIR,
    bundle: true,
    platform: "node",
    outfile: BUNDLE,
    alias: {
      "default-gateway": "no-op",
      "@achingbrain/ssdp": "no-op",
      "@railgun-community/curve25519-scalarmult-wasm":
        "@railgun-community/curve25519-scalarmult-rsjs",
      "@railgun-community/poseidon-hash-wasm":
        "@railgun-community/poseidon-hash-rsjs",
    },
  });

  // Delete most of node_modules
  console.log("Delete most of node_modules...");
  rimrafSync(BUILD_DIR, {
    filter(path) {
      if (path === BUNDLE) return false;
      if (preserveNodeModules.includes(path)) return false;
      return true;
    },
  });

  console.log("Creating a single executable file...");
  await caxa({
    input: BUILD_DIR,
    output: SHIPPED + (process.platform === "win32" ? ".exe" : ""),
    dedupe: false,
    command: [
      "{{caxa}}/node_modules/.bin/node",
      "--no-warnings",
      "{{caxa}}/bundle.js",
    ],
  });

  console.log("Deleting final leftovers...");
  rimrafSync(BUILD_NODE_MODULES);
  rimrafSync(BUNDLE);

  console.log(`\nDONE! Your executable is ${SHIPPED}`);
})();
