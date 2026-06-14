// Lazy wrapper around @trezor/connect for headless Node usage. Connect is
// dynamically imported so the `usb` native addon is not loaded at startup
// (required for the caxa-shipped binary — see ship/signers/trezor.mjs).
import fs from "fs";
import path from "path";
import { ExternalEVMTransaction } from "../../types";

let connectApi: any;

const resolveConnect = (mod: any): any => {
  const candidates = [mod?.default?.default, mod?.default, mod];
  const api = candidates.find(
    (c) =>
      c &&
      typeof c.init === "function" &&
      typeof c.ethereumGetAddress === "function",
  );
  if (!api) {
    throw new Error("Could not resolve @trezor/connect default export.");
  }
  return api;
};

const pointUsbAtBundledPrebuild = (): void => {
  if (process.env.NODE_USB_PATH) {
    return;
  }
  const bundledUsb = path.join(__dirname, "node_modules", "usb");
  if (fs.existsSync(path.join(bundledUsb, "prebuilds"))) {
    process.env.NODE_USB_PATH = bundledUsb;
  }
};

const getTrezorConnect = async (): Promise<any> => {
  if (!connectApi) {
    pointUsbAtBundledPrebuild();
    connectApi = resolveConnect(await import("@trezor/connect"));
  }
  return connectApi;
};

export const trezorDerivationPath = (derivationIndex: number): string =>
  `m/44'/60'/0'/0/${derivationIndex}`;

type TrezorSignedTx = {
  serializedTx: string;
};

let initPromise: Promise<void> | undefined;

const initTrezor = async (): Promise<void> => {
  const TrezorConnect = await getTrezorConnect();
  await TrezorConnect.init({
    manifest: {
      appName: "Terminal Wallet",
      appUrl: "https://terminal-wallet.com",
      email: "support@terminal-wallet.com",
    },
    // Headless Node: talk to the device directly over USB. Without this,
    // @trezor/connect defaults transports to ['BridgeTransport'] and hangs
    // forever waiting on a Trezor Bridge daemon that isn't running.
    transports: ["NodeUsbTransport"],
    transportReconnect: true,
  } as any);
};

const ensureTrezorReady = async (): Promise<void> => {
  if (!initPromise) {
    initPromise = initTrezor().catch((err) => {
      initPromise = undefined;
      throw new Error(
        `Failed to initialize Trezor Connect: ${(err as Error).message}`,
      );
    });
  }
  return initPromise;
};

const unwrap = <T>(result: {
  success: boolean;
  payload: T | { error: string; code?: string };
}): T => {
  if (!result.success) {
    const { error } = result.payload as { error: string };
    throw new Error(`Trezor request failed: ${error}`);
  }
  return result.payload as T;
};

export const trezorGetAddress = async (
  derivationPath: string,
  showOnDevice = false,
): Promise<string> => {
  await ensureTrezorReady();
  const TrezorConnect = await getTrezorConnect();
  const result = await TrezorConnect.ethereumGetAddress({
    path: derivationPath,
    showOnTrezor: showOnDevice,
  });
  const { address } = unwrap<{ address: string }>(result);
  return address;
};

export const trezorSignMessage = async (
  derivationPath: string,
  message: string,
): Promise<string> => {
  await ensureTrezorReady();
  const TrezorConnect = await getTrezorConnect();
  const result = await TrezorConnect.ethereumSignMessage({
    path: derivationPath,
    message,
    hex: false,
  });
  const payload = unwrap<{ address: string; signature: string }>(result);
  return payload.signature.startsWith("0x")
    ? payload.signature
    : `0x${payload.signature}`;
};

export const trezorSignTransaction = async (
  derivationPath: string,
  transaction: ExternalEVMTransaction,
): Promise<TrezorSignedTx> => {
  await ensureTrezorReady();
  const TrezorConnect = await getTrezorConnect();
  const result = await TrezorConnect.ethereumSignTransaction({
    path: derivationPath,
    transaction: transaction as any,
  });
  return unwrap<TrezorSignedTx>(result);
};

export const disposeTrezor = async (): Promise<void> => {
  if (!initPromise || !connectApi) {
    return;
  }
  try {
    await connectApi.dispose();
  } catch {
    // best-effort cleanup on exit
  }
  initPromise = undefined;
  connectApi = undefined;
};
