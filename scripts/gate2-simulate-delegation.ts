import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getCrankProbeDecoder } from "../clients/ts/src/generated/accounts/crankProbe.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getDelegateCrankProbeInstructionAsync } from "../clients/ts/src/generated/instructions/delegateCrankProbe.ts";
import { getDelegateCrankProbePermissionInstructionAsync } from "../clients/ts/src/generated/instructions/delegateCrankProbePermission.ts";
import { getDelegateDepositInstructionAsync } from "../clients/ts/src/generated/instructions/delegateDeposit.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const rpc = createSolanaRpc(RPC_URL);
const noopSigner = createNoopSigner(AUTHORITY);

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") throw new Error(`Unexpected encoding: ${data[1]}`);
  return Buffer.from(data[0], "base64");
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

export async function buildGate2Delegation(signer: TransactionSigner = noopSigner) {
  const addresses = await deriveGate2Addresses();
  const [crankPermissionDelegation, depositDelegation, crankProbeDelegation] =
    await Promise.all([
      deriveDelegationPdas(addresses.crankPermission, PERMISSION_PROGRAM_ID),
      deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
      deriveDelegationPdas(addresses.crankProbe, PROGRAM_ID),
    ]);
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: 800_000 }),
    await getDelegateCrankProbePermissionInstructionAsync({
      payer: signer,
      owner: signer,
      config: addresses.config,
      crankProbe: addresses.crankProbe,
      permission: addresses.crankPermission,
      delegationBuffer: crankPermissionDelegation.buffer,
      delegationRecord: crankPermissionDelegation.record,
      delegationMetadata: crankPermissionDelegation.metadata,
      validator: addresses.privateValidator,
    }),
    await getDelegateDepositInstructionAsync({
      payer: signer,
      owner: signer,
      config: addresses.config,
      validator: addresses.privateValidator,
      bufferDeposit: depositDelegation.buffer,
      delegationRecordDeposit: depositDelegation.record,
      delegationMetadataDeposit: depositDelegation.metadata,
      deposit: addresses.deposit,
      user: AUTHORITY,
      tokenMint: USDC_MINT,
    }),
    await getDelegateCrankProbeInstructionAsync({
      payer: signer,
      owner: signer,
      config: addresses.config,
      validator: addresses.privateValidator,
      bufferCrankProbe: crankProbeDelegation.buffer,
      delegationRecordCrankProbe: crankProbeDelegation.record,
      delegationMetadataCrankProbe: crankProbeDelegation.metadata,
      crankProbe: addresses.crankProbe,
      probeOwner: AUTHORITY,
    }),
  ];
  return {
    addresses,
    crankPermissionDelegation,
    crankProbeDelegation,
    depositDelegation,
    instructions,
  } as const;
}

export async function simulateGate2Delegation(): Promise<void> {
  const plan = await buildGate2Delegation();
  const { addresses } = plan;
  const preflightAddresses = [
    addresses.deposit,
    addresses.permission,
    addresses.crankProbe,
    addresses.crankPermission,
    plan.crankPermissionDelegation.buffer,
    plan.crankPermissionDelegation.record,
    plan.crankPermissionDelegation.metadata,
    plan.depositDelegation.buffer,
    plan.depositDelegation.record,
    plan.depositDelegation.metadata,
    plan.crankProbeDelegation.buffer,
    plan.crankProbeDelegation.record,
    plan.crankProbeDelegation.metadata,
  ] as const;
  const preflight = await rpc
    .getMultipleAccounts(preflightAddresses, {
      commitment: "finalized",
      encoding: "base64",
    })
    .send();
  const [depositAccount, depositPermission, probeAccount, probePermission, ...newPdas] =
    preflight.value;
  if (!depositAccount || depositAccount.owner !== PROGRAM_ID || accountBytes(depositAccount.data).length !== 98) {
    throw new Error("Deposit failed owner/length validation");
  }
  if (!probeAccount || probeAccount.owner !== PROGRAM_ID || accountBytes(probeAccount.data).length !== 99) {
    throw new Error("CrankProbe failed owner/length validation");
  }
  if (!depositPermission || depositPermission.owner !== DELEGATION_PROGRAM_ID) {
    throw new Error("The existing Deposit Permission is not delegated");
  }
  if (
    !probePermission ||
    probePermission.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(probePermission.data).length !== 567
  ) {
    throw new Error("CrankProbe Permission failed owner/length validation");
  }
  if (newPdas.some((account) => account !== null)) {
    throw new Error("One or more proposed delegation PDAs already exist");
  }
  const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
  const probe = getCrankProbeDecoder().decode(accountBytes(probeAccount.data));
  if (
    deposit.available !== 0n ||
    deposit.locked !== 0n ||
    deposit.nextPaymentNonce !== 0n ||
    probe.status !== CrankProbeStatus.Pending ||
    probe.taskId !== 0n ||
    probe.transitionCount !== 0n ||
    probe.deposit !== addresses.deposit
  ) {
    throw new Error(`Unexpected pre-delegation state: ${json({ deposit, probe })}`);
  }

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
    throw new Error(`Combined Gate 2 delegation is ${serializedBytes} bytes; Solana limit is 1232`);
  }
  const returnedAddresses = [
    addresses.deposit,
    addresses.crankProbe,
    addresses.crankPermission,
    plan.crankPermissionDelegation.buffer,
    plan.crankPermissionDelegation.record,
    plan.crankPermissionDelegation.metadata,
    plan.depositDelegation.buffer,
    plan.depositDelegation.record,
    plan.depositDelegation.metadata,
    plan.crankProbeDelegation.buffer,
    plan.crankProbeDelegation.record,
    plan.crankProbeDelegation.metadata,
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
    throw new Error(`Combined Gate 2 delegation failed: ${json(simulation.value.err)}`);
  }
  const post = simulation.value.accounts;
  if (!post || post.some((account) => account === null)) {
    throw new Error("Delegation simulation returned incomplete post-state");
  }
  if (
    post[0]?.owner !== DELEGATION_PROGRAM_ID ||
    post[1]?.owner !== DELEGATION_PROGRAM_ID ||
    post[2]?.owner !== DELEGATION_PROGRAM_ID
  ) {
    throw new Error("Simulation did not delegate Deposit, CrankProbe, and its Permission");
  }

  console.log(
    json({
      cluster: "Solana Devnet",
      proposedTransaction: {
        feePayer: AUTHORITY,
        signer: AUTHORITY,
        instructions: [
          "delegate CrankProbe Permission to the configured Private ER",
          "delegate Deposit to the configured Private ER",
          "delegate CrankProbe to the configured Private ER",
        ],
        privateValidator: addresses.privateValidator,
        usdcMoved: "0",
      },
      serializedBytes,
      simulation: {
        err: null,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        ownersAfter: {
          crankPermission: post[2]?.owner,
          crankProbe: post[1]?.owner,
          deposit: post[0]?.owner,
          existingDepositPermission: depositPermission.owner,
        },
      },
    }),
  );
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  await simulateGate2Delegation();
}
