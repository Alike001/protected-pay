import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import {
  getPaymentDecoder,
  PAYMENT_DISCRIMINATOR,
} from "../clients/ts/src/generated/accounts/payment.ts";
import { getCommitAndUndelegatePaymentInstruction } from "../clients/ts/src/generated/instructions/commitAndUndelegatePayment.ts";
import { PaymentStatus } from "../clients/ts/src/generated/types/paymentStatus.ts";
import {
  AUTHORITY,
  PRIVATE_VALIDATOR,
  PROGRAM_ID,
  USDC_MINT,
} from "./gate1-simulate.ts";
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
const RECOVERY_SIGNATURE = signature(
  "3aHSwTwad1nTxxGiB8DeEPPETyQkQH5B453HSVKvqej53Mz5P4HXaZHTrCG5WceXQ7484zgkEacUz3rcD2GeZPEG",
);
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const EXPECTED_VAULT_AMOUNT = 3_000_000n;
const EXPECTED_MEMBER_FLAGS = 0b1_1111;
const ZERO_32 = new Uint8Array(32);
const ZERO_ADDRESS = "11111111111111111111111111111111" as Address;
const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

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

function decodeTokenAmount(data: Uint8Array): bigint {
  if (data.length !== TOKEN_ACCOUNT_SIZE) {
    throw new Error(`Expected ${TOKEN_ACCOUNT_SIZE} token-account bytes`);
  }
  return new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getBigUint64(64, true);
}

