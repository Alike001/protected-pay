import { createHash } from "node:crypto";

import {
  createSolanaRpc,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

import {
  DEPOSIT_DISCRIMINATOR,
  getDepositDecoder,
} from "../clients/ts/src/generated/accounts/deposit.ts";
import {
  getPaymentDecoder,
  PAYMENT_DISCRIMINATOR,
} from "../clients/ts/src/generated/accounts/payment.ts";
import { PaymentStatus } from "../clients/ts/src/generated/types/paymentStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { authenticatePrivateEr, PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";
import {
  deriveV21ExpiryAddresses,
  V2_RECIPIENT,
  V21_EXPIRY_PAYMENT_ID,
  V21_EXPIRY_PAYMENT_LABEL,
} from "./p4-v2-settlement-bootstrap.ts";

const APPROVAL_FLAG = "--approved-p4-v21-expiry-tee-auth-monitor";
const DEFAULT_BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const BASE_RPC_URL = (process.env.SOLANA_RPC_URL ??
  DEFAULT_BASE_RPC_URL) as typeof DEFAULT_BASE_RPC_URL;
const EXPECTED_TASK_ID = 1_788_988_515_930n;
const EXPECTED_CREATED_AT = 1_788_988_519n;
const EXPECTED_SETTLE_AFTER = 1_788_988_579n;
const EXPECTED_EXPIRES_AT = 1_788_988_819n;
const PAYMENT_AMOUNT = 1_000_000n;
const EXPECTED_SENDER_AVAILABLE = 1_000_000n;
const EXPECTED_SENDER_NONCE = 5n;
const TOTAL_VAULT_AMOUNT = 3_000_000n;
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const POLL_INTERVAL_MILLIS = 10_000;
const MAX_SECONDS_AFTER_EXPIRY = 120n;
const EXPECTED_MEMO_HASH = new Uint8Array(
  createHash("sha256")
    .update("invoice:prototype-v21-expiry-001:consulting-services")
    .digest(),
);
const ZERO_32 = new Uint8Array(32);

type EncodedAccountData = readonly [string, string];
type JsonRpcResponse<T> = {
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
};
type SignatureEntry = {
  signature: string;
  slot: number;
  err: unknown;
  memo: string | null;
  blockTime: number | null;
  confirmationStatus?: string;
};
type TransactionResult = {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number };
    };
  };
  meta: {
    err: unknown;
    logMessages: string[] | null;
  } | null;
};

function accountBytes(data: EncodedAccountData): Uint8Array {
  if (data[1] !== "base64") {
    throw new Error(`Unexpected account encoding: ${data[1]}`);
  }
  return Buffer.from(data[0], "base64");
}

function bytesEqual(
  actual: ReadonlyUint8Array,
  expected: ReadonlyUint8Array,
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    2,
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function decodeTokenAmount(data: Uint8Array): bigint {
  if (data.length !== TOKEN_ACCOUNT_SIZE) {
    throw new Error(
      `Expected ${TOKEN_ACCOUNT_SIZE} token-account bytes, received ${data.length}`,
    );
  }
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getBigUint64(64, true);
}

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(
    `Refusing to sign the read-only TEE authentication message without ${APPROVAL_FLAG}`,
  );
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved sender signer");
}

const addresses = await deriveV21ExpiryAddresses();
const baseRpc = createSolanaRpc(BASE_RPC_URL);
const baseState = await baseRpc
  .getMultipleAccounts(
    [
      addresses.payment,
      addresses.paymentPermission,
      addresses.deposit,
      addresses.recipientDeposit,
      addresses.vaultUsdcAta,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [
  publicPaymentAccount,
  publicPaymentPermissionAccount,
  publicSenderDepositAccount,
  publicRecipientDepositAccount,
  publicVaultAccount,
] = baseState.value;
if (
  !publicPaymentAccount ||
  publicPaymentAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicPaymentAccount.data).length !== PAYMENT_SIZE ||
  !publicPaymentPermissionAccount ||
  publicPaymentPermissionAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicPaymentPermissionAccount.data).length !==
    PERMISSION_SIZE ||
  !publicSenderDepositAccount ||
  publicSenderDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicSenderDepositAccount.data).length !== DEPOSIT_SIZE ||
  !publicRecipientDepositAccount ||
  publicRecipientDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicRecipientDepositAccount.data).length !== DEPOSIT_SIZE ||
  !publicVaultAccount ||
  publicVaultAccount.owner !== TOKEN_PROGRAM_ID ||
  decodeTokenAmount(accountBytes(publicVaultAccount.data)) !==
    TOTAL_VAULT_AMOUNT
) {
  throw new Error("Finalized public topology or vault collateral is invalid");
}

