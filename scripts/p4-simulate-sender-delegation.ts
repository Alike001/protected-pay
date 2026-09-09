import { createHash } from "node:crypto";

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
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
import { getDelegateDepositInstructionAsync } from "../clients/ts/src/generated/instructions/delegateDeposit.ts";
import { getDelegatePaymentInstructionAsync } from "../clients/ts/src/generated/instructions/delegatePayment.ts";
import { getDelegatePaymentPermissionInstructionAsync } from "../clients/ts/src/generated/instructions/delegatePaymentPermission.ts";
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
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const UPGRADEABLE_LOADER =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const RECIPIENT =
  "HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr" as Address;
const PAYMENT_ID = new Uint8Array(
  createHash("sha256")
    .update("protected-pay:phase4:correct-payment:v1")
    .digest(),
);
const ZERO_32 = new Uint8Array(32);
const CONFIG_SIZE = 154;
const DEPOSIT_SIZE = 98;
const PAYMENT_SIZE = 245;
const PERMISSION_SIZE = 567;
const COMPUTE_UNIT_LIMIT = 800_000;

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

async function derivePlan() {
  const sender = await deriveAddresses();
  const [payment] = await findPaymentPda(
    { paymentId: PAYMENT_ID },
    { programAddress: PROGRAM_ID },
  );
  const paymentPermission = await permissionPda(payment);
  const [paymentPermissionDelegation, paymentDelegation, depositDelegation] =
    await Promise.all([
      deriveDelegationPdas(paymentPermission, PERMISSION_PROGRAM_ID),
      deriveDelegationPdas(payment, PROGRAM_ID),
      deriveDelegationPdas(sender.deposit, PROGRAM_ID),
    ]);
  const signer = createNoopSigner(AUTHORITY);
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
    await getDelegatePaymentPermissionInstructionAsync({
      payer: signer,
      sender: signer,
      config: sender.config,
      payment,
      permission: paymentPermission,
      delegationBuffer: paymentPermissionDelegation.buffer,
      delegationRecord: paymentPermissionDelegation.record,
      delegationMetadata: paymentPermissionDelegation.metadata,
      validator: PRIVATE_VALIDATOR,
    }),
    await getDelegatePaymentInstructionAsync({
      payer: signer,
      sender: signer,
      config: sender.config,
      validator: PRIVATE_VALIDATOR,
      bufferPayment: paymentDelegation.buffer,
      delegationRecordPayment: paymentDelegation.record,
      delegationMetadataPayment: paymentDelegation.metadata,
      payment,
      paymentId: PAYMENT_ID,
    }),
    await getDelegateDepositInstructionAsync({
      payer: signer,
      owner: signer,
      config: sender.config,
      validator: PRIVATE_VALIDATOR,
      bufferDeposit: depositDelegation.buffer,
      delegationRecordDeposit: depositDelegation.record,
      delegationMetadataDeposit: depositDelegation.metadata,
      deposit: sender.deposit,
      user: AUTHORITY,
      tokenMint: USDC_MINT,
    }),
  ];
  return {
    ...sender,
    payment,
    paymentPermission,
    paymentPermissionDelegation,
    paymentDelegation,
    depositDelegation,
    instructions,
  } as const;
}

