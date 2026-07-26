/**
 * The clear-signing breakdown.
 *
 * This is what the user reads before approving a spend, and the review modal
 * reuses it verbatim, so a wrong figure here is approved rather than caught.
 * Worth asserting case by case — particularly the ones that are easy to get
 * quietly wrong: which protocol fee applies to which verb, and what happens
 * when a price or an amount is not yet known.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import {
  amountLines,
  protocolFeeLines,
  BuilderView,
} from "../../../src/tui/format/builder-detail";
import { RailgunDisplayBalance } from "../../../src/models/balance-models";

const token = (
  symbol: string,
  held: string,
  decimals = 18,
  address = `0x${symbol.toLowerCase()}`,
): RailgunDisplayBalance =>
  ({
    symbol,
    name: symbol,
    tokenAddress: address,
    decimals,
    amount: parseUnits(held, decimals),
  }) as RailgunDisplayBalance;

const view = (over: Partial<BuilderView> = {}): BuilderView => ({
  verb: "Send",
  legs: [],
  prices: {},
  ...over,
});

// 0.25% out of the 1e9 denominator
const BP = { shield: 2_500_000n, unshield: 2_500_000n };

test("shows the amount, the symbol and the balance impact", () => {
  const { lines } = amountLines(
    view({ legs: [{ token: token("ETH", "2.5"), amount: "1.25" }] }),
  );
  const text = lines.join("\n");
  assert.match(text, /1\.25/);
  assert.match(text, /ETH/);
  // The impact line is what catches a misplaced decimal point.
  assert.match(text, /reduces ETH/);
  assert.match(text, /50\.0%/);
});

test("spending nearly everything reads as nearly everything", () => {
  const { lines } = amountLines(
    view({ legs: [{ token: token("ETH", "2.5"), amount: "2.4" }] }),
  );
  assert.match(lines.join("\n"), /96\.0%/);
});

test("an unparseable amount degrades rather than throwing", () => {
  // Amounts are re-rendered per keystroke, so mid-edit garbage is normal.
  assert.doesNotThrow(() =>
    amountLines(view({ legs: [{ token: token("ETH", "1"), amount: "1.2.3" }] })),
  );
});

test("USD is omitted when no price is known, not shown as zero", () => {
  const { lines, haveUsd } = amountLines(
    view({ legs: [{ token: token("ETH", "2"), amount: "1" }] }),
  );
  assert.equal(haveUsd, false);
  assert.ok(!lines.join("\n").includes("$"), "showed a USD figure without a price");
});

test("USD totals across legs when prices are known", () => {
  const eth = token("ETH", "10");
  const { usd, haveUsd } = amountLines(
    view({
      legs: [
        { token: eth, amount: "1" },
        { token: eth, amount: "2" },
      ],
      prices: { [eth.tokenAddress]: 100 },
    }),
  );
  assert.equal(haveUsd, true);
  assert.equal(Math.round(usd), 300);
});

test("a recipient is shown, and an empty one is marked rather than blank", () => {
  const withTo = amountLines(
    view({
      legs: [
        { token: token("ETH", "2"), amount: "1", recipient: "0x1234567890abcdef1234" },
      ],
    }),
  );
  assert.match(withTo.lines.join("\n"), /→/);

  const without = amountLines(
    view({ legs: [{ token: token("ETH", "2"), amount: "1", recipient: "" }] }),
  );
  assert.match(without.lines.join("\n"), /→ —/);
});

test("a shield is charged the shield fee, an unshield the unshield fee", () => {
  const legs = [{ token: token("ETH", "10"), amount: "1" }];
  const shield = protocolFeeLines(view({ verb: "Shield", legs, feeBasisPoints: BP }));
  assert.match(shield.lines.join("\n"), /shield fee/);

  const unshield = protocolFeeLines(view({ verb: "Unshield", legs, feeBasisPoints: BP }));
  assert.match(unshield.lines.join("\n"), /unshield fee/);
});

test("a plain send is charged no protocol fee", () => {
  const { lines } = protocolFeeLines(
    view({
      verb: "Send",
      legs: [{ token: token("ETH", "10"), amount: "1" }],
      feeBasisPoints: BP,
    }),
  );
  assert.deepEqual(lines, []);
});

test("a private swap is charged on both sides, but only quotes the known one", () => {
  // The unshield fee is exact — the sell amount is known. The shield fee is not,
  // because the buy amount only exists once the quote executes, so it shows the
  // rate. Printing a figure there would be printing a guess.
  const { lines } = protocolFeeLines(
    view({
      verb: "Swap",
      flowId: "private-swap",
      legs: [{ token: token("ETH", "10"), amount: "1" }],
      buyToken: token("USDC", "0", 6),
      feeBasisPoints: BP,
    }),
  );
  const text = lines.join("\n");
  assert.match(text, /unshield fee/);
  assert.match(text, /shield fee\s+~0\.25%/);
  assert.match(text, /USDC out/);
});

test("no fee rates means no fee lines, not a zero fee", () => {
  const { lines, usd } = protocolFeeLines(
    view({ verb: "Shield", legs: [{ token: token("ETH", "10"), amount: "1" }] }),
  );
  assert.deepEqual(lines, []);
  assert.equal(usd, 0);
});

test("the protocol fee is 0.25% of the amount, per token", () => {
  const eth = token("ETH", "10");
  const { usd } = protocolFeeLines(
    view({
      verb: "Shield",
      legs: [{ token: eth, amount: "100" }],
      prices: { [eth.tokenAddress]: 10 },
      feeBasisPoints: BP,
    }),
  );
  // 0.25% of 100 tokens = 0.25 tokens, at $10 = $2.50
  assert.ok(Math.abs(usd - 2.5) < 0.001, `expected ~2.50, got ${usd}`);
});
