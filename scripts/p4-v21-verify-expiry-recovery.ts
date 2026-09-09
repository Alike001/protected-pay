import { createHash } from "node:crypto";

import {
  createSolanaRpc,
  getAddressEncoder,
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
} from "./p4-v2-settlement-bootstrap.ts";

const APPROVAL_FLAG = "--approved-p4-v21-expiry-tee-auth-recovery-verification";
const DEFAULT_BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const BASE_RPC_URL = (process.env.SOLANA_RPC_URL ??
  DEFAULT_BASE_RPC_URL) as typeof DEFAULT_BASE_RPC_URL;
const RECOVERY_SIGNATURE =
  "3aHSwTwad1nTxxGiB8DeEPPETyQkQH5B453HSVKvqej53Mz5P4HXaZHTrCG5WceXQ7484zgkEacUz3rcD2GeZPEG";
const CREATED_AT = 1_788_988_519n;
const SETTLE_AFTER = 1_788_988_579n;
const EXPIRES_AT = 1_788_988_819n;
const PAYMENT_AMOUNT = 1_000_000n;
const TOTAL_VAULT_AMOUNT = 3_000_000n;
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const ZERO_32 = new Uint8Array(32);
const ZERO_ADDRESS = "11111111111111111111111111111111" as Address;
const MEMO_HASH = new Uint8Array(
  createHash("sha256")
    .update("invoice:prototype-v21-expiry-001:consulting-services")
    .digest(),
);

type EncodedAccountData = readonly [string, string];
type JsonRpcResponse<T> = {
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
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

function terminalCommitment(): Uint8Array {
  const addressEncoder = getAddressEncoder();
  const u64 = (value: bigint) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(value);
    return bytes;
  };
  const i64 = (value: bigint) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64LE(value);
    return bytes;
  };
  return new Uint8Array(
    createHash("sha256")
      .update(Buffer.from(V21_EXPIRY_PAYMENT_ID))
      .update(Buffer.from(addressEncoder.encode(AUTHORITY)))
      .update(Buffer.from(addressEncoder.encode(V2_RECIPIENT)))
      .update(Buffer.from(addressEncoder.encode(USDC_MINT)))
      .update(u64(PAYMENT_AMOUNT))
      .update(i64(CREATED_AT))
      .update(i64(SETTLE_AFTER))
      .update(i64(EXPIRES_AT))
      .update(new Uint8Array([PaymentStatus.Expired]))
      .update(Buffer.from(MEMO_HASH))
      .digest(),
  );
}

function tokenAmount(data: Uint8Array): bigint {
  if (data.length !== TOKEN_ACCOUNT_SIZE) {
    throw new Error("Vault token-account allocation is invalid");
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
const [publicState, unauthenticatedState] = await Promise.all([
  baseRpc
    .getMultipleAccounts(
      [addresses.payment, addresses.deposit, addresses.vaultUsdcAta],
      { commitment: "finalized", encoding: "base64" },
    )
    .send(),
  createSolanaRpc(PRIVATE_ER_ORIGIN)
    .getMultipleAccounts(
      [addresses.payment, addresses.deposit, addresses.recipientDeposit],
      { commitment: "confirmed", encoding: "base64" },
    )
    .send(),
]);
const [publicPayment, publicDeposit, vaultAccount] = publicState.value;
if (
  !publicPayment ||
  publicPayment.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicPayment.data).length !== PAYMENT_SIZE ||
  !publicDeposit ||
  publicDeposit.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicDeposit.data).length !== DEPOSIT_SIZE ||
  !vaultAccount ||
  vaultAccount.owner !== TOKEN_PROGRAM_ID ||
  tokenAmount(accountBytes(vaultAccount.data)) !== TOTAL_VAULT_AMOUNT ||
  unauthenticatedState.value.some((account) => account !== null)
) {
  throw new Error(
    "Public state, vault collateral, or outsider denial is invalid",
  );
}

