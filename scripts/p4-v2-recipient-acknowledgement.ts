import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
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
import { getAcknowledgePaymentInstruction } from "../clients/ts/src/generated/instructions/acknowledgePayment.ts";
import { PaymentStatus } from "../clients/ts/src/generated/types/paymentStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { authenticatePrivateEr, PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";
import {
  deriveV2SettlementAddresses,
  V2_RECIPIENT,
  V2_SETTLEMENT_PAYMENT_ID,
  V2_SETTLEMENT_PAYMENT_LABEL,
} from "./p4-v2-settlement-bootstrap.ts";

const DEFAULT_BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const BASE_RPC_URL = (process.env.SOLANA_RPC_URL ??
  DEFAULT_BASE_RPC_URL) as typeof DEFAULT_BASE_RPC_URL;
const APPROVAL_FLAG =
  "--approved-p4-v2-recipient-tee-acknowledgement-simulation";
const SEND_APPROVAL_FLAG = "--approved-p4-v2-recipient-acknowledgement";
const SEND_REQUESTED = process.argv.includes("--send");
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const PAYMENT_AMOUNT = 1_000_000n;
const TOTAL_VAULT_AMOUNT = 3_000_000n;

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
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to authenticate or sign without ${APPROVAL_FLAG}`);
}
if (SEND_REQUESTED && !process.argv.includes(SEND_APPROVAL_FLAG)) {
  throw new Error(`Refusing to send acknowledgement without ${SEND_APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved recipient signer");
}

