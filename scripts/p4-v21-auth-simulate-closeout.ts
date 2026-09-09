import { createHash } from "node:crypto";

import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
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
  type ReadonlyUint8Array,
  type Signature,
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
import { getCommitAndUndelegatePaymentInstruction } from "../clients/ts/src/generated/instructions/commitAndUndelegatePayment.ts";
import { PaymentStatus } from "../clients/ts/src/generated/types/paymentStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
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

const APPROVAL_FLAG =
  "--approved-p4-v21-expiry-tee-auth-closeout-simulation";
const BROADCAST_APPROVAL_FLAG =
  "--approved-p4-v21-expiry-terminal-closeout-broadcast";
const SEND_REQUESTED = process.argv.includes("--send");
const MAX_CONFIRMATION_POLLS = 180;
const PUBLIC_RPC_URL = "https://api.devnet.solana.com" as const;
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const EXPECTED_VAULT_AMOUNT = 3_000_000n;
const EXPECTED_SENDER_AVAILABLE = 2_000_000n;
const EXPECTED_SENDER_NONCE = 5n;
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function expectedTerminalCommitment(): Uint8Array {
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

function validatePayment(data: Uint8Array) {
  if (data.length !== PAYMENT_SIZE) {
    throw new Error("Payment allocation is invalid");
  }
  const payment = getPaymentDecoder().decode(data);
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
    !bytesEqual(payment.terminalCommitment, expectedTerminalCommitment()) ||
    !payment.initialized ||
    !payment.redacted ||
    payment.version !== 2
  ) {
    throw new Error(`Terminal Payment is invalid: ${json(payment)}`);
  }
  return payment;
}

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(
    `Refusing to sign TEE authentication or a simulation transaction without ${APPROVAL_FLAG}`,
  );
}
if (SEND_REQUESTED && !process.argv.includes(BROADCAST_APPROVAL_FLAG)) {
  throw new Error(
    `Refusing to broadcast terminal closeout without ${BROADCAST_APPROVAL_FLAG}`,
  );
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

const addresses = await deriveV21ExpiryAddresses();
const privateRpc = createSolanaRpc(authentication.authenticatedUrl.toString());
const publicRpc = createSolanaRpc(PUBLIC_RPC_URL);
const unauthenticatedRpc = createSolanaRpc(PRIVATE_ER_ORIGIN);

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
    !paymentPermission ||
    paymentPermission.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(paymentPermission.data).length !== PERMISSION_SIZE ||
    !senderDepositAccount ||
    senderDepositAccount.owner !== PROGRAM_ID ||
    accountBytes(senderDepositAccount.data).length !== DEPOSIT_SIZE ||
    !senderPermission ||
    senderPermission.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(senderPermission.data).length !== PERMISSION_SIZE ||
    recipientDepositForSender !== null
  ) {
    throw new Error("Private topology or sender permission boundary is invalid");
  }
  const paymentBytes = accountBytes(paymentAccount.data);
  const payment = validatePayment(paymentBytes);
  const senderDepositBytes = accountBytes(senderDepositAccount.data);
  const senderDeposit = getDepositDecoder().decode(senderDepositBytes);
  if (
    !bytesEqual(senderDeposit.discriminator, DEPOSIT_DISCRIMINATOR) ||
    senderDeposit.user !== AUTHORITY ||
    senderDeposit.tokenMint !== USDC_MINT ||
    senderDeposit.available !== EXPECTED_SENDER_AVAILABLE ||
    senderDeposit.locked !== 0n ||
    senderDeposit.nextPaymentNonce !== EXPECTED_SENDER_NONCE ||
    senderDeposit.automationPaused ||
    senderDeposit.version !== 1
  ) {
    throw new Error(`Sender Deposit is invalid: ${json(senderDeposit)}`);
  }
  return {
    payment,
    paymentBytes,
    response,
    senderDeposit,
    senderDepositBytes,
  } as const;
}

async function readPublicState() {
  const response = await publicRpc
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
  const [payment, permission, senderDeposit, recipientDeposit, vault] =
    response.value;
  if (
    !payment ||
    payment.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(payment.data).length !== PAYMENT_SIZE ||
    !permission ||
    permission.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(permission.data).length !== PERMISSION_SIZE ||
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
    throw new Error("Public topology or vault collateral is invalid");
  }
  return {
    bytes: [payment, permission, senderDeposit, recipientDeposit, vault].map(
      (account) => accountBytes(account.data),
    ),
    owners: [payment, permission, senderDeposit, recipientDeposit, vault].map(
      (account) => account.owner,
    ),
    response,
  } as const;
}

