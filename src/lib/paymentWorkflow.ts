import {
  address,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getCreatePaymentPermissionInstruction } from "../../clients/ts/src/generated/instructions/createPaymentPermission";
import { getCancelPaymentInstruction } from "../../clients/ts/src/generated/instructions/cancelPayment";
import { getCreateDepositPermissionInstruction } from "../../clients/ts/src/generated/instructions/createDepositPermission";
import { getDepositUsdcInstructionAsync } from "../../clients/ts/src/generated/instructions/depositUsdc";
import { getDelegateDepositInstructionAsync } from "../../clients/ts/src/generated/instructions/delegateDeposit";
import { getDelegateDepositPermissionInstructionAsync } from "../../clients/ts/src/generated/instructions/delegateDepositPermission";
import { getDelegatePaymentInstructionAsync } from "../../clients/ts/src/generated/instructions/delegatePayment";
import { getDelegatePaymentPermissionInstructionAsync } from "../../clients/ts/src/generated/instructions/delegatePaymentPermission";
import { getOpenPaymentInstructionAsync } from "../../clients/ts/src/generated/instructions/openPayment";
import { getPreparePaymentInstructionAsync } from "../../clients/ts/src/generated/instructions/preparePayment";
import { getSchedulePaymentInstructionAsync } from "../../clients/ts/src/generated/instructions/schedulePayment";
import { getInitializeDepositInstructionAsync } from "../../clients/ts/src/generated/instructions/initializeDeposit";
import { findDepositPda } from "../../clients/ts/src/generated/pdas/deposit";
import { findPaymentPda } from "../../clients/ts/src/generated/pdas/payment";
import { PROGRAM_ID, USDC_MINT } from "./constants";
import type { PrivateClient } from "../hooks/usePrivateBalance";
import type { AppClient } from "../client";
import { sendPrivateTransaction } from "./sendPrivateTransaction";
import { encryptMemoForRecipientLink } from "./memoEnvelope";

const PRIVATE_VALIDATOR = address("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const PERMISSION_PROGRAM = address("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const DELEGATION_PROGRAM = address("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM = address("Magic11111111111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PAYMENT_INTERVAL_MILLIS = 60_000n;
const PAYMENT_ITERATIONS = 6n;

export type PaymentStage = "preparing" | "authenticating" | "opening" | "confirmed";

export type ProtectedPaymentDraft = {
  amount: bigint;
  memo: string;
  recipient: Address;
};

export type ProtectedPaymentReceipt = {
  payment: Address;
  paymentId: Uint8Array;
  paymentReference: string;
  memoEnvelope: string | null;
  publicSignature: string;
  privateSignature: string;
};

async function permissionPda(protectedAccount: Address) {
  const [permission] = await getProgramDerivedAddress({
    programAddress: PERMISSION_PROGRAM,
    seeds: [new TextEncoder().encode("permission:"), getAddressEncoder().encode(protectedAccount)],
  });
  return permission;
}

async function delegationPdas(delegatedAccount: Address, ownerProgram: Address) {
  const accountSeed = getAddressEncoder().encode(delegatedAccount);
  const [[buffer], [record], [metadata]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: ownerProgram, seeds: [new TextEncoder().encode("buffer"), accountSeed] }),
    getProgramDerivedAddress({ programAddress: DELEGATION_PROGRAM, seeds: [new TextEncoder().encode("delegation"), accountSeed] }),
    getProgramDerivedAddress({ programAddress: DELEGATION_PROGRAM, seeds: [new TextEncoder().encode("delegation-metadata"), accountSeed] }),
  ]);
  return { buffer, metadata, record } as const;
}

function nextTaskId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const view = new DataView(bytes.buffer);
  return (view.getBigUint64(0, true) & 0x7fff_ffff_ffff_ffffn) || 1n;
}

async function memoHash(memo: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(memo)));
}

