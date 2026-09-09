import { createHash } from "node:crypto";

import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import {
  DEPOSIT_DISCRIMINATOR,
  getDepositDecoder,
} from "../clients/ts/src/generated/accounts/deposit.ts";
import {
  getPaymentDecoder,
  PAYMENT_DISCRIMINATOR,
} from "../clients/ts/src/generated/accounts/payment.ts";
import { getAdvancePaymentInstruction } from "../clients/ts/src/generated/instructions/advancePayment.ts";
import { getClaimPaymentInstruction } from "../clients/ts/src/generated/instructions/claimPayment.ts";
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

const AUTH_APPROVAL_FLAG =
  "--approved-p4-v21-expiry-tee-auth-retry-safety-simulation";
const DEFAULT_BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const BASE_RPC_URL = (process.env.SOLANA_RPC_URL ??
  DEFAULT_BASE_RPC_URL) as typeof DEFAULT_BASE_RPC_URL;
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const TOTAL_VAULT_AMOUNT = 3_000_000n;
const EXPECTED_SENDER_AVAILABLE = 2_000_000n;
const EXPECTED_SENDER_NONCE = 5n;
const PAYMENT_AMOUNT_BEFORE_REDACTION = 1_000_000n;
const CREATED_AT_BEFORE_REDACTION = 1_788_988_519n;
const SETTLE_AFTER_BEFORE_REDACTION = 1_788_988_579n;
const EXPIRES_AT_BEFORE_REDACTION = 1_788_988_819n;
const PAYMENT_REDACTED_ERROR = 6_022;
const ZERO_32 = new Uint8Array(32);
const ZERO_ADDRESS = "11111111111111111111111111111111" as Address;
const MEMO_HASH_BEFORE_REDACTION = new Uint8Array(
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
      .update(u64(PAYMENT_AMOUNT_BEFORE_REDACTION))
      .update(i64(CREATED_AT_BEFORE_REDACTION))
      .update(i64(SETTLE_AFTER_BEFORE_REDACTION))
      .update(i64(EXPIRES_AT_BEFORE_REDACTION))
      .update(new Uint8Array([PaymentStatus.Expired]))
      .update(Buffer.from(MEMO_HASH_BEFORE_REDACTION))
      .digest(),
  );
}

function isPaymentRedactedError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("InstructionError" in error)) {
    return false;
  }
  const instructionError = (error as { InstructionError: unknown })
    .InstructionError;
  if (!Array.isArray(instructionError) || instructionError[0] !== 1) {
    return false;
  }
  const custom = instructionError[1];
  return (
    !!custom &&
    typeof custom === "object" &&
    "Custom" in custom &&
    (custom as { Custom: unknown }).Custom === PAYMENT_REDACTED_ERROR
  );
}

if (process.argv.includes("--send")) {
  throw new Error("Retry-safety proof is simulation-only and cannot broadcast");
}

