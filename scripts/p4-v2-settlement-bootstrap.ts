import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createClient,
  createNoopSigner,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { signerFromFile } from "@solana/kit-plugin-signer";

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
import { getCreatePaymentPermissionInstruction } from "../clients/ts/src/generated/instructions/createPaymentPermission.ts";
import { getPreparePaymentInstructionAsync } from "../clients/ts/src/generated/instructions/preparePayment.ts";
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

const DEFAULT_RPC_URL = "https://api.devnet.solana.com" as const;
const DEFAULT_RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const RPC_URL = (process.env.SOLANA_RPC_URL ??
  DEFAULT_RPC_URL) as typeof DEFAULT_RPC_URL;
const RPC_SUBSCRIPTIONS_URL = (process.env.SOLANA_RPC_SUBSCRIPTIONS_URL ??
  DEFAULT_RPC_SUBSCRIPTIONS_URL) as typeof DEFAULT_RPC_SUBSCRIPTIONS_URL;
const UPGRADEABLE_LOADER =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
export const V2_RECIPIENT =
  "HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr" as Address;
export const V2_SETTLEMENT_PAYMENT_LABEL =
  "protected-pay:phase4:v2:settlement:1";
export const V2_SETTLEMENT_PAYMENT_ID = new Uint8Array(
  createHash("sha256").update(V2_SETTLEMENT_PAYMENT_LABEL).digest(),
);
export const V21_SETTLEMENT_PAYMENT_LABEL =
  "protected-pay:phase4:v2.1:settlement:1";
export const V21_SETTLEMENT_PAYMENT_ID = new Uint8Array(
  createHash("sha256").update(V21_SETTLEMENT_PAYMENT_LABEL).digest(),
);
export const V21_EXPIRY_PAYMENT_LABEL = "protected-pay:phase4:v2.1:expiry:1";
export const V21_EXPIRY_PAYMENT_ID = new Uint8Array(
  createHash("sha256").update(V21_EXPIRY_PAYMENT_LABEL).digest(),
);
const ZERO_32 = new Uint8Array(32);
const CONFIG_SIZE = 154;
const DEPOSIT_SIZE = 98;
const PAYMENT_SIZE = 245;
const PERMISSION_SIZE = 567;
const COMPUTE_UNIT_LIMIT = 300_000;
const V21_SETTLEMENT_MODE = process.argv.includes("--v21-settlement");
const V21_EXPIRY_MODE = process.argv.includes("--v21-expiry");
if (V21_SETTLEMENT_MODE && V21_EXPIRY_MODE) {
  throw new Error("Select only one version-2.1 fixture");
}
const SEND_REQUESTED = process.argv.includes("--send");
const APPROVAL_FLAG = V21_EXPIRY_MODE
  ? "--approved-p4-v21-expiry-bootstrap"
  : V21_SETTLEMENT_MODE
    ? "--approved-p4-v21-settlement-bootstrap"
    : "--approved-p4-v2-settlement-bootstrap";
const PAYMENT_LABEL = V21_EXPIRY_MODE
  ? V21_EXPIRY_PAYMENT_LABEL
  : V21_SETTLEMENT_MODE
    ? V21_SETTLEMENT_PAYMENT_LABEL
    : V2_SETTLEMENT_PAYMENT_LABEL;
const PAYMENT_ID = V21_EXPIRY_MODE
  ? V21_EXPIRY_PAYMENT_ID
  : V21_SETTLEMENT_MODE
    ? V21_SETTLEMENT_PAYMENT_ID
    : V2_SETTLEMENT_PAYMENT_ID;

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

async function deriveSettlementAddresses(paymentId: ReadonlyUint8Array) {
  const sender = await deriveAddresses();
  const [[recipientDeposit], [payment]] = await Promise.all([
    findDepositPda(
      { user: V2_RECIPIENT, tokenMint: USDC_MINT },
      { programAddress: PROGRAM_ID },
    ),
    findPaymentPda(
      { paymentId },
      { programAddress: PROGRAM_ID },
    ),
  ]);
  const [recipientPermission, paymentPermission] = await Promise.all([
    permissionPda(recipientDeposit),
    permissionPda(payment),
  ]);
  return {
    ...sender,
    recipient: V2_RECIPIENT,
    recipientDeposit,
    recipientPermission,
    payment,
    paymentPermission,
  } as const;
}

export async function deriveV2SettlementAddresses() {
  return deriveSettlementAddresses(V2_SETTLEMENT_PAYMENT_ID);
}

