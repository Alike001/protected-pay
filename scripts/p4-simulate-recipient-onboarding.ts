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
import { getCreateDepositPermissionInstruction } from "../clients/ts/src/generated/instructions/createDepositPermission.ts";
import { getDelegateDepositInstructionAsync } from "../clients/ts/src/generated/instructions/delegateDeposit.ts";
import { getDelegateDepositPermissionInstructionAsync } from "../clients/ts/src/generated/instructions/delegateDepositPermission.ts";
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
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const RECIPIENT =
  "HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr" as Address;
const PAYMENT_ID = new Uint8Array(
  createHash("sha256")
    .update("protected-pay:phase4:correct-payment:v1")
    .digest(),
);
const CONFIG_SIZE = 154;
const DEPOSIT_SIZE = 98;
const PAYMENT_SIZE = 245;
const PERMISSION_SIZE = 567;
const COMPUTE_UNIT_LIMIT = 500_000;
const SEND_REQUESTED = process.argv.includes("--send");
const APPROVAL_FLAG = "--approved-p4-recipient-onboarding";

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
  transactionSigner: TransactionSigner = createNoopSigner(RECIPIENT),
) {
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
  const [permissionDelegation, depositDelegation] = await Promise.all([
    deriveDelegationPdas(recipientPermission, PERMISSION_PROGRAM_ID),
    deriveDelegationPdas(recipientDeposit, PROGRAM_ID),
  ]);
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
    getCreateDepositPermissionInstruction({
      payer: transactionSigner,
      user: transactionSigner,
      deposit: recipientDeposit,
      permission: recipientPermission,
      permissionProgram: PERMISSION_PROGRAM_ID,
    }),
    await getDelegateDepositPermissionInstructionAsync({
      payer: transactionSigner,
      user: transactionSigner,
      config: sender.config,
      deposit: recipientDeposit,
      permission: recipientPermission,
      delegationBuffer: permissionDelegation.buffer,
      delegationRecord: permissionDelegation.record,
      delegationMetadata: permissionDelegation.metadata,
      validator: PRIVATE_VALIDATOR,
    }),
    await getDelegateDepositInstructionAsync({
      payer: transactionSigner,
      owner: transactionSigner,
      config: sender.config,
      validator: PRIVATE_VALIDATOR,
      bufferDeposit: depositDelegation.buffer,
      delegationRecordDeposit: depositDelegation.record,
      delegationMetadataDeposit: depositDelegation.metadata,
      deposit: recipientDeposit,
      user: RECIPIENT,
      tokenMint: USDC_MINT,
    }),
  ];
  return {
    ...sender,
    payment,
    paymentPermission,
    recipientDeposit,
    recipientPermission,
    permissionDelegation,
    depositDelegation,
    instructions,
  } as const;
}

