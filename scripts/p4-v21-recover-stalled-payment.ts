import { createHash } from "node:crypto";

import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
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
  deriveV2SettlementAddresses,
  V2_RECIPIENT,
  V2_SETTLEMENT_PAYMENT_ID,
  V2_SETTLEMENT_PAYMENT_LABEL,
} from "./p4-v2-settlement-bootstrap.ts";

const DEFAULT_BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const BASE_RPC_URL = (process.env.SOLANA_RPC_URL ??
  DEFAULT_BASE_RPC_URL) as typeof DEFAULT_BASE_RPC_URL;
const AUTH_APPROVAL_FLAG =
  "--approved-p4-v21-tee-auth-stalled-recovery-simulation";
const SEND_APPROVAL_FLAG = "--approved-p4-v21-stalled-payment-recovery";
const AUTH_APPROVED = process.argv.includes(AUTH_APPROVAL_FLAG);
const SEND_REQUESTED = process.argv.includes("--send");
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const TOTAL_VAULT_AMOUNT = 3_000_000n;
const PAYMENT_AMOUNT = 1_000_000n;
const PRIVATE_AVAILABLE_BEFORE = 2_000_000n;
const PRIVATE_AVAILABLE_AFTER = 3_000_000n;
const EXPECTED_TASK_ID = 1_788_965_539_251n;
const EXPECTED_MEMO_HASH = new Uint8Array(
  createHash("sha256")
    .update("invoice:prototype-v2-settlement-001:consulting-services")
    .digest(),
);
const ZERO_32 = new Uint8Array(32);
const ZERO_ADDRESS = "11111111111111111111111111111111" as Address;
const MAX_CONFIRMATION_POLLS = 120;

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

function assertDiscriminator(
  actual: ReadonlyUint8Array,
  expected: ReadonlyUint8Array,
  label: string,
): void {
  if (!bytesEqual(actual, expected)) {
    throw new Error(`${label} discriminator mismatch`);
  }
}

function decodeTokenAccount(data: Uint8Array) {
  if (data.length !== TOKEN_ACCOUNT_SIZE) {
    throw new Error(
      `Expected ${TOKEN_ACCOUNT_SIZE} token-account bytes, received ${data.length}`,
    );
  }
  const addressDecoder = getAddressDecoder();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: addressDecoder.decode(data.slice(0, 32)),
    owner: addressDecoder.decode(data.slice(32, 64)),
    amount: view.getBigUint64(64, true),
  };
}

function terminalCommitment(payment: {
  paymentId: ReadonlyUint8Array;
  sender: Address;
  recipient: Address;
  tokenMint: Address;
  amount: bigint;
  createdAt: bigint;
  settleAfter: bigint;
  expiresAt: bigint;
  memoHash: ReadonlyUint8Array;
}): Uint8Array {
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
      .update(Buffer.from(payment.paymentId))
      .update(Buffer.from(addressEncoder.encode(payment.sender)))
      .update(Buffer.from(addressEncoder.encode(payment.recipient)))
      .update(Buffer.from(addressEncoder.encode(payment.tokenMint)))
      .update(u64(payment.amount))
      .update(i64(payment.createdAt))
      .update(i64(payment.settleAfter))
      .update(i64(payment.expiresAt))
      .update(new Uint8Array([4]))
      .update(Buffer.from(payment.memoHash))
      .digest(),
  );
}

