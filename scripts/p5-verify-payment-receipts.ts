import {
  findLatestRestorableSenderReceipt,
  MAX_PAYMENT_RECEIPTS,
  paymentReceiptKey,
  readPaymentReceipts,
  recordPaymentReceipt,
} from "../src/lib/paymentReceiptStorage.ts";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const storage = new MemoryStorage();
const wallet = "4C2GznkXgEp2EhcXkPyBQh9feYvAkCcN2bWDrGjbkwvR";
const payment = "57NP9wnbafbng8rceQbu9bpgdvKGugD5gYP5MnrMTEkF";
const paymentReference = "94g7Y1ApCzMFtNQnidcqu8qwUPGbHAa27zaXrF7qdjwW";
const counterparty = "Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ";
const signature = "4pkb5J1fXUdbhapTnNWwsZNaDTvYW4MRbui3azXqK7aKuLkGjWfrFHEGuvESyBbV8gRE2Dwysg3EciCyReN6p6Kx";
const memoEnvelope = "AAECAw.QkNERQ.RkdISQ";

const unsafeInput = {
  action: "expired-recovered" as const,
  amount: "1000000",
  authToken: "must-not-be-stored",
  counterparty,
  memoEnvelope,
  memo: "plaintext-must-not-be-stored",
  occurredAt: 1_789_106_765_000,
  payment,
  paymentReference,
  privateSignature: signature,
  publicSignature: null,
  role: "sender" as const,
  sessionSigner: "must-not-be-stored",
  wallet,
};

if (!recordPaymentReceipt(unsafeInput, storage)) throw new Error("A valid receipt was rejected");
const serialized = storage.getItem(paymentReceiptKey(wallet)) ?? "";
if (serialized.includes("must-not-be-stored") || serialized.includes("plaintext")) {
  throw new Error("Receipt storage retained a forbidden secret or plaintext note");
}
if (!serialized.includes(memoEnvelope)) throw new Error("Encrypted recipient-link memo envelope was not retained");

if (!recordPaymentReceipt({ ...unsafeInput, occurredAt: unsafeInput.occurredAt + 1 }, storage)) {
  throw new Error("Receipt upsert failed");
}
let receipts = readPaymentReceipts(wallet, storage);
if (receipts.length !== 1 || receipts[0]?.occurredAt !== unsafeInput.occurredAt + 1) {
  throw new Error("Duplicate private receipt was not replaced deterministically");
}

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
for (let index = 0; index < MAX_PAYMENT_RECEIPTS + 5; index += 1) {
  const privateSignature = `${alphabet[index]}${signature.slice(1)}`;
  if (!recordPaymentReceipt({
    action: "protected",
    amount: String(index + 1),
    counterparty,
    occurredAt: unsafeInput.occurredAt + 100 + index,
    payment,
    paymentReference,
    privateSignature,
    publicSignature: signature,
    role: "sender",
    wallet,
  }, storage)) throw new Error(`Valid receipt ${index} was rejected`);
}

receipts = readPaymentReceipts(wallet, storage);
if (receipts.length !== MAX_PAYMENT_RECEIPTS) throw new Error("Receipt history exceeded its bounded length");
if (receipts.some((item, index) => index > 0 && receipts[index - 1]!.occurredAt < item.occurredAt)) {
  throw new Error("Receipt history is not newest-first");
}

const newestProtected = receipts.find((item) => item.action === "protected");
if (!newestProtected || findLatestRestorableSenderReceipt(receipts, wallet)?.privateSignature !== newestProtected.privateSignature) {
  throw new Error("Newest unresolved sender payment was not restorable");
}
if (!recordPaymentReceipt({ ...newestProtected, action: "undone", occurredAt: newestProtected.occurredAt + 1 }, storage)) {
  throw new Error("Terminal receipt was rejected");
}
if (findLatestRestorableSenderReceipt(readPaymentReceipts(wallet, storage), wallet)?.paymentReference === newestProtected.paymentReference) {
  throw new Error("Terminal sender payment was incorrectly restored");
}

storage.setItem(paymentReceiptKey("bad-wallet"), JSON.stringify([{ version: 1, wallet: "bad-wallet", privateSignature: "not base58" }]));
if (readPaymentReceipts("bad-wallet", storage).length !== 0) throw new Error("Malformed receipt was trusted");

console.log(JSON.stringify({
  boundedTo: receipts.length,
  newestFirst: true,
  unresolvedPaymentRestorable: true,
  plaintextMemoStored: false,
  secretsStored: false,
  validatedOnRead: true,
}, null, 2));
