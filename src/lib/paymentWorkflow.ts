import {
  address,
  createSolanaRpc,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getCreatePaymentPermissionInstruction } from "../../clients/ts/src/generated/instructions/createPaymentPermission";
import { getCancelPaymentInstruction } from "../../clients/ts/src/generated/instructions/cancelPayment";
import { getCommitAndUndelegateDepositInstruction } from "../../clients/ts/src/generated/instructions/commitAndUndelegateDeposit";
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
import { getWithdrawUsdcInstructionAsync } from "../../clients/ts/src/generated/instructions/withdrawUsdc";
import { findDepositPda } from "../../clients/ts/src/generated/pdas/deposit";
import { findPaymentPda } from "../../clients/ts/src/generated/pdas/payment";
import { MAGIC_ROUTER_RPC, PROGRAM_ID, SOLANA_DEVNET_RPC, USDC_MINT } from "./constants";
import type { PrivateClient } from "../hooks/usePrivateBalance";
import type { AppClient } from "../client";
import { sendPrivateTransaction } from "./sendPrivateTransaction";
import { sendPublicTransaction } from "./sendPublicTransaction";

const PRIVATE_VALIDATOR = address("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const PERMISSION_PROGRAM = address("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const DELEGATION_PROGRAM = address("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM = address("Magic11111111111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PAYMENT_INTERVAL_MILLIS = 60_000n;
const PAYMENT_ITERATIONS = 6n;
const BASE_LAYER_RPC = createSolanaRpc(SOLANA_DEVNET_RPC);

type FinalizedBase64Account = {
  data: readonly [string, "base64"];
  owner: string;
  space: number | bigint;
};

export type FinalizedAccountProbe = {
  account: FinalizedBase64Account | null;
  endpoint: string;
  slot: number | null;
  status: "found" | "missing" | "unavailable";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read-only JSON-RPC fallback for browsers where an SDK transport reports a
 * false missing account. The response is untrusted until its complete shape is
 * checked here and its token owner/layout/mint are checked by the caller.
 */
export async function probeFinalizedBase64Account(
  endpoint: string,
  account: Address,
): Promise<FinalizedAccountProbe> {
  try {
    const response = await fetch(endpoint, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "getAccountInfo",
        params: [account, { commitment: "finalized", encoding: "base64" }],
      }),
      cache: "no-store",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { account: null, endpoint, slot: null, status: "unavailable" };
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || "error" in payload || !isRecord(payload.result)) {
      return { account: null, endpoint, slot: null, status: "unavailable" };
    }
    const result = payload.result;
    const slot = isRecord(result.context) && typeof result.context.slot === "number" && Number.isSafeInteger(result.context.slot)
      ? result.context.slot
      : null;
    if (result.value === null) {
      return { account: null, endpoint, slot, status: "missing" };
    }
    if (!isRecord(result.value)) {
      return { account: null, endpoint, slot, status: "unavailable" };
    }

    const value = result.value;
    const data = value.data;
    if (
      typeof value.owner !== "string"
      || typeof value.space !== "number"
      || !Number.isSafeInteger(value.space)
      || !Array.isArray(data)
      || data.length !== 2
      || typeof data[0] !== "string"
      || data[1] !== "base64"
    ) {
      return { account: null, endpoint, slot, status: "unavailable" };
    }

    return {
      account: { data: [data[0], "base64"], owner: value.owner, space: value.space },
      endpoint,
      slot,
      status: "found",
    };
  } catch {
    return { account: null, endpoint, slot: null, status: "unavailable" };
  }
}

function describeAccountProbe(label: string, probe: FinalizedAccountProbe) {
  const slot = probe.slot === null ? "unknown slot" : `slot ${probe.slot}`;
  if (probe.status === "found") return `${label}: found at ${slot}`;
  if (probe.status === "missing") return `${label}: missing at ${slot}`;
  return `${label}: unavailable`;
}

async function associatedTokenAddress(owner: Address, mint: Address) {
  const [tokenAccount] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [getAddressEncoder().encode(owner), getAddressEncoder().encode(TOKEN_PROGRAM), getAddressEncoder().encode(mint)],
  });
  return tokenAccount;
}

