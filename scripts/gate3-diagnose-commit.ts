import { createSolanaRpc, signature } from "@solana/kit";

import { getCrankProbeDecoder } from "../clients/ts/src/generated/accounts/crankProbe.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { PROGRAM_ID } from "./gate1-simulate.ts";
import { DELEGATION_PROGRAM_ID, deriveDelegationPdas } from "./gate1-simulate-delegation.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") throw new Error(`Unexpected encoding: ${data[1]}`);
  return Buffer.from(data[0], "base64");
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item, 2);
}

const rpc = createSolanaRpc("https://api.devnet.solana.com");
const scheduledCommitSignature = signature(
  "Cp31gU4z8Y6hEn6jZYNXYBsUbrEjyN93VBYVgqLCk47KTFtAFDswx54t7QBJKtGLNycxB4S1ycwMiLtDNUq2hhC",
);
const processUndelegationSignature = signature(
  "5RVFFa6a1npPbR5zfsQK5zNB97yg8QtezuyDkKT3PfYq98RsJt6SisdX5dMcDCsdynMnCySRKhmexhnZbXQVutKF",
);
const addresses = await deriveGate2Addresses();
const [probeDelegation, depositDelegation] = await Promise.all([
  deriveDelegationPdas(addresses.crankProbe, PROGRAM_ID),
  deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
]);
const [accountsResponse, probeSignatures, depositSignatures, receiptStatuses, scheduledCommitTransaction, processUndelegationTransaction] = await Promise.all([
  rpc.getMultipleAccounts([
    addresses.crankProbe,
    addresses.deposit,
    probeDelegation.record,
    probeDelegation.metadata,
    depositDelegation.record,
    depositDelegation.metadata,
  ], { commitment: "finalized", encoding: "base64" }).send(),
  rpc.getSignaturesForAddress(addresses.crankProbe, { commitment: "finalized", limit: 5 }).send(),
  rpc.getSignaturesForAddress(addresses.deposit, { commitment: "finalized", limit: 5 }).send(),
  rpc.getSignatureStatuses([scheduledCommitSignature, processUndelegationSignature], { searchTransactionHistory: true }).send(),
  rpc.getTransaction(scheduledCommitSignature, {
    commitment: "finalized",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send(),
  rpc.getTransaction(processUndelegationSignature, {
    commitment: "finalized",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send(),
]);
const [probeAccount, depositAccount, probeRecord, probeMetadata, depositRecord, depositMetadata] =
  accountsResponse.value;
if (!probeAccount || !depositAccount) throw new Error("A state account is missing");
const probe = getCrankProbeDecoder().decode(accountBytes(probeAccount.data));
const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));

console.log(json({
  finalizedReadSlot: accountsResponse.context.slot,
  accounts: {
    crankProbe: {
      owner: probeAccount.owner,
      isCommitted: probeAccount.owner === PROGRAM_ID,
      isDelegated: probeAccount.owner === DELEGATION_PROGRAM_ID,
      taskId: probe.taskId,
      status: CrankProbeStatus[probe.status],
      transitionCount: probe.transitionCount,
      recordPresent: probeRecord !== null,
      metadataPresent: probeMetadata !== null,
    },
    deposit: {
      owner: depositAccount.owner,
      isCommitted: depositAccount.owner === PROGRAM_ID,
      isDelegated: depositAccount.owner === DELEGATION_PROGRAM_ID,
      nextPaymentNonce: deposit.nextPaymentNonce,
      available: deposit.available,
      locked: deposit.locked,
      recordPresent: depositRecord !== null,
      metadataPresent: depositMetadata !== null,
    },
  },
  recentPublicSignatures: {
    crankProbe: probeSignatures.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot,
      err: entry.err,
      blockTime: entry.blockTime,
      confirmationStatus: entry.confirmationStatus,
    })),
    deposit: depositSignatures.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot,
      err: entry.err,
      blockTime: entry.blockTime,
      confirmationStatus: entry.confirmationStatus,
    })),
  },
  publicReceiptChain: {
    scheduledCommit: {
      signature: scheduledCommitSignature,
      status: receiptStatuses.value[0],
      slot: scheduledCommitTransaction?.slot ?? null,
      err: scheduledCommitTransaction?.meta?.err ?? null,
      accountKeys: scheduledCommitTransaction?.transaction.message.accountKeys ?? [],
      logs: scheduledCommitTransaction?.meta?.logMessages ?? [],
    },
    processUndelegation: {
      signature: processUndelegationSignature,
      status: receiptStatuses.value[1],
      slot: processUndelegationTransaction?.slot ?? null,
      err: processUndelegationTransaction?.meta?.err ?? null,
      accountKeys: processUndelegationTransaction?.transaction.message.accountKeys ?? [],
      logs: processUndelegationTransaction?.meta?.logMessages ?? [],
    },
  },
}));
