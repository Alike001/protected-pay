import { createHash } from "node:crypto";

import {
  createSolanaRpc,
  getAddressEncoder,
  signature,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";

import {
  getPaymentDecoder,
  PAYMENT_DISCRIMINATOR,
} from "../clients/ts/src/generated/accounts/payment.ts";
import { PaymentStatus } from "../clients/ts/src/generated/types/paymentStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";
import {
  deriveV21ExpiryAddresses,
  V2_RECIPIENT,
  V21_EXPIRY_PAYMENT_ID,
  V21_EXPIRY_PAYMENT_LABEL,
} from "./p4-v2-settlement-bootstrap.ts";

const PUBLIC_RPC_URL = "https://api.devnet.solana.com" as const;
const ER_SIGNATURE = signature(
  "Zh9jropwxoVtKV6kVhqcZcVbsHGXPfZm8ZHjsH29oAp4RRJBMRT7LUZZwaPZM9KDwEGgMMCd16DBHRtpFMbtMMQ",
);
const PUBLIC_PROCESS_SIGNATURE = signature(
  "2ncJVLoHZ14hwmCcPpD9Qp5GEQyyY2NeYz1EvcnWVCWATeBfN3JNMFm8e7W9J89ccZ4qWRssyQbpB7vBgJFMjXiv",
);
const EXPECTED_PUBLIC_SLOT = 495_841_058n;
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const EXPECTED_VAULT_AMOUNT = 3_000_000n;
const ORIGINAL_AMOUNT = 1_000_000n;
const ORIGINAL_CREATED_AT = 1_788_988_519n;
const ORIGINAL_SETTLE_AFTER = 1_788_988_579n;
const ORIGINAL_EXPIRES_AT = 1_788_988_819n;
const ZERO_32 = new Uint8Array(32);
const ZERO_ADDRESS = "11111111111111111111111111111111" as Address;
const ORIGINAL_MEMO_HASH = new Uint8Array(
  createHash("sha256")
    .update("invoice:prototype-v21-expiry-001:consulting-services")
    .digest(),
);

type EncodedAccountData = readonly [string, string];

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
      .update(u64(ORIGINAL_AMOUNT))
      .update(i64(ORIGINAL_CREATED_AT))
      .update(i64(ORIGINAL_SETTLE_AFTER))
      .update(i64(ORIGINAL_EXPIRES_AT))
      .update(new Uint8Array([PaymentStatus.Expired]))
      .update(Buffer.from(ORIGINAL_MEMO_HASH))
      .digest(),
  );
}