function validatedUsdcAmount(account: FinalizedBase64Account, expectedOwner: Address) {
  if (account.owner !== TOKEN_PROGRAM || Number(account.space) !== 165) return null;
  const tokenData = getBase64Encoder().encode(account.data[0]);
  if (tokenData.length !== 165) return null;
  const tokenMint = getAddressDecoder().decode(tokenData.slice(0, 32));
  const tokenOwner = getAddressDecoder().decode(tokenData.slice(32, 64));
  if (tokenMint !== address(USDC_MINT) || tokenOwner !== expectedOwner) return null;
  return new DataView(tokenData.buffer, tokenData.byteOffset, tokenData.byteLength).getBigUint64(64, true);
}

/**
 * Discover the wallet's real USDC source account instead of assuming one local
 * ATA derivation is authoritative. The program accepts any SPL token account
 * whose mint and authority match, and every untrusted RPC field is validated.
 */
export async function discoverUsdcFundingSource(
  user: Address,
  amount: bigint,
): Promise<{ tokenAmount: bigint; userTokenAccount: Address }> {
  const response = await fetch(SOLANA_DEVNET_RPC, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "getTokenAccountsByOwner",
      params: [user, { mint: USDC_MINT }, { commitment: "finalized", encoding: "base64" }],
    }),
    cache: "no-store",
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Solana Devnet could not list this wallet's USDC accounts. Try again shortly.");

  const payload: unknown = await response.json();
  if (!isRecord(payload) || "error" in payload || !isRecord(payload.result) || !Array.isArray(payload.result.value)) {
    throw new Error("Solana Devnet returned an invalid USDC account list. Try again shortly.");
  }

  const candidates: Array<{ tokenAmount: bigint; userTokenAccount: Address }> = [];
  for (const entry of payload.result.value) {
    if (!isRecord(entry) || typeof entry.pubkey !== "string" || !isRecord(entry.account)) continue;
    const accountData = entry.account.data;
    if (
      typeof entry.account.owner !== "string"
      || typeof entry.account.space !== "number"
      || !Number.isSafeInteger(entry.account.space)
      || !Array.isArray(accountData)
      || accountData.length !== 2
      || typeof accountData[0] !== "string"
      || accountData[1] !== "base64"
    ) continue;

    try {
      const userTokenAccount = address(entry.pubkey);
      const tokenAmount = validatedUsdcAmount({
        data: [accountData[0], "base64"],
        owner: entry.account.owner,
        space: entry.account.space,
      }, user);
      if (tokenAmount !== null) candidates.push({ tokenAmount, userTokenAccount });
    } catch {
      // Ignore malformed public keys and malformed account bytes from the
      // untrusted RPC response rather than allowing them into an instruction.
    }
  }

  if (candidates.length === 0) throw new Error("No valid Circle Devnet USDC account was found for this wallet.");
  candidates.sort((left, right) => left.tokenAmount === right.tokenAmount ? 0 : left.tokenAmount > right.tokenAmount ? -1 : 1);
  const funded = candidates.find((candidate) => candidate.tokenAmount >= amount);
  if (!funded) throw new Error("The wallet does not hold enough Circle Devnet USDC for this deposit.");
  return funded;
}

export type PaymentStage = "reconciling" | "preparing" | "authenticating" | "opening" | "confirmed";

export type ProtectedPaymentDraft = {
  amount: bigint;
  memo: string;
  recipient: Address;
};

export type ProtectedPaymentReceipt = {
  payment: Address;
  paymentId: ReadonlyUint8Array;
  paymentReference: string;
  memoEnvelope: string | null;
  publicSignature: string;
  privateSignature: string;
};

