import { createHash } from "node:crypto";

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
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
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
const SEND_REQUESTED = process.argv.includes("--send");
const APPROVAL_FLAG = "--approved-p4-sender-delegation";

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

async function derivePlan(
  transactionSigner: TransactionSigner = createNoopSigner(AUTHORITY),
) {
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
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
    await getDelegatePaymentPermissionInstructionAsync({
      payer: transactionSigner,
      sender: transactionSigner,
      config: sender.config,
      payment,
      permission: paymentPermission,
      delegationBuffer: paymentPermissionDelegation.buffer,
      delegationRecord: paymentPermissionDelegation.record,
      delegationMetadata: paymentPermissionDelegation.metadata,
      validator: PRIVATE_VALIDATOR,
    }),
    await getDelegatePaymentInstructionAsync({
      payer: transactionSigner,
      sender: transactionSigner,
      config: sender.config,
      validator: PRIVATE_VALIDATOR,
      bufferPayment: paymentDelegation.buffer,
      delegationRecordPayment: paymentDelegation.record,
      delegationMetadataPayment: paymentDelegation.metadata,
      payment,
      paymentId: PAYMENT_ID,
    }),
    await getDelegateDepositInstructionAsync({
      payer: transactionSigner,
      owner: transactionSigner,
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

async function sendApprovedSenderDelegation(): Promise<void> {
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved sender signer");
  }

  // Repeat every unsigned state validation and simulation before loading the signer.
  await simulateSenderDelegation();

  const signerClient = await createClient().use(signerFromFile(keypairPath));
  if (
    signerClient.identity.address !== AUTHORITY ||
    signerClient.payer.address !== AUTHORITY
  ) {
    throw new Error("Signer does not match the approved sender and fee payer");
  }
  const rpc = createSolanaRpc(RPC_URL);
  const plan = await derivePlan(signerClient.identity);
  const authorityBefore = await rpc
    .getBalance(AUTHORITY, { commitment: "finalized" })
    .send();
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(plan.instructions, current),
  );
  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const signedWire = getBase64EncodedWireTransaction(signedTransaction);
  const signature = getSignatureFromTransaction(signedTransaction);
  const delegationPdas = [
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
  const simulatedAddresses = [
    plan.paymentPermission,
    plan.payment,
    plan.deposit,
    ...delegationPdas,
    plan.vaultUsdcAta,
  ] as const;
  const signedSimulation = await rpc
    .simulateTransaction(signedWire, {
      accounts: { addresses: simulatedAddresses, encoding: "base64" },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (signedSimulation.value.err !== null) {
    throw new Error(
      `Signed sender-delegation preflight failed: ${json({
        err: signedSimulation.value.err,
        logs: signedSimulation.value.logs,
      })}`,
    );
  }
  const signedPost = signedSimulation.value.accounts;
  if (!signedPost || signedPost.some((account) => account === null)) {
    throw new Error("Signed sender-delegation simulation returned incomplete post-state");
  }
  if (
    signedPost[0]?.owner !== DELEGATION_PROGRAM_ID ||
    signedPost[1]?.owner !== DELEGATION_PROGRAM_ID ||
    signedPost[2]?.owner !== DELEGATION_PROGRAM_ID ||
    signedPost[12]?.owner !== TOKEN_PROGRAM_ID
  ) {
    throw new Error("Signed simulation returned invalid delegated owners or vault owner");
  }
  const signedPayment = getPaymentDecoder().decode(accountBytes(signedPost[1].data));
  const signedDeposit = getDepositDecoder().decode(accountBytes(signedPost[2].data));
  assertDiscriminator(
    signedPayment.discriminator,
    PAYMENT_DISCRIMINATOR,
    "Signed simulated Payment",
  );
  assertDiscriminator(
    signedDeposit.discriminator,
    DEPOSIT_DISCRIMINATOR,
    "Signed simulated Deposit",
  );
  if (
    !bytesEqual(signedPayment.paymentId, PAYMENT_ID) ||
    signedPayment.amount !== 0n ||
    signedPayment.initialized ||
    signedDeposit.available !== 3_000_000n ||
    signedDeposit.locked !== 0n
  ) {
    throw new Error("Signed simulation changed the protected financial state");
  }
  console.log(
    json({
      signedPreflight: {
        preparedSignature: signature,
        cluster: "Solana Devnet",
        feePayer: AUTHORITY,
        recipientSignatureRequired: false,
        usdcMoved: "0",
        solTransferred: "0",
        err: null,
        unitsConsumed: signedSimulation.value.unitsConsumed ?? null,
        estimatedFeeLamports: signedSimulation.value.fee ?? null,
      },
    }),
  );

  const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTransaction, { commitment: "finalized" });

  const finalized = await rpc
    .getMultipleAccounts(
      [
        plan.paymentPermission,
        plan.payment,
        plan.deposit,
        ...delegationPdas,
        plan.vaultUsdcAta,
        AUTHORITY,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [
    paymentPermissionAccount,
    paymentAccount,
    depositAccount,
    permissionBuffer,
    permissionRecord,
    permissionMetadata,
    paymentBuffer,
    paymentRecord,
    paymentMetadata,
    depositBuffer,
    depositRecord,
    depositMetadata,
    vaultTokenAccount,
    authorityAccount,
  ] = finalized.value;
  if (
    !paymentPermissionAccount ||
    !paymentAccount ||
    !depositAccount ||
    permissionBuffer !== null ||
    !permissionRecord ||
    !permissionMetadata ||
    paymentBuffer !== null ||
    !paymentRecord ||
    !paymentMetadata ||
    depositBuffer !== null ||
    !depositRecord ||
    !depositMetadata ||
    !vaultTokenAccount ||
    !authorityAccount
  ) {
    throw new Error("Finalized sender delegation returned an unexpected account set");
  }
  if (
    paymentPermissionAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(paymentPermissionAccount.data).length !== PERMISSION_SIZE ||
    paymentAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(paymentAccount.data).length !== PAYMENT_SIZE ||
    depositAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(depositAccount.data).length !== DEPOSIT_SIZE ||
    vaultTokenAccount.owner !== TOKEN_PROGRAM_ID ||
    authorityAccount.owner !== SYSTEM_PROGRAM
  ) {
    throw new Error("A finalized delegated account failed owner or length validation");
  }
  for (const [label, account, length] of [
    ["Payment permission record", permissionRecord, 96],
    ["Payment permission metadata", permissionMetadata, 104],
    ["Payment record", paymentRecord, 96],
    ["Payment metadata", paymentMetadata, 100],
    ["Deposit record", depositRecord, 96],
    ["Deposit metadata", depositMetadata, 136],
  ] as const) {
    if (
      account.owner !== DELEGATION_PROGRAM_ID ||
      accountBytes(account.data).length !== length
    ) {
      throw new Error(`${label} failed owner/length validation`);
    }
  }
  const payment = getPaymentDecoder().decode(accountBytes(paymentAccount.data));
  const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
  assertDiscriminator(payment.discriminator, PAYMENT_DISCRIMINATOR, "Payment");
  assertDiscriminator(deposit.discriminator, DEPOSIT_DISCRIMINATOR, "Deposit");
  if (
    !bytesEqual(payment.paymentId, PAYMENT_ID) ||
    payment.sender !== AUTHORITY ||
    payment.recipient !== RECIPIENT ||
    payment.tokenMint !== USDC_MINT ||
    payment.amount !== 0n ||
    payment.initialized ||
    deposit.user !== AUTHORITY ||
    deposit.tokenMint !== USDC_MINT ||
    deposit.available !== 3_000_000n ||
    deposit.locked !== 0n ||
    deposit.nextPaymentNonce !== 1n
  ) {
    throw new Error("Finalized sender delegation failed financial-state validation");
  }
  console.log(
    json({
      finalizedTransaction: {
        cluster: "Solana Devnet",
        signature,
        finalizedReadSlot: finalized.context.slot,
        feePayer: AUTHORITY,
        authorityLamportsBefore: authorityBefore.value,
        authorityLamportsAfter: authorityAccount.lamports,
        totalFeeAndRentLamports:
          authorityBefore.value - authorityAccount.lamports,
        recipientSignatureRequired: false,
        usdcMoved: "0",
        solTransferred: "0",
        temporaryBuffersPersisted: false,
        paymentPermissionOwner: paymentPermissionAccount.owner,
        paymentOwner: paymentAccount.owner,
        senderDepositOwner: depositAccount.owner,
        senderAvailableRawUsdc: deposit.available,
        senderLockedRawUsdc: deposit.locked,
        paymentAmount: payment.amount,
        paymentInitialized: payment.initialized,
      },
    }),
  );
}

if (!SEND_REQUESTED) {
  await simulateSenderDelegation();
} else {
  if (!process.argv.includes(APPROVAL_FLAG)) {
    throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
  }
  await sendApprovedSenderDelegation();
}
