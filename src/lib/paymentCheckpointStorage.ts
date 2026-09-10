import type { PaymentOperationCheckpoint } from "./paymentOperation";

export const PAYMENT_OPERATION_PREFIX = "protected-pay:payment-operation:";
export const PAYMENT_OPERATION_LEASE_PREFIX = "protected-pay:payment-operation-lease:";
export const PAYMENT_LEASE_TTL_MS = 120_000;

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type PaymentOperationLease = {
  owner: string;
  updatedAt: number;
  version: 1;
};

export function paymentOperationKey(wallet: string) {
  return `${PAYMENT_OPERATION_PREFIX}${wallet}`;
}

export function paymentOperationLeaseKey(wallet: string) {
  return `${PAYMENT_OPERATION_LEASE_PREFIX}${wallet}`;
}

export function getPaymentTabId() {
  return crypto.randomUUID();
}

export function readPaymentOperation(wallet: string, storage: StorageLike = window.localStorage) {
  return storage.getItem(paymentOperationKey(wallet));
}

export function writePaymentOperation(
  wallet: string,
  checkpoint: PaymentOperationCheckpoint | null,
  storage: StorageLike = window.localStorage,
) {
  const key = paymentOperationKey(wallet);
  if (checkpoint) storage.setItem(key, JSON.stringify(checkpoint));
  else storage.removeItem(key);
}

export function migratePaymentOperation(wallet: string) {
  const key = paymentOperationKey(wallet);
  const shared = window.localStorage.getItem(key);
  const legacy = window.sessionStorage.getItem(key);
  if (!shared && legacy) window.localStorage.setItem(key, legacy);
  if (legacy) window.sessionStorage.removeItem(key);
  return window.localStorage.getItem(key);
}

export function readPaymentOperationLease(wallet: string, storage: StorageLike = window.localStorage): PaymentOperationLease | null {
  try {
    const raw = storage.getItem(paymentOperationLeaseKey(wallet));
    if (!raw) return null;
    const lease = JSON.parse(raw) as Partial<PaymentOperationLease>;
    if (lease.version !== 1 || typeof lease.owner !== "string" || typeof lease.updatedAt !== "number") return null;
    return lease as PaymentOperationLease;
  } catch {
    return null;
  }
}

export function paymentOperationOwnedElsewhere(
  wallet: string,
  tabId: string,
  now = Date.now(),
  storage: StorageLike = window.localStorage,
) {
  const lease = readPaymentOperationLease(wallet, storage);
  return Boolean(lease && lease.owner !== tabId && now - lease.updatedAt < PAYMENT_LEASE_TTL_MS);
}

export function acquirePaymentOperationLease(
  wallet: string,
  tabId: string,
  now = Date.now(),
  storage: StorageLike = window.localStorage,
) {
  if (paymentOperationOwnedElsewhere(wallet, tabId, now, storage)) return false;
  const lease = { owner: tabId, updatedAt: now, version: 1 } satisfies PaymentOperationLease;
  storage.setItem(paymentOperationLeaseKey(wallet), JSON.stringify(lease));
  return readPaymentOperationLease(wallet, storage)?.owner === tabId;
}

export function refreshPaymentOperationLease(
  wallet: string,
  tabId: string,
  now = Date.now(),
  storage: StorageLike = window.localStorage,
) {
  if (readPaymentOperationLease(wallet, storage)?.owner !== tabId) return false;
  storage.setItem(paymentOperationLeaseKey(wallet), JSON.stringify({ owner: tabId, updatedAt: now, version: 1 } satisfies PaymentOperationLease));
  return true;
}

export function releasePaymentOperationLease(wallet: string, tabId: string, storage: StorageLike = window.localStorage) {
  if (readPaymentOperationLease(wallet, storage)?.owner === tabId) storage.removeItem(paymentOperationLeaseKey(wallet));
}