const authentication = await authenticatePrivateEr(keypairPath);
if (authentication.identity !== AUTHORITY) {
  throw new Error("Authenticated identity does not match the sender");
}
const privateRpc = createSolanaRpc(authentication.authenticatedUrl.toString());
const privateState = await privateRpc
  .getMultipleAccounts(
    [
      addresses.payment,
      addresses.paymentPermission,
      addresses.deposit,
      addresses.permission,
      addresses.recipientDeposit,
    ],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [
  paymentAccount,
  paymentPermission,
  senderDepositAccount,
  senderPermission,
  recipientDepositForSender,
] = privateState.value;
if (
  !paymentAccount ||
  paymentAccount.owner !== PROGRAM_ID ||
  accountBytes(paymentAccount.data).length !== PAYMENT_SIZE ||
  !senderDepositAccount ||
  senderDepositAccount.owner !== PROGRAM_ID ||
  accountBytes(senderDepositAccount.data).length !== DEPOSIT_SIZE ||
  !paymentPermission ||
  paymentPermission.owner !== PERMISSION_PROGRAM_ID ||
  accountBytes(paymentPermission.data).length !== PERMISSION_SIZE ||
  !senderPermission ||
  senderPermission.owner !== PERMISSION_PROGRAM_ID ||
  accountBytes(senderPermission.data).length !== PERMISSION_SIZE ||
  recipientDepositForSender !== null
) {
  throw new Error(
    "Terminal private topology or sender permission boundary is invalid",
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
  payment.recipient !== ZERO_ADDRESS ||
  payment.tokenMint !== USDC_MINT ||
  payment.amount !== 0n ||
  payment.createdAt !== 0n ||
  payment.settleAfter !== 0n ||
  payment.expiresAt !== 0n ||
  payment.taskId !== 0n ||
  payment.status !== PaymentStatus.Expired ||
  !bytesEqual(payment.memoHash, ZERO_32) ||
  !bytesEqual(payment.terminalCommitment, terminalCommitment()) ||
  !payment.initialized ||
  !payment.redacted ||
  payment.version !== 2 ||
  !bytesEqual(senderDeposit.discriminator, DEPOSIT_DISCRIMINATOR) ||
  senderDeposit.user !== AUTHORITY ||
  senderDeposit.tokenMint !== USDC_MINT ||
  senderDeposit.available !== 2_000_000n ||
  senderDeposit.locked !== 0n ||
  senderDeposit.nextPaymentNonce !== 5n ||
  senderDeposit.automationPaused ||
  senderDeposit.version !== 1
) {
  throw new Error(
    `Finalized recovery state failed invariants: ${json({ payment, senderDeposit })}`,
  );
}

let requestId = 1;
async function rawRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(authentication.authenticatedUrl, {
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

const transaction = await rawRpc<TransactionResult | null>("getTransaction", [
  RECOVERY_SIGNATURE,
  {
    commitment: "confirmed",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  },
]);
if (!transaction?.meta || transaction.meta.err !== null) {
  throw new Error("Recovery receipt is absent or failed");
}
const requiredSigners = transaction.transaction.message.accountKeys.slice(
  0,
  transaction.transaction.message.header.numRequiredSignatures,
);
const logs = transaction.meta.logMessages ?? [];
if (
  transaction.transaction.signatures[0] !== RECOVERY_SIGNATURE ||
  requiredSigners.length !== 1 ||
  requiredSigners[0] !== AUTHORITY ||
  !logs.some((line) => line.includes(`Program ${PROGRAM_ID} invoke`)) ||
  !logs.some((line) => line === `Program ${PROGRAM_ID} success`) ||
  logs.some(
    (line) =>
      line.includes(PAYMENT_AMOUNT.toString()) ||
      line.includes(Buffer.from(MEMO_HASH).toString("hex")),
  )
) {
  throw new Error("Recovery receipt failed signer, program, or privacy checks");
}

console.log(
  json({
    finalizedExpiryRecoveryVerification: {
      signature: RECOVERY_SIGNATURE,
      transactionSlot: transaction.slot,
      blockTime: transaction.blockTime,
      requiredSigners,
      transactionError: transaction.meta.err,
      protectedPaySucceeded: true,
      protectedDataFoundInLogs: false,
      privateReadSlot: privateState.context.slot,
      payment: addresses.payment,
      paymentStatus: PaymentStatus[payment.status],
      paymentRedacted: payment.redacted,
      paymentEscrow: payment.amount,
      terminalCommitmentMatches: true,
      senderAvailable: senderDeposit.available,
      senderLocked: senderDeposit.locked,
      senderNonce: senderDeposit.nextPaymentNonce,
      recipientDepositVisibleToSender: false,
      publicFinalizedSlot: publicState.context.slot,
      vaultCollateral: TOTAL_VAULT_AMOUNT,
      publicStateChanged: false,
      unauthenticatedProtectedReads: "all null",
      bearerTokenPrintedOrStored: false,
      hardwareAttestationIndependentlyVerified: false,
      transactionSignedOrBroadcastByVerifier: false,
    },
  }),
);
