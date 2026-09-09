import { createHash } from "node:crypto";

// Historical version-1 diagnostic retained for the recorded permission failure.
// The terminal live fixture cannot be replayed; version-2 lifecycle runners use
// fresh Payment IDs after the corrected program is deployed.

import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
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
import { getSchedulePaymentInstructionAsync } from "../clients/ts/src/generated/instructions/schedulePayment.ts";
import { findDepositPda } from "../clients/ts/src/generated/pdas/deposit.ts";
import { findPaymentPda } from "../clients/ts/src/generated/pdas/payment.ts";
import { PaymentStatus } from "../clients/ts/src/generated/types/paymentStatus.ts";
import {
  AUTHORITY,
  deriveAddresses,
  PROGRAM_ID,
  USDC_MINT,
} from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { authenticatePrivateEr, PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";

const BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const APPROVAL_FLAG = "--approved-p4-tee-auth-expired-schedule-simulation";
const MAGIC_PROGRAM = "Magic11111111111111111111111111111111111111" as Address;
const RECIPIENT =
  "HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr" as Address;
const PAYMENT_ID = new Uint8Array(
  createHash("sha256")
    .update("protected-pay:phase4:correct-payment:v1")
    .digest(),
);
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOTAL_VAULT_AMOUNT = 3_000_000n;
const PAYMENT_AMOUNT = 1_000_000n;
const EXECUTION_INTERVAL_MILLIS = 60_000n;
const ITERATIONS = 5n;

type EncodedAccountData = readonly [string, string];

function accountBytes(data: EncodedAccountData): Uint8Array {
  if (data[1] !== "base64") {
    throw new Error(`Unexpected account encoding: ${data[1]}`);
  }
  return Buffer.from(data[0], "base64");
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
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

function assertDiscriminator(
  actual: ReadonlyUint8Array,
  expected: ReadonlyUint8Array,
  label: string,
): void {
  if (!bytesEqual(actual, expected)) {
    throw new Error(`${label} discriminator mismatch`);
  }
}

async function permissionPda(protectedAccount: Address) {
  const addressEncoder = getAddressEncoder();
  const [permission] = await getProgramDerivedAddress({
    programAddress: PERMISSION_PROGRAM_ID,
    seeds: [
      Buffer.from("permission:"),
      Buffer.from(addressEncoder.encode(protectedAccount)),
    ],
  });
  return permission;
}

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign TEE authentication without ${APPROVAL_FLAG}`);
}
if (process.argv.includes("--send")) {
  throw new Error("This approved checkpoint is simulation-only; --send is forbidden");
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved sender signer");
}

const sender = await deriveAddresses();
const [[payment], [recipientDeposit]] = await Promise.all([
  findPaymentPda({ paymentId: PAYMENT_ID }, { programAddress: PROGRAM_ID }),
  findDepositPda(
    { user: RECIPIENT, tokenMint: USDC_MINT },
    { programAddress: PROGRAM_ID },
  ),
]);
const [paymentPermission, recipientPermission] = await Promise.all([
  permissionPda(payment),
  permissionPda(recipientDeposit),
]);
const baseRpc = createSolanaRpc(BASE_RPC_URL);
const baseState = await baseRpc
  .getMultipleAccounts(
    [
      payment,
      paymentPermission,
      sender.deposit,
      sender.permission,
      recipientDeposit,
      recipientPermission,
      sender.vaultUsdcAta,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [
  publicPaymentAccount,
  publicPaymentPermissionAccount,
  publicSenderDepositAccount,
  publicSenderPermissionAccount,
  publicRecipientDepositAccount,
  publicRecipientPermissionAccount,
  vaultTokenAccount,
] = baseState.value;
for (const [label, account, length] of [
  ["Payment", publicPaymentAccount, PAYMENT_SIZE],
  ["Payment permission", publicPaymentPermissionAccount, PERMISSION_SIZE],
  ["sender Deposit", publicSenderDepositAccount, DEPOSIT_SIZE],
  ["sender permission", publicSenderPermissionAccount, PERMISSION_SIZE],
  ["recipient Deposit", publicRecipientDepositAccount, DEPOSIT_SIZE],
  ["recipient permission", publicRecipientPermissionAccount, PERMISSION_SIZE],
] as const) {
  if (
    !account ||
    account.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(account.data).length !== length
  ) {
    throw new Error(`${label} failed delegated owner/length validation`);
  }
}
if (
  !vaultTokenAccount ||
  vaultTokenAccount.owner !== TOKEN_PROGRAM_ID ||
  accountBytes(vaultTokenAccount.data).length !== 165 ||
  new DataView(
    accountBytes(vaultTokenAccount.data).buffer,
    accountBytes(vaultTokenAccount.data).byteOffset,
    accountBytes(vaultTokenAccount.data).byteLength,
  ).getBigUint64(64, true) !== TOTAL_VAULT_AMOUNT
) {
  throw new Error("Vault token account failed owner, length, or amount validation");
}
if (!publicPaymentAccount || !publicSenderDepositAccount || !publicRecipientDepositAccount) {
  throw new Error("Required delegated public snapshots are missing");
}
const publicPayment = getPaymentDecoder().decode(accountBytes(publicPaymentAccount.data));
const publicSenderDeposit = getDepositDecoder().decode(
  accountBytes(publicSenderDepositAccount.data),
);
const publicRecipientDeposit = getDepositDecoder().decode(
  accountBytes(publicRecipientDepositAccount.data),
);
assertDiscriminator(publicPayment.discriminator, PAYMENT_DISCRIMINATOR, "Payment");
assertDiscriminator(
  publicSenderDeposit.discriminator,
  DEPOSIT_DISCRIMINATOR,
  "Sender Deposit",
);
assertDiscriminator(
  publicRecipientDeposit.discriminator,
  DEPOSIT_DISCRIMINATOR,
  "Recipient Deposit",
);
if (
  publicPayment.amount !== 0n ||
  publicPayment.initialized ||
  publicSenderDeposit.available !== TOTAL_VAULT_AMOUNT ||
  publicSenderDeposit.locked !== 0n ||
  publicRecipientDeposit.user !== RECIPIENT ||
  publicRecipientDeposit.tokenMint !== USDC_MINT ||
  publicRecipientDeposit.available !== 0n ||
  publicRecipientDeposit.locked !== 0n
) {
  throw new Error("Unexpected public delegated snapshots before schedule simulation");
}

const unauthenticatedRpc = createSolanaRpc(PRIVATE_ER_ORIGIN);
const unauthenticatedBefore = await unauthenticatedRpc
  .getMultipleAccounts(
    [payment, sender.deposit, recipientDeposit],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
if (unauthenticatedBefore.value.some((account) => account !== null)) {
  throw new Error("Unauthenticated Private ER unexpectedly exposed protected state");
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
const privateState = await privateRpc
  .getMultipleAccounts(
    [payment, sender.deposit, recipientDeposit, paymentPermission, sender.permission],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [
  privatePaymentAccount,
  privateSenderDepositAccount,
  privateRecipientDepositForSender,
  privatePaymentPermissionAccount,
  privateSenderPermissionAccount,
] = privateState.value;
if (
  !privatePaymentAccount ||
  privatePaymentAccount.owner !== PROGRAM_ID ||
  accountBytes(privatePaymentAccount.data).length !== PAYMENT_SIZE ||
  !privateSenderDepositAccount ||
  privateSenderDepositAccount.owner !== PROGRAM_ID ||
  accountBytes(privateSenderDepositAccount.data).length !== DEPOSIT_SIZE
) {
  throw new Error("Authenticated Payment or sender Deposit failed owner/length validation");
}
for (const account of [
  privatePaymentPermissionAccount,
  privateSenderPermissionAccount,
]) {
  if (
    !account ||
    account.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(account.data).length !== PERMISSION_SIZE
  ) {
    throw new Error("Authenticated sender-visible permission failed validation");
  }
}
if (privateRecipientDepositForSender !== null) {
  throw new Error("Sender unexpectedly gained read access to recipient Deposit");
}
const privatePayment = getPaymentDecoder().decode(accountBytes(privatePaymentAccount.data));
const privateSenderDeposit = getDepositDecoder().decode(
  accountBytes(privateSenderDepositAccount.data),
);
assertDiscriminator(
  privatePayment.discriminator,
  PAYMENT_DISCRIMINATOR,
  "Private Payment",
);
assertDiscriminator(
  privateSenderDeposit.discriminator,
  DEPOSIT_DISCRIMINATOR,
  "Private sender Deposit",
);
const now = BigInt(Math.floor(Date.now() / 1000));
if (
  !bytesEqual(privatePayment.paymentId, PAYMENT_ID) ||
  privatePayment.sender !== AUTHORITY ||
  privatePayment.recipient !== RECIPIENT ||
  privatePayment.tokenMint !== USDC_MINT ||
  privatePayment.amount !== PAYMENT_AMOUNT ||
  !privatePayment.initialized ||
  privatePayment.redacted ||
  privatePayment.status !== PaymentStatus.Created ||
  privatePayment.taskId !== 0n ||
  privatePayment.expiresAt >= now ||
  privateSenderDeposit.user !== AUTHORITY ||
  privateSenderDeposit.tokenMint !== USDC_MINT ||
  privateSenderDeposit.available !== 2_000_000n ||
  privateSenderDeposit.locked !== PAYMENT_AMOUNT ||
  privateSenderDeposit.nextPaymentNonce !== 2n ||
  privateSenderDeposit.automationPaused
) {
  throw new Error(
    `Unexpected expired private Payment state: ${json({
      now,
      privatePayment,
      privateSenderDeposit,
    })}`,
  );
}

const taskId = privatePayment.expiresAt;
const instructions = [
  getSetComputeUnitLimitInstruction({ units: 400_000 }),
  await getSchedulePaymentInstructionAsync({
    magicProgram: MAGIC_PROGRAM,
    payer: authentication.signerClient.identity,
    payment,
    program: PROGRAM_ID,
    paymentId: PAYMENT_ID,
    taskId,
    executionIntervalMillis: EXECUTION_INTERVAL_MILLIS,
    iterations: ITERATIONS,
  }),
];
const { value: latestBlockhash } = await privateRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) =>
    setTransactionMessageFeePayerSigner(authentication.signerClient.payer, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions(instructions, current),
);
const signedTransaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(signedTransaction);
assertIsTransactionWithinSizeLimit(signedTransaction);
const wire = getBase64EncodedWireTransaction(signedTransaction);
const serializedBytes = Buffer.from(wire, "base64").length;
if (serializedBytes > 1_232) {
  throw new Error(`Payment schedule is ${serializedBytes} bytes; Solana limit is 1232`);
}
const preparedSignature = getSignatureFromTransaction(signedTransaction);
const simulation = await privateRpc
  .simulateTransaction(wire, {
    accounts: {
      addresses: [payment, sender.deposit],
      encoding: "base64",
    },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();

const wasFilteredBeforeExecution =
  simulation.value.err === null &&
  simulation.value.unitsConsumed === 0n &&
  (simulation.value.logs?.length ?? 0) === 0 &&
  (simulation.value.accounts == null ||
    simulation.value.accounts.every((account) => account === null));
if (wasFilteredBeforeExecution) {
  const filteredResult = json({
      authentication: {
        endpoint: PRIVATE_ER_ORIGIN,
        identity: AUTHORITY,
        challengeAgeSeconds: authentication.challengeAgeSeconds,
        tokenReceived: true,
        tokenPrinted: false,
        tokenStored: false,
      },
      expiredPayment: {
        payment,
        now,
        expiresAt: privatePayment.expiresAt,
        expiredBySeconds: now - privatePayment.expiresAt,
        status: PaymentStatus[privatePayment.status],
        amount: privatePayment.amount,
        senderAvailable: privateSenderDeposit.available,
        senderLocked: privateSenderDeposit.locked,
      },
      permissionBoundary: {
        senderCanReadPayment: true,
        senderCanReadSenderDeposit: true,
        senderCanReadRecipientDeposit: false,
        unauthenticatedProtectedReads: "all null",
      },
      attemptedSimulation: {
        cluster: "MagicBlock Private ER on Solana Devnet",
        instruction: "schedule_payment",
        taskId,
        executionIntervalMillis: EXECUTION_INTERVAL_MILLIS,
        iterations: ITERATIONS,
        scheduledTarget: "advance_payment",
        targetAccounts: [payment, sender.deposit, recipientDeposit],
        preparedSignature,
        rpcError: null,
        unitsConsumed: simulation.value.unitsConsumed,
        programLogs: simulation.value.logs,
        returnedAccounts: simulation.value.accounts,
        broadcast: false,
      },
      conclusion: {
        scheduleExecutedInSimulation: false,
        reason:
          "The sender-authenticated query is filtered before execution because advance_payment spans the recipient-only Deposit.",
        unsafeShortcutRejected:
          "Do not add every sender to the recipient's aggregate Deposit permission; current permissions imply read access.",
        recommendedArchitecture:
          "Move automated terminal decisions into a shared per-Payment escrow/state account, then let each party claim into only their own private Deposit.",
        immediateRecoveryAvailable:
          "The sender can call cancel_payment using only the shared Payment and sender Deposit to unlock the 1 USDC.",
      },
    });
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${filteredResult}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  process.exit(0);
}

if (simulation.value.err !== null) {
  console.log(
    json({
      diagnostic: "Expired Payment schedule simulation failed",
      senderCanReadRecipientDeposit: false,
      err: simulation.value.err,
      logs: simulation.value.logs,
    }),
  );
  throw new Error("Signed expired-Payment schedule simulation failed");
}
const [simulatedPaymentAccount, simulatedSenderDepositAccount] =
  simulation.value.accounts ?? [];
if (
  !simulatedPaymentAccount ||
  simulatedPaymentAccount.owner !== PROGRAM_ID ||
  accountBytes(simulatedPaymentAccount.data).length !== PAYMENT_SIZE ||
  !simulatedSenderDepositAccount ||
  simulatedSenderDepositAccount.owner !== PROGRAM_ID ||
  accountBytes(simulatedSenderDepositAccount.data).length !== DEPOSIT_SIZE
) {
  console.log(
    json({
      diagnostic: "Unexpected sender-visible simulation accounts",
      err: simulation.value.err,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      returnData: simulation.value.returnData ?? null,
      returnedAccounts: [simulatedPaymentAccount, simulatedSenderDepositAccount].map(
        (account) =>
          account
            ? {
                owner: account.owner,
                dataLength: accountBytes(account.data).length,
                lamports: account.lamports,
              }
            : null,
      ),
      logs: simulation.value.logs,
    }),
  );
  throw new Error("Schedule simulation returned invalid sender-visible post-state");
}
const simulatedPayment = getPaymentDecoder().decode(
  accountBytes(simulatedPaymentAccount.data),
);
const simulatedSenderDeposit = getDepositDecoder().decode(
  accountBytes(simulatedSenderDepositAccount.data),
);
assertDiscriminator(
  simulatedPayment.discriminator,
  PAYMENT_DISCRIMINATOR,
  "Simulated Payment",
);
assertDiscriminator(
  simulatedSenderDeposit.discriminator,
  DEPOSIT_DISCRIMINATOR,
  "Simulated sender Deposit",
);
if (
  simulatedPayment.taskId !== taskId ||
  simulatedPayment.status !== PaymentStatus.Created ||
  simulatedPayment.amount !== PAYMENT_AMOUNT ||
  simulatedSenderDeposit.available !== 2_000_000n ||
  simulatedSenderDeposit.locked !== PAYMENT_AMOUNT ||
  simulatedSenderDeposit.nextPaymentNonce !== 2n
) {
  throw new Error("Schedule simulation changed financial state or stored wrong task ID");
}
const privateAfter = await privateRpc
  .getMultipleAccounts(
    [payment, sender.deposit, recipientDeposit],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [paymentAfterAccount, senderDepositAfterAccount, recipientAfterForSender] =
  privateAfter.value;
if (
  !paymentAfterAccount ||
  !senderDepositAfterAccount ||
  recipientAfterForSender !== null ||
  !bytesEqual(
    accountBytes(paymentAfterAccount.data),
    accountBytes(privatePaymentAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(senderDepositAfterAccount.data),
    accountBytes(privateSenderDepositAccount.data),
  )
) {
  throw new Error("Simulation persisted state or weakened recipient privacy");
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: AUTHORITY,
      challengeAgeSeconds: authentication.challengeAgeSeconds,
      tokenReceived: true,
      tokenPrinted: false,
      tokenStored: false,
      hardwareAttestationIndependentlyVerified: false,
    },
    expiredPayment: {
      payment,
      now,
      expiresAt: privatePayment.expiresAt,
      expiredBySeconds: now - privatePayment.expiresAt,
      status: PaymentStatus[privatePayment.status],
      amount: privatePayment.amount,
      senderAvailable: privateSenderDeposit.available,
      senderLocked: privateSenderDeposit.locked,
    },
    permissionBoundary: {
      senderCanReadPayment: true,
      senderCanReadSenderDeposit: true,
      senderCanReadRecipientDeposit: false,
      unauthenticatedProtectedReads: "all null",
    },
    simulationOnlyTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: AUTHORITY,
      signer: AUTHORITY,
      instruction: "schedule_payment",
      taskId,
      executionIntervalMillis: EXECUTION_INTERVAL_MILLIS,
      iterations: ITERATIONS,
      scheduledTarget: "advance_payment",
      targetAccounts: [payment, sender.deposit, recipientDeposit],
      financialArgumentsInScheduledInstruction: "none",
      expectedFirstEffectiveTransition: "Expired; unlock 1 USDC back to sender",
      serializedTransactionBytes: serializedBytes,
      preparedSignature,
      signed: true,
      broadcast: false,
      splTokenMovement: "none",
    },
    signedSimulation: {
      slot: simulation.context.slot,
      err: null,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      paymentTaskIdAfter: simulatedPayment.taskId,
      paymentStatusAfter: PaymentStatus[simulatedPayment.status],
      senderAvailableAfter: simulatedSenderDeposit.available,
      senderLockedAfter: simulatedSenderDeposit.locked,
      recipientPostStateRequestedBySender: false,
    },
    postSimulation: {
      privateStatePersisted: false,
      recipientPrivacyWeakened: false,
      transactionBroadcast: false,
    },
  }),
);
