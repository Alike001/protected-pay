import {
  address,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  signature,
  type Address,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { getPaymentDecoder, type Payment } from "../../clients/ts/src/generated/accounts/payment";
import { findDepositPda } from "../../clients/ts/src/generated/pdas/deposit";
import { findPaymentPda } from "../../clients/ts/src/generated/pdas/payment";
import type { AppClient } from "../client";
import type { PrivateClient } from "../hooks/usePrivateBalance";
import { PROGRAM_ID, USDC_MINT } from "./constants";
import { encryptMemoForRecipientLink } from "./memoEnvelope";
import {
  buildProtectedPaymentInstructions,
  type PaymentStage,
  type ProtectedPaymentDraft,
  type ProtectedPaymentReceipt,
} from "./paymentWorkflow";
import { sendPrivateTransaction } from "./sendPrivateTransaction";
import { sendPublicTransaction, type PreparedTransaction } from "./sendPublicTransaction";

const DELEGATION_PROGRAM = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const PAYMENT_BYTES = 245;
const STATE_POLLS = 45;
const MAX_U64 = 18_446_744_073_709_551_615n;

type SavedTransaction = {
  lastValidBlockHeight: string;
  signature: string;
};

export type PaymentOperationCheckpoint = {
  amount: string;
  createdAt: number;
  memoEnvelope: string | null;
  memoHash: string;
  payment: string;
  paymentReference: string;
  privateTransaction?: SavedTransaction;
  publicTransaction?: SavedTransaction;
  recipient: string;
  version: 1;
  wallet: string;
};

type PendingOutcome = "confirmed" | "failed" | "expired" | "pending";

export type PaymentOperationAction =
  | "abort"
  | "complete"
  | "open-private"
  | "prepare-public"
  | "wait-private"
  | "wait-public";

type PaymentObservation = {
  privateInitialized: boolean;
  privateMatches: boolean;
  publicExists: boolean;
  publicMatches: boolean;
};

function bytesToHex(bytes: ReadonlyUint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("The saved private-note commitment is malformed.");
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function equalBytes(left: ReadonlyUint8Array, right: ReadonlyUint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function savedTransaction(prepared: PreparedTransaction): SavedTransaction {
  return { lastValidBlockHeight: prepared.lastValidBlockHeight.toString(), signature: prepared.signature };
}

function accountBytes(data: [string, "base64"] | readonly [string, "base64"]) {
  return getBase64Encoder().encode(data[0]);
}

async function hashMemo(memo: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(memo)));
}

export async function createPaymentOperationCheckpoint(
  wallet: string,
  draft: ProtectedPaymentDraft,
): Promise<PaymentOperationCheckpoint> {
  address(wallet);
  address(draft.recipient);
  if (draft.recipient === wallet) throw new Error("Choose a recipient other than your own wallet.");
  if (draft.amount <= 0n || draft.amount > MAX_U64) throw new Error("The payment amount is outside the supported range.");
  const paymentId = crypto.getRandomValues(new Uint8Array(32));
  const [payment] = await findPaymentPda({ paymentId });
  const [memoHash, memoEnvelope] = await Promise.all([
    hashMemo(draft.memo),
    encryptMemoForRecipientLink(draft.memo),
  ]);
  return {
    amount: draft.amount.toString(),
    createdAt: Date.now(),
    memoEnvelope,
    memoHash: bytesToHex(memoHash),
    payment,
    paymentReference: getBase58Decoder().decode(paymentId),
    recipient: draft.recipient,
    version: 1,
    wallet,
  };
}

export async function validatePaymentOperationCheckpoint(
  value: unknown,
  wallet: string,
): Promise<PaymentOperationCheckpoint> {
  if (!value || typeof value !== "object") throw new Error("The saved payment operation is malformed.");
  const candidate = value as Partial<PaymentOperationCheckpoint>;
  if (
    candidate.version !== 1 || candidate.wallet !== wallet ||
    typeof candidate.recipient !== "string" || typeof candidate.amount !== "string" ||
    typeof candidate.paymentReference !== "string" || typeof candidate.payment !== "string" ||
    typeof candidate.memoHash !== "string" || typeof candidate.createdAt !== "number" ||
    (candidate.memoEnvelope !== null && typeof candidate.memoEnvelope !== "string")
  ) throw new Error("The saved payment operation does not match this wallet.");
  address(candidate.wallet);
  address(candidate.recipient);
  address(candidate.payment);
  if (candidate.recipient === wallet) throw new Error("The saved payment recipient is invalid.");
  const amount = BigInt(candidate.amount);
  if (amount <= 0n || amount > MAX_U64) throw new Error("The saved payment amount is invalid.");
  const paymentId = getBase58Encoder().encode(candidate.paymentReference);
  if (paymentId.length !== 32) throw new Error("The saved payment reference is malformed.");
  const [derivedPayment] = await findPaymentPda({ paymentId });
  if (derivedPayment !== candidate.payment) throw new Error("The saved payment address does not match its reference.");
  hexToBytes(candidate.memoHash);
  for (const transaction of [candidate.publicTransaction, candidate.privateTransaction]) {
    if (transaction && (typeof transaction.signature !== "string" || typeof transaction.lastValidBlockHeight !== "string")) {
      throw new Error("The saved payment transaction checkpoint is malformed.");
    }
    if (transaction) {
      signature(transaction.signature);
      if (BigInt(transaction.lastValidBlockHeight) < 0n) throw new Error("The saved payment transaction lifetime is malformed.");
    }
  }
  return candidate as PaymentOperationCheckpoint;
}

export function nextPaymentOperationAction(
  checkpoint: Pick<PaymentOperationCheckpoint, "privateTransaction" | "publicTransaction">,
  observation: PaymentObservation,
): PaymentOperationAction {
  if (observation.publicExists && !observation.publicMatches) return "abort";
  if (!observation.publicExists) return checkpoint.publicTransaction ? "wait-public" : "prepare-public";
  if (observation.privateInitialized) return observation.privateMatches ? "complete" : "abort";
  return checkpoint.privateTransaction ? "wait-private" : "open-private";
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

function matchesPayment(
  payment: Payment,
  checkpoint: PaymentOperationCheckpoint,
  paymentId: ReadonlyUint8Array,
  requirePrivateTerms: boolean,
) {
  if (
    !equalBytes(payment.paymentId, paymentId) || payment.sender !== checkpoint.wallet ||
    payment.recipient !== checkpoint.recipient || payment.tokenMint !== USDC_MINT
  ) return false;
  if (!requirePrivateTerms) return true;
  return payment.amount === BigInt(checkpoint.amount) && equalBytes(payment.memoHash, hexToBytes(checkpoint.memoHash));
}

async function readPublicPayment(
  client: AppClient,
  paymentAddress: Address,
  checkpoint: PaymentOperationCheckpoint,
  paymentId: ReadonlyUint8Array,
) {
  const response = await client.rpc.getAccountInfo(paymentAddress, { commitment: "finalized", encoding: "base64" }).send();
  if (!response.value) return null;
  if (response.value.owner !== PROGRAM_ID && response.value.owner !== DELEGATION_PROGRAM) {
    throw new Error("The prepared payment has an unexpected public owner.");
  }
  const bytes = accountBytes((response.value as typeof response.value & { data: [string, "base64"] }).data);
  if (bytes.length !== PAYMENT_BYTES) throw new Error("The prepared payment has an unexpected public layout.");
  const decoded = getPaymentDecoder().decode(bytes);
  if (!matchesPayment(decoded, checkpoint, paymentId, false)) {
    throw new Error("The prepared payment does not match the saved sender and recipient.");
  }
  return decoded;
}

async function readPrivatePayment(
  client: PrivateClient,
  paymentAddress: Address,
  checkpoint: PaymentOperationCheckpoint,
  paymentId: ReadonlyUint8Array,
) {
  const response = await client.rpc.getAccountInfo(paymentAddress, { commitment: "confirmed", encoding: "base64" }).send();
  if (!response.value) return null;
  if (response.value.owner !== PROGRAM_ID) throw new Error("The private payment has an unexpected owner.");
  const bytes = accountBytes((response.value as typeof response.value & { data: [string, "base64"] }).data);
  if (bytes.length !== PAYMENT_BYTES) throw new Error("The private payment has an unexpected layout.");
  const decoded = getPaymentDecoder().decode(bytes);
  if (!matchesPayment(decoded, checkpoint, paymentId, decoded.initialized)) {
    throw new Error("The private payment does not match the reviewed operation.");
  }
  return decoded;
}

async function waitForPublicPayment(
  client: AppClient,
  paymentAddress: Address,
  checkpoint: PaymentOperationCheckpoint,
  paymentId: ReadonlyUint8Array,
) {
  for (let poll = 0; poll < STATE_POLLS; poll += 1) {
    const payment = await readPublicPayment(client, paymentAddress, checkpoint, paymentId);
    if (payment) return payment;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error("Payment preparation is confirmed but its delegated shell is still reconciling. Retry safely; it will not be created twice.");
}

async function waitForPrivatePayment(
  client: PrivateClient,
  paymentAddress: Address,
  checkpoint: PaymentOperationCheckpoint,
  paymentId: ReadonlyUint8Array,
) {
  for (let poll = 0; poll < STATE_POLLS; poll += 1) {
    const payment = await readPrivatePayment(client, paymentAddress, checkpoint, paymentId);
    if (payment?.initialized) return payment;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error("The private transaction is confirmed but payment state is still reconciling. Retry safely; funds will not be locked twice.");
}

export async function runPaymentOperation(
  publicClient: AppClient,
  privateClient: PrivateClient,
  transactionSigner: TransactionSigner,
  input: PaymentOperationCheckpoint,
  onCheckpoint: (checkpoint: PaymentOperationCheckpoint) => void,
  onStage: (stage: PaymentStage) => void,
  onBeforeTransaction?: () => void,
): Promise<ProtectedPaymentReceipt> {
  let checkpoint = await validatePaymentOperationCheckpoint(input, transactionSigner.address);
  const paymentId = getBase58Encoder().encode(checkpoint.paymentReference);
  const paymentAddress = address(checkpoint.payment);
  const sender = address(checkpoint.wallet);
  const draft = {
    amount: BigInt(checkpoint.amount),
    memo: "",
    recipient: address(checkpoint.recipient),
  } satisfies ProtectedPaymentDraft;
  const identity = { memoHash: hexToBytes(checkpoint.memoHash), paymentId };
  const update = (change: Partial<PaymentOperationCheckpoint>) => {
    checkpoint = { ...checkpoint, ...change };
    onCheckpoint(checkpoint);
  };

  onStage("reconciling");
  if (checkpoint.publicTransaction) {
    const outcome = await publicPendingOutcome(publicClient, checkpoint.publicTransaction);
    if (outcome === "pending") throw new Error("Payment preparation is still pending. Protected Pay will not send it again.");
    if (outcome === "failed" || outcome === "expired") {
      const existing = await readPublicPayment(publicClient, paymentAddress, checkpoint, paymentId);
      if (!existing) update({ publicTransaction: undefined });
    }
  }

  let publicPayment = await readPublicPayment(publicClient, paymentAddress, checkpoint, paymentId);
  if (!publicPayment) {
    if (checkpoint.publicTransaction) {
      publicPayment = await waitForPublicPayment(publicClient, paymentAddress, checkpoint, paymentId);
    } else {
      const [recipientDeposit] = await findDepositPda({ user: draft.recipient, tokenMint: address(USDC_MINT) });
      const recipientState = await publicClient.rpc.getAccountInfo(recipientDeposit, { commitment: "finalized" }).send();
      const plan = await buildProtectedPaymentInstructions(
        transactionSigner,
        sender,
        draft,
        recipientState.value === null,
        identity,
      );
      if (plan.payment !== paymentAddress) throw new Error("The payment builder changed the saved payment identity.");
      onStage("preparing");
      onBeforeTransaction?.();
      await sendPublicTransaction(publicClient, transactionSigner, plan.publicInstructions, (prepared) => {
        onBeforeTransaction?.();
        update({ publicTransaction: savedTransaction(prepared) });
      });
      publicPayment = await waitForPublicPayment(publicClient, paymentAddress, checkpoint, paymentId);
    }
  }

  if (!matchesPayment(publicPayment, checkpoint, paymentId, false)) {
    throw new Error("The public payment shell does not match the reviewed payment.");
  }

  let privatePayment = await readPrivatePayment(privateClient, paymentAddress, checkpoint, paymentId);
  if (privatePayment?.initialized) {
    onStage("confirmed");
    return receiptFromCheckpoint(checkpoint);
  }

  if (checkpoint.privateTransaction) {
    const outcome = await privatePendingOutcome(privateClient, checkpoint.privateTransaction);
    if (outcome === "pending") throw new Error("Payment protection is still pending. Protected Pay will not send it again.");
    if (outcome === "confirmed") {
      await waitForPrivatePayment(privateClient, paymentAddress, checkpoint, paymentId);
      onStage("confirmed");
      return receiptFromCheckpoint(checkpoint);
    }
    privatePayment = await readPrivatePayment(privateClient, paymentAddress, checkpoint, paymentId);
    if (privatePayment?.initialized) {
      onStage("confirmed");
      return receiptFromCheckpoint(checkpoint);
    }
    update({ privateTransaction: undefined });
  }

  const plan = await buildProtectedPaymentInstructions(transactionSigner, sender, draft, false, identity, privateClient);
  onStage("opening");
  onBeforeTransaction?.();
  await sendPrivateTransaction(privateClient, plan.privateInstructions, (prepared) => {
    onBeforeTransaction?.();
    update({ privateTransaction: savedTransaction(prepared) });
  });
  await waitForPrivatePayment(privateClient, paymentAddress, checkpoint, paymentId);
  onStage("confirmed");
  return receiptFromCheckpoint(checkpoint);
}

function receiptFromCheckpoint(checkpoint: PaymentOperationCheckpoint): ProtectedPaymentReceipt {
  if (!checkpoint.publicTransaction || !checkpoint.privateTransaction) {
    throw new Error("The payment reached private state without both saved transaction receipts.");
  }
  return {
    memoEnvelope: checkpoint.memoEnvelope,
    payment: address(checkpoint.payment),
    paymentId: getBase58Encoder().encode(checkpoint.paymentReference),
    paymentReference: checkpoint.paymentReference,
    privateSignature: checkpoint.privateTransaction.signature,
    publicSignature: checkpoint.publicTransaction.signature,
  };
}
