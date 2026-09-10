import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { getSchedulePaymentInstructionDataDecoder } from "../clients/ts/src/generated/instructions/schedulePayment.ts";
import { buildBalanceMutationInstructions, buildBalanceReturnInstructions, buildFirstFundingInstructions, buildProtectedPaymentInstructions, buildRecipientOnboardingInstructions } from "../src/lib/paymentWorkflow.ts";

const SENDER = address("6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn");
const RECIPIENT = address("Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ");
const signer = createNoopSigner(SENDER);
const blockhash = {
  blockhash: "11111111111111111111111111111111" as Blockhash,
  lastValidBlockHeight: 1n,
};

function transactionBytes(instructions: readonly Instruction[]) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(SENDER, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(blockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  return Buffer.from(wire, "base64").length;
}

const plan = await buildProtectedPaymentInstructions(signer, SENDER, {
  amount: 1_000_000n,
  memo: "browser builder verification",
  recipient: RECIPIENT,
});
const firstRecipientPlan = await buildProtectedPaymentInstructions(signer, SENDER, {
  amount: 1_000_000n,
  memo: "first recipient browser builder verification",
  recipient: RECIPIENT,
}, true);
const recipientOnboarding = await buildRecipientOnboardingInstructions(createNoopSigner(RECIPIENT), RECIPIENT);
const firstFunding = await buildFirstFundingInstructions(signer, SENDER, 2_000_000n);
const balanceReturn = await buildBalanceReturnInstructions(signer, SENDER);
const balanceTopUp = await buildBalanceMutationInstructions(signer, SENDER, 1_000_000n, "deposit");
const balanceWithdrawal = await buildBalanceMutationInstructions(signer, SENDER, 1_000_000n, "withdraw");

if (plan.paymentId.length !== 32) throw new Error("Payment ID must be exactly 32 bytes");
if (plan.publicInstructions.length !== 5) throw new Error("Public setup must contain compute plus four workflow instructions");
if (plan.privateInstructions.length !== 3) throw new Error("Private open must contain compute, open, and schedule instructions");
if (firstRecipientPlan.publicInstructions.length !== 6) throw new Error("A first-time recipient setup must add exactly one Deposit initialization");
if (recipientOnboarding.length !== 4) throw new Error("Recipient onboarding must contain compute plus three setup instructions");
if (firstFunding.instructions.length !== 6) throw new Error("First funding must contain compute plus five custody/onboarding instructions");
if (balanceReturn.instructions.length !== 2) throw new Error("Balance return must contain compute plus commit/undelegate");
if (balanceTopUp.instructions.length !== 3 || balanceWithdrawal.instructions.length !== 3) throw new Error("A balance mutation must contain compute, custody mutation, and redelegation");

const publicBytes = transactionBytes(plan.publicInstructions);
const privateBytes = transactionBytes(plan.privateInstructions);
const firstRecipientPublicBytes = transactionBytes(firstRecipientPlan.publicInstructions);
const recipientOnboardingBytes = transactionBytes(recipientOnboarding);
const firstFundingBytes = transactionBytes(firstFunding.instructions);
const balanceReturnBytes = transactionBytes(balanceReturn.instructions);
const balanceTopUpBytes = transactionBytes(balanceTopUp.instructions);
const balanceWithdrawalBytes = transactionBytes(balanceWithdrawal.instructions);
if ([publicBytes, privateBytes, firstRecipientPublicBytes, recipientOnboardingBytes, firstFundingBytes, balanceReturnBytes, balanceTopUpBytes, balanceWithdrawalBytes].some((bytes) => bytes > 1_232)) throw new Error("Browser transaction exceeds Solana's packet limit");
if (balanceReturnBytes !== 320 || balanceTopUpBytes !== 737 || balanceWithdrawalBytes !== 737) throw new Error("Balance-management packaging changed from the reviewed transaction shapes");

const schedule = getSchedulePaymentInstructionDataDecoder().decode(plan.privateInstructions[2].data!);
if (schedule.executionIntervalMillis !== 60_000n || schedule.iterations !== 6n) {
  throw new Error("Browser builder diverged from the proven version-2.1 Crank cadence");
}

console.log(JSON.stringify({
  assertions: "all passed",
  publicInstructionCount: plan.publicInstructions.length,
  publicTransactionBytes: publicBytes,
  firstRecipientPublicInstructionCount: firstRecipientPlan.publicInstructions.length,
  firstRecipientPublicTransactionBytes: firstRecipientPublicBytes,
  recipientOnboardingInstructionCount: recipientOnboarding.length,
  recipientOnboardingTransactionBytes: recipientOnboardingBytes,
  firstFundingInstructionCount: firstFunding.instructions.length,
  firstFundingTransactionBytes: firstFundingBytes,
  balanceReturnInstructionCount: balanceReturn.instructions.length,
  balanceReturnTransactionBytes: balanceReturnBytes,
  balanceTopUpInstructionCount: balanceTopUp.instructions.length,
  balanceTopUpTransactionBytes: balanceTopUpBytes,
  balanceWithdrawalInstructionCount: balanceWithdrawal.instructions.length,
  balanceWithdrawalTransactionBytes: balanceWithdrawalBytes,
  privateInstructionCount: plan.privateInstructions.length,
  privateTransactionBytes: privateBytes,
  scheduleIntervalMillis: schedule.executionIntervalMillis.toString(),
  scheduleIterations: schedule.iterations.toString(),
  signed: false,
  broadcast: false,
}, null, 2));
