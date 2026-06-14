import { Wallet } from "ethers";
import { ExternalSigner } from "./external-signer";

export type TerminalSigner = Wallet | ExternalSigner;
