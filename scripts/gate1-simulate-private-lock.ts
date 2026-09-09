import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getLockBalanceInstruction } from "../clients/ts/src/generated/instructions/lockBalance.ts";
import { DELEGATION_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./gate1-simulate-delegation.ts";
import { AUTHORITY, deriveAddresses } from "./gate1-simulate.ts";

const BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const PRIVATE_ER_RPC_URL = "https://devnet-tee.magicblock.app" as const;
const LOCK_AMOUNT = 250_000n;
const EXPECTED_VAULT_AMOUNT = 1_000_000n;

const baseRpc = createSolanaRpc(BASE_RPC_URL);
const privateRpc = createSolanaRpc(PRIVATE_ER_RPC_URL);
const signer = createNoopSigner(AUTHORITY);

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") {
    throw new Error(`Unexpected account encoding: ${data[1]}`);
  }
  return Buffer.from(data[0], "base64");
}

function tokenAmount(data: Uint8Array): bigint {
  if (data.length !== 165) {
    throw new Error(`Expected a 165-byte SPL Token account, received ${data.length}`);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

const addresses = await deriveAddresses();
const baseState = await baseRpc
  .getMultipleAccounts(
    [addresses.deposit, addresses.permission, addresses.vaultUsdcAta],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [baseDeposit, basePermission, vaultAta] = baseState.value;
if (!baseDeposit || !basePermission || !vaultAta) {
  throw new Error("A required delegated base-layer account is missing");
}
if (baseDeposit.owner !== DELEGATION_PROGRAM_ID || basePermission.owner !== DELEGATION_PROGRAM_ID) {
  throw new Error("Permission or Deposit is not delegated");
}
const baseDepositState = getDepositDecoder().decode(accountBytes(baseDeposit.data));
const vaultRawAmount = tokenAmount(accountBytes(vaultAta.data));
if (
  vaultAta.owner !== TOKEN_PROGRAM_ID ||
  baseDepositState.available !== EXPECTED_VAULT_AMOUNT ||
  baseDepositState.locked !== 0n ||
  vaultRawAmount !== EXPECTED_VAULT_AMOUNT
) {
  throw new Error("Delegated base snapshot or vault collateral does not match Gate 1 state");
}

const privateVisibility = await privateRpc
  .getMultipleAccounts(
    [addresses.deposit, addresses.permission],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
if (privateVisibility.value[0] !== null || privateVisibility.value[1] === null) {
  throw new Error("Unauthenticated Private ER visibility does not match the expected access boundary");
}

const instructions = [
  getSetComputeUnitLimitInstruction({ units: 200_000 }),
  getLockBalanceInstruction({
    user: signer,
    deposit: addresses.deposit,
    amount: LOCK_AMOUNT,
  }),
];
const { value: latestBlockhash } = await privateRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayer(AUTHORITY, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions(instructions, current),
);
const transaction = compileTransaction(message);
const wire = getBase64EncodedWireTransaction(transaction);
const serializedTransactionBytes = Buffer.from(wire, "base64").length;
const simulation = await privateRpc
  .simulateTransaction(wire, {
    accounts: { addresses: [addresses.deposit], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: true,
    sigVerify: false,
  })
  .send();

const returnedDeposit = simulation.value.accounts?.[0] ?? null;
const decodedPostState = returnedDeposit
  ? getDepositDecoder().decode(accountBytes(returnedDeposit.data))
  : null;
if (
  simulation.value.err === null &&
  decodedPostState &&
  (decodedPostState.available !== 750_000n || decodedPostState.locked !== LOCK_AMOUNT)
) {
  throw new Error("Private lock simulation returned an unexpected Deposit state");
}

console.log(
  json({
    cluster: "MagicBlock Private ER on Solana Devnet",
    rpcUrl: PRIVATE_ER_RPC_URL,
    feePayer: AUTHORITY,
    signer: AUTHORITY,
    instruction: "lock_balance",
    amount: {
      token: "Circle Devnet USDC internal accounting",
      raw: LOCK_AMOUNT,
      ui: "0.250000 USDC",
    },
    effectIfSent: {
      splTokenMovement: "none",
      publicBaseDepositSnapshot: {
        available: baseDepositState.available,
        locked: baseDepositState.locked,
      },
      privateDepositAfter: decodedPostState
        ? { available: decodedPostState.available, locked: decodedPostState.locked }
        : "redacted from unauthenticated response; expected available=750000, locked=250000",
      vaultRawUsdcBeforeAndAfter: vaultRawAmount,
    },
    accessControlCheck: {
      unauthenticatedDepositRead: "null",
      unauthenticatedPermissionRead: "visible",
    },
    simulation: {
      err: simulation.value.err,
      slot: simulation.context.slot,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      serializedTransactionBytes,
      logs: simulation.value.logs,
      returnedDepositState: decodedPostState,
    },
  }),
);

if (simulation.value.err !== null) {
  process.exitCode = 1;
}
