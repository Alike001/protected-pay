import { createHash } from "node:crypto";

import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
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
  CONFIG_DISCRIMINATOR,
  getConfigDecoder,
} from "../clients/ts/src/generated/accounts/config.ts";
import {
  DEPOSIT_DISCRIMINATOR,
  getDepositDecoder,
} from "../clients/ts/src/generated/accounts/deposit.ts";
import {
  getPaymentDecoder,
  PAYMENT_DISCRIMINATOR,
} from "../clients/ts/src/generated/accounts/payment.ts";
import { getOpenPaymentInstructionAsync } from "../clients/ts/src/generated/instructions/openPayment.ts";
import { findDepositPda } from "../clients/ts/src/generated/pdas/deposit.ts";
import { findPaymentPda } from "../clients/ts/src/generated/pdas/payment.ts";
import { PaymentStatus } from "../clients/ts/src/generated/types/paymentStatus.ts";
import {
  AUTHORITY,
  deriveAddresses,
  PRIVATE_VALIDATOR,
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
const APPROVAL_FLAG = "--approved-p4-tee-auth-private-open-simulation";
const RECIPIENT =
  "HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr" as Address;
const PAYMENT_ID = new Uint8Array(
  createHash("sha256")
    .update("protected-pay:phase4:correct-payment:v1")
    .digest(),
);
// This is a non-sensitive fixture preimage. The proof tests ledger privacy,
// not secrecy of source-controlled test data.
const MEMO_HASH = new Uint8Array(
  createHash("sha256")
    .update("invoice:prototype-001:consulting-services")
    .digest(),
);
const ZERO_32 = new Uint8Array(32);
const PAYMENT_AMOUNT = 1_000_000n;
const TOTAL_VAULT_AMOUNT = 3_000_000n;
const CONFIG_SIZE = 154;
const PAYMENT_SIZE = 245;
const DEPOSIT_SIZE = 98;
const PERMISSION_SIZE = 567;

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

function decodeTokenAccount(data: Uint8Array) {
  if (data.length !== 165) {
    throw new Error(`Expected 165 token-account bytes, received ${data.length}`);
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
      sender.config,
      payment,
      paymentPermission,
      sender.deposit,
      sender.permission,
      recipientDeposit,
      recipientPermission,
      sender.vault,
      sender.vaultUsdcAta,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [
  configAccount,
  publicPaymentAccount,
  publicPaymentPermissionAccount,
  publicSenderDepositAccount,
  publicSenderPermissionAccount,
  publicRecipientDepositAccount,
  publicRecipientPermissionAccount,
  vaultAccount,
  vaultTokenAccount,
] = baseState.value;
if (!configAccount || configAccount.owner !== PROGRAM_ID) {
  throw new Error("Config failed program-owner validation");
}
const configBytes = accountBytes(configAccount.data);
if (configBytes.length !== CONFIG_SIZE) {
  throw new Error(`Expected ${CONFIG_SIZE} Config bytes, received ${configBytes.length}`);
}
const config = getConfigDecoder().decode(configBytes);
assertDiscriminator(config.discriminator, CONFIG_DISCRIMINATOR, "Config");
if (
  config.authority !== AUTHORITY ||
  config.allowedMint !== USDC_MINT ||
  config.tokenProgram !== TOKEN_PROGRAM_ID ||
  config.privateValidator !== PRIVATE_VALIDATOR ||
  config.safetyWindowSeconds !== 60n ||
  config.claimWindowSeconds !== 300n ||
  config.version !== 1
) {
  throw new Error(`Unexpected finalized Config: ${json(config)}`);
}
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
if (!vaultAccount || vaultAccount.owner !== PROGRAM_ID) {
  throw new Error("Vault failed program-owner validation");
}
if (!vaultTokenAccount || vaultTokenAccount.owner !== TOKEN_PROGRAM_ID) {
  throw new Error("Vault token account failed token-program validation");
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
  throw new Error("Unexpected public pre-open Payment or Deposit snapshot");
}

const unauthenticatedRpc = createSolanaRpc(PRIVATE_ER_ORIGIN);
const unauthenticatedRead = await unauthenticatedRpc
  .getMultipleAccounts(
    [payment, sender.deposit, recipientDeposit],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
if (unauthenticatedRead.value.some((account) => account !== null)) {
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
if (
  !bytesEqual(privatePayment.paymentId, PAYMENT_ID) ||
  privatePayment.sender !== AUTHORITY ||
  privatePayment.recipient !== RECIPIENT ||
  privatePayment.tokenMint !== USDC_MINT ||
  privatePayment.amount !== 0n ||
  privatePayment.status !== PaymentStatus.Created ||
  privatePayment.initialized ||
  privatePayment.redacted ||
  privateSenderDeposit.user !== AUTHORITY ||
  privateSenderDeposit.tokenMint !== USDC_MINT ||
  privateSenderDeposit.available !== TOTAL_VAULT_AMOUNT ||
  privateSenderDeposit.locked !== 0n ||
  privateSenderDeposit.nextPaymentNonce !== 1n ||
  privateSenderDeposit.automationPaused
) {
  throw new Error("Unexpected authenticated pre-open Payment or Deposit state");
}

const instructions = [
  getSetComputeUnitLimitInstruction({ units: 200_000 }),
  await getOpenPaymentInstructionAsync({
    sender: authentication.signerClient.identity,
    config: sender.config,
    payment,
    senderDeposit: sender.deposit,
    paymentId: PAYMENT_ID,
    amount: PAYMENT_AMOUNT,
    memoHash: MEMO_HASH,
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
  throw new Error(`Private open is ${serializedBytes} bytes; Solana limit is 1232`);
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
    `Signed private-open simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
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
  throw new Error("Private-open simulation returned invalid account owners or lengths");
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
  !bytesEqual(simulatedPayment.paymentId, PAYMENT_ID) ||
  simulatedPayment.sender !== AUTHORITY ||
  simulatedPayment.recipient !== RECIPIENT ||
  simulatedPayment.tokenMint !== USDC_MINT ||
  simulatedPayment.amount !== PAYMENT_AMOUNT ||
  simulatedPayment.createdAt <= 0n ||
  simulatedPayment.settleAfter - simulatedPayment.createdAt !== 60n ||
  simulatedPayment.expiresAt - simulatedPayment.createdAt !== 300n ||
  simulatedPayment.taskId !== 0n ||
  simulatedPayment.status !== PaymentStatus.Created ||
  !bytesEqual(simulatedPayment.memoHash, MEMO_HASH) ||
  !bytesEqual(simulatedPayment.terminalCommitment, ZERO_32) ||
  !simulatedPayment.initialized ||
  simulatedPayment.redacted ||
  simulatedPayment.version !== 1 ||
  simulatedSenderDeposit.user !== AUTHORITY ||
  simulatedSenderDeposit.tokenMint !== USDC_MINT ||
  simulatedSenderDeposit.available !== 2_000_000n ||
  simulatedSenderDeposit.locked !== PAYMENT_AMOUNT ||
  simulatedSenderDeposit.nextPaymentNonce !== 2n ||
  simulatedSenderDeposit.automationPaused ||
  simulatedSenderDeposit.version !== 1
) {
  throw new Error(
    `Private-open simulation returned unexpected state: ${json({
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
  throw new Error("Private-open logs exposed a protected payment argument");
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
    privacyPreflight: {
      publicFinalizedSlot: baseState.context.slot,
      privateAuthorizedSlot: privateState.context.slot,
      unauthenticatedPaymentVisible: false,
      unauthenticatedSenderDepositVisible: false,
      unauthenticatedRecipientDepositVisible: false,
      authorizedPaymentVisible: true,
      authorizedSenderDepositVisible: true,
      publicPaymentAmountBefore: publicPayment.amount,
      publicPaymentInitializedBefore: publicPayment.initialized,
      publicSenderAvailableBefore: publicSenderDeposit.available,
      publicSenderLockedBefore: publicSenderDeposit.locked,
      vaultRawUsdc: vaultToken.amount,
    },
    simulationOnlyTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: AUTHORITY,
      signer: AUTHORITY,
      instruction: "open_payment",
      token: "Circle Devnet test USDC",
      amount: "1.000000 USDC internal accounting lock",
      recipient: RECIPIENT,
      safetyWindowSeconds: 60,
      claimWindowSeconds: 300,
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
      payment: {
        amount: simulatedPayment.amount,
        initialized: simulatedPayment.initialized,
        status: PaymentStatus[simulatedPayment.status],
        settleAfterDeltaSeconds:
          simulatedPayment.settleAfter - simulatedPayment.createdAt,
        expiresAfterDeltaSeconds:
          simulatedPayment.expiresAt - simulatedPayment.createdAt,
        memoHashMatchesPrivateFixture: true,
      },
      senderDeposit: {
        available: simulatedSenderDeposit.available,
        locked: simulatedSenderDeposit.locked,
        nextPaymentNonce: simulatedSenderDeposit.nextPaymentNonce,
      },
      protectedArgumentsFoundInProgramLogs: false,
    },
    postSimulation: {
      privateStatePersisted: false,
      publicStateChanged: false,
      unauthenticatedPrivateRead: "all null",
      transactionBroadcast: false,
    },
  }),
);