async function readUnauthenticatedState() {
  const response = await unauthenticatedRpc
    .getMultipleAccounts(
      [addresses.payment, addresses.deposit, addresses.recipientDeposit],
      { commitment: "confirmed", encoding: "base64" },
    )
    .send();
  if (response.value.some((account) => account !== null)) {
    throw new Error("Unauthenticated Private ER exposed protected state");
  }
  return response;
}

const [before, publicBefore, unauthenticatedBefore] = await Promise.all([
  readPrivateState(),
  readPublicState(),
  readUnauthenticatedState(),
]);

const { value: latestBlockhash } = await privateRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const instruction = getCommitAndUndelegatePaymentInstruction({
  payer: authentication.signerClient.payer,
  sender: authentication.signerClient.identity,
  payment: addresses.payment,
});
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) =>
    setTransactionMessageFeePayerSigner(
      authentication.signerClient.payer,
      current,
    ),
  (current) =>
    setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) =>
    appendTransactionMessageInstructions(
      [getSetComputeUnitLimitInstruction({ units: 250_000 }), instruction],
      current,
    ),
);
const transaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(transaction);
assertIsTransactionWithinSizeLimit(transaction);
const wire = getBase64EncodedWireTransaction(transaction);
const serializedBytes = Buffer.from(wire, "base64").length;
const preparedSignature = getSignatureFromTransaction(transaction);
const simulation = await privateRpc
  .simulateTransaction(wire, {
    accounts: { addresses: [addresses.payment], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(
    `Commit/undelegate simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
}
const logs = simulation.value.logs ?? [];
const logChecks = {
  protectedPaySucceeded: logs.some(
    (line) => line === `Program ${PROGRAM_ID} success`,
  ),
  hasScheduledCommitReceipt: logs.some((line) =>
    line.includes("ScheduledCommitSent signature:"),
  ),
  originalAmountFound: logs.some((line) =>
    line.includes(ORIGINAL_AMOUNT.toString()),
  ),
  originalMemoHashFound: logs.some((line) =>
    line.includes(Buffer.from(ORIGINAL_MEMO_HASH).toString("hex")),
  ),
};
if (
  !logChecks.protectedPaySucceeded ||
  !logChecks.hasScheduledCommitReceipt ||
  logChecks.originalAmountFound ||
  logChecks.originalMemoHashFound
) {
  throw new Error(`Simulation logs failed checks: ${json(logChecks)}`);
}
const [simulatedPaymentAccount] = simulation.value.accounts ?? [];
if (
  !simulatedPaymentAccount ||
  simulatedPaymentAccount.owner !== DELEGATION_PROGRAM_ID
) {
  throw new Error("Simulation did not return the expected transitional owner");
}
const simulatedPaymentBytes = accountBytes(simulatedPaymentAccount.data);
const simulatedPayment = validatePayment(simulatedPaymentBytes);
if (!bytesEqual(simulatedPaymentBytes, before.paymentBytes)) {
  throw new Error("Commit/undelegate simulation changed redacted Payment bytes");
}

const [after, publicAfter, unauthenticatedAfter] = await Promise.all([
  readPrivateState(),
  readPublicState(),
  readUnauthenticatedState(),
]);
const publicStateChanged = publicAfter.bytes.some(
  (bytes, index) =>
    publicAfter.owners[index] !== publicBefore.owners[index] ||
    !bytesEqual(bytes, publicBefore.bytes[index]!),
);
if (
  !bytesEqual(after.paymentBytes, before.paymentBytes) ||
  !bytesEqual(after.senderDepositBytes, before.senderDepositBytes) ||
  publicStateChanged
) {
  throw new Error("Simulation persisted private or public state");
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: authentication.identity,
      challengeAgeSeconds: authentication.challengeAgeSeconds,
      tokenReceived: true,
      tokenPrintedOrStored: false,
      hardwareAttestationIndependentlyVerified: false,
    },
    validatedPreState: {
      paymentLabel: V21_EXPIRY_PAYMENT_LABEL,
      privateReadSlot: before.response.context.slot,
      publicReadSlot: publicBefore.response.context.slot,
      unauthenticatedReadSlot: unauthenticatedBefore.context.slot,
      payment: addresses.payment,
      status: PaymentStatus[before.payment.status],
      redacted: before.payment.redacted,
      escrow: before.payment.amount,
      terminalCommitmentMatches: true,
      senderAvailable: before.senderDeposit.available,
      senderNonce: before.senderDeposit.nextPaymentNonce,
      recipientDepositVisibleToSender: false,
      vaultCollateral: EXPECTED_VAULT_AMOUNT,
    },
    signedSimulation: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      instruction: "commit_and_undelegate_payment",
      feePayerAndRequiredSigner: AUTHORITY,
      preparedSignature,
      serializedTransactionBytes: serializedBytes,
      slot: simulation.context.slot,
      err: null,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      committedAccounts: [addresses.payment],
      aggregateDepositsIncluded: false,
      paymentPermissionIncluded: false,
      splTokenInstructions: "none",
      usdcMoved: "0",
      transitionalOwner: simulatedPaymentAccount.owner,
      paymentBytesChanged: false,
      status: PaymentStatus[simulatedPayment.status],
      redacted: simulatedPayment.redacted,
      terminalCommitmentMatches: true,
      protectedAmountOrMemoFoundInLogs: false,
      broadcast: false,
    },
    postSimulation: {
      privatePaymentBytesChanged: false,
      senderDepositBytesChanged: false,
      senderAvailable: after.senderDeposit.available,
      publicStateChanged: false,
      vaultBalanceChanged: false,
      unauthenticatedProtectedReads: "all null",
      unauthenticatedReadSlot: unauthenticatedAfter.context.slot,
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
      "Private ER returned a signature different from the signed transaction",
    );
  }

  let erConfirmation:
    | {
        slot: bigint;
        confirmationStatus?: "processed" | "confirmed" | "finalized";
        err: unknown;
      }
    | undefined;
  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const statusResponse = await privateRpc
      .getSignatureStatuses([preparedSignature], {
        searchTransactionHistory: true,
      })
      .send();
    const status = statusResponse.value[0];
    if (status?.err) {
      throw new Error(`Private ER closeout failed: ${json(status.err)}`);
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      erConfirmation = {
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
      throw new Error("Private ER closeout expired before confirmation");
    }
    await wait(500);
  }
  if (!erConfirmation) {
    throw new Error("Private ER closeout confirmation timed out");
  }

  let scheduledCommitReceipt: string | undefined;
  let erTransactionSlot: bigint | undefined;
  let erBlockTime: bigint | null | undefined;
  for (let poll = 0; poll < 60; poll += 1) {
    const receipt = await privateRpc
      .getTransaction(preparedSignature, {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (receipt?.meta?.err) {
      throw new Error(
        `Confirmed Private ER closeout contains an error: ${json(receipt.meta.err)}`,
      );
    }
    const receiptLine = receipt?.meta?.logMessages?.find((line) =>
      line.includes("ScheduledCommitSent signature:"),
    );
    const match = receiptLine?.match(
      /ScheduledCommitSent signature: ([1-9A-HJ-NP-Za-km-z]{64,88})/,
    );
    if (receipt && match?.[1]) {
      scheduledCommitReceipt = match[1];
      erTransactionSlot = receipt.slot;
      erBlockTime = receipt.blockTime;
      break;
    }
    await wait(250);
  }
  if (
    !scheduledCommitReceipt ||
    erTransactionSlot === undefined ||
    erBlockTime === undefined
  ) {
    throw new Error("Could not obtain the scheduled-commit receipt");
  }

  const [paymentDelegation, permissionDelegation] = await Promise.all([
    deriveDelegationPdas(addresses.payment, PROGRAM_ID),
    deriveDelegationPdas(addresses.paymentPermission, PERMISSION_PROGRAM_ID),
  ]);
  let publicSettlement:
    | {
        readSlot: bigint;
        processSignature: Signature;
        processSlot: bigint;
        processBlockTime: bigint | null;
        paymentOwner: Address;
        paymentStatus: string;
        paymentRedacted: boolean;
        terminalCommitmentMatches: boolean;
        paymentDelegationAccountsClosed: boolean;
        paymentPermissionRemainsDelegated: boolean;
        aggregateDepositsRemainDelegated: boolean;
        vaultCollateral: bigint;
        protectedAmountOrMemoFoundInPublicLogs: boolean;
      }
    | undefined;

  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const response = await publicRpc
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
      .send();
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
    ] = response.value;
    if (paymentAccount?.owner !== PROGRAM_ID) {
      await wait(500);
      continue;
    }
    if (
      !bytesEqual(accountBytes(paymentAccount.data), before.paymentBytes) ||
      paymentBuffer !== null ||
      paymentRecord !== null ||
      paymentMetadata !== null ||
      !permissionAccount ||
      permissionAccount.owner !== DELEGATION_PROGRAM_ID ||
      !bytesEqual(accountBytes(permissionAccount.data), publicBefore.bytes[1]!) ||
      permissionBuffer !== null ||
      !permissionRecord ||
      permissionRecord.owner !== DELEGATION_PROGRAM_ID ||
      !permissionMetadata ||
      permissionMetadata.owner !== DELEGATION_PROGRAM_ID ||
      !senderDeposit ||
      senderDeposit.owner !== DELEGATION_PROGRAM_ID ||
      !bytesEqual(accountBytes(senderDeposit.data), publicBefore.bytes[2]!) ||
      !recipientDeposit ||
      recipientDeposit.owner !== DELEGATION_PROGRAM_ID ||
      !bytesEqual(accountBytes(recipientDeposit.data), publicBefore.bytes[3]!) ||
      !vault ||
      vault.owner !== TOKEN_PROGRAM_ID ||
      !bytesEqual(accountBytes(vault.data), publicBefore.bytes[4]!) ||
      tokenAmount(accountBytes(vault.data)) !== EXPECTED_VAULT_AMOUNT
    ) {
      throw new Error("Finalized public closeout topology or bytes are invalid");
    }
    const payment = validatePayment(accountBytes(paymentAccount.data));
    const history = await publicRpc
      .getSignaturesForAddress(addresses.payment, {
        commitment: "finalized",
        limit: 10,
      })
      .send();
    let processEntry:
      | { signature: Signature; slot: bigint; blockTime: bigint | null }
      | undefined;
    let protectedDataFound = false;
    for (const entry of history) {
      if (entry.slot <= publicBefore.response.context.slot || entry.err !== null) {
        continue;
      }
      const candidate = await publicRpc
        .getTransaction(entry.signature, {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      const keys = candidate?.transaction.message.accountKeys ?? [];
      if (
        candidate?.meta?.err === null &&
        keys.includes(addresses.payment) &&
        keys.includes(DELEGATION_PROGRAM_ID)
      ) {
        const publicLogs = candidate.meta.logMessages ?? [];
        protectedDataFound = publicLogs.some(
          (line) =>
            line.includes(ORIGINAL_AMOUNT.toString()) ||
            line.includes(Buffer.from(ORIGINAL_MEMO_HASH).toString("hex")),
        );
        processEntry = {
          signature: entry.signature,
          slot: entry.slot,
          blockTime: entry.blockTime,
        };
        break;
      }
    }
    if (!processEntry) {
      await wait(500);
      continue;
    }
    if (protectedDataFound) {
      throw new Error("Public closeout logs exposed original amount or memo hash");
    }
    publicSettlement = {
      readSlot: response.context.slot,
      processSignature: processEntry.signature,
      processSlot: processEntry.slot,
      processBlockTime: processEntry.blockTime,
      paymentOwner: paymentAccount.owner,
      paymentStatus: PaymentStatus[payment.status],
      paymentRedacted: payment.redacted,
      terminalCommitmentMatches: true,
      paymentDelegationAccountsClosed: true,
      paymentPermissionRemainsDelegated: true,
      aggregateDepositsRemainDelegated: true,
      vaultCollateral: EXPECTED_VAULT_AMOUNT,
      protectedAmountOrMemoFoundInPublicLogs: false,
    };
    break;
  }
  if (!publicSettlement) {
    throw new Error(
      "Public terminal Payment did not finalize before verification timed out",
    );
  }

  const unauthenticatedFinal = await readUnauthenticatedState();
  console.log(
    json({
      finalizedTerminalCloseout: {
        cluster: "MagicBlock Private ER to Solana Devnet",
        erSignature: preparedSignature,
        erTransactionSlot,
        erBlockTime,
        erConfirmation,
        scheduledCommitReceipt,
        publicSettlement,
        unauthenticatedPrivateErReadSlot: unauthenticatedFinal.context.slot,
        paymentPublishedOnlyAfterRedaction: true,
        recipientRemainsPublicThroughPreDelegationHistoryAndPermission: true,
        aggregateBalancesPublished: false,
        splTokenMovement: "none",
        usdcMoved: "0",
        authenticationTokenPrintedOrStored: false,
      },
    }),
  );
}
