import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createClient,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";

import { buildFirstFundingInstructions } from "../src/lib/paymentWorkflow.ts";
import { MAGIC_ROUTER_RPC, SOLANA_DEVNET_RPC } from "../src/lib/constants.ts";

const USER = address("4C2GznkXgEp2EhcXkPyBQh9feYvAkCcN2bWDrGjbkwvR");
const USER_USDC = address("GhVfyTgi5GnNrSUCVY4PPWkLGC52J1cS8vSN3tDd9Eqb");
const AMOUNT = 1_000_000n;

function json(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

const baseRpc = createSolanaRpc(SOLANA_DEVNET_RPC);
const routerRpc = createSolanaRpc(MAGIC_ROUTER_RPC);
const signer = createNoopSigner(USER);
const plan = await buildFirstFundingInstructions(signer, USER, AMOUNT, USER_USDC);
const { value: latestBlockhash } = await baseRpc.getLatestBlockhash({ commitment: "confirmed" }).send();
function transactionWire(instructions: typeof plan.instructions, version: 0 | "legacy" = 0) {
  const message = pipe(
    createTransactionMessage({ version }),
    (current) => setTransactionMessageFeePayer(USER, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

const wire = transactionWire(plan.instructions);
const preparationWire = transactionWire(plan.preparationInstructions);
const legacyPreparationWire = transactionWire(plan.preparationInstructions, "legacy");

async function simulate(label: string, rpc: ReturnType<typeof createSolanaRpc>) {
  try {
    const response = await rpc.simulateTransaction(wire, {
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    }).send();
    return {
      err: response.value.err,
      label,
      logs: response.value.logs,
      returnData: response.value.returnData ?? null,
      unitsConsumed: response.value.unitsConsumed ?? null,
    };
  } catch (error) {
    return {
      error: error instanceof Error
        ? { cause: error.cause, message: error.message, name: error.name, stack: error.stack }
        : String(error),
      label,
    };
  }
}

async function simulatePreparation() {
  async function run(label: string, candidateWire: Base64EncodedWireTransaction) {
    const response = await baseRpc.simulateTransaction(candidateWire, {
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    }).send();
    return {
      err: response.value.err,
      instructionCount: plan.preparationInstructions.length,
      label,
      logs: response.value.logs,
      serializedBytes: Buffer.from(candidateWire, "base64").length,
      unitsConsumed: response.value.unitsConsumed ?? null,
    };
  }
  return Promise.all([
    run("split v0 preparation on Solana Devnet", preparationWire),
    run("split legacy preparation on Solana Devnet", legacyPreparationWire),
  ]);
}

const [base, router] = await Promise.all([
  simulate("Solana Devnet", baseRpc),
  simulate("MagicBlock Router", routerRpc),
]);
const preparation = await simulatePreparation();

async function simulatePlanned(label: string, estimateResourceLimits: boolean) {
  const client = createClient()
    .use(signerPlugin(signer))
    .use(solanaRpc({
      rpcUrl: SOLANA_DEVNET_RPC,
      transactionConfig: { estimateResourceLimits },
    }));
  const planned = await client.planTransaction(plan.instructions);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, planned);
  const plannedWire = getBase64EncodedWireTransaction(compileTransaction(withLifetime));
  try {
    const response = await baseRpc.simulateTransaction(plannedWire, {
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    }).send();
    return {
      err: response.value.err,
      instructionCount: planned.instructions.length,
      label,
      logs: response.value.logs,
      unitsConsumed: response.value.unitsConsumed ?? null,
    };
  } catch (error) {
    return {
      error: error instanceof Error
        ? { cause: error.cause, message: error.message, name: error.name }
        : String(error),
      instructionCount: planned.instructions.length,
      label,
    };
  }
}

const [defaultPlanner, fixedPlanner] = await Promise.all([
  simulatePlanned("default automatic estimation planner", true),
  simulatePlanned("explicit-budget planner", false),
]);

console.log(json({
  amount: AMOUNT,
  deposit: plan.deposit,
  instructionCount: plan.instructions.length,
  permission: plan.permission,
  recipient: USER,
  serializedBytes: Buffer.from(wire, "base64").length,
  plannerSimulations: [defaultPlanner, fixedPlanner],
  simulations: [...preparation, base, router],
  userTokenAccount: plan.userTokenAccount,
}));