export async function deriveV21SettlementAddresses() {
  return deriveSettlementAddresses(V21_SETTLEMENT_PAYMENT_ID);
}

export async function deriveV21ExpiryAddresses() {
  return deriveSettlementAddresses(V21_EXPIRY_PAYMENT_ID);
}

async function deriveSelectedSettlementAddresses() {
  return deriveSettlementAddresses(PAYMENT_ID);
}

async function buildInstructions(
  senderSigner: TransactionSigner,
): Promise<Instruction[]> {
  const addresses = await deriveSelectedSettlementAddresses();
  return [
    getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
    await getPreparePaymentInstructionAsync({
      sender: senderSigner,
      config: addresses.config,
      payment: addresses.payment,
      paymentId: PAYMENT_ID,
      recipient: V2_RECIPIENT,
    }),
    getCreatePaymentPermissionInstruction({
      payer: senderSigner,
      sender: senderSigner,
      payment: addresses.payment,
      permission: addresses.paymentPermission,
      permissionProgram: PERMISSION_PROGRAM_ID,
    }),
  ];
}

const rpc = createSolanaRpc(RPC_URL);

async function loadValidatedPreState() {
  const addresses = await deriveSelectedSettlementAddresses();
  const response = await rpc
    .getMultipleAccounts(
      [
        PROGRAM_ID,
        addresses.config,
        addresses.deposit,
        addresses.permission,
        addresses.recipientDeposit,
        addresses.recipientPermission,
        addresses.payment,
        addresses.paymentPermission,
        AUTHORITY,
        V2_RECIPIENT,
        PERMISSION_PROGRAM_ID,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [
    programAccount,
    configAccount,
    senderDepositAccount,
    senderPermissionAccount,
    recipientDepositAccount,
    recipientPermissionAccount,
    paymentAccount,
    paymentPermissionAccount,
    authorityAccount,
    recipientAccount,
    permissionProgramAccount,
  ] = response.value;

  if (!programAccount?.executable || programAccount.owner !== UPGRADEABLE_LOADER) {
    throw new Error("Protected Pay program failed executable/loader validation");
  }
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

  if (!senderDepositAccount || senderDepositAccount.owner !== DELEGATION_PROGRAM_ID) {
    throw new Error("Sender Deposit is not delegated to MagicBlock");
  }
  if (!recipientDepositAccount || recipientDepositAccount.owner !== DELEGATION_PROGRAM_ID) {
    throw new Error("Recipient Deposit is not delegated to MagicBlock");
  }
  const senderDepositBytes = accountBytes(senderDepositAccount.data);
  const recipientDepositBytes = accountBytes(recipientDepositAccount.data);
  if (
    senderDepositBytes.length !== DEPOSIT_SIZE ||
    recipientDepositBytes.length !== DEPOSIT_SIZE
  ) {
    throw new Error("A delegated Deposit has an unexpected allocation");
  }
  const senderDeposit = getDepositDecoder().decode(senderDepositBytes);
  const recipientDeposit = getDepositDecoder().decode(recipientDepositBytes);
  assertDiscriminator(
    senderDeposit.discriminator,
    DEPOSIT_DISCRIMINATOR,
    "Sender Deposit",
  );
  assertDiscriminator(
    recipientDeposit.discriminator,
    DEPOSIT_DISCRIMINATOR,
    "Recipient Deposit",
  );
  if (
    senderDeposit.user !== AUTHORITY ||
    senderDeposit.tokenMint !== USDC_MINT ||
    senderDeposit.version !== 1 ||
    recipientDeposit.user !== V2_RECIPIENT ||
    recipientDeposit.tokenMint !== USDC_MINT ||
    recipientDeposit.version !== 1
  ) {
    throw new Error("A delegated Deposit failed identity validation");
  }
  if (
    !senderPermissionAccount ||
    senderPermissionAccount.owner !== DELEGATION_PROGRAM_ID ||
    !recipientPermissionAccount ||
    recipientPermissionAccount.owner !== DELEGATION_PROGRAM_ID
  ) {
    throw new Error("A required existing Deposit permission is not delegated");
  }
  if (paymentAccount !== null || paymentPermissionAccount !== null) {
    throw new Error("The version-2 settlement fixture already exists");
  }
  if (!authorityAccount || authorityAccount.owner !== SYSTEM_PROGRAM) {
    throw new Error("Sender fee payer failed system-owner validation");
  }
  if (!recipientAccount || recipientAccount.owner !== SYSTEM_PROGRAM) {
    throw new Error("Recipient wallet failed system-owner validation");
  }
  if (!permissionProgramAccount?.executable) {
    throw new Error("MagicBlock Permission Program is unavailable");
  }

  return {
    addresses,
    authorityAccount,
    config,
    finalizedReadSlot: response.context.slot,
    recipientDepositBytes,
    senderDepositBytes,
  };
}

async function buildUnsignedTransaction(senderSigner: TransactionSigner) {
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const instructions = await buildInstructions(senderSigner);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(AUTHORITY, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const transaction = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(transaction);
  return { message, wire };
}

function validateSimulatedFixture(
  accounts: readonly ({ data: EncodedAccountData; owner: Address } | null)[],
  before: Awaited<ReturnType<typeof loadValidatedPreState>>,
) {
  const [paymentAccount, paymentPermissionAccount, senderDeposit, recipientDeposit] =
    accounts;
  if (
    !paymentAccount ||
    !paymentPermissionAccount ||
    !senderDeposit ||
    !recipientDeposit
  ) {
    throw new Error("Settlement bootstrap simulation returned incomplete post-state");
  }
  if (
    paymentAccount.owner !== PROGRAM_ID ||
    accountBytes(paymentAccount.data).length !== PAYMENT_SIZE ||
    paymentPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(paymentPermissionAccount.data).length !== PERMISSION_SIZE
  ) {
    throw new Error("A new settlement-fixture account failed owner/length validation");
  }
  if (
    senderDeposit.owner !== DELEGATION_PROGRAM_ID ||
    recipientDeposit.owner !== DELEGATION_PROGRAM_ID ||
    !bytesEqual(accountBytes(senderDeposit.data), before.senderDepositBytes) ||
    !bytesEqual(accountBytes(recipientDeposit.data), before.recipientDepositBytes)
  ) {
    throw new Error("Bootstrap changed an existing private Deposit snapshot");
  }
  const payment = getPaymentDecoder().decode(accountBytes(paymentAccount.data));
  assertDiscriminator(payment.discriminator, PAYMENT_DISCRIMINATOR, "Payment");
  if (
    !bytesEqual(payment.paymentId, PAYMENT_ID) ||
    payment.sender !== AUTHORITY ||
    payment.recipient !== V2_RECIPIENT ||
    payment.tokenMint !== USDC_MINT ||
    payment.amount !== 0n ||
    payment.createdAt !== 0n ||
    payment.settleAfter !== 0n ||
    payment.expiresAt !== 0n ||
    payment.taskId !== 0n ||
    payment.status !== PaymentStatus.Created ||
    !bytesEqual(payment.memoHash, ZERO_32) ||
    !bytesEqual(payment.terminalCommitment, ZERO_32) ||
    payment.initialized ||
    payment.redacted ||
    payment.version !== 2
  ) {
    throw new Error(`Unexpected version-2 Payment shell: ${json(payment)}`);
  }
  return payment;
}

async function simulateBootstrap() {
  const before = await loadValidatedPreState();
  const { wire } = await buildUnsignedTransaction(createNoopSigner(AUTHORITY));
  const serializedBytes = Buffer.from(wire, "base64").length;
  if (serializedBytes > 1_232) {
    throw new Error(`Settlement bootstrap is ${serializedBytes} bytes; limit is 1232`);
  }
  const returnedAddresses = [
    before.addresses.payment,
    before.addresses.paymentPermission,
    before.addresses.deposit,
    before.addresses.recipientDeposit,
    AUTHORITY,
  ] as const;
  const simulation = await rpc
    .simulateTransaction(wire, {
      accounts: { addresses: returnedAddresses, encoding: "base64" },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err !== null) {
    throw new Error(
      `Version-2 settlement bootstrap simulation failed: ${json({
        err: simulation.value.err,
        logs: simulation.value.logs,
      })}`,
    );
  }
  const accounts = simulation.value.accounts ?? [];
  const payment = validateSimulatedFixture(accounts.slice(0, 4), before);
  const postAuthority = accounts[4];
  if (!postAuthority || postAuthority.owner !== SYSTEM_PROGRAM) {
    throw new Error("Simulation omitted the fee-payer post-state");
  }
  console.log(
    json({
      validatedPreState: {
        finalizedReadSlot: before.finalizedReadSlot,
        programId: PROGRAM_ID,
        timingPolicy: {
          safetyWindowSeconds: before.config.safetyWindowSeconds,
          claimWindowSeconds: before.config.claimWindowSeconds,
        },
        senderDepositAlreadyDelegated: true,
        recipientDepositAlreadyDelegated: true,
        bothDepositPermissionsAlreadyDelegated: true,
        freshPaymentAndPermissionAbsent: true,
      },
      proposedTransaction: {
        cluster: "Solana Devnet",
        feePayer: AUTHORITY,
        signers: [AUTHORITY],
        recipientSignatureRequired: false,
        instructions: ["prepare_payment", "create_payment_permission"],
        paymentLabel: PAYMENT_LABEL,
        paymentIdHex: Buffer.from(PAYMENT_ID).toString("hex"),
        payment: before.addresses.payment,
        paymentPermission: before.addresses.paymentPermission,
        usdcMoved: "0",
        solTransferred: "0",
        privateDepositsMutated: false,
        serializedTransactionBytes: serializedBytes,
        signed: false,
        broadcast: false,
      },
      simulation: {
        slot: simulation.context.slot,
        err: null,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        estimatedFeeLamports: simulation.value.fee ?? null,
        estimatedFeeAndRentLamports:
          before.authorityAccount.lamports - postAuthority.lamports,
        paymentVersion: payment.version,
        paymentAmount: payment.amount,
        paymentInitialized: payment.initialized,
        paymentPubliclyNamesSenderAndRecipient: true,
      },
    }),
  );
}

async function sendApprovedBootstrap() {
  await simulateBootstrap();
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error("SOLANA_KEYPAIR_PATH must name the approved sender signer");
  }
  const signerClient = await createClient().use(signerFromFile(keypairPath));
  if (
    signerClient.identity.address !== AUTHORITY ||
    signerClient.payer.address !== AUTHORITY
  ) {
    throw new Error("Signer does not match the approved sender and fee payer");
  }
  const before = await loadValidatedPreState();
  const instructions = await buildInstructions(signerClient.identity);
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const wire = getBase64EncodedWireTransaction(signedTransaction);
  const signature = getSignatureFromTransaction(signedTransaction);
  const returnedAddresses = [
    before.addresses.payment,
    before.addresses.paymentPermission,
    before.addresses.deposit,
    before.addresses.recipientDeposit,
  ] as const;
  const simulation = await rpc
    .simulateTransaction(wire, {
      accounts: { addresses: returnedAddresses, encoding: "base64" },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (simulation.value.err !== null) {
    throw new Error(
      `Signed settlement-bootstrap preflight failed: ${json({
        err: simulation.value.err,
        logs: simulation.value.logs,
      })}`,
    );
  }
  validateSimulatedFixture(simulation.value.accounts ?? [], before);
  console.log(
    json({
      signedPreflight: {
        preparedSignature: signature,
        cluster: "Solana Devnet",
        feePayer: AUTHORITY,
        instructions: ["prepare_payment", "create_payment_permission"],
        usdcMoved: "0",
        solTransferred: "0",
        err: null,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        estimatedFeeLamports: simulation.value.fee ?? null,
      },
    }),
  );

  const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTransaction, { commitment: "finalized" });

  const finalized = await rpc
    .getMultipleAccounts(
      [
        before.addresses.payment,
        before.addresses.paymentPermission,
        before.addresses.deposit,
        before.addresses.recipientDeposit,
        AUTHORITY,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const payment = validateSimulatedFixture(finalized.value.slice(0, 4), before);
  const authority = finalized.value[4];
  if (!authority || authority.owner !== SYSTEM_PROGRAM) {
    throw new Error("Finalized verification omitted the fee payer");
  }
  console.log(
    json({
      finalizedTransaction: {
        cluster: "Solana Devnet",
        signature,
        finalizedReadSlot: finalized.context.slot,
        feePayer: AUTHORITY,
        authorityLamports: authority.lamports,
        payment: before.addresses.payment,
        paymentPermission: before.addresses.paymentPermission,
        paymentVersion: payment.version,
        paymentAmount: payment.amount,
        paymentInitialized: payment.initialized,
        usdcMoved: "0",
        privateDepositsMutated: false,
      },
    }),
  );
}

const IS_MAIN =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (IS_MAIN) {
  if (!SEND_REQUESTED) {
    await simulateBootstrap();
  } else {
    if (!process.argv.includes(APPROVAL_FLAG)) {
      throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
    }
    await sendApprovedBootstrap();
  }
}