function decodePermission(data: Uint8Array, protectedAccount: Address) {
  if (data.length !== PERMISSION_SIZE) {
    throw new Error(`Expected ${PERMISSION_SIZE} Permission bytes`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decodedProtectedAccount = addressDecoder.decode(data.slice(2, 34));
  const memberCount = view.getUint32(35, true);
  const members = Array.from({ length: memberCount }, (_value, index) => {
    const offset = 39 + index * 33;
    if (offset + 33 > data.length) {
      throw new Error("Permission member vector exceeds account data");
    }
    return {
      flags: data[offset]!,
      publicKey: addressDecoder.decode(data.slice(offset + 1, offset + 33)),
    };
  });
  const meaningfulBytes = 39 + memberCount * 33;
  const nonZeroPaddingBytes = data
    .slice(meaningfulBytes)
    .filter((byte) => byte !== 0).length;
  if (
    data[0] !== 0 ||
    data[34] !== 1 ||
    decodedProtectedAccount !== protectedAccount ||
    nonZeroPaddingBytes !== 0
  ) {
    throw new Error("Payment Permission header, target, or padding is invalid");
  }
  return {
    protectedAccount: decodedProtectedAccount,
    members,
    meaningfulBytes,
    nonZeroPaddingBytes,
  };
}

function decodeDelegationRecord(data: Uint8Array) {
  if (data.length !== 96) {
    throw new Error(`Expected a 96-byte Delegation Record, received ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    discriminator: view.getBigUint64(0, true),
    authority: addressDecoder.decode(data.slice(8, 40)),
    originalOwner: addressDecoder.decode(data.slice(40, 72)),
    delegationSlot: view.getBigUint64(72, true),
    delegatedLamports: view.getBigUint64(80, true),
    commitFrequencyMs: view.getBigUint64(88, true),
  };
}

function decodeDelegationMetadata(data: Uint8Array) {
  if (data.length < 53) {
    throw new Error("Delegation Metadata is too short");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const seedCount = view.getUint32(17, true);
  let offset = 21;
  const seeds: Uint8Array[] = [];
  for (let index = 0; index < seedCount; index += 1) {
    if (offset + 4 > data.length) {
      throw new Error("Delegation Metadata seed length exceeds account data");
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > data.length) {
      throw new Error("Delegation Metadata seed exceeds account data");
    }
    seeds.push(data.slice(offset, offset + length));
    offset += length;
  }
  if (offset + 32 !== data.length) {
    throw new Error("Delegation Metadata has unexpected trailing data");
  }
  return {
    discriminator: view.getBigUint64(0, true),
    lastCommitId: view.getBigUint64(8, true),
    undelegationRequester: data[16]!,
    seeds,
    rentPayer: addressDecoder.decode(data.slice(offset, offset + 32)),
  };
}

const addresses = await deriveV21ExpiryAddresses();
const [permissionDelegation, paymentDelegation] = await Promise.all([
  deriveDelegationPdas(addresses.paymentPermission, PERMISSION_PROGRAM_ID),
  deriveDelegationPdas(addresses.payment, PROGRAM_ID),
]);
const publicRpc = createSolanaRpc(PUBLIC_RPC_URL);
const privateRpc = createSolanaRpc(PRIVATE_ER_ORIGIN);
const publicAddresses = [
  addresses.payment,
  addresses.paymentPermission,
  paymentDelegation.buffer,
  paymentDelegation.record,
  paymentDelegation.metadata,
  permissionDelegation.buffer,
  permissionDelegation.record,
  permissionDelegation.metadata,
  addresses.deposit,
  addresses.recipientDeposit,
  addresses.vaultUsdcAta,
] as const;
const [publicResponse, unauthenticatedResponse, unauthenticatedReceipt] =
  await Promise.all([
    publicRpc
      .getMultipleAccounts(publicAddresses, {
        commitment: "finalized",
        encoding: "base64",
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
    privateRpc
      .getTransaction(RECOVERY_SIGNATURE, {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send(),
  ]);

const [
  publicPaymentAccount,
  publicPermissionAccount,
  paymentBuffer,
  paymentRecordAccount,
  paymentMetadataAccount,
  permissionBuffer,
  permissionRecordAccount,
  permissionMetadataAccount,
  senderDepositAccount,
  recipientDepositAccount,
  vaultAccount,
] = publicResponse.value;
if (
  !publicPaymentAccount ||
  publicPaymentAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicPaymentAccount.data).length !== PAYMENT_SIZE ||
  !publicPermissionAccount ||
  publicPermissionAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicPermissionAccount.data).length !== PERMISSION_SIZE ||
  paymentBuffer !== null ||
  permissionBuffer !== null ||
  !paymentRecordAccount ||
  paymentRecordAccount.owner !== DELEGATION_PROGRAM_ID ||
  !paymentMetadataAccount ||
  paymentMetadataAccount.owner !== DELEGATION_PROGRAM_ID ||
  !permissionRecordAccount ||
  permissionRecordAccount.owner !== DELEGATION_PROGRAM_ID ||
  !permissionMetadataAccount ||
  permissionMetadataAccount.owner !== DELEGATION_PROGRAM_ID ||
  !senderDepositAccount ||
  senderDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(senderDepositAccount.data).length !== DEPOSIT_SIZE ||
  !recipientDepositAccount ||
  recipientDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(recipientDepositAccount.data).length !== DEPOSIT_SIZE ||
  !vaultAccount ||
  vaultAccount.owner !== TOKEN_PROGRAM_ID ||
  decodeTokenAmount(accountBytes(vaultAccount.data)) !== EXPECTED_VAULT_AMOUNT
) {
  throw new Error("Corrected-layout public delegation topology is invalid");
}

const publicPayment = getPaymentDecoder().decode(
  accountBytes(publicPaymentAccount.data),
);
if (
  !bytesEqual(publicPayment.discriminator, PAYMENT_DISCRIMINATOR) ||
  !bytesEqual(publicPayment.paymentId, V21_EXPIRY_PAYMENT_ID) ||
  publicPayment.sender !== AUTHORITY ||
  publicPayment.recipient !== V2_RECIPIENT ||
  publicPayment.tokenMint !== USDC_MINT ||
  publicPayment.amount !== 0n ||
  publicPayment.createdAt !== 0n ||
  publicPayment.settleAfter !== 0n ||
  publicPayment.expiresAt !== 0n ||
  publicPayment.taskId !== 0n ||
  publicPayment.status !== PaymentStatus.Created ||
  !bytesEqual(publicPayment.memoHash, ZERO_32) ||
  !bytesEqual(publicPayment.terminalCommitment, ZERO_32) ||
  publicPayment.initialized ||
  publicPayment.redacted ||
  publicPayment.version !== 2
) {
  throw new Error(`Public Payment shell is unexpected: ${json(publicPayment)}`);
}

const permission = decodePermission(
  accountBytes(publicPermissionAccount.data),
  addresses.payment,
);
const permissionMemberMap = new Map(
  permission.members.map((member) => [member.publicKey, member.flags]),
);
if (
  permission.members.length !== 3 ||
  permissionMemberMap.get(PROGRAM_ID) !== 0 ||
  permissionMemberMap.get(AUTHORITY) !== EXPECTED_MEMBER_FLAGS ||
  permissionMemberMap.get(V2_RECIPIENT) !== EXPECTED_MEMBER_FLAGS
) {
  throw new Error(`Payment Permission membership is unexpected: ${json(permission)}`);
}

const paymentRecord = decodeDelegationRecord(accountBytes(paymentRecordAccount.data));
const permissionRecord = decodeDelegationRecord(
  accountBytes(permissionRecordAccount.data),
);
const paymentMetadata = decodeDelegationMetadata(
  accountBytes(paymentMetadataAccount.data),
);
const permissionMetadata = decodeDelegationMetadata(
  accountBytes(permissionMetadataAccount.data),
);
const expectedPaymentSeeds = [
  Buffer.from("payment"),
  Buffer.from(V21_EXPIRY_PAYMENT_ID),
];
const expectedPermissionSeeds = [
  Buffer.from("permission:"),
  Buffer.from(addressEncoder.encode(addresses.payment)),
];
for (const [label, record, originalOwner] of [
  ["Payment", paymentRecord, PROGRAM_ID],
  ["Payment Permission", permissionRecord, PERMISSION_PROGRAM_ID],
] as const) {
  if (
    record.discriminator !== 100n ||
    record.authority !== PRIVATE_VALIDATOR ||
    record.originalOwner !== originalOwner
  ) {
    throw new Error(`${label} Delegation Record is invalid`);
  }
}
for (const [label, metadata, expectedSeeds] of [
  ["Payment", paymentMetadata, expectedPaymentSeeds],
  ["Payment Permission", permissionMetadata, expectedPermissionSeeds],
] as const) {
  if (
    metadata.discriminator !== 102n ||
    metadata.undelegationRequester !== 0 ||
    metadata.rentPayer !== AUTHORITY ||
    metadata.seeds.length !== expectedSeeds.length ||
    !metadata.seeds.every((seed, index) =>
      bytesEqual(seed, expectedSeeds[index]!),
    )
  ) {
    throw new Error(`${label} Delegation Metadata is invalid`);
  }
}

const [unauthPayment, unauthSenderDeposit, unauthRecipientDeposit, unauthPermission] =
  unauthenticatedResponse.value;
if (
  unauthPayment !== null ||
  unauthSenderDeposit !== null ||
  unauthRecipientDeposit !== null ||
  !unauthPermission
) {
  throw new Error("Unauthenticated Private ER account visibility is invalid");
}
if (!unauthenticatedReceipt?.meta || unauthenticatedReceipt.meta.err !== null) {
  throw new Error("Known recovery receipt is unavailable or failed");
}
const redactedReceipt = {
  accountKeyCount: unauthenticatedReceipt.transaction.message.accountKeys.length,
  instructionCount: unauthenticatedReceipt.transaction.message.instructions.length,
  logCount: unauthenticatedReceipt.meta.logMessages?.length ?? 0,
  preBalanceCount: unauthenticatedReceipt.meta.preBalances?.length ?? 0,
  postBalanceCount: unauthenticatedReceipt.meta.postBalances?.length ?? 0,
};
if (Object.values(redactedReceipt).some((count) => count !== 0)) {
  throw new Error(`Unauthenticated receipt leaked execution details: ${json(redactedReceipt)}`);
}

const commitInstruction = getCommitAndUndelegatePaymentInstruction({
  payer: createNoopSigner(AUTHORITY),
  sender: AUTHORITY,
  payment: addresses.payment,
});
const { value: latestBlockhash } = await privateRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayer(AUTHORITY, current),
  (current) =>
    setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) =>
    appendTransactionMessageInstructions(
      [getSetComputeUnitLimitInstruction({ units: 250_000 }), commitInstruction],
      current,
    ),
);
const transaction = compileTransaction(message);
const serializedBytes = Buffer.from(
  getBase64EncodedWireTransaction(transaction),
  "base64",
).length;
if (serializedBytes > 1_232) {
  throw new Error(`Commit/undelegate transaction is ${serializedBytes} bytes`);
}

const publicHistory = await publicRpc
  .getSignaturesForAddress(addresses.payment, {
    commitment: "finalized",
    limit: 10,
  })
  .send();

console.log(
  json({
    correctedLayoutPrivacyAudit: {
      paymentLabel: V21_EXPIRY_PAYMENT_LABEL,
      payment: addresses.payment,
      publicReadSlot: publicResponse.context.slot,
      publicPaymentShell: {
        paymentIdHex: Buffer.from(publicPayment.paymentId).toString("hex"),
        sender: publicPayment.sender,
        recipient: publicPayment.recipient,
        tokenMint: publicPayment.tokenMint,
        amount: publicPayment.amount,
        createdAt: publicPayment.createdAt,
        settleAfter: publicPayment.settleAfter,
        expiresAt: publicPayment.expiresAt,
        taskId: publicPayment.taskId,
        status: PaymentStatus[publicPayment.status],
        memoHashIsZero: bytesEqual(publicPayment.memoHash, ZERO_32),
        initialized: publicPayment.initialized,
        redacted: publicPayment.redacted,
        version: publicPayment.version,
      },
      publicPermission: {
        address: addresses.paymentPermission,
        members: permission.members,
        meaningfulBytes: permission.meaningfulBytes,
        nonZeroPaddingBytes: permission.nonZeroPaddingBytes,
      },
      publicDelegation: {
        validator: paymentRecord.authority,
        paymentRecord: paymentDelegation.record,
        paymentMetadata: paymentDelegation.metadata,
        paymentDelegationSlot: paymentRecord.delegationSlot,
        paymentCommitFrequencyMs: paymentRecord.commitFrequencyMs,
        permissionRecord: permissionDelegation.record,
        permissionMetadata: permissionDelegation.metadata,
        temporaryBuffersClosed: true,
      },
      aggregateDepositsStillDelegated: {
        sender: addresses.deposit,
        recipient: addresses.recipientDeposit,
      },
      vaultCollateral: EXPECTED_VAULT_AMOUNT,
      publicPaymentHistory: publicHistory.map((entry) => ({
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime,
        err: entry.err,
      })),
      unauthenticatedPrivateEr: {
        readSlot: unauthenticatedResponse.context.slot,
        protectedPaymentVisible: false,
        senderDepositVisible: false,
        recipientDepositVisible: false,
        permissionVisible: true,
        knownRecoveryReceipt: {
          signature: RECOVERY_SIGNATURE,
          slot: unauthenticatedReceipt.slot,
          blockTime: unauthenticatedReceipt.blockTime,
          ...redactedReceipt,
        },
      },
    },
    unsignedTerminalCommitPreflight: {
      endpoint: PRIVATE_ER_ORIGIN,
      feePayer: AUTHORITY,
      requiredSigners: [AUTHORITY],
      instruction: "commit_and_undelegate_payment",
      payment: addresses.payment,
      committedAccounts: [addresses.payment],
      aggregateDepositsCommitted: false,
      paymentPermissionCommitted: false,
      splTokenInstructions: "none",
      usdcMoved: "0",
      serializedBytes,
      keypairLoaded: false,
      teeAuthenticationSigned: false,
      transactionSigned: false,
      transactionSimulated: false,
      transactionBroadcast: false,
      nextApprovalRequired:
        "sender TEE authentication and signature-verified terminal Payment commit/undelegate simulation",
    },
    measuredPrivacyBoundary: {
      publicBeforeDelegationAndStillObservable: [
        "sender and recipient wallet relationship",
        "Payment address and deterministic payment ID",
        "USDC mint",
        "Payment Permission members and capability flags",
        "delegation validator, records, metadata, PDA seeds, slot, and timing",
        "pre-delegation empty Payment shell",
        "vault collateral, public transaction existence, slots, and block times",
      ],
      privateWhileDelegated: [
        "live amount and per-Payment escrow",
        "memo hash",
        "live status and deadlines",
        "Crank task ID",
        "aggregate user balances and nonces",
        "protected transaction accounts, instructions, logs, and balances",
      ],
      publicAfterProposedCommit: [
        "sender, mint, payment ID, terminal Expired status, version, and initialized/redacted flags",
        "terminal commitment hash",
        "commit/undelegation transaction accounts, instruction data, logs, slot, and timing",
      ],
      remainsRedactedAfterProposedCommit: [
        "recipient",
        "amount",
        "memo hash",
        "created, settlement, and expiry timestamps",
        "Crank task ID",
        "both aggregate Deposit balances because Deposits are not committed",
      ],
      claim:
        "Private pending terms and balances inside MagicBlock's authenticated Private ER; not anonymous and not permanently opaque metadata.",
    },
    assertions: "all passed",
  }),
);
