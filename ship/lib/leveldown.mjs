import FS from "node:fs";
import Path from "node:path";
import { rimrafSync } from "rimraf";
import { prebuildPreservePath, resolvePrebuildSegments } from "./prebuilds.mjs";

/**
 * Point leveldown's binding.js at the correct prebuild for this OS/arch.
 * @returns {string} absolute path to preserve in the caxa bundle
 */
export const patchLeveldownBinding = ({
  buildDir,
  buildNodeModules,
  platform,
  arch,
  preserveNodeModules,
}) => {
  const segments = resolvePrebuildSegments(platform, arch, "leveldown");
  if (!segments) {
    throw new Error("ERR Unsupported os/arch, no leveldown prebuilds found");
  }

  const bindingJS = Path.join(buildDir, "node_modules", "leveldown", "binding.js");
  rimrafSync(bindingJS);

  const expanded = segments.map((str) => `'${str}'`).join(", ");
  FS.writeFileSync(
    bindingJS,
    `const path = require('path');\n` +
      `module.exports = require(path.join(` +
      `__dirname, 'node_modules', 'leveldown', 'prebuilds', ${expanded}` +
      `));`,
  );

  const preservePath = prebuildPreservePath(
    buildNodeModules,
    "leveldown",
    segments,
  );
  preserveNodeModules.push(preservePath);
  return preservePath;
};