const addresses = await deriveV21ExpiryAddresses();
const baseRpc = createSolanaRpc(BASE_RPC_URL);
const publicBefore = await baseRpc
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
  publicPayment,
  publicPaymentPermission,
  publicSenderDeposit,
  publicRecipientDeposit,
  publicVault,
] = publicBefore.value;
if (
  !publicPayment ||
  publicPayment.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicPayment.data).length !== PAYMENT_SIZE ||
  !publicPaymentPermission ||
  publicPaymentPermission.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicPaymentPermission.data).length !== PERMISSION_SIZE ||
  !publicSenderDeposit ||
  publicSenderDeposit.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicSenderDeposit.data).length !== DEPOSIT_SIZE ||
  !publicRecipientDeposit ||
  publicRecipientDeposit.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicRecipientDeposit.data).length !== DEPOSIT_SIZE ||
  !publicVault ||
  publicVault.owner !== TOKEN_PROGRAM_ID ||
  tokenAmount(accountBytes(publicVault.data)) !== TOTAL_VAULT_AMOUNT
) {
  throw new Error("Public delegated topology or vault collateral is invalid");
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

const noopSigner = createNoopSigner(AUTHORITY);
const proposedAdvance = [
  getSetComputeUnitLimitInstruction({ units: 60_000 }),
  getAdvancePaymentInstruction({ payment: addresses.payment }),
];
const proposedClaim = [
  getSetComputeUnitLimitInstruction({ units: 60_000 }),
  getClaimPaymentInstruction({
    claimant: noopSigner,
    payment: addresses.payment,
    claimantDeposit: addresses.deposit,
  }),
];
if (!process.argv.includes(AUTH_APPROVAL_FLAG)) {
  console.log(
    json({
      publicPreflight: {
        cluster: "Solana Devnet and MagicBlock Private ER",
        finalizedReadSlot: publicBefore.context.slot,
        paymentLabel: V21_EXPIRY_PAYMENT_LABEL,
        payment: addresses.payment,
        delegatedOwnersAndAllocationsValid: true,
        vaultCollateral: TOTAL_VAULT_AMOUNT,
        unauthenticatedProtectedReads: "all null",
      },
      proposedSimulationOnlyTransactions: [
        {
          instruction: "advance_payment",
          accounts: [addresses.payment],
          expectedResult: "success with byte-for-byte terminal no-op",
          signerAndFeePayer: AUTHORITY,
        },
        {
          instruction: "claim_payment",
          accounts: [addresses.payment, addresses.deposit],
          expectedResult: "rejected with PaymentRedacted (6022)",
          signerAndFeePayer: AUTHORITY,
          recipientDepositIncluded: false,
        },
      ],
      transactionInstructionCounts: [
        proposedAdvance.length,
        proposedClaim.length,
      ],
      token: "Circle Devnet test USDC",
      expectedSenderAvailableBeforeAndAfter: EXPECTED_SENDER_AVAILABLE,
      splTokenMovement: "none",
      authenticationSigned: false,
      transactionsSigned: false,
      transactionsBroadcast: false,
    }),
  );
  process.exit(0);
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved sender signer");
}
const authentication = await authenticatePrivateEr(keypairPath);
if (
  authentication.identity !== AUTHORITY ||
  authentication.signerClient.identity.address !== AUTHORITY ||
  authentication.signerClient.payer.address !== AUTHORITY
) {
  throw new Error("Authenticated identity does not match the approved sender");
}
const privateRpc = createSolanaRpc(authentication.authenticatedUrl.toString());

async function readPrivateState() {
  const response = await privateRpc
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
  ] = response.value;
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
      "Private terminal topology or sender permission boundary is invalid",
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
    senderDeposit.available !== EXPECTED_SENDER_AVAILABLE ||
    senderDeposit.locked !== 0n ||
    senderDeposit.nextPaymentNonce !== EXPECTED_SENDER_NONCE ||
    senderDeposit.automationPaused ||
    senderDeposit.version !== 1
  ) {
    throw new Error(
      `Unexpected terminal state before retry simulations: ${json({ payment, senderDeposit })}`,
    );
  }
  return {
    payment,
    paymentBytes: accountBytes(paymentAccount.data),
    response,
    senderDeposit,
    senderDepositBytes: accountBytes(senderDepositAccount.data),
  } as const;
}

async function signSimulation(
  instructions: readonly Instruction[],
  returnedAddresses: Address[],
) {
  const { value: latestBlockhash } = await privateRpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) =>
      setTransactionMessageFeePayerSigner(
        authentication.signerClient.payer,
        current,
      ),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(transaction);
  assertIsTransactionWithinSizeLimit(transaction);
  const wire = getBase64EncodedWireTransaction(transaction);
  return {
    serializedBytes: Buffer.from(wire, "base64").length,
    signature: getSignatureFromTransaction(transaction),
    simulation: await privateRpc
      .simulateTransaction(wire, {
        accounts: { addresses: returnedAddresses, encoding: "base64" },
        commitment: "confirmed",
        encoding: "base64",
        innerInstructions: true,
        replaceRecentBlockhash: false,
        sigVerify: true,
      })
      .send(),
  } as const;
}