const addresses = await deriveV21ExpiryAddresses();
const [paymentDelegation, permissionDelegation] = await Promise.all([
  deriveDelegationPdas(addresses.payment, PROGRAM_ID),
  deriveDelegationPdas(addresses.paymentPermission, PERMISSION_PROGRAM_ID),
]);
const publicRpc = createSolanaRpc(PUBLIC_RPC_URL);
const privateRpc = createSolanaRpc(PRIVATE_ER_ORIGIN);
const [publicState, publicReceipt, unauthenticatedState] = await Promise.all([
  publicRpc
    .getMultipleAccounts(
      [
        addresses.payment,
        paymentDelegation.buffer,
        paymentDelegation.record,
        paymentDelegation.metadata,
        addresses.paymentPermission,
        permissionDelegation.buffer,
        permissionDelegation.record,
        permissionDelegation.metadata,
        addresses.deposit,
        addresses.recipientDeposit,
        addresses.vaultUsdcAta,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send(),
  publicRpc
    .getTransaction(PUBLIC_PROCESS_SIGNATURE, {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send(),
  privateRpc
    .getMultipleAccounts(
      [
        addresses.payment,
        addresses.deposit,
        addresses.recipientDeposit,
        addresses.paymentPermission,
      ],
      { commitment: "confirmed", encoding: "base64" },
    )
    .send(),
]);

const [
  paymentAccount,
  paymentBuffer,
  paymentRecord,
  paymentMetadata,
  permissionAccount,
  permissionBuffer,
  permissionRecord,
  permissionMetadata,
  senderDeposit,
  recipientDeposit,
  vault,
] = publicState.value;
if (
  !paymentAccount ||
  paymentAccount.owner !== PROGRAM_ID ||
  accountBytes(paymentAccount.data).length !== PAYMENT_SIZE ||
  paymentBuffer !== null ||
  paymentRecord !== null ||
  paymentMetadata !== null ||
  !permissionAccount ||
  permissionAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(permissionAccount.data).length !== PERMISSION_SIZE ||
  permissionBuffer !== null ||
  !permissionRecord ||
  permissionRecord.owner !== DELEGATION_PROGRAM_ID ||
  !permissionMetadata ||
  permissionMetadata.owner !== DELEGATION_PROGRAM_ID ||
  !senderDeposit ||
  senderDeposit.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(senderDeposit.data).length !== DEPOSIT_SIZE ||
  !recipientDeposit ||
  recipientDeposit.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(recipientDeposit.data).length !== DEPOSIT_SIZE ||
  !vault ||
  vault.owner !== TOKEN_PROGRAM_ID ||
  tokenAmount(accountBytes(vault.data)) !== EXPECTED_VAULT_AMOUNT
) {
  throw new Error("Finalized public account topology is invalid");
}

const payment = getPaymentDecoder().decode(accountBytes(paymentAccount.data));
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
  payment.version !== 2
) {
  throw new Error(`Final public Payment is invalid: ${json(payment)}`);
}

const publicKeys = publicReceipt?.transaction.message.accountKeys ?? [];
const publicLogs = publicReceipt?.meta?.logMessages ?? [];
if (
  !publicReceipt?.meta ||
  publicReceipt.meta.err !== null ||
  publicReceipt.slot !== EXPECTED_PUBLIC_SLOT ||
  !publicKeys.includes(addresses.payment) ||
  !publicKeys.includes(DELEGATION_PROGRAM_ID) ||
  publicLogs.some(
    (line) =>
      line.includes(ORIGINAL_AMOUNT.toString()) ||
      line.includes(Buffer.from(ORIGINAL_MEMO_HASH).toString("hex")),
  )
) {
  throw new Error("Public ProcessUndelegation receipt failed verification");
}

const [unauthPayment, unauthSenderDeposit, unauthRecipientDeposit, unauthPermission] =
  unauthenticatedState.value;
if (
  unauthPayment !== null ||
  unauthSenderDeposit !== null ||
  unauthRecipientDeposit !== null ||
  !unauthPermission
) {
  throw new Error("Unauthenticated post-closeout visibility is invalid");
}

console.log(
  json({
    finalizedPublicCloseoutVerification: {
      paymentLabel: V21_EXPIRY_PAYMENT_LABEL,
      payment: addresses.payment,
      erSignature: ER_SIGNATURE,
      publicProcessSignature: PUBLIC_PROCESS_SIGNATURE,
      publicProcessSlot: publicReceipt.slot,
      publicProcessBlockTime: publicReceipt.blockTime,
      finalizedReadSlot: publicState.context.slot,
      paymentOwner: paymentAccount.owner,
      paymentStatus: PaymentStatus[payment.status],
      paymentRedacted: payment.redacted,
      paymentEscrow: payment.amount,
      recipientRedacted: payment.recipient === ZERO_ADDRESS,
      memoHashRedacted: bytesEqual(payment.memoHash, ZERO_32),
      timestampsRedacted:
        payment.createdAt === 0n &&
        payment.settleAfter === 0n &&
        payment.expiresAt === 0n,
      crankTaskIdRedacted: payment.taskId === 0n,
      terminalCommitmentMatches: true,
      paymentDelegationRecordAndMetadataClosed: true,
      paymentPermissionRemainsDelegated: true,
      senderDepositRemainsDelegated: true,
      recipientDepositRemainsDelegated: true,
      aggregateBalancesPublished: false,
      vaultCollateral: EXPECTED_VAULT_AMOUNT,
      protectedAmountOrMemoFoundInPublicLogs: false,
      unauthenticatedProtectedReads: "all null",
      unauthenticatedPermissionVisible: true,
      unauthenticatedReadSlot: unauthenticatedState.context.slot,
      keypairLoaded: false,
      transactionSignedOrBroadcastByVerifier: false,
    },
    assertions: "all passed",
  }),
);
