import FS from "node:fs";
import Path from "node:path";
import { prebuildPreservePath, resolvePrebuildSegments } from "../lib/prebuilds.mjs";

const ETH_ONLY_METHOD_SOURCE = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMethod = void 0;
const tslib_1 = require("tslib");
const Methods = tslib_1.__importStar(require("../api"));
const errors_1 = require("../constants/errors");
const network_1 = require("../constants/network");
const moduleMethods = { ethereum: require("../api/ethereum/api") };
const getMethodModule = (method) =>
  network_1.MODULES.find((module) => method.startsWith(module));
const getMethod = async (message) => {
  const { method } = message.payload;
  if (typeof method !== "string") {
    throw (0, errors_1.TypedError)("Method_InvalidParameter", "Message method is not set");
  }
  const methodModule = getMethodModule(method);
  const methods =
    methodModule && moduleMethods[methodModule] ? moduleMethods[methodModule] : Methods;
  const MethodConstructor = methods[method];
  if (MethodConstructor) {
    return new MethodConstructor(message);
  }
  throw (0, errors_1.TypedError)("Method_InvalidParameter", \`Method \${method} not found\`);
};
exports.getMethod = getMethod;
`;

/** @type {import("./types.mjs").SignerShipConfig} */
export const trezorSignerShip = {
  id: "trezor",
  npmPackage: "@trezor/connect",
  backendBundlePattern: /backends\/trezor\/index/,
  stubPath: (repoRoot) => Path.join(repoRoot, "ship", "stubs", "trezor.cjs"),

  isInstalled(repoRoot) {
    return FS.existsSync(
      Path.join(repoRoot, "node_modules", "@trezor", "connect"),
    );
  },

  setup({ buildNodeModules, platform, arch, preserveNodeModules }) {
    const segments = resolvePrebuildSegments(platform, arch, "usb");
    if (!segments) {
      throw new Error("ERR Unsupported os/arch, no usb prebuild found");
    }

    preserveNodeModules.push(
      prebuildPreservePath(buildNodeModules, "usb", segments),
    );

    const connectCoreDir = Path.join(
      buildNodeModules,
      "@trezor",
      "connect",
      "lib",
      "core",
    );
    const ethOnlyMethodPath = Path.join(connectCoreDir, "method.ethonly.js");
    FS.writeFileSync(ethOnlyMethodPath, ETH_ONLY_METHOD_SOURCE);

    const plugin = {
      name: "trezor-method-ethonly",
      setup(build) {
        build.onResolve({ filter: /^\.\/method$/ }, (args) => {
          if (
            args.importer.includes(`@trezor${Path.sep}connect`) &&
            args.importer.endsWith(Path.join("core", "index.js"))
          ) {
            return { path: ethOnlyMethodPath };
          }
          return undefined;
        });
      },
    };

    return { plugins: [plugin] };
  },
};