const addresses = await deriveV2SettlementAddresses();
const baseRpc = createSolanaRpc(BASE_RPC_URL);
const baseState = await baseRpc
  .getMultipleAccounts(
    [
      addresses.payment,
      addresses.paymentPermission,
      addresses.deposit,
      addresses.permission,
      addresses.recipientDeposit,
      addresses.recipientPermission,
      addresses.vaultUsdcAta,
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
  authentication.identity !== V2_RECIPIENT ||
  authentication.signerClient.identity.address !== V2_RECIPIENT ||
  authentication.signerClient.payer.address !== V2_RECIPIENT
) {
  throw new Error("Authenticated identity does not match the approved recipient");
}
const privateRpc = createSolanaRpc(authentication.authenticatedUrl.toString());
const privateState = await privateRpc
  .getMultipleAccounts(
    [
      addresses.payment,
      addresses.paymentPermission,
      addresses.recipientDeposit,
      addresses.recipientPermission,
      addresses.deposit,
    ],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [
  paymentAccount,
  paymentPermissionAccount,
  recipientDepositAccount,
  recipientPermissionAccount,
  senderDepositForRecipient,
] = privateState.value;
if (
  !paymentAccount ||
  paymentAccount.owner !== PROGRAM_ID ||
  accountBytes(paymentAccount.data).length !== PAYMENT_SIZE ||
  !recipientDepositAccount ||
  recipientDepositAccount.owner !== PROGRAM_ID ||
  accountBytes(recipientDepositAccount.data).length !== DEPOSIT_SIZE ||
  !paymentPermissionAccount ||
  paymentPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
  accountBytes(paymentPermissionAccount.data).length !== PERMISSION_SIZE ||
  !recipientPermissionAccount ||
  recipientPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
  accountBytes(recipientPermissionAccount.data).length !== PERMISSION_SIZE ||
  senderDepositForRecipient !== null
) {
  throw new Error("Recipient private-state permission boundary is invalid");
}
const paymentBefore = getPaymentDecoder().decode(accountBytes(paymentAccount.data));
const recipientDepositBefore = getDepositDecoder().decode(
  accountBytes(recipientDepositAccount.data),
);
const now = BigInt(Math.floor(Date.now() / 1000));
if (
  !bytesEqual(paymentBefore.discriminator, PAYMENT_DISCRIMINATOR) ||
  !bytesEqual(paymentBefore.paymentId, V2_SETTLEMENT_PAYMENT_ID) ||
  paymentBefore.sender !== AUTHORITY ||
  paymentBefore.recipient !== V2_RECIPIENT ||
  paymentBefore.tokenMint !== USDC_MINT ||
  paymentBefore.amount !== PAYMENT_AMOUNT ||
  !paymentBefore.initialized ||
  paymentBefore.redacted ||
  paymentBefore.version !== 2 ||
  paymentBefore.taskId <= 0n ||
  paymentBefore.createdAt <= 0n ||
  !bytesEqual(recipientDepositBefore.discriminator, DEPOSIT_DISCRIMINATOR) ||
  recipientDepositBefore.user !== V2_RECIPIENT ||
  recipientDepositBefore.tokenMint !== USDC_MINT ||
  recipientDepositBefore.available !== 0n ||
  recipientDepositBefore.locked !== 0n ||
  recipientDepositBefore.version !== 1
) {
  throw new Error("Recipient-visible Payment or Deposit failed identity validation");
}
if (
  paymentBefore.status !== PaymentStatus.Created ||
  paymentBefore.expiresAt <= now
) {
  console.log(
    json({
      authentication: {
        endpoint: PRIVATE_ER_ORIGIN,
        identity: V2_RECIPIENT,
        challengeAgeSeconds: authentication.challengeAgeSeconds,
        tokenReceived: true,
        tokenPrinted: false,
        tokenStored: false,
      },
      acknowledgementUnavailable: {
        payment: addresses.payment,
        status: PaymentStatus[paymentBefore.status],
        createdAt: paymentBefore.createdAt,
        expiresAt: paymentBefore.expiresAt,
        observedAt: now,
        expiredBySeconds:
          now > paymentBefore.expiresAt ? now - paymentBefore.expiresAt : 0n,
        taskId: paymentBefore.taskId,
        amount: paymentBefore.amount,
        recipientDepositUnchanged: true,
        senderDepositVisibleToRecipient: false,
        acknowledgementSigned: false,
        acknowledgementBroadcast: false,
      },
    }),
  );
  process.exit(0);
}

const instructions = [
  getSetComputeUnitLimitInstruction({ units: 100_000 }),
  getAcknowledgePaymentInstruction({
    recipient: authentication.signerClient.identity,
    payment: addresses.payment,
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
const preparedSignature = getSignatureFromTransaction(signedTransaction);
const simulation = await privateRpc
  .simulateTransaction(wire, {
    accounts: {
      addresses: [addresses.payment, addresses.recipientDeposit],
      encoding: "base64",
    },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(
    `Signed acknowledgement simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
}
const [simulatedPaymentAccount, simulatedRecipientDepositAccount] =
  simulation.value.accounts ?? [];
if (
  !simulatedPaymentAccount ||
  simulatedPaymentAccount.owner !== PROGRAM_ID ||
  !simulatedRecipientDepositAccount ||
  simulatedRecipientDepositAccount.owner !== PROGRAM_ID ||
  !bytesEqual(
    accountBytes(simulatedRecipientDepositAccount.data),
    accountBytes(recipientDepositAccount.data),
  )
) {
  throw new Error("Acknowledgement simulation returned invalid account state");
}
const paymentAfter = getPaymentDecoder().decode(
  accountBytes(simulatedPaymentAccount.data),
);
if (
  !bytesEqual(paymentAfter.paymentId, paymentBefore.paymentId) ||
  paymentAfter.sender !== paymentBefore.sender ||
  paymentAfter.recipient !== paymentBefore.recipient ||
  paymentAfter.tokenMint !== paymentBefore.tokenMint ||
  paymentAfter.amount !== paymentBefore.amount ||
  paymentAfter.createdAt !== paymentBefore.createdAt ||
  paymentAfter.settleAfter !== paymentBefore.settleAfter ||
  paymentAfter.expiresAt !== paymentBefore.expiresAt ||
  paymentAfter.taskId !== paymentBefore.taskId ||
  !bytesEqual(paymentAfter.memoHash, paymentBefore.memoHash) ||
  !bytesEqual(paymentAfter.terminalCommitment, paymentBefore.terminalCommitment) ||
  paymentAfter.status !== PaymentStatus.Acknowledged ||
  !paymentAfter.initialized ||
  paymentAfter.redacted ||
  paymentAfter.version !== 2
) {
  throw new Error(`Acknowledgement simulation changed unexpected fields: ${json(paymentAfter)}`);
}
const memoHashHex = Buffer.from(paymentBefore.memoHash).toString("hex");
const logs = simulation.value.logs ?? [];
if (
  logs.some(
    (line) => line.includes(PAYMENT_AMOUNT.toString()) || line.includes(memoHashHex),
  )
) {
  throw new Error("Acknowledgement logs exposed protected payment data");
}

const [privateAfterSimulation, publicAfterSimulation, unauthenticatedAfter] =
  await Promise.all([
    privateRpc
      .getMultipleAccounts(
        [addresses.payment, addresses.recipientDeposit, addresses.deposit],
        { commitment: "confirmed", encoding: "base64" },
      )
      .send(),
    baseRpc
      .getMultipleAccounts(
        [addresses.payment, addresses.recipientDeposit, addresses.vaultUsdcAta],
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
const [privatePaymentAfter, privateRecipientAfter, privateSenderForRecipientAfter] =
  privateAfterSimulation.value;
const [publicPaymentAfter, publicRecipientAfter, publicVaultAfter] =
  publicAfterSimulation.value;
if (
  !privatePaymentAfter ||
  !privateRecipientAfter ||
  privateSenderForRecipientAfter !== null ||
  !publicPaymentAfter ||
  !publicRecipientAfter ||
  !publicVaultAfter ||
  !bytesEqual(accountBytes(privatePaymentAfter.data), accountBytes(paymentAccount.data)) ||
  !bytesEqual(
    accountBytes(privateRecipientAfter.data),
    accountBytes(recipientDepositAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(publicPaymentAfter.data),
    accountBytes(publicPaymentAccount!.data),
  ) ||
  !bytesEqual(
    accountBytes(publicRecipientAfter.data),
    accountBytes(publicRecipientDepositAccount!.data),
  ) ||
  !bytesEqual(accountBytes(publicVaultAfter.data), accountBytes(vaultTokenAccount.data)) ||
  unauthenticatedAfter.value.some((account) => account !== null)
) {
  throw new Error("Simulation persisted state or weakened the privacy boundary");
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: V2_RECIPIENT,
      challengeAgeSeconds: authentication.challengeAgeSeconds,
      tokenReceived: true,
      tokenPrinted: false,
      tokenStored: false,
      hardwareAttestationIndependentlyVerified: false,
    },
    privacyPreflight: {
      publicFinalizedSlot: baseState.context.slot,
      privateAuthorizedSlot: privateState.context.slot,
      recipientCanReadPayment: true,
      recipientCanReadOwnDeposit: true,
      recipientCanReadSenderDeposit: false,
      unauthenticatedProtectedReads: "all null",
    },
    simulationOnlyTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: V2_RECIPIENT,
      signer: V2_RECIPIENT,
      instruction: "acknowledge_payment",
      paymentLabel: V2_SETTLEMENT_PAYMENT_LABEL,
      payment: addresses.payment,
      token: "Circle Devnet test USDC",
      amountMoved: "0",
      recipientDepositIncludedInInstruction: false,
      senderDepositIncludedInInstruction: false,
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
      paymentStatusBefore: PaymentStatus[paymentBefore.status],
      paymentStatusAfter: PaymentStatus[paymentAfter.status],
      paymentTaskId: paymentAfter.taskId,
      paymentAmountUnchanged: true,
      paymentTermsUnchanged: true,
      recipientDepositUnchanged: true,
      protectedDataFoundInLogs: false,
    },
    postSimulation: {
      privateStatePersisted: false,
      publicStateChanged: false,
      unauthenticatedPrivateRead: "all null",
      transactionBroadcast: false,
    },
  }),
);

if (SEND_REQUESTED) {
  const submittedSignature = await privateRpc
    .sendTransaction(wire, {
      encoding: "base64",
      maxRetries: 5n,
      preflightCommitment: "confirmed",
      skipPreflight: false,
    })
    .send();
  if (submittedSignature !== preparedSignature) {
    throw new Error("Private ER returned a different acknowledgement signature");
  }
  let confirmation;
  for (let poll = 0; poll < 120; poll += 1) {
    const response = await privateRpc
      .getSignatureStatuses([preparedSignature], { searchTransactionHistory: true })
      .send();
    const status = response.value[0];
    if (status?.err) {
      throw new Error(`Recipient acknowledgement failed: ${json(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      confirmation = status;
      break;
    }
    await wait(500);
  }
  if (!confirmation) {
    throw new Error("Recipient acknowledgement confirmation timed out");
  }
  const confirmed = await privateRpc
    .getAccountInfo(addresses.payment, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!confirmed.value || confirmed.value.owner !== PROGRAM_ID) {
    throw new Error("Confirmed acknowledgement Payment is unavailable");
  }
  const confirmedPayment = getPaymentDecoder().decode(
    accountBytes(confirmed.value.data),
  );
  if (
    confirmedPayment.status !== PaymentStatus.Acknowledged ||
    confirmedPayment.amount !== PAYMENT_AMOUNT ||
    confirmedPayment.taskId !== paymentBefore.taskId ||
    confirmedPayment.version !== 2
  ) {
    throw new Error("Confirmed acknowledgement state is invalid");
  }
  console.log(
    json({
      confirmedPrivateTransaction: {
        cluster: "MagicBlock Private ER on Solana Devnet",
        signature: preparedSignature,
        confirmation,
        feePayer: V2_RECIPIENT,
        instruction: "acknowledge_payment",
        payment: addresses.payment,
        status: PaymentStatus[confirmedPayment.status],
        amountMoved: "0",
        splTokenMovement: "none",
      },
    }),
  );
}