async function simulateSenderDelegation(): Promise<void> {
  const plan = await derivePlan();
  const newDelegationPdas = [
    plan.paymentPermissionDelegation.buffer,
    plan.paymentPermissionDelegation.record,
    plan.paymentPermissionDelegation.metadata,
    plan.paymentDelegation.buffer,
    plan.paymentDelegation.record,
    plan.paymentDelegation.metadata,
    plan.depositDelegation.buffer,
    plan.depositDelegation.record,
    plan.depositDelegation.metadata,
  ] as const;
  const preflight = await createSolanaRpc(RPC_URL)
    .getMultipleAccounts(
      [
        PROGRAM_ID,
        plan.config,
        plan.paymentPermission,
        plan.payment,
        plan.deposit,
        plan.permission,
        plan.vaultUsdcAta,
        AUTHORITY,
        DELEGATION_PROGRAM_ID,
        PERMISSION_PROGRAM_ID,
        PRIVATE_VALIDATOR,
        ...newDelegationPdas,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [
    programAccount,
    configAccount,
    paymentPermissionAccount,
    paymentAccount,
    depositAccount,
    depositPermissionAccount,
    vaultTokenAccount,
    authorityAccount,
    delegationProgramAccount,
    permissionProgramAccount,
    validatorAccount,
    ...newDelegationPdaAccounts
  ] = preflight.value;

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
  if (
    !paymentPermissionAccount ||
    paymentPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(paymentPermissionAccount.data).length !== PERMISSION_SIZE
  ) {
    throw new Error("Payment permission failed owner/length validation");
  }
  if (!paymentAccount || paymentAccount.owner !== PROGRAM_ID) {
    throw new Error("Payment failed program-owner validation");
  }
  const paymentBytes = accountBytes(paymentAccount.data);
  if (paymentBytes.length !== PAYMENT_SIZE) {
    throw new Error(`Expected ${PAYMENT_SIZE} Payment bytes, received ${paymentBytes.length}`);
  }
  const payment = getPaymentDecoder().decode(paymentBytes);
  assertDiscriminator(payment.discriminator, PAYMENT_DISCRIMINATOR, "Payment");
  if (
    !bytesEqual(payment.paymentId, PAYMENT_ID) ||
    payment.sender !== AUTHORITY ||
    payment.recipient !== RECIPIENT ||
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
    payment.version !== 1
  ) {
    throw new Error(`Unexpected finalized Payment shell: ${json(payment)}`);
  }
  if (!depositAccount || depositAccount.owner !== PROGRAM_ID) {
    throw new Error("Sender Deposit failed program-owner validation");
  }
  const depositBytes = accountBytes(depositAccount.data);
  if (depositBytes.length !== DEPOSIT_SIZE) {
    throw new Error(`Expected ${DEPOSIT_SIZE} Deposit bytes, received ${depositBytes.length}`);
  }
  const deposit = getDepositDecoder().decode(depositBytes);
  assertDiscriminator(deposit.discriminator, DEPOSIT_DISCRIMINATOR, "Sender Deposit");
  if (
    deposit.user !== AUTHORITY ||
    deposit.tokenMint !== USDC_MINT ||
    deposit.available !== 3_000_000n ||
    deposit.locked !== 0n ||
    deposit.nextPaymentNonce !== 1n ||
    deposit.automationPaused ||
    deposit.version !== 1
  ) {
    throw new Error(`Unexpected finalized sender Deposit: ${json(deposit)}`);
  }
  if (!depositPermissionAccount || depositPermissionAccount.owner !== DELEGATION_PROGRAM_ID) {
    throw new Error("Sender Deposit permission is not delegated");
  }
  if (!vaultTokenAccount || vaultTokenAccount.owner !== TOKEN_PROGRAM_ID) {
    throw new Error("Vault token account failed token-program validation");
  }
  if (!authorityAccount || authorityAccount.owner !== SYSTEM_PROGRAM) {
    throw new Error("Sender fee payer failed system-owner validation");
  }
  if (
    !delegationProgramAccount?.executable ||
    !permissionProgramAccount?.executable ||
    !validatorAccount
  ) {
    throw new Error("A required MagicBlock program or Private ER validator is unavailable");
  }
  if (newDelegationPdaAccounts.some((account) => account !== null)) {
    throw new Error("One or more proposed delegation PDAs already exist");
  }

  const rpc = createSolanaRpc(RPC_URL);
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(AUTHORITY, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(plan.instructions, current),
  );
  const transaction = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(transaction);
  const serializedBytes = Buffer.from(wire, "base64").length;
  if (serializedBytes > 1_232) {
    throw new Error(
      `Sender delegation is ${serializedBytes} bytes; Solana limit is 1232`,
    );
  }

  const returnedAddresses = [
    plan.paymentPermission,
    plan.payment,
    plan.deposit,
    ...newDelegationPdas,
    plan.vaultUsdcAta,
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
      `Sender delegation simulation failed: ${json({
        err: simulation.value.err,
        logs: simulation.value.logs,
      })}`,
    );
  }
  const post = simulation.value.accounts;
  if (!post || post.length !== returnedAddresses.length) {
    throw new Error("Sender delegation simulation returned an incomplete account set");
  }
  const [postPermission, postPayment, postDeposit, ...postTail] = post;
  const postVaultToken = postTail.at(-2);
  const postAuthority = postTail.at(-1);
  const createdDelegationAccounts = postTail.slice(0, 9);
  if (
    !postPermission ||
    !postPayment ||
    !postDeposit ||
    !postVaultToken ||
    !postAuthority ||
    createdDelegationAccounts.some((account) => account === null)
  ) {
    throw new Error("Sender delegation simulation returned a null persistent post-state");
  }
  if (
    postPermission.owner !== DELEGATION_PROGRAM_ID ||
    postPayment.owner !== DELEGATION_PROGRAM_ID ||
    postDeposit.owner !== DELEGATION_PROGRAM_ID
  ) {
    throw new Error("Simulation did not delegate all three sender-controlled accounts");
  }
  const postPaymentBytes = accountBytes(postPayment.data);
  const postDepositBytes = accountBytes(postDeposit.data);
  if (
    !bytesEqual(postPaymentBytes, paymentBytes) ||
    !bytesEqual(postDepositBytes, depositBytes) ||
    !bytesEqual(accountBytes(postPermission.data), accountBytes(paymentPermissionAccount.data)) ||
    postVaultToken.owner !== TOKEN_PROGRAM_ID ||
    !bytesEqual(accountBytes(postVaultToken.data), accountBytes(vaultTokenAccount.data))
  ) {
    throw new Error("Delegation changed payment, balance, permission, or vault data");
  }

  const rentLamports = createdDelegationAccounts.reduce(
    (total, account) => total + (account?.lamports ?? 0n),
    0n,
  );
  console.log(
    json({
      validatedPreState: {
        finalizedReadSlot: preflight.context.slot,
        payment: plan.payment,
        paymentPermission: plan.paymentPermission,
        senderDeposit: plan.deposit,
        existingSenderDepositPermissionOwner: depositPermissionAccount.owner,
        senderAvailableRawUsdc: deposit.available,
        senderLockedRawUsdc: deposit.locked,
        paymentAmount: payment.amount,
        paymentInitialized: payment.initialized,
        proposedDelegationPdasAbsent: true,
      },
      proposedTransaction: {
        cluster: "Solana Devnet",
        rpcUrl: RPC_URL,
        feePayer: AUTHORITY,
        signers: [AUTHORITY],
        recipientSignatureRequired: false,
        privateValidator: PRIVATE_VALIDATOR,
        instructions: [
          "delegate Payment permission",
          "delegate Payment shell",
          "delegate funded sender Deposit",
        ],
        usdcMoved: "0",
        solTransferred: "0",
        serializedTransactionBytes: serializedBytes,
        signed: false,
        broadcast: false,
      },
      simulation: {
        slot: simulation.context.slot,
        err: null,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        estimatedFeeLamports: simulation.value.fee ?? null,
        createdDelegationAccountLamports: rentLamports,
        totalFeeAndRentLamports:
          authorityAccount.lamports - postAuthority.lamports,
        ownersAfter: {
          paymentPermission: postPermission.owner,
          payment: postPayment.owner,
          senderDeposit: postDeposit.owner,
        },
        financialStateUnchanged: true,
      },
      privacyBoundary: {
        public: [
          "sender, recipient, mint, and Payment address from the prepared shell",
          "delegation records and configured Private ER validator",
          "the pre-delegation snapshots already written to Solana",
        ],
        privateAfterDelegation: [
          "payment amount and memo supplied during private open",
          "subsequent Payment and Deposit state transitions inside the Private ER",
        ],
        claimLimit:
          "Delegation does not provide sender anonymity and cannot erase bootstrap data already public.",
      },
    }),
  );
}

await simulateSenderDelegation();