export type ProtectedPaymentIdentity = {
  memoHash: ReadonlyUint8Array;
  paymentId: ReadonlyUint8Array;
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
  identity?: ProtectedPaymentIdentity,
  privateClient?: PrivateClient,
) {
  const paymentId = identity?.paymentId ?? crypto.getRandomValues(new Uint8Array(32));
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
      sender,
      payer: privateClient?.identity ?? transactionSigner,
      sessionToken: privateClient?.sessionToken,
      payment,
      senderDeposit,
      paymentId,
      amount: draft.amount,
      memoHash: identity?.memoHash ?? await memoHash(draft.memo),
    }),
    await getSchedulePaymentInstructionAsync({
      magicProgram: MAGIC_PROGRAM,
      payer: privateClient?.identity ?? transactionSigner,
      sender,
      sessionToken: privateClient?.sessionToken,
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
  return sendPublicTransaction(publicClient, transactionSigner, instructions);
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
  fundingSource?: Address,
) {
  if (amount <= 0n) throw new Error("Funding amount must be greater than zero.");
  const mint = address(USDC_MINT);
  const [deposit] = await findDepositPda({ user, tokenMint: mint });
  const permission = await permissionPda(deposit);
  const [userTokenAccount, depositDelegation, permissionDelegation] = await Promise.all([
    fundingSource ? Promise.resolve(fundingSource) : associatedTokenAddress(user, mint),
    delegationPdas(deposit, address(PROGRAM_ID)),
    delegationPdas(permission, PERMISSION_PROGRAM),
  ]);
  const preparationInstructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 500_000 }),
    await getInitializeDepositInstructionAsync({ payer: transactionSigner, user, tokenMint: mint }),
    await getDepositUsdcInstructionAsync({ user: transactionSigner, userTokenAccount, tokenMint: mint, amount }),
    getCreateDepositPermissionInstruction({ payer: transactionSigner, user: transactionSigner, deposit, permission, permissionProgram: PERMISSION_PROGRAM }),
  ];
  const delegationInstructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 500_000 }),
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
  return {
    delegationInstructions,
    deposit,
    // Retain the combined plan for diagnostics and size regression checks.
    instructions: [...preparationInstructions, ...delegationInstructions.slice(1)],
    permission,
    preparationInstructions,
    userTokenAccount,
  } as const;
}

export async function buildBalanceReturnInstructions(
  privateClient: PrivateClient,
  user: Address,
) {
  const [deposit] = await findDepositPda({ user, tokenMint: address(USDC_MINT) });
  return {
    deposit,
    instructions: [
      getSetComputeUnitLimitInstruction({ units: 200_000 }),
      getCommitAndUndelegateDepositInstruction({
        payer: privateClient.identity,
        user,
        sessionToken: privateClient.sessionToken,
        deposit,
      }),
    ] as readonly Instruction[],
  } as const;
}

export async function buildBalanceMutationInstructions(
  transactionSigner: TransactionSigner,
  user: Address,
  amount: bigint,
  kind: "deposit" | "withdraw",
) {
  if (amount <= 0n) throw new Error("Balance change amount must be greater than zero.");
  const mint = address(USDC_MINT);
  const [deposit] = await findDepositPda({ user, tokenMint: mint });
  const [userTokenAccount, depositDelegation] = await Promise.all([
    associatedTokenAddress(user, mint),
    delegationPdas(deposit, address(PROGRAM_ID)),
  ]);
  const mutation = kind === "deposit"
    ? await getDepositUsdcInstructionAsync({ user: transactionSigner, deposit, userTokenAccount, tokenMint: mint, amount })
    : await getWithdrawUsdcInstructionAsync({ user: transactionSigner, deposit, userTokenAccount, tokenMint: mint, amount });
  const redelegate = await getDelegateDepositInstructionAsync({
    payer: transactionSigner,
    owner: transactionSigner,
    validator: PRIVATE_VALIDATOR,
    bufferDeposit: depositDelegation.buffer,
    delegationRecordDeposit: depositDelegation.record,
    delegationMetadataDeposit: depositDelegation.metadata,
    deposit,
    user,
    tokenMint: mint,
  });
  return {
    deposit,
    instructions: [getSetComputeUnitLimitInstruction({ units: 1_000_000 }), mutation, redelegate] as readonly Instruction[],
    userTokenAccount,
  } as const;
}

