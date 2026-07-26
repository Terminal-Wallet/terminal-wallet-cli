/**
 * Pure menu-item presentation — the selection prefix + highlight styling,
 * separated from blessed so the "which item looks selected" logic is testable.
 */
export const menuItemContent = (label: string, selected: boolean): string =>
  `${selected ? "› " : "  "}${label}`;

export interface MenuItemStyle {
  bg?: string;
  fg: string;
}

export const menuItemStyle = (selected: boolean): MenuItemStyle =>
  selected ? { bg: "green", fg: "black" } : { fg: "white" };
