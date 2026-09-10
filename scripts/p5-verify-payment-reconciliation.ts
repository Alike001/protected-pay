import { address } from "@solana/kit";
import {
  createPaymentOperationCheckpoint,
  nextPaymentOperationAction,
  validatePaymentOperationCheckpoint,
  type PaymentOperationAction,
  type PaymentOperationCheckpoint,
} from "../src/lib/paymentOperation";

const SENDER = "6Etw8jh5pDdn8ZQp2sD1HtxHf42yM8gXrY8NqFzYcm6P";
const RECIPIENT = "Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ";
const TEST_SIGNATURE = "3aHSwTwad1nTxxGiB8DeEPPETyQkQH5B453HSVKvqej53Mz5P4HXaZHTrCG5WceXQ7484zgkEacUz3rcD2GeZPEG";

function expectAction(
  name: string,
  checkpoint: Pick<PaymentOperationCheckpoint, "privateTransaction" | "publicTransaction">,
  observation: Parameters<typeof nextPaymentOperationAction>[1],
  expected: PaymentOperationAction,
) {
  const actual = nextPaymentOperationAction(checkpoint, observation);
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`);
  return { actual, name };
}

const checkpoint = await createPaymentOperationCheckpoint(SENDER, {
  amount: 1_250_000n,
  memo: "Invoice #184",
  recipient: address(RECIPIENT),
});
await validatePaymentOperationCheckpoint(checkpoint, SENDER);

const serialized = JSON.stringify(checkpoint);
if (serialized.includes("Invoice #184")) throw new Error("The recovery checkpoint leaked the plaintext private note.");
if (!checkpoint.memoEnvelope || checkpoint.memoHash.length !== 64) throw new Error("The private note was not retained safely.");

const publicPending = {
  ...checkpoint,
  publicTransaction: { lastValidBlockHeight: "500", signature: TEST_SIGNATURE },
};
const privatePending = {
  ...publicPending,
  privateTransaction: { lastValidBlockHeight: "501", signature: TEST_SIGNATURE },
};

const cases = [
  expectAction("fresh draft", checkpoint, { publicExists: false, publicMatches: false, privateInitialized: false, privateMatches: false }, "prepare-public"),
  expectAction("prepared public signature", publicPending, { publicExists: false, publicMatches: false, privateInitialized: false, privateMatches: false }, "wait-public"),
  expectAction("unexpected public account", checkpoint, { publicExists: true, publicMatches: false, privateInitialized: false, privateMatches: false }, "abort"),
  expectAction("delegated shell ready", publicPending, { publicExists: true, publicMatches: true, privateInitialized: false, privateMatches: false }, "open-private"),
  expectAction("prepared private signature", privatePending, { publicExists: true, publicMatches: true, privateInitialized: false, privateMatches: false }, "wait-private"),
  expectAction("matching private payment", privatePending, { publicExists: true, publicMatches: true, privateInitialized: true, privateMatches: true }, "complete"),
  expectAction("mismatched private terms", privatePending, { publicExists: true, publicMatches: true, privateInitialized: true, privateMatches: false }, "abort"),
];

for (const mutation of [
  { ...checkpoint, amount: "0" },
  { ...checkpoint, memoHash: "00" },
  { ...checkpoint, payment: RECIPIENT },
]) {
  let rejected = false;
  try {
    await validatePaymentOperationCheckpoint(mutation, SENDER);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("A malformed recovery checkpoint was accepted.");
}

console.log(JSON.stringify({
  broadcast: false,
  cases,
  checkpointContainsPlaintextMemo: false,
  payment: checkpoint.payment,
  paymentReference: checkpoint.paymentReference,
  signed: false,
  validationTamperCases: 3,
}, null, 2));