export async function buildProtectedPaymentInstructions(
  transactionSigner: TransactionSigner,
  sender: Address,
  draft: ProtectedPaymentDraft,
  initializeRecipientDeposit = false,
) {
  const paymentId = crypto.getRandomValues(new Uint8Array(32));
  const [payment] = await findPaymentPda({ paymentId });
  const [senderDeposit, permission, paymentDelegation] = await Promise.all([
    findDepositPda({ user: sender, tokenMint: address(USDC_MINT) }).then(([value]) => value),
    permissionPda(payment),
    delegationPdas(payment, address(PROGRAM_ID)),
  ]);
  const permissionDelegation = await delegationPdas(permission, PERMISSION_PROGRAM);

  const publicInstructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 1_400_000 }),
    ...(initializeRecipientDeposit ? [await getInitializeDepositInstructionAsync({
      payer: transactionSigner,
      user: draft.recipient,
      tokenMint: address(USDC_MINT),
    })] : []),
    await getPreparePaymentInstructionAsync({
      sender: transactionSigner,
      payment,
      paymentId,
      recipient: draft.recipient,
    }),
    getCreatePaymentPermissionInstruction({
      payer: transactionSigner,
      sender: transactionSigner,
      payment,
      permission,
      permissionProgram: PERMISSION_PROGRAM,
    }),
    await getDelegatePaymentPermissionInstructionAsync({
      payer: transactionSigner,
      sender: transactionSigner,
      payment,
      permission,
      delegationBuffer: permissionDelegation.buffer,
      delegationRecord: permissionDelegation.record,
      delegationMetadata: permissionDelegation.metadata,
      validator: PRIVATE_VALIDATOR,
    }),
    await getDelegatePaymentInstructionAsync({
      payer: transactionSigner,
      sender: transactionSigner,
      validator: PRIVATE_VALIDATOR,
      bufferPayment: paymentDelegation.buffer,
      delegationRecordPayment: paymentDelegation.record,
      delegationMetadataPayment: paymentDelegation.metadata,
      payment,
      paymentId,
    }),
  ];

  const privateInstructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 400_000 }),
    await getOpenPaymentInstructionAsync({
      sender: transactionSigner,
      payment,
      senderDeposit,
      paymentId,
      amount: draft.amount,
      memoHash: await memoHash(draft.memo),
    }),
    await getSchedulePaymentInstructionAsync({
      magicProgram: MAGIC_PROGRAM,
      payer: transactionSigner,
      payment,
      program: address(PROGRAM_ID),
      paymentId,
      taskId: nextTaskId(),
      executionIntervalMillis: PAYMENT_INTERVAL_MILLIS,
      iterations: PAYMENT_ITERATIONS,
    }),
  ];

  return { payment, paymentId, privateInstructions, publicInstructions, recipientDeposit: await findDepositPda({ user: draft.recipient, tokenMint: address(USDC_MINT) }).then(([value]) => value) } as const;
}

export async function openProtectedPayment(
  publicClient: AppClient,
  privateClient: PrivateClient,
  transactionSigner: TransactionSigner,
  sender: Address,
  draft: ProtectedPaymentDraft,
  onStage: (stage: PaymentStage) => void,
): Promise<ProtectedPaymentReceipt> {
  const [recipientDeposit] = await findDepositPda({ user: draft.recipient, tokenMint: address(USDC_MINT) });
  const recipientDepositState = await publicClient.rpc.getAccountInfo(recipientDeposit, { commitment: "finalized" }).send();
  const plan = await buildProtectedPaymentInstructions(transactionSigner, sender, draft, recipientDepositState.value === null);
  const memoEnvelope = await encryptMemoForRecipientLink(draft.memo);
  const existing = await publicClient.rpc.getAccountInfo(plan.payment, { commitment: "finalized" }).send();
  if (existing.value) throw new Error("A random payment reference collided. Please review again.");

  onStage("preparing");
  const publicResult = await publicClient.sendTransaction(plan.publicInstructions);
  onStage("opening");
  const privateSignature = await sendPrivateTransaction(privateClient, plan.privateInstructions);
  onStage("confirmed");

  return {
    payment: plan.payment,
    paymentId: plan.paymentId,
    paymentReference: getBase58Decoder().decode(plan.paymentId),
    memoEnvelope,
    publicSignature: String(publicResult.context.signature),
    privateSignature,
  };
}

export async function onboardRecipientDeposit(
  publicClient: AppClient,
  transactionSigner: TransactionSigner,
  recipient: Address,
) {
  const [deposit] = await findDepositPda({ user: recipient, tokenMint: address(USDC_MINT) });
  const permission = await permissionPda(deposit);
  const [depositState, permissionState] = (await publicClient.rpc.getMultipleAccounts(
    [deposit, permission],
    { commitment: "finalized" },
  ).send()).value;
  if (!depositState) throw new Error("The sender did not initialize your receiving balance.");
  if (depositState.owner === DELEGATION_PROGRAM && permissionState?.owner === DELEGATION_PROGRAM) return null;
  if (depositState.owner !== PROGRAM_ID) throw new Error("The receiving balance has an unexpected owner.");
  if (permissionState && permissionState.owner !== PERMISSION_PROGRAM) throw new Error("The receiving permission has an unexpected owner.");

  const instructions = await buildRecipientOnboardingInstructions(
    transactionSigner,
    recipient,
    !permissionState,
    permissionState?.owner !== DELEGATION_PROGRAM,
  );
  const result = await publicClient.sendTransaction(instructions);
  return String(result.context.signature);
}

