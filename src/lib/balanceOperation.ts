import { address, getAddressDecoder, getBase64Encoder, signature, type Address, type TransactionSigner } from "@solana/kit";
import { getDepositDecoder } from "../../clients/ts/src/generated/accounts/deposit";
import { findDepositPda } from "../../clients/ts/src/generated/pdas/deposit";
import type { AppClient } from "../client";
import type { PrivateClient } from "../hooks/usePrivateBalance";
import { PROGRAM_ID, USDC_MINT } from "./constants";
import { buildBalanceMutationInstructions, buildBalanceReturnInstructions } from "./paymentWorkflow";
import { sendPrivateTransaction } from "./sendPrivateTransaction";
import { sendPublicTransaction, type PreparedTransaction } from "./sendPublicTransaction";

const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const DEPOSIT_BYTES = 98;
const TOKEN_ACCOUNT_BYTES = 165;
const MAX_U64 = 18_446_744_073_709_551_615n;
const STATE_POLLS = 45;

export type BalanceOperationKind = "deposit" | "withdraw";
export type BalanceOperationStage = "reconciling" | "returning" | "waiting-return" | "mutating" | "waiting-private" | "complete";

type SavedTransaction = {
  lastValidBlockHeight: string;
  signature: string;
};

export type BalanceOperationCheckpoint = {
  amount: string;
  createdAt: number;
  expectedAvailable: string;
  kind: BalanceOperationKind;
  mutationTransaction?: SavedTransaction;
  returnTransaction?: SavedTransaction;
  startAvailable: string;
  version: 1;
  wallet: string;
};

type DepositState = {
  available: bigint;
  locked: bigint;
  owner: string;
};

type PendingOutcome = "confirmed" | "failed" | "expired" | "pending";
export type BalanceOperationAction = "abort" | "complete" | "mutate" | "return" | "wait-mutation" | "wait-private" | "wait-return";

function savedTransaction(prepared: PreparedTransaction): SavedTransaction {
  return { lastValidBlockHeight: prepared.lastValidBlockHeight.toString(), signature: prepared.signature };
}

function accountBytes(data: [string, "base64"] | readonly [string, "base64"]) {
  return getBase64Encoder().encode(data[0]);
}

function decodeDeposit(
  account: { data: [string, "base64"] | readonly [string, "base64"]; owner: string },
  wallet: string,
  expectedOwner: string,
): DepositState {
  const bytes = accountBytes(account.data);
  if (account.owner !== expectedOwner || bytes.length !== DEPOSIT_BYTES) {
    throw new Error("The protected balance account failed its owner or layout check.");
  }
  const decoded = getDepositDecoder().decode(bytes);
  if (decoded.user !== wallet || decoded.tokenMint !== USDC_MINT || decoded.version !== 1) {
    throw new Error("The protected balance account does not belong to this wallet and mint.");
  }
  return { available: decoded.available, locked: decoded.locked, owner: account.owner };
}

export function createBalanceOperationCheckpoint(
  wallet: string,
  kind: BalanceOperationKind,
  amount: bigint,
  startAvailable: bigint,
): BalanceOperationCheckpoint {
  if (amount <= 0n) throw new Error("Balance change amount must be greater than zero.");
  const expectedAvailable = kind === "deposit" ? startAvailable + amount : startAvailable - amount;
  if (expectedAvailable < 0n) throw new Error("Withdrawal exceeds the protected balance.");
  if (expectedAvailable > MAX_U64) throw new Error("The resulting protected balance exceeds the program limit.");
  return {
    amount: amount.toString(),
    createdAt: Date.now(),
    expectedAvailable: expectedAvailable.toString(),
    kind,
    startAvailable: startAvailable.toString(),
    version: 1,
    wallet,
  };
}

export function validateBalanceOperationCheckpoint(value: unknown, wallet: string): BalanceOperationCheckpoint {
  if (!value || typeof value !== "object") throw new Error("The saved balance operation is malformed.");
  const candidate = value as Partial<BalanceOperationCheckpoint>;
  if (
    candidate.version !== 1 || candidate.wallet !== wallet ||
    (candidate.kind !== "deposit" && candidate.kind !== "withdraw") ||
    typeof candidate.amount !== "string" || typeof candidate.startAvailable !== "string" ||
    typeof candidate.expectedAvailable !== "string" || typeof candidate.createdAt !== "number"
  ) throw new Error("The saved balance operation does not match this wallet.");
  const amount = BigInt(candidate.amount);
  const start = BigInt(candidate.startAvailable);
  const expected = BigInt(candidate.expectedAvailable);
  const rebuilt = createBalanceOperationCheckpoint(wallet, candidate.kind, amount, start);
  if (rebuilt.expectedAvailable !== expected.toString()) throw new Error("The saved balance operation failed its amount check.");
  for (const transaction of [candidate.returnTransaction, candidate.mutationTransaction]) {
    if (transaction && (typeof transaction.signature !== "string" || typeof transaction.lastValidBlockHeight !== "string")) {
      throw new Error("The saved transaction checkpoint is malformed.");
    }
    if (transaction) {
      signature(transaction.signature);
      if (BigInt(transaction.lastValidBlockHeight) < 0n) throw new Error("The saved transaction lifetime is malformed.");
    }
  }
  return candidate as BalanceOperationCheckpoint;
}

