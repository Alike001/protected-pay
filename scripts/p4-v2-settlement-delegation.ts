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
  getBase64EncodedWireTransaction,
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
import { getDelegatePaymentInstructionAsync } from "../clients/ts/src/generated/instructions/delegatePayment.ts";
import { getDelegatePaymentPermissionInstructionAsync } from "../clients/ts/src/generated/instructions/delegatePaymentPermission.ts";
import { PaymentStatus } from "../clients/ts/src/generated/types/paymentStatus.ts";
import {
  AUTHORITY,
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
import {
  deriveV21ExpiryAddresses,
  deriveV21SettlementAddresses,
  deriveV2SettlementAddresses,
  V2_RECIPIENT,
  V21_EXPIRY_PAYMENT_ID,
  V21_EXPIRY_PAYMENT_LABEL,
  V21_SETTLEMENT_PAYMENT_ID,
  V21_SETTLEMENT_PAYMENT_LABEL,
  V2_SETTLEMENT_PAYMENT_ID,
  V2_SETTLEMENT_PAYMENT_LABEL,
} from "./p4-v2-settlement-bootstrap.ts";

const DEFAULT_RPC_URL = "https://api.devnet.solana.com" as const;
const DEFAULT_RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const RPC_URL = (process.env.SOLANA_RPC_URL ??
  DEFAULT_RPC_URL) as typeof DEFAULT_RPC_URL;
const RPC_SUBSCRIPTIONS_URL = (process.env.SOLANA_RPC_SUBSCRIPTIONS_URL ??
  DEFAULT_RPC_SUBSCRIPTIONS_URL) as typeof DEFAULT_RPC_SUBSCRIPTIONS_URL;
const UPGRADEABLE_LOADER =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const CONFIG_SIZE = 154;
const DEPOSIT_SIZE = 98;
const PAYMENT_SIZE = 245;
const PERMISSION_SIZE = 567;
const COMPUTE_UNIT_LIMIT = 600_000;
const V21_SETTLEMENT_MODE = process.argv.includes("--v21-settlement");
const V21_EXPIRY_MODE = process.argv.includes("--v21-expiry");
if (V21_SETTLEMENT_MODE && V21_EXPIRY_MODE) {
  throw new Error("--v21-settlement and --v21-expiry are mutually exclusive");
}
const SEND_REQUESTED = process.argv.includes("--send");
const VERIFY_REQUESTED = process.argv.includes("--verify-finalized");
const APPROVAL_FLAG = V21_EXPIRY_MODE
  ? "--approved-p4-v21-expiry-delegation"
  : V21_SETTLEMENT_MODE
    ? "--approved-p4-v21-settlement-delegation"
    : "--approved-p4-v2-settlement-delegation";
const PAYMENT_ID = V21_EXPIRY_MODE
  ? V21_EXPIRY_PAYMENT_ID
  : V21_SETTLEMENT_MODE
    ? V21_SETTLEMENT_PAYMENT_ID
    : V2_SETTLEMENT_PAYMENT_ID;
const PAYMENT_LABEL = V21_EXPIRY_MODE
  ? V21_EXPIRY_PAYMENT_LABEL
  : V21_SETTLEMENT_MODE
    ? V21_SETTLEMENT_PAYMENT_LABEL
    : V2_SETTLEMENT_PAYMENT_LABEL;

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

async function derivePlan(
  signer: TransactionSigner = createNoopSigner(AUTHORITY),
) {
  const addresses = V21_EXPIRY_MODE
    ? await deriveV21ExpiryAddresses()
    : V21_SETTLEMENT_MODE
      ? await deriveV21SettlementAddresses()
      : await deriveV2SettlementAddresses();
  const [permissionDelegation, paymentDelegation] = await Promise.all([
    deriveDelegationPdas(addresses.paymentPermission, PERMISSION_PROGRAM_ID),
    deriveDelegationPdas(addresses.payment, PROGRAM_ID),
  ]);
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
    await getDelegatePaymentPermissionInstructionAsync({
      payer: signer,
      sender: signer,
      config: addresses.config,
      payment: addresses.payment,
      permission: addresses.paymentPermission,
      delegationBuffer: permissionDelegation.buffer,
      delegationRecord: permissionDelegation.record,
      delegationMetadata: permissionDelegation.metadata,
      validator: PRIVATE_VALIDATOR,
    }),
    await getDelegatePaymentInstructionAsync({
      payer: signer,
      sender: signer,
      config: addresses.config,
      validator: PRIVATE_VALIDATOR,
      bufferPayment: paymentDelegation.buffer,
      delegationRecordPayment: paymentDelegation.record,
      delegationMetadataPayment: paymentDelegation.metadata,
      payment: addresses.payment,
      paymentId: PAYMENT_ID,
    }),
  ];
  return {
    ...addresses,
    instructions,
    paymentDelegation,
    permissionDelegation,
  } as const;
}

