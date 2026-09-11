import { useEffect, useState } from "react";

export const PAYMENT_RECEIPT_PREFIX = "protected-pay:payment-receipts:";
export const PAYMENT_RECEIPTS_CHANGED = "protected-pay:payment-receipts-changed";
export const MAX_PAYMENT_RECEIPTS = 20;

export type PaymentReceiptAction = "protected" | "undone" | "expired-recovered" | "acknowledged" | "claimed";

export type PaymentReceiptRecord = {
  action: PaymentReceiptAction;
  amount: string;
  counterparty: string;
  memoEnvelope?: string | null;
  occurredAt: number;
  payment: string;
  paymentReference: string;
  privateSignature: string;
  publicSignature: string | null;
  role: "sender" | "recipient";
  version: 1;
  wallet: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MEMO_ENVELOPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ACTIONS = new Set<PaymentReceiptAction>(["protected", "undone", "expired-recovered", "acknowledged", "claimed"]);

export function paymentReceiptKey(wallet: string) {
  return `${PAYMENT_RECEIPT_PREFIX}${wallet}`;
}

function validBase58(value: unknown, minimum = 32, maximum = 88): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && BASE58.test(value);
}

function parseReceipt(value: unknown, wallet: string): PaymentReceiptRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<PaymentReceiptRecord>;
  if (
    item.version !== 1
    || item.wallet !== wallet
    || !ACTIONS.has(item.action as PaymentReceiptAction)
    || (item.role !== "sender" && item.role !== "recipient")
    || typeof item.amount !== "string"
    || !/^\d+$/.test(item.amount)
    || (item.memoEnvelope !== undefined && item.memoEnvelope !== null && (
      typeof item.memoEnvelope !== "string"
      || item.memoEnvelope.length > 2_048
      || !MEMO_ENVELOPE.test(item.memoEnvelope)
    ))
    || !validBase58(item.counterparty)
    || !validBase58(item.payment)
    || !validBase58(item.paymentReference)
    || !validBase58(item.privateSignature, 64)
    || (item.publicSignature !== null && !validBase58(item.publicSignature, 64))
    || typeof item.occurredAt !== "number"
    || !Number.isSafeInteger(item.occurredAt)
    || item.occurredAt <= 0
  ) return null;
  return {
    action: item.action as PaymentReceiptAction,
    amount: item.amount,
    counterparty: item.counterparty,
    memoEnvelope: item.memoEnvelope ?? null,
    occurredAt: item.occurredAt,
    payment: item.payment,
    paymentReference: item.paymentReference,
    privateSignature: item.privateSignature,
    publicSignature: item.publicSignature,
    role: item.role,
    version: 1,
    wallet,
  };
}

export function findLatestRestorableSenderReceipt(receipts: readonly PaymentReceiptRecord[], wallet: string | null) {
  if (!wallet) return null;
  const latestByPayment = new Map<string, PaymentReceiptRecord>();
  for (const receipt of receipts) {
    const current = latestByPayment.get(receipt.paymentReference);
    if (receipt.wallet === wallet && receipt.role === "sender" && (!current || receipt.occurredAt > current.occurredAt)) {
      latestByPayment.set(receipt.paymentReference, receipt);
    }
  }
  let latest: PaymentReceiptRecord | null = null;
  for (const receipt of latestByPayment.values()) {
    if (receipt.action === "protected" && (!latest || receipt.occurredAt > latest.occurredAt)) latest = receipt;
  }
  return latest;
}

export function readPaymentReceipts(wallet: string, storage: StorageLike = window.localStorage) {
  try {
    const raw = storage.getItem(paymentReceiptKey(wallet));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => parseReceipt(item, wallet))
      .filter((item): item is PaymentReceiptRecord => item !== null)
      .sort((left, right) => right.occurredAt - left.occurredAt)
      .slice(0, MAX_PAYMENT_RECEIPTS);
  } catch {
    return [];
  }
}

export function recordPaymentReceipt(
  input: Omit<PaymentReceiptRecord, "version">,
  storage: StorageLike = window.localStorage,
) {
  const receipt = parseReceipt({ ...input, version: 1 }, input.wallet);
  if (!receipt) return false;
  try {
    const existing = readPaymentReceipts(input.wallet, storage).filter(
      (item) => item.privateSignature !== receipt.privateSignature || item.action !== receipt.action,
    );
    storage.setItem(paymentReceiptKey(input.wallet), JSON.stringify([receipt, ...existing].slice(0, MAX_PAYMENT_RECEIPTS)));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PAYMENT_RECEIPTS_CHANGED, { detail: { wallet: input.wallet } }));
    }
    return true;
  } catch {
    return false;
  }
}

export function usePaymentReceipts(wallet: string | null) {
  const [receipts, setReceipts] = useState<PaymentReceiptRecord[]>([]);

  useEffect(() => {
    if (!wallet) {
      setReceipts([]);
      return;
    }
    const refresh = () => setReceipts(readPaymentReceipts(wallet));
    const onChanged = (event: Event) => {
      const changedWallet = (event as CustomEvent<{ wallet?: string }>).detail?.wallet;
      if (!changedWallet || changedWallet === wallet) refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key === paymentReceiptKey(wallet)) refresh();
    };
    refresh();
    window.addEventListener(PAYMENT_RECEIPTS_CHANGED, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PAYMENT_RECEIPTS_CHANGED, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [wallet]);

  return receipts;
}
