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
import { getCancelPaymentInstruction } from "../clients/ts/src/generated/instructions/cancelPayment.ts";
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
const APPROVAL_FLAG = "--approved-p4-tee-auth-expired-cancel-simulation";
const SEND_REQUESTED = process.argv.includes("--send");
const SEND_APPROVAL_FLAG = "--approved-p4-expired-payment-cancellation";
const MAX_CONFIRMATION_POLLS = 120;
const RECIPIENT =
  "HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr" as Address;
const PAYMENT_ID = new Uint8Array(
  createHash("sha256")
    .update("protected-pay:phase4:correct-payment:v1")
    .digest(),
);
const MEMO_HASH = new Uint8Array(
  createHash("sha256")
    .update("invoice:prototype-001:consulting-services")
    .digest(),
);
const ZERO_32 = new Uint8Array(32);
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const TOTAL_VAULT_AMOUNT = 3_000_000n;
const PAYMENT_AMOUNT = 1_000_000n;

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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
if (SEND_REQUESTED && !process.argv.includes(SEND_APPROVAL_FLAG)) {
  throw new Error(
    `Refusing to broadcast the expired-Payment cancellation without ${SEND_APPROVAL_FLAG}`,
  );
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
const paymentPermission = await permissionPda(payment);

const baseRpc = createSolanaRpc(BASE_RPC_URL);
const baseState = await baseRpc
  .getMultipleAccounts(
    [
      payment,
      paymentPermission,
      sender.deposit,
      sender.permission,
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
  vaultTokenAccount,
] = baseState.value;
for (const [label, account, length] of [
  ["Payment", publicPaymentAccount, PAYMENT_SIZE],
  ["Payment permission", publicPaymentPermissionAccount, PERMISSION_SIZE],
  ["sender Deposit", publicSenderDepositAccount, DEPOSIT_SIZE],
  ["sender permission", publicSenderPermissionAccount, PERMISSION_SIZE],
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
  vaultToken.owner !== sender.vault ||
  vaultToken.amount !== TOTAL_VAULT_AMOUNT
) {
  throw new Error(`Unexpected vault collateral: ${json(vaultToken)}`);
}
if (!publicPaymentAccount || !publicSenderDepositAccount) {
  throw new Error("Required public delegated snapshots are missing");
}
const publicPayment = getPaymentDecoder().decode(
  accountBytes(publicPaymentAccount.data),
);
const publicSenderDeposit = getDepositDecoder().decode(
  accountBytes(publicSenderDepositAccount.data),
);
assertDiscriminator(publicPayment.discriminator, PAYMENT_DISCRIMINATOR, "Payment");
assertDiscriminator(
  publicSenderDeposit.discriminator,
  DEPOSIT_DISCRIMINATOR,
  "Sender Deposit",
);
if (
  !bytesEqual(publicPayment.paymentId, PAYMENT_ID) ||
  publicPayment.sender !== AUTHORITY ||
  publicPayment.recipient !== RECIPIENT ||
  publicPayment.tokenMint !== USDC_MINT ||
  publicPayment.amount !== 0n ||
  publicPayment.status !== PaymentStatus.Created ||
  publicPayment.initialized ||
  publicPayment.redacted ||
  publicSenderDeposit.user !== AUTHORITY ||
  publicSenderDeposit.tokenMint !== USDC_MINT ||
  publicSenderDeposit.available !== TOTAL_VAULT_AMOUNT ||
  publicSenderDeposit.locked !== 0n ||
  publicSenderDeposit.nextPaymentNonce !== 1n ||
  publicSenderDeposit.automationPaused
) {
  throw new Error("Unexpected public delegated snapshots before cancellation simulation");
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
    [payment, paymentPermission, sender.deposit, sender.permission],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [
  privatePaymentAccount,
  privatePaymentPermissionAccount,
  privateSenderDepositAccount,
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
    throw new Error("Authenticated permission failed owner/length validation");
  }
}
const privatePayment = getPaymentDecoder().decode(
  accountBytes(privatePaymentAccount.data),
);
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
  privatePayment.createdAt <= 0n ||
  privatePayment.settleAfter - privatePayment.createdAt !== 60n ||
  privatePayment.expiresAt - privatePayment.createdAt !== 300n ||
  privatePayment.expiresAt >= now ||
  privatePayment.taskId !== 0n ||
  privatePayment.status !== PaymentStatus.Created ||
  !bytesEqual(privatePayment.memoHash, MEMO_HASH) ||
  !bytesEqual(privatePayment.terminalCommitment, ZERO_32) ||
  !privatePayment.initialized ||
  privatePayment.redacted ||
  privatePayment.version !== 1 ||
  privateSenderDeposit.user !== AUTHORITY ||
  privateSenderDeposit.tokenMint !== USDC_MINT ||
  privateSenderDeposit.available !== 2_000_000n ||
  privateSenderDeposit.locked !== PAYMENT_AMOUNT ||
  privateSenderDeposit.nextPaymentNonce !== 2n ||
  privateSenderDeposit.automationPaused ||
  privateSenderDeposit.version !== 1
) {
  throw new Error(
    `Unexpected expired private Payment state: ${json({
      now,
      privatePayment,
      privateSenderDeposit,
    })}`,
  );
}

const cancelInstruction = getCancelPaymentInstruction({
  sender: AUTHORITY,
  payer: authentication.signerClient.identity,
  payment,
  senderDeposit: sender.deposit,
});
if (
  cancelInstruction.accounts.length !== 5 ||
  cancelInstruction.accounts.some((account) => account.address === RECIPIENT) ||
  cancelInstruction.accounts.some((account) => account.address === recipientDeposit)
) {
  throw new Error("Cancellation instruction unexpectedly includes a recipient account");
}
const instructions = [
  getSetComputeUnitLimitInstruction({ units: 200_000 }),
  cancelInstruction,
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
  throw new Error(`Payment cancellation is ${serializedBytes} bytes; Solana limit is 1232`);
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
if (simulation.value.err !== null) {
  throw new Error(
    `Signed expired-Payment cancellation simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
}
if (
  simulation.value.unitsConsumed === 0n ||
  (simulation.value.logs?.length ?? 0) === 0
) {
  throw new Error("Cancellation was filtered before program execution");
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
  throw new Error("Cancellation simulation returned invalid account owners or lengths");
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
  !bytesEqual(simulatedPayment.paymentId, privatePayment.paymentId) ||
  simulatedPayment.sender !== privatePayment.sender ||
  simulatedPayment.recipient !== privatePayment.recipient ||
  simulatedPayment.tokenMint !== privatePayment.tokenMint ||
  simulatedPayment.amount !== privatePayment.amount ||
  simulatedPayment.createdAt !== privatePayment.createdAt ||
  simulatedPayment.settleAfter !== privatePayment.settleAfter ||
  simulatedPayment.expiresAt !== privatePayment.expiresAt ||
  simulatedPayment.taskId !== privatePayment.taskId ||
  simulatedPayment.status !== PaymentStatus.Cancelled ||
  !bytesEqual(simulatedPayment.memoHash, privatePayment.memoHash) ||
  !bytesEqual(
    simulatedPayment.terminalCommitment,
    privatePayment.terminalCommitment,
  ) ||
  simulatedPayment.initialized !== privatePayment.initialized ||
  simulatedPayment.redacted !== privatePayment.redacted ||
  simulatedPayment.version !== privatePayment.version ||
  simulatedPayment.bump !== privatePayment.bump ||
  simulatedSenderDeposit.user !== privateSenderDeposit.user ||
  simulatedSenderDeposit.tokenMint !== privateSenderDeposit.tokenMint ||
  simulatedSenderDeposit.available !== TOTAL_VAULT_AMOUNT ||
  simulatedSenderDeposit.locked !== 0n ||
  simulatedSenderDeposit.nextPaymentNonce !==
    privateSenderDeposit.nextPaymentNonce ||
  simulatedSenderDeposit.automationPaused !==
    privateSenderDeposit.automationPaused ||
  simulatedSenderDeposit.version !== privateSenderDeposit.version
) {
  throw new Error(
    `Cancellation simulation returned unexpected state: ${json({
      simulatedPayment,
      simulatedSenderDeposit,
    })}`,
  );
}

const memoHashHex = Buffer.from(MEMO_HASH).toString("hex");
const logs = simulation.value.logs ?? [];
if (
  logs.some(
    (line) => line.includes(PAYMENT_AMOUNT.toString()) || line.includes(memoHashHex),
  )
) {
  throw new Error("Cancellation logs exposed a protected payment value");
}

const [privateAfterSimulation, publicAfterSimulation, unauthenticatedAfter] =
  await Promise.all([
    privateRpc
      .getMultipleAccounts(
        [payment, sender.deposit],
        { commitment: "confirmed", encoding: "base64" },
      )
      .send(),
    baseRpc
      .getMultipleAccounts(
        [payment, sender.deposit, sender.vaultUsdcAta],
        { commitment: "finalized", encoding: "base64" },
      )
      .send(),
    unauthenticatedRpc
      .getMultipleAccounts(
        [payment, sender.deposit, recipientDeposit],
        { commitment: "confirmed", encoding: "base64" },
      )
      .send(),
  ]);
const [privatePaymentAfterAccount, privateDepositAfterAccount] =
  privateAfterSimulation.value;
const [publicPaymentAfterAccount, publicDepositAfterAccount, publicVaultAfterAccount] =
  publicAfterSimulation.value;
if (
  !privatePaymentAfterAccount ||
  !privateDepositAfterAccount ||
  !publicPaymentAfterAccount ||
  !publicDepositAfterAccount ||
  !publicVaultAfterAccount
) {
  throw new Error("A post-simulation privacy-boundary account is missing");
}
if (
  privatePaymentAfterAccount.owner !== PROGRAM_ID ||
  privateDepositAfterAccount.owner !== PROGRAM_ID ||
  publicPaymentAfterAccount.owner !== DELEGATION_PROGRAM_ID ||
  publicDepositAfterAccount.owner !== DELEGATION_PROGRAM_ID ||
  publicVaultAfterAccount.owner !== TOKEN_PROGRAM_ID ||
  !bytesEqual(
    accountBytes(privatePaymentAfterAccount.data),
    accountBytes(privatePaymentAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(privateDepositAfterAccount.data),
    accountBytes(privateSenderDepositAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(publicPaymentAfterAccount.data),
    accountBytes(publicPaymentAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(publicDepositAfterAccount.data),
    accountBytes(publicSenderDepositAccount.data),
  ) ||
  !bytesEqual(
    accountBytes(publicVaultAfterAccount.data),
    accountBytes(vaultTokenAccount.data),
  ) ||
  unauthenticatedAfter.value.some((account) => account !== null)
) {
  throw new Error("Simulation persisted state or weakened the privacy boundary");
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: AUTHORITY,
      challengeService: "Query Filtering Service",
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
      statusBefore: PaymentStatus[privatePayment.status],
      amount: privatePayment.amount,
    },
    simulationOnlyTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: AUTHORITY,
      signer: AUTHORITY,
      instruction: "cancel_payment",
      token: "Circle Devnet test USDC",
      recipient: RECIPIENT,
      recovery: "Unlock 1.000000 USDC from reserved to sender-available balance",
      instructionAccounts: [AUTHORITY, payment, sender.deposit],
      recipientAccountRequired: false,
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
      paymentStatus: {
        before: PaymentStatus[privatePayment.status],
        after: PaymentStatus[simulatedPayment.status],
      },
      senderDeposit: {
        availableBefore: privateSenderDeposit.available,
        availableAfter: simulatedSenderDeposit.available,
        lockedBefore: privateSenderDeposit.locked,
        lockedAfter: simulatedSenderDeposit.locked,
        nextPaymentNonceUnchanged: true,
      },
      paymentTermsUnchangedExceptStatus: true,
      protectedValuesFoundInProgramLogs: false,
    },
    privacyBoundary: {
      publicPaymentAmount: publicPayment.amount,
      publicPaymentInitialized: publicPayment.initialized,
      publicSenderAvailable: publicSenderDeposit.available,
      publicSenderLocked: publicSenderDeposit.locked,
      vaultRawUsdc: vaultToken.amount,
      unauthenticatedProtectedReads: "all null",
    },
    postSimulation: {
      privateStatePersisted: false,
      publicStateChanged: false,
      vaultBalanceChanged: false,
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
    throw new Error(
      "Private ER returned a signature different from the signed cancellation",
    );
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
      throw new Error(
        `Private Payment cancellation failed after submission: ${json(status.err)}`,
      );
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
      throw new Error("Private Payment cancellation expired before confirmation");
    }
    await wait(500);
  }
  if (!confirmation) {
    throw new Error("Private Payment cancellation confirmation timed out");
  }

  let confirmedPayment;
  let confirmedDeposit;
  for (let poll = 0; poll < 40; poll += 1) {
    const response = await privateRpc
      .getMultipleAccounts(
        [payment, sender.deposit],
        { commitment: "confirmed", encoding: "base64" },
      )
      .send();
    const [paymentAccount, depositAccount] = response.value;
    if (
      paymentAccount?.owner === PROGRAM_ID &&
      accountBytes(paymentAccount.data).length === PAYMENT_SIZE &&
      depositAccount?.owner === PROGRAM_ID &&
      accountBytes(depositAccount.data).length === DEPOSIT_SIZE
    ) {
      const decodedPayment = getPaymentDecoder().decode(
        accountBytes(paymentAccount.data),
      );
      const decodedDeposit = getDepositDecoder().decode(
        accountBytes(depositAccount.data),
      );
      assertDiscriminator(
        decodedPayment.discriminator,
        PAYMENT_DISCRIMINATOR,
        "Confirmed Payment",
      );
      assertDiscriminator(
        decodedDeposit.discriminator,
        DEPOSIT_DISCRIMINATOR,
        "Confirmed sender Deposit",
      );
      if (
        decodedPayment.status === PaymentStatus.Cancelled &&
        decodedDeposit.available === TOTAL_VAULT_AMOUNT &&
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
    throw new Error(
      "Confirmed cancellation was not visible in the authenticated private readback",
    );
  }
  if (
    !bytesEqual(confirmedPayment.paymentId, privatePayment.paymentId) ||
    confirmedPayment.sender !== privatePayment.sender ||
    confirmedPayment.recipient !== privatePayment.recipient ||
    confirmedPayment.tokenMint !== privatePayment.tokenMint ||
    confirmedPayment.amount !== privatePayment.amount ||
    confirmedPayment.createdAt !== privatePayment.createdAt ||
    confirmedPayment.settleAfter !== privatePayment.settleAfter ||
    confirmedPayment.expiresAt !== privatePayment.expiresAt ||
    confirmedPayment.taskId !== privatePayment.taskId ||
    !bytesEqual(confirmedPayment.memoHash, privatePayment.memoHash) ||
    !bytesEqual(
      confirmedPayment.terminalCommitment,
      privatePayment.terminalCommitment,
    ) ||
    confirmedPayment.initialized !== privatePayment.initialized ||
    confirmedPayment.redacted !== privatePayment.redacted ||
    confirmedPayment.version !== privatePayment.version ||
    confirmedPayment.bump !== privatePayment.bump ||
    confirmedDeposit.user !== privateSenderDeposit.user ||
    confirmedDeposit.tokenMint !== privateSenderDeposit.tokenMint ||
    confirmedDeposit.nextPaymentNonce !== privateSenderDeposit.nextPaymentNonce ||
    confirmedDeposit.automationPaused !==
      privateSenderDeposit.automationPaused ||
    confirmedDeposit.version !== privateSenderDeposit.version
  ) {
    throw new Error("Confirmed private recovery state failed exact validation");
  }

  const [publicAfterSend, unauthenticatedAfterSend] = await Promise.all([
    baseRpc
      .getMultipleAccounts(
        [payment, sender.deposit, sender.vaultUsdcAta],
        { commitment: "finalized", encoding: "base64" },
      )
      .send(),
    unauthenticatedRpc
      .getMultipleAccounts(
        [payment, sender.deposit, recipientDeposit],
        { commitment: "confirmed", encoding: "base64" },
      )
      .send(),
  ]);
  const [publicPaymentAfterSend, publicDepositAfterSend, publicVaultAfterSend] =
    publicAfterSend.value;
  if (
    !publicPaymentAfterSend ||
    !publicDepositAfterSend ||
    !publicVaultAfterSend ||
    publicPaymentAfterSend.owner !== DELEGATION_PROGRAM_ID ||
    publicDepositAfterSend.owner !== DELEGATION_PROGRAM_ID ||
    publicVaultAfterSend.owner !== TOKEN_PROGRAM_ID ||
    !bytesEqual(
      accountBytes(publicPaymentAfterSend.data),
      accountBytes(publicPaymentAccount.data),
    ) ||
    !bytesEqual(
      accountBytes(publicDepositAfterSend.data),
      accountBytes(publicSenderDepositAccount.data),
    ) ||
    !bytesEqual(
      accountBytes(publicVaultAfterSend.data),
      accountBytes(vaultTokenAccount.data),
    ) ||
    unauthenticatedAfterSend.value.some((account) => account !== null)
  ) {
    throw new Error(
      "Confirmed cancellation changed public state or weakened private access control",
    );
  }

  console.log(
    json({
      finalizedRecovery: {
        cluster: "MagicBlock Private ER on Solana Devnet",
        signature: submittedSignature,
        slot: confirmation.slot,
        confirmationStatus: confirmation.confirmationStatus,
        payment,
        paymentStatus: PaymentStatus[confirmedPayment.status],
        senderAvailable: confirmedDeposit.available,
        senderLocked: confirmedDeposit.locked,
        nextPaymentNonce: confirmedDeposit.nextPaymentNonce,
        internalAmountRecovered: PAYMENT_AMOUNT,
        token: "Circle Devnet test USDC",
        splTokenMovement: "none; private accounting only",
        recipientSignatureRequired: false,
        publicStateChanged: false,
        vaultBalanceChanged: false,
        unauthenticatedProtectedReads: "all null",
        hardwareAttestationIndependentlyVerified: false,
      },
    }),
  );
}
