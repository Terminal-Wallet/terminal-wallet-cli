/**
 * Menu actions modeled as DATA (mirrors the choices array in the old main-ui,
 * but decoupled from layout). The renderer groups by `group` and lays them out
 * with flexbox — no more manual visible.slice()/padEnd() column math.
 */
export type MenuGroup =
  | "Private Actions"
  | "Public Actions"
  | "0x Swap Tools"
  | "Morpho Vaults"
  | "Utilities";

export interface MenuAction {
  id: string;
  label: string;
  group: MenuGroup;
  disabled?: boolean;
}

export const GROUP_ORDER: MenuGroup[] = [
  "Private Actions",
  "Public Actions",
  "0x Swap Tools",
  "Morpho Vaults",
  "Utilities",
];

// NOTE: the native-token actions (base-shield / base-unshield / public-base-
// transfer — "Shield/Unshield/Send ETH") were removed as separate entries. They
// now fold into the ERC20 Shield / Unshield / Send cards via the per-leg native
// token picker, so the palette stays a small, uniform card set. The underlying
// txBuilderConfigs entries for the base flows remain (reused by that picker).
export const buildActions = (baseSymbol: string): MenuAction[] => [
  { id: "private-transfer", label: `Send ERC20s Privately`, group: "Private Actions" },
  { id: "unshield-private-balances", label: `Unshield ERC20s`, group: "Private Actions" },

  { id: "shield-public-balances", label: `Shield ERC20s`, group: "Public Actions" },
  { id: "public-transfer", label: `Send ERC20s Publicly`, group: "Public Actions" },

  { id: "private-swap", label: `Privately SWAP ERC20`, group: "0x Swap Tools" },
  { id: "public-swap", label: `Publicly SWAP ERC20`, group: "0x Swap Tools" },

  { id: "morpho-vault-deposit", label: `Deposit into Vault`, group: "Morpho Vaults" },
  { id: "morpho-vault-redeem", label: `Redeem from Vault`, group: "Morpho Vaults" },

  { id: "activity", label: "Activity / History", group: "Utilities" },
  { id: "wallet-tools", label: "Wallet Tools", group: "Utilities" },
  { id: "switch-wallet", label: "Switch Wallet", group: "Utilities" },
  { id: "network", label: "Switch Network", group: "Utilities" },
  { id: "add-token", label: "Add New ERC20 Token", group: "Utilities" },
  { id: "edit-contact-addresses", label: "Add / Edit Contacts", group: "Utilities" },
  { id: "refresh-balances", label: "Refresh Balances", group: "Utilities" },
  { id: "toggle-balance", label: "Toggle Public/Private", group: "Utilities" },
  { id: "reset-broadcasters", label: "Reset Broadcasters", group: "Utilities" },
  { id: "edit-rpc", label: "Edit RPC Providers", group: "Utilities" },
  { id: "exit", label: "Exit", group: "Utilities" },
];