export function nextBalanceOperationAction(
  checkpoint: BalanceOperationCheckpoint,
  observation: { owner: string; publicAvailable: bigint; publicLocked: bigint; privateAvailable: bigint | null; privateLocked: bigint | null },
): BalanceOperationAction {
  const start = BigInt(checkpoint.startAvailable);
  const expected = BigInt(checkpoint.expectedAvailable);
  if (observation.owner === DELEGATION_PROGRAM) {
    if (observation.privateAvailable === expected && observation.privateLocked === 0n) return "complete";
    if (checkpoint.mutationTransaction) return "wait-mutation";
    if (checkpoint.returnTransaction) return "wait-return";
    if (observation.privateAvailable === start && observation.privateLocked === 0n) return "return";
    return "abort";
  }
  if (observation.owner === PROGRAM_ID) {
    if (observation.publicAvailable === expected && observation.publicLocked === 0n) return "wait-private";
    if (checkpoint.mutationTransaction) return "wait-mutation";
    if (observation.publicAvailable === start && observation.publicLocked === 0n) return "mutate";
  }
  return "abort";
}

async function publicPendingOutcome(client: AppClient, transaction: SavedTransaction): Promise<PendingOutcome> {
  const response = await client.rpc.getSignatureStatuses([signature(transaction.signature)], { searchTransactionHistory: true }).send();
  const status = response.value[0];
  if (status?.err) return "failed";
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return "confirmed";
  const blockHeight = await client.rpc.getBlockHeight({ commitment: "confirmed" }).send();
  return blockHeight > BigInt(transaction.lastValidBlockHeight) ? "expired" : "pending";
}

async function privatePendingOutcome(client: PrivateClient, transaction: SavedTransaction): Promise<PendingOutcome> {
  const response = await client.rpc.getSignatureStatuses([signature(transaction.signature)], { searchTransactionHistory: true }).send();
  const status = response.value[0];
  if (status?.err) return "failed";
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return "confirmed";
  const blockHeight = await client.rpc.getBlockHeight({ commitment: "confirmed" }).send();
  return blockHeight > BigInt(transaction.lastValidBlockHeight) ? "expired" : "pending";
}

async function readPublicDeposit(client: AppClient, deposit: Address, wallet: string) {
  const response = await client.rpc.getAccountInfo(deposit, { commitment: "finalized", encoding: "base64" }).send();
  if (!response.value) throw new Error("The protected balance account no longer exists.");
  if (response.value.owner !== PROGRAM_ID && response.value.owner !== DELEGATION_PROGRAM) {
    throw new Error("The protected balance has an unexpected public owner.");
  }
  return decodeDeposit(response.value as typeof response.value & { data: [string, "base64"] }, wallet, response.value.owner);
}

async function readPrivateDeposit(client: PrivateClient, deposit: Address, wallet: string) {
  const response = await client.rpc.getAccountInfo(deposit, { commitment: "confirmed", encoding: "base64" }).send();
  if (!response.value) return null;
  return decodeDeposit(response.value as typeof response.value & { data: [string, "base64"] }, wallet, PROGRAM_ID);
}

async function assertTopUpFunds(
  client: AppClient,
  transactionSigner: TransactionSigner,
  wallet: Address,
  amount: bigint,
) {
  const plan = await buildBalanceMutationInstructions(transactionSigner, wallet, amount, "deposit");
  const response = await client.rpc.getAccountInfo(plan.userTokenAccount, { commitment: "finalized", encoding: "base64" }).send();
  if (!response.value || response.value.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
    throw new Error("No Circle Devnet USDC token account was found for this wallet.");
  }
  const bytes = accountBytes((response.value as typeof response.value & { data: [string, "base64"] }).data);
  if (bytes.length !== TOKEN_ACCOUNT_BYTES) throw new Error("The wallet's Devnet USDC token account has an unexpected layout.");
  const mint = getAddressDecoder().decode(bytes.slice(0, 32));
  const owner = getAddressDecoder().decode(bytes.slice(32, 64));
  const tokenAmount = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true);
  if (mint !== USDC_MINT || owner !== wallet) throw new Error("The wallet token account does not match Circle Devnet USDC ownership.");
  if (tokenAmount < amount) throw new Error("The wallet does not hold enough Circle Devnet USDC for this top-up.");
}

