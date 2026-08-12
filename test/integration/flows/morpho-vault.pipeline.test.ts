/**
 * A vault build carried through the generic cross-contract rail.
 *
 * The point is that no vault-specific pipeline exists: the recipe's output is
 * reduced to CrossContractInputs and the SAME runner the 0x swap uses takes it
 * from there. What is asserted is that the recipe's own gas floor survives the
 * trip — the wallet's no-floor default would let the batch run out of gas after
 * the proof — and that the flow is labelled as a vault action rather than
 * inheriting the swap's identity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import {
  MorphoVaultV1DepositRecipe,
  RecipeInput,
  makeEphemeralExecutor,
} from "@railgun-community/cookbook";
import { runTransaction } from "../../../src/flows/run";
import { CrossContractSpec } from "../../../src/flows/deps/cross-contract";
import { CrossContractInputs } from "../../../src/railgun/transaction/cross-contract";
import { RailgunTransaction } from "../../../src/models/transaction-models";
import { useRelayAdapt, isEphemeral7702 } from "../../../src/flows/spec";
import { requiresProof, requires7702Broadcaster } from "../../../src/flows/caps";
import {
  SELECTOR,
  UNGATED_VAULT,
  collectEvents,
  crossContractSpec,
  encode,
  makeCrossContractRunDeps,
  makeFakeProvider,
  primeRailgunFees,
  privateGasEstimate,
  privateRecipient,
  TOKENS,
} from "../../_support";

const VAULT = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB";
const EXECUTOR = "0x1234567890AbcdEF1234567890aBcdef12345678";

/** The same reduction the wallet performs, over a genuinely built recipe. */
const buildDepositInputs = async (): Promise<CrossContractInputs> => {
  primeRailgunFees();
  const { provider } = makeFakeProvider({
    ...UNGATED_VAULT,
    [`${VAULT}:${SELECTOR.asset}`]: encode(["address"], [TOKENS.USDC.address]),
    [`${VAULT}:${SELECTOR.decimals}`]: encode(["uint8"], [18]),
    [`${TOKENS.USDC.address}:${SELECTOR.decimals}`]: encode(["uint8"], [6]),
    [`${VAULT}:${SELECTOR.previewDeposit}`]: encode(["uint256"], [10n ** 21n]),
  });
  const recipe = new MorphoVaultV1DepositRecipe(
    VAULT,
    100n,
    makeEphemeralExecutor(EXECUTOR),
    provider,
  );
  const input: RecipeInput = {
    networkName: NetworkName.Ethereum,
    railgunAddress: privateRecipient,
    erc20Amounts: [
      {
        tokenAddress: TOKENS.USDC.address,
        decimals: BigInt(TOKENS.USDC.decimals),
        amount: 1_000_000_000n,
      },
    ],
    nfts: [],
  };
  const output = await recipe.getRecipeOutput(input);
  return {
    relayAdaptUnshieldERC20Amounts: input.erc20Amounts,
    relayAdaptShieldERC20Addresses: output.erc20AmountRecipients.map(
      ({ tokenAddress }) => ({
        tokenAddress,
        recipientAddress: privateRecipient,
      }),
    ),
    crossContractCalls: output.crossContractCalls,
    minGasLimit: output.minGasLimit,
  };
};

test("a vault deposit reduces to cross-contract inputs that keep the recipe's floor", async () => {
  const inputs = await buildDepositInputs();
  assert.ok(inputs.crossContractCalls.length > 0);
  assert.equal(inputs.minGasLimit, 2_900_000n);
  assert.ok(
    inputs.relayAdaptShieldERC20Addresses.some(
      (r) => r.tokenAddress.toLowerCase() === VAULT.toLowerCase(),
    ),
    "the shares are shielded back",
  );
  assert.ok(
    inputs.relayAdaptShieldERC20Addresses.every(
      (r) => r.recipientAddress === privateRecipient,
    ),
    "everything comes back to this wallet",
  );
});

test("vault pipeline: estimate→prove(progress)→send drives through runTransaction", async () => {
  const inputs = await buildDepositInputs();
  const spec = crossContractSpec({
    type: RailgunTransaction.MorphoVaultDeposit,
    inputs,
  });
  const { emit, phases, result } = collectEvents();

  let estimated: CrossContractSpec | undefined;
  const out = await runTransaction(
    spec,
    makeCrossContractRunDeps({
      estimateGas: async (s) => {
        estimated = s;
        return privateGasEstimate();
      },
    }),
    emit,
  );

  assert.equal(out.ok, true);
  assert.deepEqual(phases(), ["estimate", "prove", "prove", "prove", "send"]);
  assert.equal(estimated?.type, RailgunTransaction.MorphoVaultDeposit);
  assert.equal(estimated?.inputs.minGasLimit, 2_900_000n);
  assert.ok(result()?.hash);
});

test("both vault directions are relay-adapt 7702 flows that a broadcaster can carry", () => {
  for (const type of [
    RailgunTransaction.MorphoVaultDeposit,
    RailgunTransaction.MorphoVaultRedeem,
  ]) {
    assert.equal(useRelayAdapt(type), true, `${type} relay-adapt`);
    assert.equal(isEphemeral7702(type), true, `${type} 7702`);
    assert.equal(requiresProof(type), true, `${type} proof`);
    assert.equal(
      requires7702Broadcaster(type),
      true,
      `${type} needs a 7702-capable broadcaster`,
    );
  }
});
