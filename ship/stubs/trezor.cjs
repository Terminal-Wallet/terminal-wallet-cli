"use strict";

/** Stub used by ship when @trezor/connect is not installed. */
exports.backend = {
  id: "trezor",
  label: "Trezor",
  derivationPath: () => {
    throw new Error("Hardware wallet support is not installed.");
  },
  getAddress: async () => {
    throw new Error("Hardware wallet support is not installed.");
  },
  signMessage: async () => {
    throw new Error("Hardware wallet support is not installed.");
  },
  signTransaction: async () => {
    throw new Error("Hardware wallet support is not installed.");
  },
  dispose: async () => {},
};
