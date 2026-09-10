import { address } from "@solana/kit";
import {
  acquirePaymentOperationLease,
  getPaymentTabId,
  paymentOperationOwnedElsewhere,
  readPaymentOperation,
  refreshPaymentOperationLease,
  releasePaymentOperationLease,
  writePaymentOperation,
} from "../src/lib/paymentCheckpointStorage";
import { createPaymentOperationCheckpoint } from "../src/lib/paymentOperation";
import { workflowIssueFrom } from "../src/lib/workflowIssue";
import { assertCanProtectPayment } from "../src/lib/privateBalanceGuard";

const SENDER = "6Etw8jh5pDdn8ZQp2sD1HtxHf42yM8gXrY8NqFzYcm6P";
const RECIPIENT = "Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ";

class MemoryStorage {
  #values = new Map<string, string>();
  getItem(key: string) { return this.#values.get(key) ?? null; }
  removeItem(key: string) { this.#values.delete(key); }
  setItem(key: string, value: string) { this.#values.set(key, value); }
}

function expectKind(error: unknown, expected: ReturnType<typeof workflowIssueFrom>["kind"]) {
  const issue = workflowIssueFrom(error);
  if (issue.kind !== expected) throw new Error(`Expected ${expected}, received ${issue.kind}.`);
  return { kind: issue.kind, retryLabel: issue.retryLabel };
}

const issueCases = [
  expectKind(Object.assign(new Error("User rejected the request"), { code: 4001 }), "signature-rejected"),
  expectKind(new Error("Payment preparation is still pending. Protected Pay will not send it again."), "confirmation-delayed"),
  expectKind(new Error("Connect a wallet before unlocking private state."), "wallet-disconnected"),
  expectKind(new Error("401: private session token expired"), "authentication-expired"),
  expectKind(new Error("Failed to fetch"), "network"),
  expectKind(new Error("Set up your protected balance before sending a payment."), "funding-required"),
  expectKind(new Error("The payment amount exceeds your available protected balance."), "insufficient-balance"),
];

let missingBalanceBlocked = false;
try {
  assertCanProtectPayment({ available: 0n, exists: false, paused: false }, 10_000n);
} catch {
  missingBalanceBlocked = true;
}
if (!missingBalanceBlocked) throw new Error("A missing protected balance reached the transaction path.");

let insufficientBalanceBlocked = false;
try {
  assertCanProtectPayment({ available: 9_999n, exists: true, paused: false }, 10_000n);
} catch {
  insufficientBalanceBlocked = true;
}
if (!insufficientBalanceBlocked) throw new Error("An underfunded protected balance reached the transaction path.");
assertCanProtectPayment({ available: 10_000n, exists: true, paused: false }, 10_000n);

const storage = new MemoryStorage();
if (getPaymentTabId() === getPaymentTabId()) throw new Error("Two browser documents received the same payment tab identity.");
const checkpoint = await createPaymentOperationCheckpoint(SENDER, {
  amount: 12_500_000n,
  memo: "Private invoice that must not appear in storage",
  recipient: address(RECIPIENT),
});
writePaymentOperation(SENDER, checkpoint, storage);
const saved = readPaymentOperation(SENDER, storage);
if (!saved) throw new Error("The shared recovery checkpoint was not saved.");
if (saved.includes("Private invoice that must not appear in storage")) throw new Error("Shared recovery storage leaked the plaintext note.");

if (!acquirePaymentOperationLease(SENDER, "tab-a", 1_000, storage)) throw new Error("The first tab could not acquire the payment lease.");
if (acquirePaymentOperationLease(SENDER, "tab-b", 1_001, storage)) throw new Error("A second tab acquired an active payment lease.");
if (!paymentOperationOwnedElsewhere(SENDER, "tab-b", 1_002, storage)) throw new Error("The second tab did not detect active ownership.");
if (!refreshPaymentOperationLease(SENDER, "tab-a", 2_000, storage)) throw new Error("The active tab could not refresh its lease.");
releasePaymentOperationLease(SENDER, "tab-b", storage);
if (!paymentOperationOwnedElsewhere(SENDER, "tab-b", 2_001, storage)) throw new Error("A non-owner released the active lease.");
if (!acquirePaymentOperationLease(SENDER, "tab-b", 122_001, storage)) throw new Error("A stale payment lease could not be recovered by another tab.");
releasePaymentOperationLease(SENDER, "tab-b", storage);

console.log(JSON.stringify({
  broadcast: false,
  checkpointContainsPlaintextMemo: false,
  crossTab: {
    activeTabExclusion: true,
    exactCheckpointShared: true,
    staleLeaseRecovery: true,
  },
  privateBalancePreflight: {
    exactAvailableBalanceAccepted: true,
    insufficientBalanceBlocked,
    missingBalanceBlocked,
  },
  issueCases,
  signed: false,
}, null, 2));
