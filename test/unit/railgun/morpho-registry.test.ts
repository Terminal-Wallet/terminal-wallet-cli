/**
 * The vault registry's guarantees, which are all about failure.
 *
 * This reaches a third-party API to decide which vaults a user may send money
 * to, so the questions that matter are what it does when the API is slow,
 * changed, or lying — not what it does when everything works.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import {
  listMorphoVaults,
  resetMorphoVaultCache,
} from "../../../src/railgun/transaction/morpho/vault-registry";
import { MORPHO_VAULTS } from "../../../src/railgun/transaction/morpho/vault";

const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  resetMorphoVaultCache();
  try {
    await run();
  } finally {
    globalThis.fetch = real;
    resetMorphoVaultCache();
  }
};

const json = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const respond = (v1Items: unknown[]) =>
  (async (_url: unknown, init: unknown) => {
    const body = String((init as { body?: string })?.body ?? "");
    return json(
      body.includes("vaultV2s")
        ? { data: { vaultV2s: { items: [] } } }
        : { data: { vaults: { items: v1Items } } },
    );
  }) as unknown as typeof fetch;

test("an unreachable API falls back to the curated list, never to nothing", async () => {
  // An empty picker reads as "this wallet cannot do vaults", which is a lie.
  await withFetch(
    (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch,
    async () => {
      const vaults = await listMorphoVaults(NetworkName.Ethereum);
      assert.deepEqual(
        vaults.map((v) => v.vaultAddress),
        MORPHO_VAULTS.map((v) => v.vaultAddress),
      );
    },
  );
});

test("an HTTP error is a failure, not an empty list", async () => {
  await withFetch(
    (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
    async () => {
      const vaults = await listMorphoVaults(NetworkName.Ethereum);
      assert.ok(vaults.length > 0, "fell through to an empty picker");
    },
  );
});

test("a response whose shape changed falls back rather than offering garbage", async () => {
  await withFetch(
    (async () => json({ data: { somethingElse: true } })) as unknown as typeof fetch,
    async () => {
      const vaults = await listMorphoVaults(NetworkName.Ethereum);
      assert.equal(vaults.length, MORPHO_VAULTS.length);
    },
  );
});

test("a vault carrying a RED warning is never offered", async () => {
  // This is the whole reason an automatic list is defensible.
  const flagged = {
    address: "0x1111111111111111111111111111111111111111",
    name: "Flagged USDC",
    asset: { symbol: "USDC", address: "0xaaa", decimals: 6 },
    state: { totalAssetsUsd: 500_000_000, netApy: 0.9 },
    liquidity: { usd: 500_000_000 },
    warnings: [{ type: "deposit_disabled", level: "RED" }],
  };
  const clean = {
    ...flagged,
    address: "0x2222222222222222222222222222222222222222",
    name: "Clean USDC",
    warnings: [],
  };
  await withFetch(respond([flagged, clean]), async () => {
    const vaults = await listMorphoVaults(NetworkName.Ethereum);
    assert.deepEqual(vaults.map((v) => v.name), ["Clean USDC"]);
  });
});

test("a vault too small to redeem out of is not offered", async () => {
  const tiny = {
    address: "0x3333333333333333333333333333333333333333",
    name: "Tiny USDC",
    asset: { symbol: "USDC", address: "0xaaa", decimals: 6 },
    state: { totalAssetsUsd: 100_000, netApy: 0.5 },
    liquidity: { usd: 1_000 },
    warnings: [],
  };
  await withFetch(respond([tiny]), async () => {
    // Nothing usable came back, so the curated list stands in.
    const vaults = await listMorphoVaults(NetworkName.Ethereum);
    assert.equal(vaults.length, MORPHO_VAULTS.length);
  });
});

test("one asset cannot crowd out the picker", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    address: `0x${String(i).padStart(40, "4")}`,
    name: `USDC Vault ${i}`,
    asset: { symbol: "USDC", address: "0xaaa", decimals: 6 },
    state: { totalAssetsUsd: 100_000_000 - i, netApy: 0.04 },
    liquidity: { usd: 50_000_000 },
    warnings: [],
  }));
  await withFetch(respond(many), async () => {
    const vaults = await listMorphoVaults(NetworkName.Ethereum);
    assert.equal(vaults.length, 3, "should keep only the best few per asset");
    // Already ordered by TVL, so the ones kept are the largest.
    assert.deepEqual(vaults.map((v) => v.name), [
      "USDC Vault 0",
      "USDC Vault 1",
      "USDC Vault 2",
    ]);
  });
});

test("a non-Ethereum network offers nothing rather than mainnet vaults", async () => {
  const vaults = await listMorphoVaults(NetworkName.Polygon);
  assert.deepEqual(vaults, []);
});
