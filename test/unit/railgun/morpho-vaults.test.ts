/**
 * The curated vault list.
 *
 * Morpho lists hundreds of vaults and several carry live deposit-disabled or
 * bad-debt warnings, so this is a curated set rather than an enumeration.
 * Every entry was verified against mainnet — name, asset, decimals, that
 * previewDeposit answers, and which generation it is.
 *
 * The generation is not cosmetic: it selects the recipe subclass. Getting it
 * wrong builds a batch against the wrong interface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MORPHO_VAULTS } from "../../../src/railgun/transaction/morpho/vault";

test("no vault is listed twice, by name or by address", () => {
  const addresses = MORPHO_VAULTS.map((v) => v.vaultAddress.toLowerCase());
  const names = MORPHO_VAULTS.map((v) => v.name);
  assert.equal(new Set(addresses).size, addresses.length, "duplicate address");
  assert.equal(new Set(names).size, names.length, "duplicate name");
});

test("every address is a well-formed, checksummable contract address", () => {
  for (const vault of MORPHO_VAULTS) {
    assert.match(
      vault.vaultAddress,
      /^0x[0-9a-fA-F]{40}$/,
      `${vault.name} has a malformed address`,
    );
  }
});

test("every vault declares a generation, because it picks the recipe", () => {
  for (const vault of MORPHO_VAULTS) {
    assert.ok(
      vault.generation === "V1" || vault.generation === "V2",
      `${vault.name} has no generation`,
    );
  }
});

test("the list covers more than one asset", () => {
  // The whole point of expanding it: a wallet holding ETH or WBTC had nothing
  // to use when both vaults were USDC.
  const assets = MORPHO_VAULTS.map((v) => v.name.replace(/^.*\s/, ""));
  assert.ok(new Set(assets).size >= 3, `only covers ${[...new Set(assets)].join(", ")}`);
});

test("the thin vaults are deliberately absent", () => {
  // DAI and wstETH vaults exist but hold around $1M, which is not enough to be
  // confident a redemption comes back out. Absent on purpose, not forgotten.
  const names = MORPHO_VAULTS.map((v) => v.name.toLowerCase()).join(" ");
  assert.ok(!names.includes("dai"), "a DAI vault was added without re-checking liquidity");
  assert.ok(!names.includes("wsteth"), "a wstETH vault was added without re-checking liquidity");
});
