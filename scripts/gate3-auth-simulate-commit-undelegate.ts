import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Signature,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getCrankProbeDecoder } from "../clients/ts/src/generated/accounts/crankProbe.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getCommitAndUndelegateCrankProbeInstructionAsync } from "../clients/ts/src/generated/instructions/commitAndUndelegateCrankProbe.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";
import { authenticatePrivateEr, PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";

const PUBLIC_RPC_URL = "https://api.devnet.solana.com" as const;
const APPROVAL_FLAG = "--approved-gate3-tee-auth";
const SEND_REQUESTED = process.argv.includes("--send");
const SEND_APPROVAL_FLAG = "--approved-gate3-commit-undelegate";
const MAX_CONFIRMATION_POLLS = 120;
const EXPECTED_TASK_ID = 1_788_931_901n;

function accountBytes(data: readonly [string, string]): Uint8Array {
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign a TEE authentication message without ${APPROVAL_FLAG}`);
}
if (SEND_REQUESTED && !process.argv.includes(SEND_APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign or send the commit/undelegate transaction without ${SEND_APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved owner signer file");
}
const authentication = await authenticatePrivateEr(keypairPath);
if (
  authentication.identity !== AUTHORITY ||
  authentication.signerClient.payer.address !== AUTHORITY
) {
  throw new Error("Signer does not match the protected owner and fee payer");
}
const privateRpc = createSolanaRpc(authentication.authenticatedUrl.toString());
const publicRpc = createSolanaRpc(PUBLIC_RPC_URL);
const addresses = await deriveGate2Addresses();
const [privateResponse, publicResponse] = await Promise.all([
  privateRpc.getMultipleAccounts(
    [addresses.crankProbe, addresses.deposit],
    { commitment: "confirmed", encoding: "base64" },
  ).send(),
  publicRpc.getMultipleAccounts(
    [addresses.crankProbe, addresses.deposit],
    { commitment: "finalized", encoding: "base64" },
  ).send(),
]);
const [privateProbeAccount, privateDepositAccount] = privateResponse.value;
const [publicProbeAccount, publicDepositAccount] = publicResponse.value;
if (!privateProbeAccount || !privateDepositAccount || !publicProbeAccount || !publicDepositAccount) {
  throw new Error("A required private or public Gate 3 account is missing");
}
if (
  privateProbeAccount.owner !== PROGRAM_ID ||
  privateDepositAccount.owner !== PROGRAM_ID ||
  publicProbeAccount.owner !== DELEGATION_PROGRAM_ID ||
  publicDepositAccount.owner !== DELEGATION_PROGRAM_ID
) {
  throw new Error("Private/public ownership boundary failed validation");
}
const privateProbe = getCrankProbeDecoder().decode(accountBytes(privateProbeAccount.data));
const privateDeposit = getDepositDecoder().decode(accountBytes(privateDepositAccount.data));
const publicProbe = getCrankProbeDecoder().decode(accountBytes(publicProbeAccount.data));
const publicDeposit = getDepositDecoder().decode(accountBytes(publicDepositAccount.data));
if (
  privateProbe.taskId !== EXPECTED_TASK_ID ||
  privateProbe.status !== CrankProbeStatus.Advanced ||
  privateProbe.transitionCount !== 1n ||
  privateDeposit.user !== AUTHORITY ||
  privateDeposit.tokenMint !== USDC_MINT ||
  privateDeposit.nextPaymentNonce !== 1n ||
  privateDeposit.available !== 0n ||
  privateDeposit.locked !== 0n ||
  publicProbe.taskId !== 0n ||
  publicProbe.status !== CrankProbeStatus.Pending ||
  publicProbe.transitionCount !== 0n ||
  publicDeposit.nextPaymentNonce !== 0n
) {
  throw new Error(`Unexpected pre-commit private/public state: ${json({ privateProbe, privateDeposit, publicProbe, publicDeposit })}`);
}

const instruction = await getCommitAndUndelegateCrankProbeInstructionAsync({
  payer: createNoopSigner(AUTHORITY),
  owner: createNoopSigner(AUTHORITY),
  crankProbe: addresses.crankProbe,
  deposit: addresses.deposit,
});
const instructions = [getSetComputeUnitLimitInstruction({ units: 250_000 }), instruction];
const { value: latestBlockhash } = await privateRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayer(AUTHORITY, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions(instructions, current),
);
const transaction = compileTransaction(message);
const wire = getBase64EncodedWireTransaction(transaction);
const serializedBytes = Buffer.from(wire, "base64").length;
if (serializedBytes > 1_232) {
  throw new Error(`Gate 3 commit/undelegate is ${serializedBytes} bytes; Solana limit is 1232`);
}
const simulation = await privateRpc
  .simulateTransaction(wire, {
    accounts: {
      addresses: [addresses.crankProbe, addresses.deposit],
      encoding: "base64",
    },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: true,
    sigVerify: false,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(`Authenticated commit/undelegate simulation failed: ${json({ err: simulation.value.err, logs: simulation.value.logs })}`);
}
const [postProbeAccount, postDepositAccount] = simulation.value.accounts ?? [];
if (!postProbeAccount || !postDepositAccount) {
  throw new Error("Commit/undelegate simulation returned incomplete post-state");
}
if (
  postProbeAccount.owner !== DELEGATION_PROGRAM_ID ||
  postDepositAccount.owner !== DELEGATION_PROGRAM_ID
) {
  throw new Error("Simulation did not return the expected transitional delegated owners");
}
const postProbe = getCrankProbeDecoder().decode(accountBytes(postProbeAccount.data));
const postDeposit = getDepositDecoder().decode(accountBytes(postDepositAccount.data));
if (
  postProbe.taskId !== EXPECTED_TASK_ID ||
  postProbe.status !== CrankProbeStatus.Advanced ||
  postProbe.transitionCount !== 1n ||
  postDeposit.nextPaymentNonce !== 1n ||
  postDeposit.available !== 0n ||
  postDeposit.locked !== 0n
) {
  throw new Error(`Commit/undelegate simulation changed terminal state: ${json({ postProbe, postDeposit })}`);
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: authentication.identity,
      challengeAgeSeconds: authentication.challengeAgeSeconds,
      tokenReceived: true,
      tokenPrinted: false,
      tokenStored: false,
    },
    validatedPreState: {
      privateReadSlot: privateResponse.context.slot,
      publicReadSlot: publicResponse.context.slot,
      private: {
        taskId: privateProbe.taskId,
        status: CrankProbeStatus[privateProbe.status],
        transitionCount: privateProbe.transitionCount,
        nextPaymentNonce: privateDeposit.nextPaymentNonce,
      },
      publicStaleSnapshot: {
        taskId: publicProbe.taskId,
        status: CrankProbeStatus[publicProbe.status],
        transitionCount: publicProbe.transitionCount,
        nextPaymentNonce: publicDeposit.nextPaymentNonce,
      },
    },
    proposedTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: AUTHORITY,
      requiredSigners: [AUTHORITY],
      instruction: "commit_and_undelegate_crank_probe",
      committedAccounts: [addresses.crankProbe, addresses.deposit],
      permissionAccountsCommitted: false,
      splTokenInstructions: "none",
      usdcMoved: "0",
      signed: false,
      submitted: false,
    },
    authenticatedSimulation: {
      slot: simulation.context.slot,
      err: null,
      serializedBytes,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      postState: {
        transitionalOwner: DELEGATION_PROGRAM_ID,
        taskId: postProbe.taskId,
        status: CrankProbeStatus[postProbe.status],
        transitionCount: postProbe.transitionCount,
        nextPaymentNonce: postDeposit.nextPaymentNonce,
        available: postDeposit.available,
        locked: postDeposit.locked,
      },
      publicDisclosureIfSubmitted: [
        "CrankProbe owner/deposit relationship and deadline",
        "task ID 1788931901",
        "Advanced status and transition count 1",
        "Deposit owner, USDC mint, balances, payment nonce 1, and pause flag",
        "commit/undelegation transaction accounts, instruction data, logs, and timing",
      ],
      logs: simulation.value.logs,
    },
  }),
);

if (SEND_REQUESTED) {
  const signedInstruction = await getCommitAndUndelegateCrankProbeInstructionAsync({
    payer: authentication.signerClient.payer,
    owner: authentication.signerClient.identity,
    crankProbe: addresses.crankProbe,
    deposit: addresses.deposit,
  });
  const signedMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(authentication.signerClient.payer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 250_000 }),
      signedInstruction,
    ], current),
  );
  const signedTransaction = await signTransactionMessageWithSigners(signedMessage);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const signedWire = getBase64EncodedWireTransaction(signedTransaction);
  const erSignature = getSignatureFromTransaction(signedTransaction);
  const signedPreflight = await privateRpc
    .simulateTransaction(signedWire, {
      accounts: {
        addresses: [addresses.crankProbe, addresses.deposit],
        encoding: "base64",
      },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (signedPreflight.value.err !== null) {
    throw new Error(`Signed commit/undelegate preflight failed: ${json(signedPreflight.value.err)}`);
  }
  const [signedProbeAccount, signedDepositAccount] = signedPreflight.value.accounts ?? [];
  if (!signedProbeAccount || !signedDepositAccount) {
    throw new Error("Signed preflight returned incomplete post-state");
  }
  const signedProbe = getCrankProbeDecoder().decode(accountBytes(signedProbeAccount.data));
  const signedDeposit = getDepositDecoder().decode(accountBytes(signedDepositAccount.data));
  if (
    signedProbe.taskId !== EXPECTED_TASK_ID ||
    signedProbe.status !== CrankProbeStatus.Advanced ||
    signedProbe.transitionCount !== 1n ||
    signedDeposit.nextPaymentNonce !== 1n ||
    signedDeposit.available !== 0n ||
    signedDeposit.locked !== 0n
  ) {
    throw new Error(`Signed preflight changed terminal state: ${json({ signedProbe, signedDeposit })}`);
  }

  console.log(json({
    preparedErSignature: erSignature,
    signedPreflight: {
      err: null,
      unitsConsumed: signedPreflight.value.unitsConsumed ?? null,
      taskId: signedProbe.taskId,
      transitionCount: signedProbe.transitionCount,
      nextPaymentNonce: signedDeposit.nextPaymentNonce,
      usdcMoved: "0",
    },
  }));

  const submittedSignature = await privateRpc.sendTransaction(signedWire, {
    encoding: "base64",
    maxRetries: 5n,
    preflightCommitment: "confirmed",
    skipPreflight: false,
  }).send();
  if (submittedSignature !== erSignature) {
    throw new Error("Private ER returned a signature different from the signed transaction");
  }

  let erConfirmation:
    | { slot: bigint; confirmationStatus?: "processed" | "confirmed" | "finalized"; err: unknown }
    | undefined;
  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const statusResponse = await privateRpc
      .getSignatureStatuses([erSignature], { searchTransactionHistory: true })
      .send();
    const status = statusResponse.value[0];
    if (status?.err) {
      throw new Error(`Private ER commit/undelegate failed: ${json(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      erConfirmation = {
        slot: status.slot,
        confirmationStatus: status.confirmationStatus,
        err: status.err,
      };
      break;
    }
    const blockHeight = await privateRpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (blockHeight > latestBlockhash.lastValidBlockHeight) {
      throw new Error("Private ER commit/undelegate expired before confirmation");
    }
    await wait(500);
  }
  if (!erConfirmation) {
    throw new Error("Private ER commit/undelegate confirmation timed out");
  }

  let scheduledCommitReceiptSignature: string | undefined;
  let erTransactionSlot: bigint | undefined;
  for (let poll = 0; poll < 30; poll += 1) {
    const transactionResponse = await privateRpc.getTransaction(erSignature, {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    }).send();
    if (transactionResponse?.meta?.err) {
      throw new Error(`Confirmed Private ER transaction contains an error: ${json(transactionResponse.meta.err)}`);
    }
    const commitmentLog = transactionResponse?.meta?.logMessages?.find((line) =>
      line.startsWith("ScheduledCommitSent signature: "),
    );
    const match = commitmentLog?.match(/^ScheduledCommitSent signature: ([1-9A-HJ-NP-Za-km-z]{64,88})$/);
    if (match?.[1] && transactionResponse) {
      scheduledCommitReceiptSignature = match[1];
      erTransactionSlot = transactionResponse.slot;
      break;
    }
    await wait(250);
  }
  if (!scheduledCommitReceiptSignature || erTransactionSlot === undefined) {
    throw new Error("Could not obtain the scheduled-commit receipt from the ER transaction");
  }

  const [probeDelegation, depositDelegation] = await Promise.all([
    deriveDelegationPdas(addresses.crankProbe, PROGRAM_ID),
    deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
  ]);
  let baseSettlement:
    | {
        readSlot: bigint;
        commitmentSlot: bigint;
        probeOwner: string;
        depositOwner: string;
        taskId: bigint;
        status: string;
        transitionCount: bigint;
        nextPaymentNonce: bigint;
        stateDelegationRecordsPresent: boolean;
        stateDelegationMetadataPresent: boolean;
        permissionAccountsRemainDelegated: boolean;
      }
    | undefined;
  let processUndelegationSignature: Signature | undefined;
  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const accountsResponse = await publicRpc.getMultipleAccounts([
        addresses.crankProbe,
        addresses.deposit,
        probeDelegation.record,
        probeDelegation.metadata,
        depositDelegation.record,
        depositDelegation.metadata,
        addresses.permission,
        addresses.crankPermission,
      ], { commitment: "finalized", encoding: "base64" }).send();
    const [settledProbeAccount, settledDepositAccount, probeRecord, probeMetadata, depositRecord, depositMetadata, depositPermission, crankPermission] =
      accountsResponse.value;
    if (
      settledProbeAccount?.owner === PROGRAM_ID &&
      settledDepositAccount?.owner === PROGRAM_ID
    ) {
      if (!depositPermission || !crankPermission) {
        throw new Error("A Permission account disappeared during state undelegation");
      }
      const settledProbe = getCrankProbeDecoder().decode(accountBytes(settledProbeAccount.data));
      const settledDeposit = getDepositDecoder().decode(accountBytes(settledDepositAccount.data));
      if (
        settledProbe.taskId !== EXPECTED_TASK_ID ||
        settledProbe.status !== CrankProbeStatus.Advanced ||
        settledProbe.transitionCount !== 1n ||
        settledDeposit.nextPaymentNonce !== 1n ||
        settledDeposit.available !== 0n ||
        settledDeposit.locked !== 0n
      ) {
        throw new Error(`Finalized committed state is unexpected: ${json({ settledProbe, settledDeposit })}`);
      }
      const recentSignatures = await publicRpc
        .getSignaturesForAddress(addresses.crankProbe, { commitment: "finalized", limit: 10 })
        .send();
      for (const entry of recentSignatures) {
        if (entry.slot <= publicResponse.context.slot || entry.err !== null) continue;
        const candidate = await publicRpc.getTransaction(entry.signature, {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        }).send();
        const keys = candidate?.transaction.message.accountKeys ?? [];
        if (
          candidate?.meta?.err === null &&
          keys.includes(addresses.crankProbe) &&
          keys.includes(addresses.deposit) &&
          keys.includes(DELEGATION_PROGRAM_ID)
        ) {
          processUndelegationSignature = entry.signature;
          break;
        }
      }
      if (!processUndelegationSignature) {
        await wait(500);
        continue;
      }
      const processEntry = recentSignatures.find(
        (entry) => entry.signature === processUndelegationSignature,
      )!;
      baseSettlement = {
        readSlot: accountsResponse.context.slot,
        commitmentSlot: processEntry.slot,
        probeOwner: settledProbeAccount.owner,
        depositOwner: settledDepositAccount.owner,
        taskId: settledProbe.taskId,
        status: CrankProbeStatus[settledProbe.status],
        transitionCount: settledProbe.transitionCount,
        nextPaymentNonce: settledDeposit.nextPaymentNonce,
        stateDelegationRecordsPresent: probeRecord !== null || depositRecord !== null,
        stateDelegationMetadataPresent: probeMetadata !== null || depositMetadata !== null,
        permissionAccountsRemainDelegated:
          depositPermission.owner === DELEGATION_PROGRAM_ID &&
          crankPermission.owner === DELEGATION_PROGRAM_ID,
      };
      break;
    }
    await wait(500);
  }
  if (!baseSettlement) {
    throw new Error("Base-layer commit/undelegation did not finalize before the verification timeout");
  }
  if (baseSettlement.stateDelegationRecordsPresent || baseSettlement.stateDelegationMetadataPresent) {
    throw new Error("State delegation records or metadata remain after finalized undelegation");
  }

  console.log(json({
    cluster: "MagicBlock Private ER to Solana Devnet",
    erSignature,
    erTransactionSlot,
    erConfirmation,
    scheduledCommitReceiptSignature,
    processUndelegationSignature,
    baseSettlement,
    permissionAccountAction: "none; both Permission accounts remain delegated",
    usdcMovement: "none",
    authTokenPrinted: false,
    authTokenStored: false,
  }));
}