const before = await readPrivateState();
const advanceInstructions = [
  getSetComputeUnitLimitInstruction({ units: 60_000 }),
  getAdvancePaymentInstruction({ payment: addresses.payment }),
];
const advance = await signSimulation(advanceInstructions, [addresses.payment]);
if (
  advance.simulation.value.err !== null ||
  advance.simulation.value.unitsConsumed === 0n
) {
  throw new Error(
    `Terminal advance simulation did not succeed: ${json(advance.simulation.value)}`,
  );
}
const [advancedPaymentAccount] = advance.simulation.value.accounts ?? [];
if (
  !advancedPaymentAccount ||
  advancedPaymentAccount.owner !== PROGRAM_ID ||
  !bytesEqual(accountBytes(advancedPaymentAccount.data), before.paymentBytes)
) {
  throw new Error("Repeated advance_payment was not a byte-for-byte no-op");
}

const claimInstructions = [
  getSetComputeUnitLimitInstruction({ units: 60_000 }),
  getClaimPaymentInstruction({
    claimant: authentication.signerClient.identity,
    payment: addresses.payment,
    claimantDeposit: addresses.deposit,
  }),
];
const claim = await signSimulation(claimInstructions, [
  addresses.payment,
  addresses.deposit,
]);
if (
  !isPaymentRedactedError(claim.simulation.value.err) ||
  !(claim.simulation.value.logs ?? []).some((line) =>
    line.includes("PaymentRedacted"),
  )
) {
  throw new Error(
    `Duplicate claim did not fail with PaymentRedacted: ${json({
      err: claim.simulation.value.err,
      logs: claim.simulation.value.logs,
    })}`,
  );
}

const [after, publicAfter, unauthenticatedAfter] = await Promise.all([
  readPrivateState(),
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
  !bytesEqual(after.paymentBytes, before.paymentBytes) ||
  !bytesEqual(after.senderDepositBytes, before.senderDepositBytes) ||
  publicAfter.value.some((account, index) => {
    const prior = [publicPayment, publicSenderDeposit, publicVault][index];
    return (
      !account ||
      !prior ||
      account.owner !== prior.owner ||
      !bytesEqual(accountBytes(account.data), accountBytes(prior.data))
    );
  }) ||
  unauthenticatedAfter.value.some((account) => account !== null)
) {
  throw new Error("Retry simulations persisted state or weakened privacy");
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: AUTHORITY,
      challengeAgeSeconds: authentication.challengeAgeSeconds,
      tokenReceived: true,
      tokenPrintedOrStored: false,
      hardwareAttestationIndependentlyVerified: false,
    },
    terminalPreState: {
      privateSlot: before.response.context.slot,
      payment: addresses.payment,
      status: PaymentStatus[before.payment.status],
      redacted: before.payment.redacted,
      escrow: before.payment.amount,
      terminalCommitmentMatches: true,
      senderAvailable: before.senderDeposit.available,
      senderNonce: before.senderDeposit.nextPaymentNonce,
      recipientDepositVisibleToSender: false,
    },
    repeatedAdvanceSimulation: {
      preparedSignature: advance.signature,
      serializedTransactionBytes: advance.serializedBytes,
      slot: advance.simulation.context.slot,
      err: null,
      unitsConsumed: advance.simulation.value.unitsConsumed ?? null,
      stateChanged: false,
      byteForByteNoop: true,
      broadcast: false,
    },
    duplicateClaimSimulation: {
      preparedSignature: claim.signature,
      serializedTransactionBytes: claim.serializedBytes,
      slot: claim.simulation.context.slot,
      expectedError: "PaymentRedacted",
      expectedCustomErrorCode: PAYMENT_REDACTED_ERROR,
      errorMatched: true,
      senderBalanceChanged: false,
      recipientDepositIncluded: false,
      broadcast: false,
    },
    postSimulation: {
      paymentBytesChanged: false,
      senderDepositBytesChanged: false,
      senderAvailable: after.senderDeposit.available,
      publicStateChanged: false,
      vaultBalanceChanged: false,
      unauthenticatedProtectedReads: "all null",
      transactionsBroadcast: false,
    },
  }),
);