async function simulateRecipientOnboarding(): Promise<void> {
const plan = await derivePlan();
const delegationPdas = [
  plan.permissionDelegation.buffer,
  plan.permissionDelegation.record,
  plan.permissionDelegation.metadata,
  plan.depositDelegation.buffer,
  plan.depositDelegation.record,
  plan.depositDelegation.metadata,
] as const;
const rpc = createSolanaRpc(RPC_URL);
const preflight = await rpc
  .getMultipleAccounts(
    [
      plan.config,
      plan.payment,
      plan.paymentPermission,
      plan.recipientDeposit,
      plan.recipientPermission,
      RECIPIENT,
      plan.vaultUsdcAta,
      DELEGATION_PROGRAM_ID,
      PERMISSION_PROGRAM_ID,
      PRIVATE_VALIDATOR,
      ...delegationPdas,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [
  configAccount,
  paymentAccount,
  paymentPermissionAccount,
  recipientDepositAccount,
  recipientPermissionAccount,
  recipientAccount,
  vaultTokenAccount,
  delegationProgramAccount,
  permissionProgramAccount,
  validatorAccount,
  ...delegationPdaAccounts
] = preflight.value;

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
  config.allowedMint !== USDC_MINT ||
  config.tokenProgram !== TOKEN_PROGRAM_ID ||
  config.privateValidator !== PRIVATE_VALIDATOR ||
  config.safetyWindowSeconds !== 60n ||
  config.claimWindowSeconds !== 300n ||
  config.version !== 1
) {
  throw new Error(`Unexpected Config: ${json(config)}`);
}
if (
  !paymentAccount ||
  paymentAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(paymentAccount.data).length !== PAYMENT_SIZE
) {
  throw new Error("Delegated Payment failed owner/length validation");
}
const payment = getPaymentDecoder().decode(accountBytes(paymentAccount.data));
assertDiscriminator(payment.discriminator, PAYMENT_DISCRIMINATOR, "Payment");
if (
  !bytesEqual(payment.paymentId, PAYMENT_ID) ||
  payment.sender !== AUTHORITY ||
  payment.recipient !== RECIPIENT ||
  payment.tokenMint !== USDC_MINT ||
  payment.amount !== 0n ||
  payment.status !== PaymentStatus.Created ||
  payment.initialized ||
  payment.version !== 1
) {
  throw new Error(`Unexpected delegated Payment shell: ${json(payment)}`);
}
if (
  !paymentPermissionAccount ||
  paymentPermissionAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(paymentPermissionAccount.data).length !== PERMISSION_SIZE
) {
  throw new Error("Payment permission is not delegated");
}
if (!recipientDepositAccount || recipientDepositAccount.owner !== PROGRAM_ID) {
  throw new Error("Recipient Deposit failed program-owner validation");
}
const recipientDepositBytes = accountBytes(recipientDepositAccount.data);
if (recipientDepositBytes.length !== DEPOSIT_SIZE) {
  throw new Error(
    `Expected ${DEPOSIT_SIZE} recipient Deposit bytes, received ${recipientDepositBytes.length}`,
  );
}
const recipientDeposit = getDepositDecoder().decode(recipientDepositBytes);
assertDiscriminator(
  recipientDeposit.discriminator,
  DEPOSIT_DISCRIMINATOR,
  "Recipient Deposit",
);
if (
  recipientDeposit.user !== RECIPIENT ||
  recipientDeposit.tokenMint !== USDC_MINT ||
  recipientDeposit.available !== 0n ||
  recipientDeposit.locked !== 0n ||
  recipientDeposit.nextPaymentNonce !== 0n ||
  recipientDeposit.automationPaused ||
  recipientDeposit.version !== 1
) {
  throw new Error(`Unexpected recipient Deposit: ${json(recipientDeposit)}`);
}
if (recipientPermissionAccount !== null) {
  throw new Error("Recipient permission already exists; refusing init-only simulation");
}
if (!recipientAccount || recipientAccount.owner !== SYSTEM_PROGRAM) {
  throw new Error("Recipient fee-payer account failed system-owner validation");
}
if (!vaultTokenAccount || vaultTokenAccount.owner !== TOKEN_PROGRAM_ID) {
  throw new Error("Vault token account failed token-program validation");
}
if (
  !delegationProgramAccount?.executable ||
  !permissionProgramAccount?.executable ||
  !validatorAccount
) {
  throw new Error("A required MagicBlock program or Private ER validator is unavailable");
}
if (delegationPdaAccounts.some((account) => account !== null)) {
  throw new Error("One or more recipient delegation PDAs already exist");
}

const { value: latestBlockhash } = await rpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayer(RECIPIENT, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions(plan.instructions, current),
);
const transaction = compileTransaction(message);
const wire = getBase64EncodedWireTransaction(transaction);
const serializedBytes = Buffer.from(wire, "base64").length;
if (serializedBytes > 1_232) {
  throw new Error(
    `Recipient onboarding is ${serializedBytes} bytes; Solana limit is 1232`,
  );
}
const returnedAddresses = [
  plan.recipientPermission,
  plan.recipientDeposit,
  ...delegationPdas,
  plan.vaultUsdcAta,
  RECIPIENT,
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
    `Recipient onboarding simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
}
const post = simulation.value.accounts;
if (!post || post.some((account) => account === null)) {
  throw new Error("Recipient onboarding simulation returned incomplete post-state");
}
const postPermission = post[0];
const postDeposit = post[1];
const postVaultToken = post[8];
const postRecipient = post[9];
if (
  !postPermission ||
  !postDeposit ||
  !postVaultToken ||
  !postRecipient ||
  postPermission.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(postPermission.data).length !== PERMISSION_SIZE ||
  postDeposit.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(postDeposit.data).length !== DEPOSIT_SIZE ||
  postVaultToken.owner !== TOKEN_PROGRAM_ID ||
  !bytesEqual(accountBytes(postVaultToken.data), accountBytes(vaultTokenAccount.data)) ||
  !bytesEqual(accountBytes(postDeposit.data), recipientDepositBytes)
) {
  throw new Error("Recipient onboarding changed financial data or failed delegation");
}

const createdAccounts = [post[0], ...post.slice(2, 8)];
const createdAccountRent = createdAccounts.reduce(
  (total, account) => total + (account?.lamports ?? 0n),
  0n,
);
console.log(
  json({
    validatedPreState: {
      finalizedReadSlot: preflight.context.slot,
      payment: plan.payment,
      paymentRecipient: payment.recipient,
      paymentPermissionOwner: paymentPermissionAccount.owner,
      recipient: RECIPIENT,
      recipientDeposit: plan.recipientDeposit,
      recipientPermissionAbsent: true,
      recipientDepositAvailable: recipientDeposit.available,
      recipientDepositLocked: recipientDeposit.locked,
      recipientLamports: recipientAccount.lamports,
      delegationPdasAbsent: true,
    },
    proposedTransaction: {
      cluster: "Solana Devnet",
      feePayer: RECIPIENT,
      signers: [RECIPIENT],
      senderSignatureRequired: false,
      privateValidator: PRIVATE_VALIDATOR,
      instructions: [
        "create recipient Deposit permission",
        "delegate recipient Deposit permission",
        "delegate recipient Deposit",
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
      createdAccountRentLamports: createdAccountRent,
      totalFeeAndRentLamports:
        recipientAccount.lamports - postRecipient.lamports,
      recipientPermissionOwnerAfter: postPermission.owner,
      recipientDepositOwnerAfter: postDeposit.owner,
      financialStateUnchanged: true,
    },
    productBoundary: {
      currentPrototype: "one recipient signature, with the recipient paying Devnet fee and rent",
      productionTarget:
        "one recipient signature with a sponsor/relayer paying fees; sponsorship is not implemented yet",
    },
  }),
);
}

async function sendApprovedRecipientOnboarding(): Promise<void> {
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error("SOLANA_KEYPAIR_PATH must name the approved recipient signer");
  }

  // Repeat all unsigned validation and simulation before loading the signer.
  await simulateRecipientOnboarding();

  const signerClient = await createClient().use(signerFromFile(keypairPath));
  if (
    signerClient.identity.address !== RECIPIENT ||
    signerClient.payer.address !== RECIPIENT
  ) {
    throw new Error("Signer does not match the approved recipient and fee payer");
  }
  const rpc = createSolanaRpc(RPC_URL);
  const plan = await derivePlan(signerClient.identity);
  const delegationPdas = [
    plan.permissionDelegation.buffer,
    plan.permissionDelegation.record,
    plan.permissionDelegation.metadata,
    plan.depositDelegation.buffer,
    plan.depositDelegation.record,
    plan.depositDelegation.metadata,
  ] as const;
  const before = await rpc
    .getMultipleAccounts(
      [plan.recipientDeposit, plan.vaultUsdcAta, RECIPIENT],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [depositBeforeAccount, vaultBeforeAccount, recipientBeforeAccount] =
    before.value;
  if (
    !depositBeforeAccount ||
    depositBeforeAccount.owner !== PROGRAM_ID ||
    accountBytes(depositBeforeAccount.data).length !== DEPOSIT_SIZE ||
    !vaultBeforeAccount ||
    vaultBeforeAccount.owner !== TOKEN_PROGRAM_ID ||
    !recipientBeforeAccount ||
    recipientBeforeAccount.owner !== SYSTEM_PROGRAM
  ) {
    throw new Error("Recipient onboarding signed pre-state failed owner/length checks");
  }
  const depositBeforeBytes = accountBytes(depositBeforeAccount.data);
  const vaultBeforeBytes = accountBytes(vaultBeforeAccount.data);
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
  const simulatedAddresses = [
    plan.recipientPermission,
    plan.recipientDeposit,
    ...delegationPdas,
    plan.vaultUsdcAta,
    RECIPIENT,
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
      `Signed recipient-onboarding preflight failed: ${json({
        err: signedSimulation.value.err,
        logs: signedSimulation.value.logs,
      })}`,
    );
  }
  const signedPost = signedSimulation.value.accounts;
  if (!signedPost || signedPost.some((account) => account === null)) {
    throw new Error("Signed recipient-onboarding simulation returned incomplete post-state");
  }
  const signedPermission = signedPost[0];
  const signedDepositAccount = signedPost[1];
  const signedVault = signedPost[8];
  if (
    !signedPermission ||
    !signedDepositAccount ||
    !signedVault ||
    signedPermission.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(signedPermission.data).length !== PERMISSION_SIZE ||
    signedDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(signedDepositAccount.data).length !== DEPOSIT_SIZE ||
    !bytesEqual(accountBytes(signedDepositAccount.data), depositBeforeBytes) ||
    signedVault.owner !== TOKEN_PROGRAM_ID ||
    !bytesEqual(accountBytes(signedVault.data), vaultBeforeBytes)
  ) {
    throw new Error("Signed simulation changed financial state or failed delegation");
  }
  const signedDeposit = getDepositDecoder().decode(
    accountBytes(signedDepositAccount.data),
  );
  assertDiscriminator(
    signedDeposit.discriminator,
    DEPOSIT_DISCRIMINATOR,
    "Signed simulated recipient Deposit",
  );
  if (
    signedDeposit.user !== RECIPIENT ||
    signedDeposit.tokenMint !== USDC_MINT ||
    signedDeposit.available !== 0n ||
    signedDeposit.locked !== 0n
  ) {
    throw new Error("Signed simulation returned invalid recipient accounting");
  }
  console.log(
    json({
      signedPreflight: {
        preparedSignature: signature,
        cluster: "Solana Devnet",
        feePayer: RECIPIENT,
        senderSignatureRequired: false,
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
        plan.recipientPermission,
        plan.recipientDeposit,
        ...delegationPdas,
        plan.vaultUsdcAta,
        RECIPIENT,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [
    permissionAccount,
    depositAccount,
    permissionBuffer,
    permissionRecord,
    permissionMetadata,
    depositBuffer,
    depositRecord,
    depositMetadata,
    vaultAccount,
    recipientAccount,
  ] = finalized.value;
  if (
    !permissionAccount ||
    !depositAccount ||
    permissionBuffer !== null ||
    !permissionRecord ||
    !permissionMetadata ||
    depositBuffer !== null ||
    !depositRecord ||
    !depositMetadata ||
    !vaultAccount ||
    !recipientAccount
  ) {
    throw new Error("Finalized recipient onboarding returned an unexpected account set");
  }
  if (
    permissionAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(permissionAccount.data).length !== PERMISSION_SIZE ||
    depositAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(depositAccount.data).length !== DEPOSIT_SIZE ||
    vaultAccount.owner !== TOKEN_PROGRAM_ID ||
    !bytesEqual(accountBytes(vaultAccount.data), vaultBeforeBytes) ||
    recipientAccount.owner !== SYSTEM_PROGRAM
  ) {
    throw new Error("A finalized recipient account failed owner, length, or vault checks");
  }
  for (const [label, account, length] of [
    ["Recipient permission record", permissionRecord, 96],
    ["Recipient permission metadata", permissionMetadata, 104],
    ["Recipient Deposit record", depositRecord, 96],
    ["Recipient Deposit metadata", depositMetadata, 136],
  ] as const) {
    if (
      account.owner !== DELEGATION_PROGRAM_ID ||
      accountBytes(account.data).length !== length
    ) {
      throw new Error(`${label} failed owner/length validation`);
    }
  }
  const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
  assertDiscriminator(deposit.discriminator, DEPOSIT_DISCRIMINATOR, "Recipient Deposit");
  if (
    deposit.user !== RECIPIENT ||
    deposit.tokenMint !== USDC_MINT ||
    deposit.available !== 0n ||
    deposit.locked !== 0n ||
    deposit.nextPaymentNonce !== 0n ||
    deposit.automationPaused ||
    deposit.version !== 1
  ) {
    throw new Error("Finalized recipient onboarding failed accounting validation");
  }
  console.log(
    json({
      finalizedTransaction: {
        cluster: "Solana Devnet",
        signature,
        finalizedReadSlot: finalized.context.slot,
        feePayer: RECIPIENT,
        recipientLamportsBefore: recipientBeforeAccount.lamports,
        recipientLamportsAfter: recipientAccount.lamports,
        totalFeeAndRentLamports:
          recipientBeforeAccount.lamports - recipientAccount.lamports,
        senderSignatureRequired: false,
        usdcMoved: "0",
        solTransferred: "0",
        temporaryBuffersPersisted: false,
        recipientPermission: plan.recipientPermission,
        recipientPermissionOwner: permissionAccount.owner,
        recipientDeposit: plan.recipientDeposit,
        recipientDepositOwner: depositAccount.owner,
        recipientAvailableRawUsdc: deposit.available,
        recipientLockedRawUsdc: deposit.locked,
      },
    }),
  );
}

if (!SEND_REQUESTED) {
  await simulateRecipientOnboarding();
} else {
  if (!process.argv.includes(APPROVAL_FLAG)) {
    throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
  }
  await sendApprovedRecipientOnboarding();
}
