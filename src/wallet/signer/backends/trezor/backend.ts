import { ExternalSignerBackend } from "../../types";
import {
  disposeTrezor,
  trezorDerivationPath,
  trezorGetAddress,
  trezorSignMessage,
  trezorSignTransaction,
} from "./client";

export const trezorBackend: ExternalSignerBackend = {
  id: "trezor",
  label: "Trezor",
  derivationPath: trezorDerivationPath,
  getAddress: async (derivationIndex) =>
    trezorGetAddress(trezorDerivationPath(derivationIndex)),
  signMessage: async (derivationIndex, message) =>
    trezorSignMessage(trezorDerivationPath(derivationIndex), message),
  signTransaction: async (derivationIndex, transaction) => {
    const { serializedTx } = await trezorSignTransaction(
      trezorDerivationPath(derivationIndex),
      transaction,
    );
    return serializedTx;
  },
  dispose: disposeTrezor,
};
