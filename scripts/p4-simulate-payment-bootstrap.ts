import { createHash } from "node:crypto";

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
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
import {
  getVaultDecoder,
  VAULT_DISCRIMINATOR,
} from "../clients/ts/src/generated/accounts/vault.ts";
import { getCreatePaymentPermissionInstruction } from "../clients/ts/src/generated/instructions/createPaymentPermission.ts";
import { getDepositUsdcInstructionAsync } from "../clients/ts/src/generated/instructions/depositUsdc.ts";
import { getInitializeDepositInstructionAsync } from "../clients/ts/src/generated/instructions/initializeDeposit.ts";
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

const RPC_URL = "https://api.devnet.solana.com" as const;
const UPGRADEABLE_LOADER =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const RECIPIENT =
  "HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr" as Address;
const PAYMENT_LABEL = "protected-pay:phase4:correct-payment:v1";
const PAYMENT_ID = new Uint8Array(
  createHash("sha256").update(PAYMENT_LABEL).digest(),
);
const ZERO_32 = new Uint8Array(32);
const DEPOSIT_AMOUNT = 3_000_000n;
const CONFIG_SIZE = 154;
const VAULT_SIZE = 49;
const DEPOSIT_SIZE = 98;
const PAYMENT_SIZE = 245;
const PERMISSION_SIZE = 567;
const TOKEN_ACCOUNT_SIZE = 165;
const COMPUTE_UNIT_LIMIT = 700_000;

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
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
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
    throw new Error(`Expected ${TOKEN_ACCOUNT_SIZE} token-account bytes, received ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = getAddressDecoder();
  return {
    mint: decoder.decode(data.slice(0, 32)),
    owner: decoder.decode(data.slice(32, 64)),
    amount: view.getBigUint64(64, true),
  };
}

const rpc = createSolanaRpc(RPC_URL);
const addressEncoder = getAddressEncoder();

async function permissionPda(protectedAccount: Address) {
  const [permission] = await getProgramDerivedAddress({
    programAddress: PERMISSION_PROGRAM_ID,
    seeds: [
      Buffer.from("permission:"),
      Buffer.from(addressEncoder.encode(protectedAccount)),
    ],
  });
  return permission;
}

async function deriveBootstrapAddresses() {
  const sender = await deriveAddresses();
  const [[recipientDeposit], [payment]] = await Promise.all([
    findDepositPda(
      { user: RECIPIENT, tokenMint: USDC_MINT },
      { programAddress: PROGRAM_ID },
    ),
    findPaymentPda({ paymentId: PAYMENT_ID }, { programAddress: PROGRAM_ID }),
  ]);
  const [recipientPermission, paymentPermission] = await Promise.all([
    permissionPda(recipientDeposit),
    permissionPda(payment),
  ]);
  return {
    ...sender,
    recipient: RECIPIENT,
    recipientDeposit,
    recipientPermission,
    payment,
    paymentPermission,
  } as const;
}

async function buildBootstrapInstructions(
  senderSigner: TransactionSigner,
): Promise<Instruction[]> {
  const addresses = await deriveBootstrapAddresses();
  return [
    getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
    await getDepositUsdcInstructionAsync({
      user: senderSigner,
      config: addresses.config,
      vault: addresses.vault,
      deposit: addresses.deposit,
      userTokenAccount: addresses.walletUsdcAta,
      vaultTokenAccount: addresses.vaultUsdcAta,
      tokenMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      amount: DEPOSIT_AMOUNT,
    }),
    await getInitializeDepositInstructionAsync({
      payer: senderSigner,
      user: RECIPIENT,
      config: addresses.config,
      deposit: addresses.recipientDeposit,
      tokenMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
    await getPreparePaymentInstructionAsync({
      sender: senderSigner,
      config: addresses.config,
      payment: addresses.payment,
      paymentId: PAYMENT_ID,
      recipient: RECIPIENT,
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

async function loadValidatedPreState() {
  const addresses = await deriveBootstrapAddresses();
  const response = await rpc
    .getMultipleAccounts(
      [
        PROGRAM_ID,
        addresses.config,
        addresses.vault,
        addresses.deposit,
        addresses.walletUsdcAta,
        addresses.vaultUsdcAta,
        AUTHORITY,
        RECIPIENT,
        addresses.recipientDeposit,
        addresses.recipientPermission,
        addresses.payment,
        addresses.paymentPermission,
        addresses.permission,
        PERMISSION_PROGRAM_ID,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [
    programAccount,
    configAccount,
    vaultAccount,
    senderDepositAccount,
    walletTokenAccount,
    vaultTokenAccount,
    authorityAccount,
    recipientAccount,
    recipientDepositAccount,
    recipientPermissionAccount,
    paymentAccount,
    paymentPermissionAccount,
    senderPermissionAccount,
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

  if (!vaultAccount || vaultAccount.owner !== PROGRAM_ID) {
    throw new Error("Vault failed program-owner validation");
  }
  const vaultBytes = accountBytes(vaultAccount.data);
  if (vaultBytes.length !== VAULT_SIZE) {
    throw new Error(`Expected ${VAULT_SIZE} Vault bytes, received ${vaultBytes.length}`);
  }
  const vault = getVaultDecoder().decode(vaultBytes);
  assertDiscriminator(vault.discriminator, VAULT_DISCRIMINATOR, "Vault");
  if (vault.tokenMint !== USDC_MINT || vault.totalLiability !== 0n) {
    throw new Error(`Unexpected finalized Vault: ${json(vault)}`);
  }

  if (!senderDepositAccount || senderDepositAccount.owner !== PROGRAM_ID) {
    throw new Error("Sender Deposit failed program-owner validation");
  }
  const senderDepositBytes = accountBytes(senderDepositAccount.data);
  if (senderDepositBytes.length !== DEPOSIT_SIZE) {
    throw new Error(
      `Expected ${DEPOSIT_SIZE} sender Deposit bytes, received ${senderDepositBytes.length}`,
    );
  }
  const senderDeposit = getDepositDecoder().decode(senderDepositBytes);
  assertDiscriminator(senderDeposit.discriminator, DEPOSIT_DISCRIMINATOR, "Sender Deposit");
  if (
    senderDeposit.user !== AUTHORITY ||
    senderDeposit.tokenMint !== USDC_MINT ||
    senderDeposit.available !== 0n ||
    senderDeposit.locked !== 0n ||
    senderDeposit.nextPaymentNonce !== 1n ||
    senderDeposit.automationPaused ||
    senderDeposit.version !== 1
  ) {
    throw new Error(`Unexpected finalized sender Deposit: ${json(senderDeposit)}`);
  }

  if (!walletTokenAccount || walletTokenAccount.owner !== TOKEN_PROGRAM_ID) {
    throw new Error("Sender USDC account failed token-program validation");
  }
  if (!vaultTokenAccount || vaultTokenAccount.owner !== TOKEN_PROGRAM_ID) {
    throw new Error("Vault USDC account failed token-program validation");
  }
  const walletToken = decodeTokenAccount(accountBytes(walletTokenAccount.data));
  const vaultToken = decodeTokenAccount(accountBytes(vaultTokenAccount.data));
  if (
    walletToken.mint !== USDC_MINT ||
    walletToken.owner !== AUTHORITY ||
    walletToken.amount !== 20_000_000n ||
    vaultToken.mint !== USDC_MINT ||
    vaultToken.owner !== addresses.vault ||
    vaultToken.amount !== 0n
  ) {
    throw new Error(`Unexpected token pre-state: ${json({ walletToken, vaultToken })}`);
  }

  if (!authorityAccount || authorityAccount.owner !== SYSTEM_PROGRAM) {
    throw new Error("Sender fee-payer account failed owner validation");
  }
  if (!recipientAccount || recipientAccount.owner !== SYSTEM_PROGRAM) {
    throw new Error("Candidate recipient account failed owner validation");
  }
  if (
    recipientDepositAccount !== null ||
    recipientPermissionAccount !== null ||
    paymentAccount !== null ||
    paymentPermissionAccount !== null
  ) {
    throw new Error("A proposed init-only bootstrap account already exists");
  }
  if (!senderPermissionAccount || senderPermissionAccount.owner !== DELEGATION_PROGRAM_ID) {
    throw new Error("Sender Deposit permission is not in the expected delegated state");
  }
  if (!permissionProgramAccount?.executable) {
    throw new Error("MagicBlock Permission Program is unavailable");
  }

  return {
    addresses,
    authorityAccount,
    config,
    finalizedReadSlot: response.context.slot,
    recipientAccount,
    senderDeposit,
    vault,
    vaultToken,
    walletToken,
  };
}

async function simulatePaymentBootstrap() {
  const before = await loadValidatedPreState();
  const senderSigner = createNoopSigner(AUTHORITY);
  const instructions = await buildBootstrapInstructions(senderSigner);
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(AUTHORITY, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const transaction = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(transaction);
  const serializedBytes = Buffer.from(wire, "base64").length;
  if (serializedBytes > 1_232) {
    throw new Error(`Payment bootstrap is ${serializedBytes} bytes; Solana limit is 1232`);
  }

  const simulation = await rpc
    .simulateTransaction(wire, {
      accounts: {
        addresses: [
          before.addresses.walletUsdcAta,
          before.addresses.vaultUsdcAta,
          before.addresses.vault,
          before.addresses.deposit,
          before.addresses.recipientDeposit,
          before.addresses.recipientPermission,
          before.addresses.payment,
          before.addresses.paymentPermission,
          AUTHORITY,
        ],
        encoding: "base64",
      },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();

  if (simulation.value.err !== null) {
    throw new Error(
      `Payment bootstrap simulation failed: ${json({
        err: simulation.value.err,
        logs: simulation.value.logs,
      })}`,
    );
  }
  const [
    postWalletTokenAccount,
    postVaultTokenAccount,
    postVaultAccount,
    postSenderDepositAccount,
    postRecipientDepositAccount,
    postRecipientPermissionAccount,
    postPaymentAccount,
    postPaymentPermissionAccount,
    postAuthorityAccount,
  ] = simulation.value.accounts ?? [];
  if (
    !postWalletTokenAccount ||
    !postVaultTokenAccount ||
    !postVaultAccount ||
    !postSenderDepositAccount ||
    !postRecipientDepositAccount ||
    !postPaymentAccount ||
    !postPaymentPermissionAccount ||
    !postAuthorityAccount
  ) {
    throw new Error("Payment bootstrap simulation returned incomplete post-state");
  }
  if (
    postWalletTokenAccount.owner !== TOKEN_PROGRAM_ID ||
    postVaultTokenAccount.owner !== TOKEN_PROGRAM_ID ||
    postVaultAccount.owner !== PROGRAM_ID ||
    accountBytes(postVaultAccount.data).length !== VAULT_SIZE ||
    postSenderDepositAccount.owner !== PROGRAM_ID ||
    accountBytes(postSenderDepositAccount.data).length !== DEPOSIT_SIZE ||
    postRecipientDepositAccount.owner !== PROGRAM_ID ||
    accountBytes(postRecipientDepositAccount.data).length !== DEPOSIT_SIZE ||
    postPaymentAccount.owner !== PROGRAM_ID ||
    accountBytes(postPaymentAccount.data).length !== PAYMENT_SIZE ||
    postPaymentPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(postPaymentPermissionAccount.data).length !== PERMISSION_SIZE ||
    postAuthorityAccount.owner !== SYSTEM_PROGRAM
  ) {
    throw new Error("A simulated bootstrap account failed owner or length validation");
  }
  if (postRecipientPermissionAccount !== null) {
    throw new Error("Sender bootstrap unexpectedly created the recipient's permission");
  }

  const postWalletToken = decodeTokenAccount(accountBytes(postWalletTokenAccount.data));
  const postVaultToken = decodeTokenAccount(accountBytes(postVaultTokenAccount.data));
  const postVault = getVaultDecoder().decode(accountBytes(postVaultAccount.data));
  const postSenderDeposit = getDepositDecoder().decode(
    accountBytes(postSenderDepositAccount.data),
  );
  const postRecipientDeposit = getDepositDecoder().decode(
    accountBytes(postRecipientDepositAccount.data),
  );
  const postPayment = getPaymentDecoder().decode(accountBytes(postPaymentAccount.data));
  assertDiscriminator(postVault.discriminator, VAULT_DISCRIMINATOR, "Post Vault");
  assertDiscriminator(
    postSenderDeposit.discriminator,
    DEPOSIT_DISCRIMINATOR,
    "Post sender Deposit",
  );
  assertDiscriminator(
    postRecipientDeposit.discriminator,
    DEPOSIT_DISCRIMINATOR,
    "Post recipient Deposit",
  );
  assertDiscriminator(postPayment.discriminator, PAYMENT_DISCRIMINATOR, "Post Payment");

  if (
    postWalletToken.mint !== USDC_MINT ||
    postWalletToken.owner !== AUTHORITY ||
    postWalletToken.amount !== before.walletToken.amount - DEPOSIT_AMOUNT ||
    postVaultToken.mint !== USDC_MINT ||
    postVaultToken.owner !== before.addresses.vault ||
    postVaultToken.amount !== before.vaultToken.amount + DEPOSIT_AMOUNT ||
    postVault.tokenMint !== USDC_MINT ||
    postVault.totalLiability !== DEPOSIT_AMOUNT
  ) {
    throw new Error(
      `Simulated token or Vault accounting is incorrect: ${json({
        postWalletToken,
        postVaultToken,
        postVault,
      })}`,
    );
  }
  if (
    postSenderDeposit.user !== AUTHORITY ||
    postSenderDeposit.tokenMint !== USDC_MINT ||
    postSenderDeposit.available !== DEPOSIT_AMOUNT ||
    postSenderDeposit.locked !== 0n ||
    postSenderDeposit.nextPaymentNonce !== 1n ||
    postSenderDeposit.automationPaused ||
    postSenderDeposit.version !== 1
  ) {
    throw new Error(`Simulated sender Deposit is incorrect: ${json(postSenderDeposit)}`);
  }
  if (
    postRecipientDeposit.user !== RECIPIENT ||
    postRecipientDeposit.tokenMint !== USDC_MINT ||
    postRecipientDeposit.available !== 0n ||
    postRecipientDeposit.locked !== 0n ||
    postRecipientDeposit.nextPaymentNonce !== 0n ||
    postRecipientDeposit.automationPaused ||
    postRecipientDeposit.version !== 1
  ) {
    throw new Error(`Simulated recipient Deposit is incorrect: ${json(postRecipientDeposit)}`);
  }
  if (
    !bytesEqual(postPayment.paymentId, PAYMENT_ID) ||
    postPayment.sender !== AUTHORITY ||
    postPayment.recipient !== RECIPIENT ||
    postPayment.tokenMint !== USDC_MINT ||
    postPayment.amount !== 0n ||
    postPayment.createdAt !== 0n ||
    postPayment.settleAfter !== 0n ||
    postPayment.expiresAt !== 0n ||
    postPayment.taskId !== 0n ||
    postPayment.status !== PaymentStatus.Created ||
    !bytesEqual(postPayment.memoHash, ZERO_32) ||
    !bytesEqual(postPayment.terminalCommitment, ZERO_32) ||
    postPayment.initialized ||
    postPayment.redacted ||
    postPayment.version !== 1
  ) {
    throw new Error(`Simulated public Payment shell is incorrect: ${json(postPayment)}`);
  }
  console.log(
    json({
      validatedPreState: {
        finalizedReadSlot: before.finalizedReadSlot,
        programId: PROGRAM_ID,
        config: before.addresses.config,
        timingPolicy: {
          safetyWindowSeconds: before.config.safetyWindowSeconds,
          claimWindowSeconds: before.config.claimWindowSeconds,
        },
        sender: AUTHORITY,
        recipient: RECIPIENT,
        senderWalletRawUsdc: before.walletToken.amount,
        vaultRawUsdc: before.vaultToken.amount,
        vaultLiability: before.vault.totalLiability,
        senderDepositAvailable: before.senderDeposit.available,
        senderDepositLocked: before.senderDeposit.locked,
        recipientLamports: before.recipientAccount.lamports,
      },
      proposedTransaction: {
        cluster: "Solana Devnet",
        feePayer: AUTHORITY,
        signers: [AUTHORITY],
        instructions: [
          "deposit_usdc",
          "initialize_deposit (recipient)",
          "prepare_payment",
          "create_payment_permission",
        ],
        depositAmount: "3.000000 test USDC",
        paymentAmountExposed: false,
        paymentAmountLocked: "0 (private open happens later)",
        paymentLabel: PAYMENT_LABEL,
        paymentIdHex: Buffer.from(PAYMENT_ID).toString("hex"),
        creates: {
          recipientDeposit: before.addresses.recipientDeposit,
          recipientPermission: "deferred until recipient opens the payment link",
          payment: before.addresses.payment,
          paymentPermission: before.addresses.paymentPermission,
        },
        serializedTransactionBytes: serializedBytes,
        signed: false,
        sent: false,
      },
      simulation: {
        slot: simulation.context.slot,
        err: null,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        estimatedFeeLamports: simulation.value.fee ?? null,
        feePayerLamportsBefore: before.authorityAccount.lamports,
        feePayerLamportsAfter: postAuthorityAccount.lamports,
        totalFeeAndRentLamports:
          before.authorityAccount.lamports - postAuthorityAccount.lamports,
        senderWalletRawUsdcAfter: postWalletToken.amount,
        vaultRawUsdcAfter: postVaultToken.amount,
        vaultLiabilityAfter: postVault.totalLiability,
        senderDepositAvailableAfter: postSenderDeposit.available,
        recipientDepositAvailableAfter: postRecipientDeposit.available,
        paymentShellAmount: postPayment.amount,
        paymentShellInitialized: postPayment.initialized,
      },
    }),
  );
}

await simulatePaymentBootstrap();
