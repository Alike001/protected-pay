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
  type Blockhash,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import {
  getPaymentDecoder,
  PAYMENT_DISCRIMINATOR,
} from "../clients/ts/src/generated/accounts/payment.ts";
import { getCreatePaymentPermissionInstruction } from "../clients/ts/src/generated/instructions/createPaymentPermission.ts";
import { getDelegatePaymentInstructionAsync } from "../clients/ts/src/generated/instructions/delegatePayment.ts";
import { getDelegatePaymentPermissionInstructionAsync } from "../clients/ts/src/generated/instructions/delegatePaymentPermission.ts";
import { getOpenPaymentInstructionAsync } from "../clients/ts/src/generated/instructions/openPayment.ts";
import { getPreparePaymentInstructionAsync } from "../clients/ts/src/generated/instructions/preparePayment.ts";
import { getSchedulePaymentInstructionAsync } from "../clients/ts/src/generated/instructions/schedulePayment.ts";
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
} from "./gate1-simulate-delegation.ts";
import { PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";
import { V2_RECIPIENT } from "./p4-v2-settlement-bootstrap.ts";

const PUBLIC_RPC_URL = "https://api.devnet.solana.com" as const;
const PAYMENT_LABEL = "protected-pay:phase4:approval-count:1";
const PAYMENT_ID = new Uint8Array(
  createHash("sha256").update(PAYMENT_LABEL).digest(),
);
const MEMO_HASH = new Uint8Array(
  createHash("sha256")
    .update("approval-count-measurement:no-private-memo")
    .digest(),
);
const MAGIC_PROGRAM = "Magic11111111111111111111111111111111111111" as Address;
const PAYMENT_AMOUNT = 1_000_000n;
const MAX_TRANSACTION_BYTES = 1_232;
const PAYMENT_SIZE = 245;
const PERMISSION_SIZE = 567;
const BASE_COMPUTE_LIMIT = 1_400_000;
const PRIVATE_COMPUTE_LIMIT = 400_000;

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

function compileNoopTransaction(
  instructions: readonly Instruction[],
  blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint },
) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(AUTHORITY, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(blockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const transaction = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(transaction);
  return {
    bytes: Buffer.from(wire, "base64").length,
    wire,
  } as const;
}

if (process.argv.includes("--send")) {
  throw new Error("Approval-count measurement is simulation-only and cannot broadcast");
}

const sender = await deriveAddresses();
const [[payment], paymentPermission] = await Promise.all([
  findPaymentPda({ paymentId: PAYMENT_ID }, { programAddress: PROGRAM_ID }),
  (async () => {
    const [derivedPayment] = await findPaymentPda(
      { paymentId: PAYMENT_ID },
      { programAddress: PROGRAM_ID },
    );
    return permissionPda(derivedPayment);
  })(),
]);
const [paymentDelegation, permissionDelegation] = await Promise.all([
  deriveDelegationPdas(payment, PROGRAM_ID),
  deriveDelegationPdas(paymentPermission, PERMISSION_PROGRAM_ID),
]);
const signer = createNoopSigner(AUTHORITY);

const combinedBaseInstructions = [
  getSetComputeUnitLimitInstruction({ units: BASE_COMPUTE_LIMIT }),
  await getPreparePaymentInstructionAsync({
    sender: signer,
    config: sender.config,
    payment,
    paymentId: PAYMENT_ID,
    recipient: V2_RECIPIENT,
  }),
  getCreatePaymentPermissionInstruction({
    payer: signer,
    sender: signer,
    payment,
    permission: paymentPermission,
    permissionProgram: PERMISSION_PROGRAM_ID,
  }),
  await getDelegatePaymentPermissionInstructionAsync({
    payer: signer,
    sender: signer,
    config: sender.config,
    payment,
    permission: paymentPermission,
    delegationBuffer: permissionDelegation.buffer,
    delegationRecord: permissionDelegation.record,
    delegationMetadata: permissionDelegation.metadata,
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
];

const publicRpc = createSolanaRpc(PUBLIC_RPC_URL);
const proposedAccounts = [
  payment,
  paymentPermission,
  paymentDelegation.buffer,
  paymentDelegation.record,
  paymentDelegation.metadata,
  permissionDelegation.buffer,
  permissionDelegation.record,
  permissionDelegation.metadata,
] as const;
const before = await publicRpc
  .getMultipleAccounts(
    [
      sender.config,
      sender.deposit,
      sender.permission,
      AUTHORITY,
      PRIVATE_VALIDATOR,
      ...proposedAccounts,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [config, senderDeposit, senderPermission, authority, validator, ...unused] =
  before.value;
if (
  !config ||
  config.owner !== PROGRAM_ID ||
  !senderDeposit ||
  senderDeposit.owner !== DELEGATION_PROGRAM_ID ||
  !senderPermission ||
  senderPermission.owner !== DELEGATION_PROGRAM_ID ||
  !authority ||
  !validator ||
  unused.some((account) => account !== null)
) {
  throw new Error("Funded-sender topology or fresh Payment PDAs are invalid");
}

const { value: publicBlockhash } = await publicRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const combinedBase = compileNoopTransaction(
  combinedBaseInstructions,
  publicBlockhash,
);
if (combinedBase.bytes > MAX_TRANSACTION_BYTES) {
  throw new Error(
    `Combined create/delegate transaction is ${combinedBase.bytes} bytes and cannot be one approval`,
  );
}
const baseSimulation = await publicRpc
  .simulateTransaction(combinedBase.wire, {
    accounts: { addresses: [payment, paymentPermission], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: true,
    sigVerify: false,
  })
  .send();
if (baseSimulation.value.err !== null) {
  throw new Error(
    `Combined create/delegate simulation failed: ${json({
      err: baseSimulation.value.err,
      logs: baseSimulation.value.logs,
    })}`,
  );
}
const [simulatedPaymentAccount, simulatedPermissionAccount] =
  baseSimulation.value.accounts ?? [];
if (
  !simulatedPaymentAccount ||
  simulatedPaymentAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(simulatedPaymentAccount.data).length !== PAYMENT_SIZE ||
  !simulatedPermissionAccount ||
  simulatedPermissionAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(simulatedPermissionAccount.data).length !== PERMISSION_SIZE
) {
  throw new Error("Combined simulation did not produce delegated Payment topology");
}
const simulatedPayment = getPaymentDecoder().decode(
  accountBytes(simulatedPaymentAccount.data),
);
if (
  !bytesEqual(simulatedPayment.discriminator, PAYMENT_DISCRIMINATOR) ||
  !bytesEqual(simulatedPayment.paymentId, PAYMENT_ID) ||
  simulatedPayment.sender !== AUTHORITY ||
  simulatedPayment.recipient !== V2_RECIPIENT ||
  simulatedPayment.tokenMint !== USDC_MINT ||
  simulatedPayment.amount !== 0n ||
  simulatedPayment.status !== PaymentStatus.Created ||
  simulatedPayment.initialized ||
  simulatedPayment.redacted ||
  simulatedPayment.version !== 2
) {
  throw new Error(`Combined simulation produced an invalid shell: ${json(simulatedPayment)}`);
}

const taskId = 1_788_999_999_001n;
const privateInstructions = [
  getSetComputeUnitLimitInstruction({ units: PRIVATE_COMPUTE_LIMIT }),
  await getOpenPaymentInstructionAsync({
    sender: AUTHORITY,
    payer: signer,
    config: sender.config,
    payment,
    senderDeposit: sender.deposit,
    paymentId: PAYMENT_ID,
    amount: PAYMENT_AMOUNT,
    memoHash: MEMO_HASH,
  }),
  await getSchedulePaymentInstructionAsync({
    magicProgram: MAGIC_PROGRAM,
    payer: signer,
    sender: AUTHORITY,
    payment,
    program: PROGRAM_ID,
    paymentId: PAYMENT_ID,
    taskId,
    executionIntervalMillis: 60_000n,
    iterations: 6n,
  }),
];
const privateRpc = createSolanaRpc(PRIVATE_ER_ORIGIN);
const { value: privateBlockhash } = await privateRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const privateOpen = compileNoopTransaction(privateInstructions, privateBlockhash);
if (privateOpen.bytes > MAX_TRANSACTION_BYTES) {
  throw new Error(`Atomic open/schedule is ${privateOpen.bytes} bytes`);
}

const after = await publicRpc
  .getMultipleAccounts(proposedAccounts, {
    commitment: "finalized",
    encoding: "base64",
  })
  .send();
if (after.value.some((account) => account !== null)) {
  throw new Error("Approval-count simulation persisted proposed accounts");
}

console.log(
  json({
    approvalCountMeasurement: {
      scenario:
        "funded sender with an already delegated Deposit sends to a wallet address",
      freshPaymentLabel: PAYMENT_LABEL,
      freshPayment: payment,
      recipient: V2_RECIPIENT,
      baseTransaction: {
        walletPrompt: 1,
        instructions: [
          "prepare_payment",
          "create_payment_permission",
          "delegate_payment_permission",
          "delegate_payment",
        ],
        serializedBytes: combinedBase.bytes,
        maxBytes: MAX_TRANSACTION_BYTES,
        simulationSlot: baseSimulation.context.slot,
        simulationError: null,
        unitsConsumed: baseSimulation.value.unitsConsumed ?? null,
        resultingPaymentOwner: simulatedPaymentAccount.owner,
        resultingPermissionOwner: simulatedPermissionAccount.owner,
      },
      privateTransaction: {
        walletPrompt: 1,
        instructions: ["open_payment", "schedule_payment"],
        serializedBytes: privateOpen.bytes,
        expectedIntegration:
          "already proven live as one atomic Private ER transaction",
      },
      teeAuthentication: {
        walletMessagePromptOnColdSession: 1,
        walletMessagePromptWithValidCachedSession: 0,
        paidApiKeyRequired: false,
      },
      totalWalletPrompts: {
        coldSession: 3,
        validCachedSession: 2,
        onchainTransactionApprovals: 2,
      },
      excludedFromFundedSenderCount: [
        "initial USDC funding approval",
        "one-time Deposit and Permission creation/delegation",
        "recipient Deposit onboarding before claim",
      ],
      privacyAndValueImpact: {
        baseTransactionCreatesPublicRelationshipShell: true,
        privateOpenMovesOneTestUsdcIntoPerPaymentEscrow: true,
        measurementSimulationMovedUsdc: false,
        measurementPersistedState: false,
      },
      keypairLoaded: false,
      teeAuthenticationSigned: false,
      transactionsSigned: false,
      transactionsBroadcast: false,
    },
    productDecision: {
      primaryCopy: "Review and protect payment",
      walletUx:
        "One Solana setup approval, one private payment approval, and a one-time session signature when authentication is not cached.",
      doNotClaim: "one-click or one-approval send",
    },
    assertions: "all passed",
  }),
);
