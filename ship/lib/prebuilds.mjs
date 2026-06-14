import Path from "node:path";

/**
 * Resolve native prebuild path segments for the current platform/arch.
 * @returns {string[] | undefined}
 */
export const resolvePrebuildSegments = (platform, arch, packageKey) => {
  const maps = {
    leveldown: {
      darwin: ["darwin-x64+arm64", "node.napi.node"],
      "linux-x64": ["linux-x64", "node.napi.glibc.node"],
      "linux-arm64": ["linux-arm64", "node.napi.glibc.node"],
      "win32-x64": ["win32-x64", "node.napi.node"],
      "win32-ia32": ["win32-ia32", "node.napi.node"],
    },
    usb: {
      darwin: ["darwin-x64+arm64", "node.napi.node"],
      "linux-x64": ["linux-x64", "node.napi.glibc.node"],
      "linux-arm64": ["linux-arm64", "node.napi.armv8.node"],
      "win32-x64": ["win32-x64", "node.napi.node"],
      "win32-ia32": ["win32-ia32", "node.napi.node"],
      "win32-arm64": ["win32-arm64", "node.napi.node"],
    },
  };

  const map = maps[packageKey];
  if (!map) {
    return undefined;
  }

  const key = platform === "darwin" ? "darwin" : `${platform}-${arch}`;
  return map[key];
};

/**
 * @param {string} buildNodeModules
 * @param {string} packageName  e.g. "leveldown" or "usb"
 * @param {string[]} segments
 */
export const prebuildPreservePath = (
  buildNodeModules,
  packageName,
  segments,
) => {
  return Path.join(buildNodeModules, packageName, "prebuilds", ...segments);
};
