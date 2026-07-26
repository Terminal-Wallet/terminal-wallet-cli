/**
 * Extension point for future RAILGUN Cookbook integrations (LP, lending, etc.),
 * surfaced by the palette's "Other" card. Today it's an empty/placeholder
 * registry — adding a recipe here makes it appear in the Other menu. Pure +
 * unit-tested so the shape stays stable as real recipes land.
 */

export interface CookbookRecipe {
  id: string;
  label: string;
  hint?: string;
  available: boolean; // false → shown but "coming soon"
}

/** Registered cookbook recipes (none wired yet — extension point). */
export const listCookbookRecipes = (): CookbookRecipe[] => [
  // Example shape for future recipes:
  // { id: "uniswap-lp", label: "Uniswap LP", hint: "add liquidity", available: false },
];

/** Whether any recipe is actually runnable today. */
export const hasAvailableRecipe = (recipes = listCookbookRecipes()): boolean =>
  recipes.some((r) => r.available);
