/**
 * Menu actions modeled as DATA (mirrors the choices array in the old main-ui,
 * but decoupled from layout). The renderer groups by `group` and lays them out
 * with flexbox — no more manual visible.slice()/padEnd() column math.
 */
export type MenuGroup =
  | "Private Actions"
  | "Public Actions"
  | "Morpho"
  | "f(x)"
  | "Utilities";

export interface MenuAction {
  id: string;
  label: string;
  group: MenuGroup;
  /**
   * The second line on a palette card. The label says what the action is; this
   * says what it does to your money, which is the part worth reading before
   * choosing. Kept next to the label so the two are written together.
   */
  hint?: string;
  disabled?: boolean;
}

export const GROUP_ORDER: MenuGroup[] = [
  "Private Actions",
  "Public Actions",
  "Morpho",
  "f(x)",
  "Utilities",
];

// NOTE: the native-token actions (base-shield / base-unshield / public-base-
// transfer — "Shield/Unshield/Send ETH") were removed as separate entries. They
// now fold into the ERC20 Shield / Unshield / Send cards via the per-leg native
// token picker, so the palette stays a small, uniform card set. The underlying
// txBuilderConfigs entries for the base flows remain (reused by that picker).
export const buildActions = (baseSymbol: string): MenuAction[] => [
  { id: "private-transfer", label: "Send", hint: "0zk \u2192 0zk", group: "Private Actions" },
  { id: "unshield-private-balances", label: "Unshield", hint: "make it public", group: "Private Actions" },
  { id: "private-swap", label: "Swap", hint: "shielded, 0x", group: "Private Actions" },

  { id: "shield-public-balances", label: "Shield", hint: "into RAILGUN", group: "Public Actions" },
  { id: "public-transfer", label: "Send", hint: "0x \u2192 0x", group: "Public Actions" },
  { id: "public-swap", label: "Swap", hint: "public, 0x", group: "Public Actions" },

  { id: "morpho-vault-deposit", label: "Deposit", hint: "earn yield", group: "Morpho" },
  { id: "morpho-vault-redeem", label: "Withdraw", hint: "to private", group: "Morpho" },

  { id: "fx-mint-open", label: "Mint fxUSD", hint: "on collateral", group: "f(x)" },
  { id: "fx-mint-manage", label: "Manage", hint: "top up / repay", group: "f(x)" },
  { id: "fx-mint-close", label: "Close", hint: "repay, unwind", group: "f(x)" },
  {
    id: "fx-mint-dust-close",
    label: "Close fully",
    hint: "sell to cover",
    group: "f(x)",
  },

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
