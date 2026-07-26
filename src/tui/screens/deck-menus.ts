/**
 * Pure, renderer-agnostic definitions of the deck's SCOPED card menus. Each top
 * card opens only its own concern: the wallet card → wallet/identity actions,
 * the network card → chain/RPC, the status (sync) card → refresh + heavy
 * maintenance (rescans / POI), and the utilities card → advanced leftovers from
 * the original UI. Kept here (not inline in deck-entry) so the grouping is
 * unit-testable; the deck owns only the dispatch.
 */
import { InputChoice } from "../../core/input";

export const walletMenu = (): InputChoice[] => [
  { label: "Show Addresses", value: "reveal-address", hint: "0x + 0zk · copy" },
  { label: "Switch Wallet", value: "switch-wallet", hint: "account" },
  { label: "New / Import Wallet", value: "new-wallet", hint: "seed" },
  { label: "Contacts", value: "contacts", hint: "address book" },
  { label: "External Signers", value: "signers", hint: "gas keys" },
  { label: "Reveal Recovery Phrase", value: "mnemonic", hint: "backup" },
];

export const networkMenu = (): InputChoice[] => [
  { label: "Switch Network", value: "network", hint: "chain" },
  { label: "Add ERC20 Token", value: "add-token", hint: "tokens" },
  { label: "Edit RPC Providers", value: "edit-rpc", hint: "endpoints" },
  { label: "Start Waku", value: "waku-start", hint: "connect broadcasters" },
  { label: "Refresh Waku / Broadcasters", value: "reset-broadcasters", hint: "reconnect · re-discover" },
  { label: "Stop Waku", value: "waku-stop", hint: "disconnect" },
  { label: "Broadcaster Allow / Blocklist", value: "broadcaster-prefs", hint: "favorites · blocked" },
];

export const statusMenu = (): InputChoice[] => [
  { label: "Refresh Balances", value: "refresh", hint: "scan" },
  { label: "Full Rescan", value: "full-rescan", hint: "rebuild UTXO + balances · unstick" },
  { label: "Full TXID Rescan", value: "txid-rescan", hint: "reset txid tree" },
  { label: "POI Tools", value: "poi", hint: "proof of innocence" },
  { label: "Activity / History", value: "activity", hint: "reload" },
];

/** Advanced settings + leftovers from the original UI. Label flips with the sender state. */
export const utilitiesMenu = (showSender: boolean): InputChoice[] => [
  { label: "Default Fee Mode", value: "default-fee", hint: "self / external signer" },
  {
    label: `${showSender ? "Hide" : "Show"} Private TX Sender Address`,
    value: "toggle-sender",
    hint: "privacy",
  },
  {
    label: "7702 Ephemeral Accounts",
    value: "ephemeral-accounts",
    hint: "index · stranded-fund recovery",
  },
  { label: "WIPE ALL DATA", value: "destruct", hint: "DANGER — no recovery" },
];