async function waitForPublicReturn(client: AppClient, deposit: Address, wallet: string) {
  for (let poll = 0; poll < STATE_POLLS; poll += 1) {
    const state = await readPublicDeposit(client, deposit, wallet);
    if (state.owner === PROGRAM_ID) return state;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error("The private return is confirmed but Solana is still finalizing it. Retry safely in a moment; no USDC movement will be repeated.");
}

async function waitForExpectedPrivate(
  publicClient: AppClient,
  privateClient: PrivateClient,
  deposit: Address,
  wallet: string,
  expected: bigint,
) {
  for (let poll = 0; poll < STATE_POLLS; poll += 1) {
    const publicState = await readPublicDeposit(publicClient, deposit, wallet);
    if (publicState.owner === DELEGATION_PROGRAM) {
      const privateState = await readPrivateDeposit(privateClient, deposit, wallet);
      if (privateState?.available === expected && privateState.locked === 0n) return privateState;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error("The custody transaction is confirmed but the private balance is still reconciling. Retry safely in a moment; the transaction will not be resent.");
}

export async function runBalanceOperation(
  publicClient: AppClient,
  privateClient: PrivateClient,
  transactionSigner: TransactionSigner,
  input: BalanceOperationCheckpoint,
  onCheckpoint: (checkpoint: BalanceOperationCheckpoint) => void,
  onStage: (stage: BalanceOperationStage) => void,
) {
  let checkpoint = validateBalanceOperationCheckpoint(input, transactionSigner.address);
  const wallet = address(checkpoint.wallet);
  const amount = BigInt(checkpoint.amount);
  const expected = BigInt(checkpoint.expectedAvailable);
  const [deposit] = await findDepositPda({ user: wallet, tokenMint: address(USDC_MINT) });
  const update = (change: Partial<BalanceOperationCheckpoint>) => {
    checkpoint = { ...checkpoint, ...change };
    onCheckpoint(checkpoint);
  };

  onStage("reconciling");
  if (checkpoint.kind === "deposit" && !checkpoint.returnTransaction && !checkpoint.mutationTransaction) {
    await assertTopUpFunds(publicClient, transactionSigner, wallet, amount);
  }
  if (checkpoint.mutationTransaction) {
    const outcome = await publicPendingOutcome(publicClient, checkpoint.mutationTransaction);
    if (outcome === "pending") throw new Error("The custody transaction is still pending. Protected Pay will not send it again.");
    if (outcome === "confirmed") {
      onStage("waiting-private");
      await waitForExpectedPrivate(publicClient, privateClient, deposit, checkpoint.wallet, expected);
      onStage("complete");
      return checkpoint;
    }
    update({ mutationTransaction: undefined });
  }

  if (checkpoint.returnTransaction) {
    const outcome = await privatePendingOutcome(privateClient, checkpoint.returnTransaction);
    if (outcome === "pending") throw new Error("The private return transaction is still pending. Protected Pay will not send it again.");
    if (outcome === "failed" || outcome === "expired") update({ returnTransaction: undefined });
  }

  let publicState = await readPublicDeposit(publicClient, deposit, checkpoint.wallet);
  let privateState = publicState.owner === DELEGATION_PROGRAM
    ? await readPrivateDeposit(privateClient, deposit, checkpoint.wallet)
    : null;
  let action = nextBalanceOperationAction(checkpoint, {
    owner: publicState.owner,
    privateAvailable: privateState?.available ?? null,
    privateLocked: privateState?.locked ?? null,
    publicAvailable: publicState.available,
    publicLocked: publicState.locked,
  });
  if (action === "complete") {
    onStage("complete");
    return checkpoint;
  }
  if (action === "wait-mutation" || action === "wait-private") {
    throw new Error("The custody transaction may already have changed the balance. Protected Pay will wait for authoritative private state instead of sending it again.");
  }
  if (publicState.owner === DELEGATION_PROGRAM) {
    if (action === "wait-return") {
      onStage("waiting-return");
      publicState = await waitForPublicReturn(publicClient, deposit, checkpoint.wallet);
    } else if (action === "return") {
      const plan = await buildBalanceReturnInstructions(transactionSigner, wallet);
      onStage("returning");
      await sendPrivateTransaction(privateClient, plan.instructions, (prepared) => update({ returnTransaction: savedTransaction(prepared) }));
      onStage("waiting-return");
      publicState = await waitForPublicReturn(publicClient, deposit, checkpoint.wallet);
    } else {
      throw new Error("The private balance changed after review. Start again with the latest balance.");
    }
  }

  privateState = null;
  action = nextBalanceOperationAction(checkpoint, {
    owner: publicState.owner,
    privateAvailable: null,
    privateLocked: null,
    publicAvailable: publicState.available,
    publicLocked: publicState.locked,
  });
  if (action !== "mutate") {
    throw new Error("The public balance does not match the reviewed operation. No custody transaction was sent.");
  }

  const mutation = await buildBalanceMutationInstructions(transactionSigner, wallet, amount, checkpoint.kind);
  onStage("mutating");
  await sendPublicTransaction(publicClient, transactionSigner, mutation.instructions, (prepared) => update({ mutationTransaction: savedTransaction(prepared) }));
  onStage("waiting-private");
  await waitForExpectedPrivate(publicClient, privateClient, deposit, checkpoint.wallet, expected);
  onStage("complete");
  return checkpoint;
}