const unauthenticatedRpc = createSolanaRpc(PRIVATE_ER_ORIGIN);
const unauthenticatedBefore = await unauthenticatedRpc
  .getMultipleAccounts(
    [addresses.payment, addresses.deposit, addresses.recipientDeposit],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
if (unauthenticatedBefore.value.some((account) => account !== null)) {
  throw new Error("Unauthenticated Private ER exposed protected state");
}

const authentication = await authenticatePrivateEr(keypairPath);
if (
  authentication.identity !== AUTHORITY ||
  authentication.signerClient.identity.address !== AUTHORITY
) {
  throw new Error("Authenticated identity does not match the approved sender");
}
const authenticatedUrl = authentication.authenticatedUrl;
const privateRpc = createSolanaRpc(authenticatedUrl.toString());

async function readPrivateState() {
  const response = await privateRpc
    .getMultipleAccounts(
      [
        addresses.payment,
        addresses.paymentPermission,
        addresses.deposit,
        addresses.recipientDeposit,
      ],
      { commitment: "confirmed", encoding: "base64" },
    )
    .send();
  const [
    paymentAccount,
    permissionAccount,
    senderDepositAccount,
    recipientDeposit,
  ] = response.value;
  if (
    !paymentAccount ||
    paymentAccount.owner !== PROGRAM_ID ||
    accountBytes(paymentAccount.data).length !== PAYMENT_SIZE ||
    !permissionAccount ||
    permissionAccount.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(permissionAccount.data).length !== PERMISSION_SIZE ||
    !senderDepositAccount ||
    senderDepositAccount.owner !== PROGRAM_ID ||
    accountBytes(senderDepositAccount.data).length !== DEPOSIT_SIZE ||
    recipientDeposit !== null
  ) {
    throw new Error(
      "Authenticated private topology or permission boundary is invalid",
    );
  }
  const payment = getPaymentDecoder().decode(accountBytes(paymentAccount.data));
  const senderDeposit = getDepositDecoder().decode(
    accountBytes(senderDepositAccount.data),
  );
  if (
    !bytesEqual(payment.discriminator, PAYMENT_DISCRIMINATOR) ||
    !bytesEqual(payment.paymentId, V21_EXPIRY_PAYMENT_ID) ||
    payment.sender !== AUTHORITY ||
    payment.recipient !== V2_RECIPIENT ||
    payment.tokenMint !== USDC_MINT ||
    payment.amount !== PAYMENT_AMOUNT ||
    payment.createdAt !== EXPECTED_CREATED_AT ||
    payment.settleAfter !== EXPECTED_SETTLE_AFTER ||
    payment.expiresAt !== EXPECTED_EXPIRES_AT ||
    payment.taskId !== EXPECTED_TASK_ID ||
    !bytesEqual(payment.memoHash, EXPECTED_MEMO_HASH) ||
    !bytesEqual(payment.terminalCommitment, ZERO_32) ||
    !payment.initialized ||
    payment.redacted ||
    payment.version !== 2 ||
    !bytesEqual(senderDeposit.discriminator, DEPOSIT_DISCRIMINATOR) ||
    senderDeposit.user !== AUTHORITY ||
    senderDeposit.tokenMint !== USDC_MINT ||
    senderDeposit.available !== EXPECTED_SENDER_AVAILABLE ||
    senderDeposit.locked !== 0n ||
    senderDeposit.nextPaymentNonce !== EXPECTED_SENDER_NONCE ||
    senderDeposit.automationPaused ||
    senderDeposit.version !== 1 ||
    ![PaymentStatus.Created, PaymentStatus.Expired].includes(payment.status)
  ) {
    throw new Error(
      `Unexpected live expiry state: ${json({ payment, senderDeposit })}`,
    );
  }
  return { payment, response, senderDeposit } as const;
}

let poll = 0;
let observed = await readPrivateState();
console.log(
  json({
    monitorStarted: {
      paymentLabel: V21_EXPIRY_PAYMENT_LABEL,
      payment: addresses.payment,
      taskId: observed.payment.taskId,
      status: PaymentStatus[observed.payment.status],
      createdAt: observed.payment.createdAt,
      expiresAt: observed.payment.expiresAt,
      secondsUntilExpiry: observed.payment.expiresAt - nowSeconds(),
      privateSlot: observed.response.context.slot,
      senderAvailable: observed.senderDeposit.available,
      senderNonce: observed.senderDeposit.nextPaymentNonce,
      unauthenticatedProtectedReads: "all null",
      transactionSignedOrBroadcast: false,
    },
  }),
);

while (observed.payment.status !== PaymentStatus.Expired) {
  const now = nowSeconds();
  if (now > EXPECTED_EXPIRES_AT + MAX_SECONDS_AFTER_EXPIRY) {
    throw new Error(
      "Payment did not reach Expired within the guarded observation window",
    );
  }
  await wait(POLL_INTERVAL_MILLIS);
  poll += 1;
  observed = await readPrivateState();
  if (poll % 3 === 0 || observed.payment.status === PaymentStatus.Expired) {
    console.log(
      json({
        monitorTick: {
          poll,
          observedAt: nowSeconds(),
          privateSlot: observed.response.context.slot,
          status: PaymentStatus[observed.payment.status],
          secondsFromExpiry: nowSeconds() - observed.payment.expiresAt,
          paymentEscrow: observed.payment.amount,
          senderAvailable: observed.senderDeposit.available,
        },
      }),
    );
  }
}

let requestId = 1;
async function rawRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(authenticatedUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
  });
  if (!response.ok) {
    throw new Error(
      `Private RPC ${method} failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as JsonRpcResponse<T>;
  if (body.error || body.result === undefined) {
    throw new Error(
      `Private RPC ${method} failed: ${json(body.error ?? "missing result")}`,
    );
  }
  return body.result;
}

const signatureEntries = await rawRpc<SignatureEntry[]>(
  "getSignaturesForAddress",
  [addresses.payment, { commitment: "confirmed", limit: 20 }],
);
const transactionResults = await Promise.all(
  signatureEntries.map(async (entry) => ({
    entry,
    transaction: await rawRpc<TransactionResult | null>("getTransaction", [
      entry.signature,
      {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      },
    ]),
  })),
);
const relevantTransactions = transactionResults
  .filter(({ transaction }) =>
    transaction?.meta?.logMessages?.some((line) =>
      line.includes(`Program ${PROGRAM_ID} invoke`),
    ),
  )
  .map(({ entry, transaction }) => {
    const message = transaction!.transaction.message;
    const logs = transaction!.meta?.logMessages ?? [];
    const requiredSigners = message.accountKeys.slice(
      0,
      message.header.numRequiredSignatures,
    );
    return {
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime,
      err: transaction!.meta?.err ?? entry.err,
      feePayer: message.accountKeys[0] ?? null,
      requiredSigners,
      userSigned: requiredSigners.includes(AUTHORITY),
      succeeded: logs.some((line) => line === `Program ${PROGRAM_ID} success`),
    };
  })
  .sort((left, right) => (left.blockTime ?? 0) - (right.blockTime ?? 0));
const scheduleTransactions = relevantTransactions.filter(
  (transaction) => transaction.userSigned,
);
const autonomousTransactions = relevantTransactions.filter(
  (transaction) => !transaction.userSigned,
);
if (
  scheduleTransactions.length !== 1 ||
  autonomousTransactions.length < 6 ||
  autonomousTransactions.some(
    (transaction) =>
      transaction.err !== null ||
      !transaction.succeeded ||
      transaction.requiredSigners.includes(AUTHORITY),
  )
) {
  throw new Error(
    `Crank receipt invariant failed: ${json({ scheduleTransactions, autonomousTransactions })}`,
  );
}

const [publicAfter, unauthenticatedAfter] = await Promise.all([
  baseRpc
    .getMultipleAccounts(
      [addresses.payment, addresses.deposit, addresses.vaultUsdcAta],
      { commitment: "finalized", encoding: "base64" },
    )
    .send(),
  unauthenticatedRpc
    .getMultipleAccounts(
      [addresses.payment, addresses.deposit, addresses.recipientDeposit],
      { commitment: "confirmed", encoding: "base64" },
    )
    .send(),
]);
if (
  publicAfter.value.some((account, index) => {
    const before = [
      publicPaymentAccount,
      publicSenderDepositAccount,
      publicVaultAccount,
    ][index];
    return (
      !account ||
      !before ||
      account.owner !== before.owner ||
      !bytesEqual(accountBytes(account.data), accountBytes(before.data))
    );
  }) ||
  unauthenticatedAfter.value.some((account) => account !== null)
) {
  throw new Error("Autonomous expiry changed public state or weakened privacy");
}

console.log(
  json({
    autonomousExpiryVerified: {
      payment: addresses.payment,
      taskId: observed.payment.taskId,
      status: PaymentStatus[observed.payment.status],
      privateSlot: observed.response.context.slot,
      paymentEscrow: observed.payment.amount,
      senderAvailable: observed.senderDeposit.available,
      senderNonce: observed.senderDeposit.nextPaymentNonce,
      scheduleTransactions,
      autonomousExecutionCount: autonomousTransactions.length,
      autonomousTransactions,
      userAbsentFromAutonomousRequiredSigners: true,
      publicStateChanged: false,
      vaultBalanceChanged: false,
      unauthenticatedProtectedReads: "all null",
      authenticationTokenPrintedOrStored: false,
      hardwareAttestationIndependentlyVerified: false,
      financialTransactionSignedOrBroadcastByMonitor: false,
    },
  }),
);