if (SEND_REQUESTED && !AUTH_APPROVED) {
  throw new Error(`Refusing to sign or send without ${AUTH_APPROVAL_FLAG}`);
}
if (SEND_REQUESTED && !process.argv.includes(SEND_APPROVAL_FLAG)) {
  throw new Error(`Refusing to broadcast recovery without ${SEND_APPROVAL_FLAG}`);
}
if (!SEND_REQUESTED && process.argv.includes(SEND_APPROVAL_FLAG)) {
  throw new Error("Recovery broadcast approval requires --send");
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
if (!vaultTokenAccount || vaultTokenAccount.owner !== TOKEN_PROGRAM_ID) {
  throw new Error("Vault token account failed token-program owner validation");
}
const vaultToken = decodeTokenAccount(accountBytes(vaultTokenAccount.data));
if (
  vaultToken.mint !== USDC_MINT ||
  vaultToken.owner !== addresses.vault ||
  vaultToken.amount !== TOTAL_VAULT_AMOUNT
) {
  throw new Error(`Unexpected vault collateral: ${json(vaultToken)}`);
}
if (
  !publicPaymentAccount ||
  !publicSenderDepositAccount ||
  !publicRecipientDepositAccount
) {
  throw new Error("Required delegated public snapshots are missing");
}
const publicPayment = getPaymentDecoder().decode(
  accountBytes(publicPaymentAccount.data),
);
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
  !bytesEqual(publicPayment.paymentId, V2_SETTLEMENT_PAYMENT_ID) ||
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
  publicPayment.version !== 2 ||
  publicSenderDeposit.user !== AUTHORITY ||
  publicSenderDeposit.tokenMint !== USDC_MINT ||
  publicSenderDeposit.available !== TOTAL_VAULT_AMOUNT ||
  publicSenderDeposit.locked !== 0n ||
  publicSenderDeposit.nextPaymentNonce !== 1n ||
  publicSenderDeposit.automationPaused ||
  publicRecipientDeposit.user !== V2_RECIPIENT ||
  publicRecipientDeposit.tokenMint !== USDC_MINT ||
  publicRecipientDeposit.available !== 0n ||
  publicRecipientDeposit.locked !== 0n ||
  publicRecipientDeposit.nextPaymentNonce !== 0n ||
  publicRecipientDeposit.automationPaused ||
  publicRecipientDeposit.version !== 1
) {
  throw new Error(
    `Unexpected delegated public snapshots before recovery: ${json({
      payment: {
        sender: publicPayment.sender,
        recipient: publicPayment.recipient,
        tokenMint: publicPayment.tokenMint,
        amount: publicPayment.amount,
        status: PaymentStatus[publicPayment.status],
        initialized: publicPayment.initialized,
        redacted: publicPayment.redacted,
        version: publicPayment.version,
      },
      senderDeposit: publicSenderDeposit,
      recipientDeposit: publicRecipientDeposit,
    })}`,
  );
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

if (!AUTH_APPROVED) {
  console.log(
    json({
      publicPreflight: {
        cluster: "Solana Devnet and MagicBlock Private ER",
        finalizedReadSlot: baseState.context.slot,
        paymentLabel: V2_SETTLEMENT_PAYMENT_LABEL,
        payment: addresses.payment,
        senderDeposit: addresses.deposit,
        recipientDeposit: addresses.recipientDeposit,
        delegatedOwnersAndAllocationsValid: true,
        publicShellStillHidesPrivateOpenState: true,
        unauthenticatedProtectedReads: "all null",
        vaultCollateral: vaultToken.amount,
      },
      guardedRecoveryPath: {
        executionEnvironment: "MagicBlock Private ER on Solana Devnet",
        instructions: ["advance_payment", "claim_payment"],
        atomic: true,
        signerAndFeePayer: AUTHORITY,
        expectedInternalRecovery: PAYMENT_AMOUNT,
        splTokenMovement: "none; private accounting only",
        recipientSignatureRequired: false,
        recipientDepositRequired: false,
        authenticationSigned: false,
        transactionSigned: false,
        transactionBroadcast: false,
      },
      privateTerminalStateRequiresAuthorizedRead: true,
      authenticationOrTransactionSigned: false,
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
  privatePaymentAccount,
  privatePaymentPermissionAccount,
  privateSenderDepositAccount,
  privateSenderPermissionAccount,
  recipientDepositForSender,
] = privateState.value;
if (
  !privatePaymentAccount ||
  privatePaymentAccount.owner !== PROGRAM_ID ||
  accountBytes(privatePaymentAccount.data).length !== PAYMENT_SIZE ||
  !privateSenderDepositAccount ||
  privateSenderDepositAccount.owner !== PROGRAM_ID ||
  accountBytes(privateSenderDepositAccount.data).length !== DEPOSIT_SIZE ||
  !privatePaymentPermissionAccount ||
  privatePaymentPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
  accountBytes(privatePaymentPermissionAccount.data).length !== PERMISSION_SIZE ||
  !privateSenderPermissionAccount ||
  privateSenderPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
  accountBytes(privateSenderPermissionAccount.data).length !== PERMISSION_SIZE ||
  recipientDepositForSender !== null
) {
  throw new Error("Sender private-state permission boundary is invalid");
}
const paymentBefore = getPaymentDecoder().decode(
  accountBytes(privatePaymentAccount.data),
);
const senderDepositBefore = getDepositDecoder().decode(
  accountBytes(privateSenderDepositAccount.data),
);
assertDiscriminator(
  paymentBefore.discriminator,
  PAYMENT_DISCRIMINATOR,
  "Private Payment",
);
assertDiscriminator(
  senderDepositBefore.discriminator,
  DEPOSIT_DISCRIMINATOR,
  "Private sender Deposit",
);
const now = BigInt(Math.floor(Date.now() / 1000));
if (
  !bytesEqual(paymentBefore.paymentId, V2_SETTLEMENT_PAYMENT_ID) ||
  paymentBefore.sender !== AUTHORITY ||
  paymentBefore.recipient !== V2_RECIPIENT ||
  paymentBefore.tokenMint !== USDC_MINT ||
  paymentBefore.amount !== PAYMENT_AMOUNT ||
  paymentBefore.createdAt <= 0n ||
  paymentBefore.settleAfter - paymentBefore.createdAt !== 60n ||
  paymentBefore.expiresAt - paymentBefore.createdAt !== 300n ||
  paymentBefore.expiresAt >= now ||
  paymentBefore.taskId !== EXPECTED_TASK_ID ||
  paymentBefore.status !== PaymentStatus.Created ||
  !bytesEqual(paymentBefore.memoHash, EXPECTED_MEMO_HASH) ||
  !bytesEqual(paymentBefore.terminalCommitment, ZERO_32) ||
  !paymentBefore.initialized ||
  paymentBefore.redacted ||
  paymentBefore.version !== 2 ||
  senderDepositBefore.user !== AUTHORITY ||
  senderDepositBefore.tokenMint !== USDC_MINT ||
  senderDepositBefore.available !== PRIVATE_AVAILABLE_BEFORE ||
  senderDepositBefore.locked !== 0n ||
  senderDepositBefore.nextPaymentNonce !== 3n ||
  senderDepositBefore.automationPaused ||
  senderDepositBefore.version !== 1
) {
  throw new Error(
    `Unexpected private state before stalled-payment recovery: ${json({
      now,
      paymentBefore,
      senderDepositBefore,
    })}`,
  );
}

const expectedTerminalCommitment = terminalCommitment(paymentBefore);
const instructions = [
  getSetComputeUnitLimitInstruction({ units: 120_000 }),
  getAdvancePaymentInstruction({ payment: addresses.payment }),
  getClaimPaymentInstruction({
    claimant: authentication.signerClient.identity,
    payment: addresses.payment,
    claimantDeposit: addresses.deposit,
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
  throw new Error(`Atomic recovery is ${serializedBytes} bytes; Solana limit is 1232`);
}
const preparedSignature = getSignatureFromTransaction(signedTransaction);
const simulation = await privateRpc
  .simulateTransaction(wire, {
    accounts: {
      addresses: [addresses.payment, addresses.deposit],
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
    `Signed atomic recovery simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
}
if (
  simulation.value.unitsConsumed === 0n ||
  (simulation.value.logs?.length ?? 0) === 0
) {
  throw new Error("Atomic recovery was filtered before program execution");
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
  throw new Error("Recovery simulation returned invalid account owners or lengths");
}
const paymentAfter = getPaymentDecoder().decode(
  accountBytes(simulatedPaymentAccount.data),
);
const senderDepositAfter = getDepositDecoder().decode(
  accountBytes(simulatedSenderDepositAccount.data),
);
assertDiscriminator(
  paymentAfter.discriminator,
  PAYMENT_DISCRIMINATOR,
  "Simulated Payment",
);
assertDiscriminator(
  senderDepositAfter.discriminator,
  DEPOSIT_DISCRIMINATOR,
  "Simulated sender Deposit",
);
if (
  !bytesEqual(paymentAfter.paymentId, paymentBefore.paymentId) ||
  paymentAfter.sender !== paymentBefore.sender ||
  paymentAfter.recipient !== ZERO_ADDRESS ||
  paymentAfter.tokenMint !== paymentBefore.tokenMint ||
  paymentAfter.amount !== 0n ||
  paymentAfter.createdAt !== 0n ||
  paymentAfter.settleAfter !== 0n ||
  paymentAfter.expiresAt !== 0n ||
  paymentAfter.taskId !== 0n ||
  paymentAfter.status !== PaymentStatus.Expired ||
  !bytesEqual(paymentAfter.memoHash, ZERO_32) ||
  !bytesEqual(paymentAfter.terminalCommitment, expectedTerminalCommitment) ||
  !paymentAfter.initialized ||
  !paymentAfter.redacted ||
  paymentAfter.version !== paymentBefore.version ||
  paymentAfter.bump !== paymentBefore.bump ||
  senderDepositAfter.user !== senderDepositBefore.user ||
  senderDepositAfter.tokenMint !== senderDepositBefore.tokenMint ||
  senderDepositAfter.available !== PRIVATE_AVAILABLE_AFTER ||
  senderDepositAfter.locked !== 0n ||
  senderDepositAfter.nextPaymentNonce !== senderDepositBefore.nextPaymentNonce ||
  senderDepositAfter.automationPaused !== senderDepositBefore.automationPaused ||
  senderDepositAfter.version !== senderDepositBefore.version
) {
  throw new Error(
    `Atomic recovery simulation returned unexpected state: ${json({
      paymentAfter,
      senderDepositAfter,
    })}`,
  );
}
const logs = simulation.value.logs ?? [];
if (
  logs.some(
    (line) =>
      line.includes(PAYMENT_AMOUNT.toString()) ||
      line.includes(Buffer.from(EXPECTED_MEMO_HASH).toString("hex")),
  )
) {
  throw new Error("Recovery logs exposed protected payment data");
}

const [privateAfterSimulation, publicAfterSimulation, unauthenticatedAfter] =
  await Promise.all([
    privateRpc
      .getMultipleAccounts(
        [addresses.payment, addresses.deposit],
        { commitment: "confirmed", encoding: "base64" },
      )
      .send(),
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
const [privatePaymentAfterSimulation, privateDepositAfterSimulation] =
  privateAfterSimulation.value;
const [publicPaymentAfterSimulation, publicDepositAfterSimulation, vaultAfter] =
  publicAfterSimulation.value;
if (
  !privatePaymentAfterSimulation ||
  !privateDepositAfterSimulation ||
  !publicPaymentAfterSimulation ||
  !publicDepositAfterSimulation ||
  !vaultAfter ||
  !bytesEqual(
    accountBytes(privatePaymentAfterSimulation.data),
    accountBytes(privatePaymentAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(privateDepositAfterSimulation.data),
    accountBytes(privateSenderDepositAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(publicPaymentAfterSimulation.data),
    accountBytes(publicPaymentAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(publicDepositAfterSimulation.data),
    accountBytes(publicSenderDepositAccount.data),
  ) ||
  !bytesEqual(accountBytes(vaultAfter.data), accountBytes(vaultTokenAccount.data)) ||
  unauthenticatedAfter.value.some((account) => account !== null)
) {
  throw new Error("Simulation persisted state or weakened the privacy boundary");
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
    stalledPayment: {
      payment: addresses.payment,
      taskId: paymentBefore.taskId,
      observedAt: now,
      expiresAt: paymentBefore.expiresAt,
      expiredBySeconds: now - paymentBefore.expiresAt,
      statusBefore: PaymentStatus[paymentBefore.status],
      privateEscrowAmount: paymentBefore.amount,
    },
    simulationOnlyTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      instructions: ["advance_payment", "claim_payment"],
      atomic: true,
      feePayerAndSigner: AUTHORITY,
      payment: addresses.payment,
      claimantDeposit: addresses.deposit,
      recipientSignatureRequired: false,
      recipientDepositIncluded: false,
      serializedTransactionBytes: serializedBytes,
      preparedSignature,
      signed: true,
      broadcast: false,
      splTokenMovement: "none; private accounting only",
    },
    signedSimulation: {
      slot: simulation.context.slot,
      err: null,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      paymentStatusBefore: PaymentStatus[paymentBefore.status],
      paymentStatusAfter: PaymentStatus[paymentAfter.status],
      paymentRedactedAfterClaim: paymentAfter.redacted,
      terminalCommitmentMatches: true,
      senderAvailableBefore: senderDepositBefore.available,
      senderAvailableAfter: senderDepositAfter.available,
      senderLockedUnchanged: true,
      protectedDataFoundInLogs: false,
    },
    postSimulation: {
      privateStatePersisted: false,
      publicStateChanged: false,
      vaultBalanceChanged: false,
      unauthenticatedProtectedReads: "all null",
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
    throw new Error("Private ER returned a different recovery signature");
  }

  let confirmation:
    | {
        slot: bigint;
        confirmationStatus?: "processed" | "confirmed" | "finalized";
        err: unknown;
      }
    | undefined;
  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const response = await privateRpc
      .getSignatureStatuses([preparedSignature], {
        searchTransactionHistory: true,
      })
      .send();
    const status = response.value[0];
    if (status?.err) {
      throw new Error(`Stalled-payment recovery failed: ${json(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      confirmation = {
        slot: status.slot,
        confirmationStatus: status.confirmationStatus,
        err: status.err,
      };
      break;
    }
    const blockHeight = await privateRpc
      .getBlockHeight({ commitment: "confirmed" })
      .send();
    if (blockHeight > latestBlockhash.lastValidBlockHeight) {
      throw new Error("Stalled-payment recovery expired before confirmation");
    }
    await wait(500);
  }
  if (!confirmation) {
    throw new Error("Stalled-payment recovery confirmation timed out");
  }

  let confirmedPayment;
  let confirmedDeposit;
  for (let poll = 0; poll < 40; poll += 1) {
    const response = await privateRpc
      .getMultipleAccounts(
        [addresses.payment, addresses.deposit],
        { commitment: "confirmed", encoding: "base64" },
      )
      .send();
    const [paymentAccount, depositAccount] = response.value;
    if (
      paymentAccount?.owner === PROGRAM_ID &&
      depositAccount?.owner === PROGRAM_ID
    ) {
      const decodedPayment = getPaymentDecoder().decode(
        accountBytes(paymentAccount.data),
      );
      const decodedDeposit = getDepositDecoder().decode(
        accountBytes(depositAccount.data),
      );
      if (
        decodedPayment.status === PaymentStatus.Expired &&
        decodedPayment.redacted &&
        bytesEqual(
          decodedPayment.terminalCommitment,
          expectedTerminalCommitment,
        ) &&
        decodedDeposit.available === PRIVATE_AVAILABLE_AFTER &&
        decodedDeposit.locked === 0n
      ) {
        confirmedPayment = decodedPayment;
        confirmedDeposit = decodedDeposit;
        break;
      }
    }
    await wait(250);
  }
  if (!confirmedPayment || !confirmedDeposit) {
    throw new Error("Confirmed recovery state was not visible in private readback");
  }

  const [publicAfterSend, unauthenticatedAfterSend] = await Promise.all([
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
  const [publicPaymentAfterSend, publicDepositAfterSend, vaultAfterSend] =
    publicAfterSend.value;
  if (
    !publicPaymentAfterSend ||
    !publicDepositAfterSend ||
    !vaultAfterSend ||
    !bytesEqual(
      accountBytes(publicPaymentAfterSend.data),
      accountBytes(publicPaymentAccount.data),
    ) ||
    !bytesEqual(
      accountBytes(publicDepositAfterSend.data),
      accountBytes(publicSenderDepositAccount.data),
    ) ||
    !bytesEqual(
      accountBytes(vaultAfterSend.data),
      accountBytes(vaultTokenAccount.data),
    ) ||
    unauthenticatedAfterSend.value.some((account) => account !== null)
  ) {
    throw new Error("Recovery changed public state or weakened privacy");
  }

  console.log(
    json({
      confirmedRecovery: {
        cluster: "MagicBlock Private ER on Solana Devnet",
        signature: submittedSignature,
        slot: confirmation.slot,
        confirmationStatus: confirmation.confirmationStatus,
        payment: addresses.payment,
        paymentStatus: PaymentStatus[confirmedPayment.status],
        paymentRedacted: confirmedPayment.redacted,
        terminalCommitmentMatches: true,
        senderAvailable: confirmedDeposit.available,
        senderLocked: confirmedDeposit.locked,
        internalAmountRecovered: PAYMENT_AMOUNT,
        token: "Circle Devnet test USDC",
        splTokenMovement: "none; private accounting only",
        recipientSignatureRequired: false,
        publicStateChanged: false,
        vaultBalanceChanged: false,
        unauthenticatedProtectedReads: "all null",
      },
    }),
  );
}