export async function buildRecipientOnboardingInstructions(
  transactionSigner: TransactionSigner,
  recipient: Address,
  createPermission = true,
  delegatePermission = true,
) {
  const [deposit] = await findDepositPda({ user: recipient, tokenMint: address(USDC_MINT) });
  const permission = await permissionPda(deposit);
  const [depositDelegation, permissionDelegation] = await Promise.all([
    delegationPdas(deposit, address(PROGRAM_ID)),
    delegationPdas(permission, PERMISSION_PROGRAM),
  ]);
  const instructions: Instruction[] = [getSetComputeUnitLimitInstruction({ units: 600_000 })];
  if (createPermission) {
    instructions.push(getCreateDepositPermissionInstruction({
      payer: transactionSigner,
      user: transactionSigner,
      deposit,
      permission,
      permissionProgram: PERMISSION_PROGRAM,
    }));
  }
  if (delegatePermission) {
    instructions.push(await getDelegateDepositPermissionInstructionAsync({
      payer: transactionSigner,
      user: transactionSigner,
      deposit,
      permission,
      delegationBuffer: permissionDelegation.buffer,
      delegationRecord: permissionDelegation.record,
      delegationMetadata: permissionDelegation.metadata,
      validator: PRIVATE_VALIDATOR,
    }));
  }
  instructions.push(await getDelegateDepositInstructionAsync({
    payer: transactionSigner,
    owner: transactionSigner,
    validator: PRIVATE_VALIDATOR,
    bufferDeposit: depositDelegation.buffer,
    delegationRecordDeposit: depositDelegation.record,
    delegationMetadataDeposit: depositDelegation.metadata,
    deposit,
    user: recipient,
    tokenMint: address(USDC_MINT),
  }));
  return instructions;
}

export async function buildFirstFundingInstructions(
  transactionSigner: TransactionSigner,
  user: Address,
  amount: bigint,
) {
  if (amount <= 0n) throw new Error("Funding amount must be greater than zero.");
  const mint = address(USDC_MINT);
  const [deposit] = await findDepositPda({ user, tokenMint: mint });
  const permission = await permissionPda(deposit);
  const [[userTokenAccount], depositDelegation, permissionDelegation] = await Promise.all([
    getProgramDerivedAddress({
      programAddress: ASSOCIATED_TOKEN_PROGRAM,
      seeds: [getAddressEncoder().encode(user), getAddressEncoder().encode(TOKEN_PROGRAM), getAddressEncoder().encode(mint)],
    }),
    delegationPdas(deposit, address(PROGRAM_ID)),
    delegationPdas(permission, PERMISSION_PROGRAM),
  ]);
  const instructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 1_400_000 }),
    await getInitializeDepositInstructionAsync({ payer: transactionSigner, user, tokenMint: mint }),
    await getDepositUsdcInstructionAsync({ user: transactionSigner, userTokenAccount, tokenMint: mint, amount }),
    getCreateDepositPermissionInstruction({ payer: transactionSigner, user: transactionSigner, deposit, permission, permissionProgram: PERMISSION_PROGRAM }),
    await getDelegateDepositPermissionInstructionAsync({
      payer: transactionSigner,
      user: transactionSigner,
      deposit,
      permission,
      delegationBuffer: permissionDelegation.buffer,
      delegationRecord: permissionDelegation.record,
      delegationMetadata: permissionDelegation.metadata,
      validator: PRIVATE_VALIDATOR,
    }),
    await getDelegateDepositInstructionAsync({
      payer: transactionSigner,
      owner: transactionSigner,
      validator: PRIVATE_VALIDATOR,
      bufferDeposit: depositDelegation.buffer,
      delegationRecordDeposit: depositDelegation.record,
      delegationMetadataDeposit: depositDelegation.metadata,
      deposit,
      user,
      tokenMint: mint,
    }),
  ];
  return { deposit, instructions, permission, userTokenAccount } as const;
}

export async function fundFirstProtectedBalance(
  publicClient: AppClient,
  transactionSigner: TransactionSigner,
  user: Address,
  amount: bigint,
) {
  const plan = await buildFirstFundingInstructions(transactionSigner, user, amount);
  const [depositState, permissionState, tokenAccountState] = (await publicClient.rpc.getMultipleAccounts(
    [plan.deposit, plan.permission, plan.userTokenAccount],
    { commitment: "finalized", encoding: "base64" },
  ).send()).value;
  if (depositState || permissionState) throw new Error("This protected balance is already initialized. Top-ups require the withdrawal/redelegation flow.");
  if (!tokenAccountState || tokenAccountState.owner !== TOKEN_PROGRAM) throw new Error("No Circle Devnet USDC token account was found for this wallet.");
  const tokenData = getBase64Encoder().encode((tokenAccountState.data as [string, "base64"])[0]);
  if (tokenData.length !== 165) throw new Error("The wallet's Devnet USDC token account has an unexpected layout.");
  const tokenAmount = new DataView(tokenData.buffer, tokenData.byteOffset, tokenData.byteLength).getBigUint64(64, true);
  if (tokenAmount < amount) throw new Error("The wallet does not hold enough Circle Devnet USDC for this deposit.");
  const result = await publicClient.sendTransaction(plan.instructions);
  return String(result.context.signature);
}

export async function cancelProtectedPayment(
  privateClient: PrivateClient,
  transactionSigner: TransactionSigner,
  sender: Address,
  payment: Address,
) {
  const [senderDeposit] = await findDepositPda({ user: sender, tokenMint: address(USDC_MINT) });
  return sendPrivateTransaction(privateClient, [
    getSetComputeUnitLimitInstruction({ units: 250_000 }),
    getCancelPaymentInstruction({ sender: transactionSigner, payment, senderDeposit }),
  ]);
}