const rpc = createSolanaRpc(RPC_URL);

async function loadValidatedPreState(plan: Awaited<ReturnType<typeof derivePlan>>) {
  const newDelegationAccounts = [
    plan.permissionDelegation.buffer,
    plan.permissionDelegation.record,
    plan.permissionDelegation.metadata,
    plan.paymentDelegation.buffer,
    plan.paymentDelegation.record,
    plan.paymentDelegation.metadata,
  ] as const;
  const response = await rpc
    .getMultipleAccounts(
      [
        PROGRAM_ID,
        plan.config,
        plan.payment,
        plan.paymentPermission,
        plan.deposit,
        plan.permission,
        plan.recipientDeposit,
        plan.recipientPermission,
        AUTHORITY,
        DELEGATION_PROGRAM_ID,
        PERMISSION_PROGRAM_ID,
        PRIVATE_VALIDATOR,
        ...newDelegationAccounts,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [
    programAccount,
    configAccount,
    paymentAccount,
    paymentPermissionAccount,
    senderDepositAccount,
    senderPermissionAccount,
    recipientDepositAccount,
    recipientPermissionAccount,
    authorityAccount,
    delegationProgramAccount,
    permissionProgramAccount,
    validatorAccount,
    ...proposedDelegationAccounts
  ] = response.value;

  if (!programAccount?.executable || programAccount.owner !== UPGRADEABLE_LOADER) {
    throw new Error("Protected Pay program failed executable/loader validation");
  }
  if (!configAccount || configAccount.owner !== PROGRAM_ID) {
    throw new Error("Config failed program-owner validation");
  }
  const configBytes = accountBytes(configAccount.data);
  if (configBytes.length !== CONFIG_SIZE) {
    throw new Error("Config allocation mismatch");
  }
  const config = getConfigDecoder().decode(configBytes);
  if (
    !bytesEqual(config.discriminator, CONFIG_DISCRIMINATOR) ||
    config.authority !== AUTHORITY ||
    config.allowedMint !== USDC_MINT ||
    config.tokenProgram !== TOKEN_PROGRAM_ID ||
    config.privateValidator !== PRIVATE_VALIDATOR ||
    config.safetyWindowSeconds !== 60n ||
    config.claimWindowSeconds !== 300n
  ) {
    throw new Error(`Unexpected Config: ${json(config)}`);
  }
  if (!paymentAccount || paymentAccount.owner !== PROGRAM_ID) {
    throw new Error("Version-2 Payment shell failed program-owner validation");
  }
  const paymentBytes = accountBytes(paymentAccount.data);
  if (paymentBytes.length !== PAYMENT_SIZE) {
    throw new Error("Payment allocation mismatch");
  }
  const payment = getPaymentDecoder().decode(paymentBytes);
  if (
    !bytesEqual(payment.discriminator, PAYMENT_DISCRIMINATOR) ||
    !bytesEqual(payment.paymentId, PAYMENT_ID) ||
    payment.sender !== AUTHORITY ||
    payment.recipient !== V2_RECIPIENT ||
    payment.tokenMint !== USDC_MINT ||
    payment.amount !== 0n ||
    payment.status !== PaymentStatus.Created ||
    payment.initialized ||
    payment.redacted ||
    payment.version !== 2
  ) {
    throw new Error(`Unexpected version-2 Payment shell: ${json(payment)}`);
  }
  if (
    !paymentPermissionAccount ||
    paymentPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(paymentPermissionAccount.data).length !== PERMISSION_SIZE
  ) {
    throw new Error("Payment permission failed owner/length validation");
  }
  if (
    !senderDepositAccount ||
    senderDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
    !recipientDepositAccount ||
    recipientDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
    !senderPermissionAccount ||
    senderPermissionAccount.owner !== DELEGATION_PROGRAM_ID ||
    !recipientPermissionAccount ||
    recipientPermissionAccount.owner !== DELEGATION_PROGRAM_ID
  ) {
    throw new Error("An existing private Deposit or permission is not delegated");
  }
  const senderDepositBytes = accountBytes(senderDepositAccount.data);
  const recipientDepositBytes = accountBytes(recipientDepositAccount.data);
  if (
    senderDepositBytes.length !== DEPOSIT_SIZE ||
    recipientDepositBytes.length !== DEPOSIT_SIZE
  ) {
    throw new Error("A delegated Deposit allocation is invalid");
  }
  const senderDeposit = getDepositDecoder().decode(senderDepositBytes);
  const recipientDeposit = getDepositDecoder().decode(recipientDepositBytes);
  if (
    !bytesEqual(senderDeposit.discriminator, DEPOSIT_DISCRIMINATOR) ||
    senderDeposit.user !== AUTHORITY ||
    senderDeposit.tokenMint !== USDC_MINT ||
    !bytesEqual(recipientDeposit.discriminator, DEPOSIT_DISCRIMINATOR) ||
    recipientDeposit.user !== V2_RECIPIENT ||
    recipientDeposit.tokenMint !== USDC_MINT
  ) {
    throw new Error("A delegated Deposit failed identity validation");
  }
  if (!authorityAccount || authorityAccount.owner !== SYSTEM_PROGRAM) {
    throw new Error("Fee payer failed system-owner validation");
  }
  if (
    !delegationProgramAccount?.executable ||
    !permissionProgramAccount?.executable ||
    !validatorAccount
  ) {
    throw new Error("A required MagicBlock program or validator is unavailable");
  }
  if (proposedDelegationAccounts.some((account) => account !== null)) {
    throw new Error("A proposed delegation account already exists");
  }
  return {
    authorityAccount,
    finalizedReadSlot: response.context.slot,
    newDelegationAccounts,
    paymentBytes,
    paymentPermissionBytes: accountBytes(paymentPermissionAccount.data),
    recipientDepositBytes,
    senderDepositBytes,
  };
}

function validatePostState(
  accounts: readonly ({ data: EncodedAccountData; lamports: bigint; owner: Address } | null)[],
  before: Awaited<ReturnType<typeof loadValidatedPreState>>,
  temporaryBuffersClosed = false,
) {
  const [paymentPermission, payment, ...tail] = accounts;
  const createdDelegationAccounts = tail.slice(0, 6);
  const [permissionBuffer, permissionRecord, permissionMetadata, paymentBuffer, paymentRecord, paymentMetadata] =
    createdDelegationAccounts;
  const senderDeposit = tail[6];
  const recipientDeposit = tail[7];
  const authority = tail[8];
  const delegationAccountsValid = temporaryBuffersClosed
    ? permissionBuffer === null &&
      paymentBuffer === null &&
      permissionRecord !== null &&
      permissionMetadata !== null &&
      paymentRecord !== null &&
      paymentMetadata !== null
    : createdDelegationAccounts.every((account) => account !== null);
  if (
    !paymentPermission ||
    !payment ||
    !delegationAccountsValid ||
    !senderDeposit ||
    !recipientDeposit ||
    !authority
  ) {
    throw new Error("Delegation simulation returned incomplete post-state");
  }
  if (
    paymentPermission.owner !== DELEGATION_PROGRAM_ID ||
    payment.owner !== DELEGATION_PROGRAM_ID ||
    senderDeposit.owner !== DELEGATION_PROGRAM_ID ||
    recipientDeposit.owner !== DELEGATION_PROGRAM_ID ||
    !bytesEqual(accountBytes(paymentPermission.data), before.paymentPermissionBytes) ||
    !bytesEqual(accountBytes(payment.data), before.paymentBytes) ||
    !bytesEqual(accountBytes(senderDeposit.data), before.senderDepositBytes) ||
    !bytesEqual(accountBytes(recipientDeposit.data), before.recipientDepositBytes) ||
    authority.owner !== SYSTEM_PROGRAM
  ) {
    throw new Error("Delegation changed financial data or produced an invalid owner");
  }
  return {
    authority,
    rentLamports: createdDelegationAccounts.reduce(
      (total, account) => total + (account?.lamports ?? 0n),
      0n,
    ),
  };
}

async function verifyFinalizedDelegation() {
  const plan = await derivePlan();
  const response = await rpc
    .getMultipleAccounts(returnedAddresses(plan), {
      commitment: "finalized",
      encoding: "base64",
    })
    .send();
  const [
    paymentPermission,
    paymentAccount,
    permissionBuffer,
    permissionRecord,
    permissionMetadata,
    paymentBuffer,
    paymentRecord,
    paymentMetadata,
    senderDepositAccount,
    recipientDepositAccount,
    authorityAccount,
  ] = response.value;
  if (
    !paymentPermission ||
    paymentPermission.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(paymentPermission.data).length !== PERMISSION_SIZE ||
    !paymentAccount ||
    paymentAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(paymentAccount.data).length !== PAYMENT_SIZE ||
    permissionBuffer !== null ||
    paymentBuffer !== null ||
    !permissionRecord ||
    permissionRecord.owner !== DELEGATION_PROGRAM_ID ||
    !permissionMetadata ||
    permissionMetadata.owner !== DELEGATION_PROGRAM_ID ||
    !paymentRecord ||
    paymentRecord.owner !== DELEGATION_PROGRAM_ID ||
    !paymentMetadata ||
    paymentMetadata.owner !== DELEGATION_PROGRAM_ID ||
    !senderDepositAccount ||
    senderDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
    !recipientDepositAccount ||
    recipientDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
    !authorityAccount ||
    authorityAccount.owner !== SYSTEM_PROGRAM
  ) {
    throw new Error("Finalized delegation account topology is invalid");
  }
  const payment = getPaymentDecoder().decode(accountBytes(paymentAccount.data));
  const senderDeposit = getDepositDecoder().decode(accountBytes(senderDepositAccount.data));
  const recipientDeposit = getDepositDecoder().decode(
    accountBytes(recipientDepositAccount.data),
  );
  if (
    !bytesEqual(payment.discriminator, PAYMENT_DISCRIMINATOR) ||
    !bytesEqual(payment.paymentId, PAYMENT_ID) ||
    payment.sender !== AUTHORITY ||
    payment.recipient !== V2_RECIPIENT ||
    payment.tokenMint !== USDC_MINT ||
    payment.amount !== 0n ||
    payment.status !== PaymentStatus.Created ||
    payment.initialized ||
    payment.redacted ||
    payment.version !== 2 ||
    !bytesEqual(senderDeposit.discriminator, DEPOSIT_DISCRIMINATOR) ||
    senderDeposit.user !== AUTHORITY ||
    senderDeposit.tokenMint !== USDC_MINT ||
    !bytesEqual(recipientDeposit.discriminator, DEPOSIT_DISCRIMINATOR) ||
    recipientDeposit.user !== V2_RECIPIENT ||
    recipientDeposit.tokenMint !== USDC_MINT
  ) {
    throw new Error("Finalized delegation state failed relationship validation");
  }
  console.log(
    json({
      finalizedDelegationVerification: {
        finalizedReadSlot: response.context.slot,
        payment: plan.payment,
        paymentPermission: plan.paymentPermission,
        paymentOwner: paymentAccount.owner,
        paymentPermissionOwner: paymentPermission.owner,
        paymentVersion: payment.version,
        paymentAmount: payment.amount,
        paymentInitialized: payment.initialized,
        delegationRecordsAndMetadataPresent: true,
        temporaryDelegationBuffersClosed: true,
        senderDepositOwner: senderDepositAccount.owner,
        recipientDepositOwner: recipientDepositAccount.owner,
        authorityLamports: authorityAccount.lamports,
      },
    }),
  );
}

async function buildUnsignedWire(plan: Awaited<ReturnType<typeof derivePlan>>) {
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(AUTHORITY, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(plan.instructions, current),
  );
  const transaction = compileTransaction(message);
  return getBase64EncodedWireTransaction(transaction);
}

function returnedAddresses(plan: Awaited<ReturnType<typeof derivePlan>>) {
  return [
    plan.paymentPermission,
    plan.payment,
    plan.permissionDelegation.buffer,
    plan.permissionDelegation.record,
    plan.permissionDelegation.metadata,
    plan.paymentDelegation.buffer,
    plan.paymentDelegation.record,
    plan.paymentDelegation.metadata,
    plan.deposit,
    plan.recipientDeposit,
    AUTHORITY,
  ] as const;
}

async function simulateDelegation() {
  const plan = await derivePlan();
  const before = await loadValidatedPreState(plan);
  const wire = await buildUnsignedWire(plan);
  const serializedBytes = Buffer.from(wire, "base64").length;
  if (serializedBytes > 1_232) {
    throw new Error(`Settlement delegation is ${serializedBytes} bytes; limit is 1232`);
  }
  const simulation = await rpc
    .simulateTransaction(wire, {
      accounts: { addresses: returnedAddresses(plan), encoding: "base64" },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err !== null) {
    throw new Error(
      `Version-2 settlement delegation simulation failed: ${json({
        err: simulation.value.err,
        logs: simulation.value.logs,
      })}`,
    );
  }
  const post = validatePostState(simulation.value.accounts ?? [], before);
  console.log(
    json({
      validatedPreState: {
        finalizedReadSlot: before.finalizedReadSlot,
        payment: plan.payment,
        paymentPermission: plan.paymentPermission,
        paymentVersion: 2,
        senderDepositAlreadyDelegated: true,
        recipientDepositAlreadyDelegated: true,
        proposedDelegationAccountsAbsent: true,
      },
      proposedTransaction: {
        cluster: "Solana Devnet",
        feePayer: AUTHORITY,
        signers: [AUTHORITY],
        recipientSignatureRequired: false,
        paymentLabel: PAYMENT_LABEL,
        instructions: ["delegate Payment permission", "delegate Payment"],
        writableFinancialAccounts: [plan.payment],
        senderDepositIncludedInInstructions: false,
        recipientDepositIncludedInInstructions: false,
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
        delegationAccountRentLamports: post.rentLamports,
        estimatedFeeAndRentLamports:
          before.authorityAccount.lamports - post.authority.lamports,
        paymentAndPermissionOwnersAfter: DELEGATION_PROGRAM_ID,
        allFinancialDataUnchanged: true,
      },
    }),
  );
}

async function sendApprovedDelegation() {
  await simulateDelegation();
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
  const plan = await derivePlan(signerClient.identity);
  const before = await loadValidatedPreState(plan);
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(plan.instructions, current),
  );
  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const wire = getBase64EncodedWireTransaction(signedTransaction);
  const signature = getSignatureFromTransaction(signedTransaction);
  const simulation = await rpc
    .simulateTransaction(wire, {
      accounts: { addresses: returnedAddresses(plan), encoding: "base64" },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (simulation.value.err !== null) {
    throw new Error(
      `Signed settlement-delegation preflight failed: ${json({
        err: simulation.value.err,
        logs: simulation.value.logs,
      })}`,
    );
  }
  validatePostState(simulation.value.accounts ?? [], before);
  console.log(
    json({
      signedPreflight: {
        preparedSignature: signature,
        cluster: "Solana Devnet",
        feePayer: AUTHORITY,
        instructions: ["delegate Payment permission", "delegate Payment"],
        usdcMoved: "0",
        solTransferred: "0",
        err: null,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        estimatedFeeLamports: simulation.value.fee ?? null,
      },
    }),
  );
  const subscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subscriptions });
  await sendAndConfirm(signedTransaction, { commitment: "finalized" });
  const finalized = await rpc
    .getMultipleAccounts(returnedAddresses(plan), {
      commitment: "finalized",
      encoding: "base64",
    })
    .send();
  validatePostState(finalized.value, before, true);
  console.log(
    json({
      finalizedTransaction: {
        cluster: "Solana Devnet",
        signature,
        finalizedReadSlot: finalized.context.slot,
        feePayer: AUTHORITY,
        payment: plan.payment,
        paymentPermission: plan.paymentPermission,
        paymentOwner: finalized.value[1]?.owner,
        paymentPermissionOwner: finalized.value[0]?.owner,
        senderDepositOwner: finalized.value[8]?.owner,
        recipientDepositOwner: finalized.value[9]?.owner,
        authorityLamports: finalized.value[10]?.lamports,
        usdcMoved: "0",
        financialDataChanged: false,
      },
    }),
  );
}

if (VERIFY_REQUESTED) {
  if (SEND_REQUESTED) {
    throw new Error("--verify-finalized cannot be combined with --send");
  }
  await verifyFinalizedDelegation();
} else if (!SEND_REQUESTED) {
  await simulateDelegation();
} else {
  if (!process.argv.includes(APPROVAL_FLAG)) {
    throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
  }
  await sendApprovedDelegation();
}
