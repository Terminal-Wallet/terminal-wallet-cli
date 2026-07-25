/**
 * Deterministic token fixtures. Real mainnet addresses so tests that touch
 * address formatting / native-token detection behave like production.
 */
export interface TokenFixture {
  address: string;
  symbol: string;
  decimals: number;
}

export const TOKENS = {
  WETH: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    decimals: 18,
  },
  USDC: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    decimals: 6,
  },
  NATIVE: {
    address: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
  },
} satisfies Record<string, TokenFixture>;

/** 1 token unit at the given decimals (e.g. oneUnit(18) === 1e18 wei). */
export const oneUnit = (decimals: number): bigint => 10n ** BigInt(decimals);