export async function verifyFirstFundingPlan(
  publicClient: AppClient,
  plan: Awaited<ReturnType<typeof buildFirstFundingInstructions>>,
  user: Address,
  amount: bigint,
) {
  const status = await inspectFirstFundingAccounts(publicClient, plan.deposit, plan.permission, "confirmed");
  if (status !== "fresh") {
    return { status, tokenAmount: null, userTokenAccount: plan.userTokenAccount } as const;
  }

  // Faucet-created token accounts can reach different public RPC nodes a few
  // seconds apart. Poll the exact derived ATA separately; no transaction is
  // constructed until the finalized account and its owner/layout are verified.
  let tokenAccountState: FinalizedBase64Account | null = null;
  for (let attempt = 0; attempt < 5 && !tokenAccountState; attempt += 1) {
    try {
      const accountState = (await BASE_LAYER_RPC.getAccountInfo(
        plan.userTokenAccount,
        { commitment: "finalized", encoding: "base64" },
      ).send()).value;
      if (accountState) {
        tokenAccountState = {
          data: accountState.data as [string, "base64"],
          owner: String(accountState.owner),
          space: accountState.space,
        };
      }
    } catch {
      // A direct, independently validated JSON-RPC probe below distinguishes a
      // transport failure from a genuinely missing finalized account.
      break;
    }
    if (!tokenAccountState && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  if (!tokenAccountState) {
    const [solanaProbe, routerProbe] = await Promise.all([
      probeFinalizedBase64Account(SOLANA_DEVNET_RPC, plan.userTokenAccount),
      probeFinalizedBase64Account(MAGIC_ROUTER_RPC, plan.userTokenAccount),
    ]);
    tokenAccountState = solanaProbe.account ?? routerProbe.account;
    if (!tokenAccountState) {
      throw new Error(
        `Could not read USDC account ${plan.userTokenAccount} for wallet ${user}. ${describeAccountProbe("Solana Devnet", solanaProbe)}; ${describeAccountProbe("Magic Router", routerProbe)}.`,
      );
    }
  }
  if (tokenAccountState.owner !== TOKEN_PROGRAM) throw new Error("The wallet's Devnet USDC account has an unexpected owner program.");
  const tokenData = getBase64Encoder().encode((tokenAccountState.data as [string, "base64"])[0]);
  if (Number(tokenAccountState.space) !== 165 || tokenData.length !== 165) {
    throw new Error("The wallet's Devnet USDC token account has an unexpected layout.");
  }
  const tokenMint = getAddressDecoder().decode(tokenData.slice(0, 32));
  const tokenOwner = getAddressDecoder().decode(tokenData.slice(32, 64));
  if (tokenMint !== address(USDC_MINT) || tokenOwner !== user) {
    throw new Error("The wallet's Devnet USDC token account does not match the expected mint and owner.");
  }
  const tokenAmount = new DataView(tokenData.buffer, tokenData.byteOffset, tokenData.byteLength).getBigUint64(64, true);
  if (tokenAmount < amount) throw new Error("The wallet does not hold enough Circle Devnet USDC for this deposit.");
  return { status: "fresh", tokenAmount, userTokenAccount: plan.userTokenAccount } as const;
}

async function inspectFirstFundingAccounts(
  publicClient: AppClient,
  deposit: Address,
  permission: Address,
  commitment: "confirmed" | "finalized",
): Promise<"fresh" | "prepared" | "delegated"> {
  const [depositState, permissionState] = (await publicClient.rpc.getMultipleAccounts(
    [deposit, permission],
    { commitment, encoding: "base64" },
  ).send()).value;
  if (!depositState && !permissionState) return "fresh";
  if (!depositState || !permissionState) {
    throw new Error("Protected balance setup is incomplete on Devnet. No transaction was sent; inspect the Deposit and Permission accounts before retrying.");
  }
  if (depositState.owner === DELEGATION_PROGRAM && permissionState.owner === DELEGATION_PROGRAM) return "delegated";
  if (depositState.owner === PROGRAM_ID && permissionState.owner === PERMISSION_PROGRAM) return "prepared";
  throw new Error("Protected balance accounts have unexpected owners. No transaction was sent.");
}

async function waitForPreparedFunding(
  publicClient: AppClient,
  deposit: Address,
  permission: Address,
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { value: [depositState, permissionState] } = await publicClient.rpc.getMultipleAccounts(
      [deposit, permission],
      { commitment: "confirmed", encoding: "base64" },
    ).send();
    if (depositState?.owner === PROGRAM_ID && permissionState?.owner === PERMISSION_PROGRAM) return;
    if (attempt < 29) await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error("Your USDC deposit confirmed, but the privacy accounts are still syncing. Choose Set up balance again to safely finish protection; funds will not be deposited twice.");
}

export type FirstFundingStage = "checking" | "depositing" | "delegating" | "ready";

export async function fundFirstProtectedBalance(
  publicClient: AppClient,
  transactionSigner: TransactionSigner,
  user: Address,
  amount: bigint,
  onStage?: (stage: FirstFundingStage) => void,
) {
  onStage?.("checking");
  const mint = address(USDC_MINT);
  const [deposit] = await findDepositPda({ user, tokenMint: mint });
  const permission = await permissionPda(deposit);
  // Confirmed state is used here so an immediate retry after approving step 1
  // cannot mistake a not-yet-finalized Deposit for a fresh setup and deposit
  // the same requested amount twice.
  const existingState = await inspectFirstFundingAccounts(publicClient, deposit, permission, "confirmed");
  if (existingState === "delegated") {
    onStage?.("ready");
    return null;
  }
  if (existingState === "prepared") {
    const plan = await buildFirstFundingInstructions(
      transactionSigner,
      user,
      amount,
      await associatedTokenAddress(user, mint),
    );
    onStage?.("delegating");
    const signature = await sendPublicTransaction(publicClient, transactionSigner, plan.delegationInstructions);
    onStage?.("ready");
    return signature;
  }

  const fundingSource = await discoverUsdcFundingSource(user, amount);
  const plan = await buildFirstFundingInstructions(transactionSigner, user, amount, fundingSource.userTokenAccount);
  const state = await verifyFirstFundingPlan(publicClient, plan, user, amount);
  if (state.status === "fresh") {
    onStage?.("depositing");
    await sendPublicTransaction(publicClient, transactionSigner, plan.preparationInstructions);
    await waitForPreparedFunding(publicClient, plan.deposit, plan.permission);
  }
  onStage?.("delegating");
  const signature = await sendPublicTransaction(publicClient, transactionSigner, plan.delegationInstructions);
  onStage?.("ready");
  return signature;
}

export async function cancelProtectedPayment(
  privateClient: PrivateClient,
  sender: Address,
  payment: Address,
) {
  const [senderDeposit] = await findDepositPda({ user: sender, tokenMint: address(USDC_MINT) });
  return sendPrivateTransaction(privateClient, [
    getSetComputeUnitLimitInstruction({ units: 250_000 }),
    getCancelPaymentInstruction({
      sender,
      payer: privateClient.identity,
      sessionToken: privateClient.sessionToken,
      payment,
      senderDeposit,
    }),
  ]);
}
