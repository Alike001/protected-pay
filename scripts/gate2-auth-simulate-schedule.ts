import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createClient,
  createNoopSigner,
  createSignableMessage,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getCrankProbeDecoder } from "../clients/ts/src/generated/accounts/crankProbe.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getScheduleCrankProbeInstructionAsync } from "../clients/ts/src/generated/instructions/scheduleCrankProbe.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import { PERMISSION_PROGRAM_ID } from "./gate1-simulate-delegation.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";

const PRIVATE_ER_ORIGIN = "https://devnet-tee.magicblock.app" as const;
const APPROVAL_FLAG = "--approved-gate2-tee-auth";
const SEND_REQUESTED = process.argv.includes("--send");
const SEND_APPROVAL_FLAG = "--approved-gate2-schedule";
const MAX_CHALLENGE_AGE_SECONDS = 300;
const MAX_CONFIRMATION_POLLS = 120;
const EXECUTION_INTERVAL_MILLIS = 1_000n;
const ITERATIONS = 3n;

type ChallengeResponse = { challenge?: unknown; error?: unknown };
type LoginResponse = { token?: unknown; expiresAt?: unknown; error?: unknown };

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
  throw new Error(`Refusing to sign or send the schedule without ${SEND_APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (
  signerClient.identity.address !== AUTHORITY ||
  signerClient.payer.address !== AUTHORITY
) {
  throw new Error("Signer address does not match the approved Gate 2 identity");
}

const challengeUrl = new URL("/auth/challenge", PRIVATE_ER_ORIGIN);
challengeUrl.searchParams.set("pubkey", AUTHORITY);
const challengeHttpResponse = await fetch(challengeUrl, {
  headers: { accept: "application/json" },
});
if (!challengeHttpResponse.ok) {
  throw new Error(`TEE challenge request failed with HTTP ${challengeHttpResponse.status}`);
}
const challengeJson = (await challengeHttpResponse.json()) as ChallengeResponse;
if (typeof challengeJson.challenge !== "string" || challengeJson.challenge.length === 0) {
  throw new Error(`TEE returned no valid challenge: ${String(challengeJson.error ?? "unknown error")}`);
}
const expectedPattern = new RegExp(
  `^Login to Query Filtering Service\\nTimestamp: (\\d{10})\\nUser: ${AUTHORITY}$`,
);
const match = expectedPattern.exec(challengeJson.challenge);
if (!match?.[1]) {
  throw new Error("TEE challenge format, service name, or wallet address is unexpected");
}
const challengeTimestamp = Number(match[1]);
const nowSeconds = Math.floor(Date.now() / 1000);
if (
  !Number.isSafeInteger(challengeTimestamp) ||
  Math.abs(nowSeconds - challengeTimestamp) > MAX_CHALLENGE_AGE_SECONDS
) {
  throw new Error("TEE challenge timestamp is stale or implausibly far in the future");
}

const signableMessage = createSignableMessage(
  new TextEncoder().encode(challengeJson.challenge),
);
const [signatureDictionary] = await signerClient.identity.signMessages([signableMessage]);
const signatureBytes = signatureDictionary[AUTHORITY];
if (!signatureBytes || signatureBytes.length !== 64) {
  throw new Error("Wallet did not produce the expected 64-byte authentication signature");
}
const signature = getBase58Decoder().decode(signatureBytes);

const loginHttpResponse = await fetch(new URL("/auth/login", PRIVATE_ER_ORIGIN), {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({
    pubkey: AUTHORITY,
    challenge: challengeJson.challenge,
    signature,
  }),
});
const loginJson = (await loginHttpResponse.json()) as LoginResponse;
if (!loginHttpResponse.ok) {
  throw new Error(
    `TEE authentication failed with HTTP ${loginHttpResponse.status}: ${String(loginJson.error ?? "unknown error")}`,
  );
}
if (typeof loginJson.token !== "string" || loginJson.token.length < 20) {
  throw new Error("TEE authentication returned no valid bearer token");
}

// Keep the bearer token only in this process. Never print it or write it to disk.
const authenticatedUrl = new URL(PRIVATE_ER_ORIGIN);
authenticatedUrl.searchParams.set("token", loginJson.token);
const privateRpc = createSolanaRpc(authenticatedUrl.toString());
const addresses = await deriveGate2Addresses();
const authorizedState = await privateRpc
  .getMultipleAccounts(
    [
      addresses.deposit,
      addresses.crankProbe,
      addresses.permission,
      addresses.crankPermission,
    ],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [depositAccount, probeAccount, depositPermissionAccount, crankPermissionAccount] =
  authorizedState.value;
if (!depositAccount || !probeAccount || !depositPermissionAccount || !crankPermissionAccount) {
  throw new Error("Authenticated Private ER did not return all four protected Gate 2 accounts");
}
if (depositAccount.owner !== PROGRAM_ID || accountBytes(depositAccount.data).length !== 98) {
  throw new Error("Authenticated Private ER Deposit failed owner/length validation");
}
if (probeAccount.owner !== PROGRAM_ID || accountBytes(probeAccount.data).length !== 99) {
  throw new Error("Authenticated Private ER CrankProbe failed owner/length validation");
}
for (const permissionAccount of [depositPermissionAccount, crankPermissionAccount]) {
  if (
    permissionAccount.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(permissionAccount.data).length !== 567
  ) {
    throw new Error("Authenticated Private ER Permission failed owner/length validation");
  }
}

const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
const probe = getCrankProbeDecoder().decode(accountBytes(probeAccount.data));
if (
  deposit.user !== AUTHORITY ||
  deposit.tokenMint !== USDC_MINT ||
  deposit.available !== 0n ||
  deposit.locked !== 0n ||
  deposit.nextPaymentNonce !== 0n ||
  deposit.automationPaused ||
  deposit.version !== 1
) {
  throw new Error(`Unexpected authenticated Private ER Deposit state: ${json(deposit)}`);
}
if (
  probe.owner !== AUTHORITY ||
  probe.deposit !== addresses.deposit ||
  probe.taskId !== 0n ||
  probe.transitionCount !== 0n ||
  probe.status !== CrankProbeStatus.Pending ||
  probe.version !== 1 ||
  probe.notBefore <= 0n
) {
  throw new Error(`Unexpected authenticated Private ER CrankProbe state: ${json(probe)}`);
}

const taskId = probe.notBefore;
const instructions = [
  getSetComputeUnitLimitInstruction({ units: 400_000 }),
  await getScheduleCrankProbeInstructionAsync({
    payer: createNoopSigner(AUTHORITY),
    crankProbe: addresses.crankProbe,
    deposit: addresses.deposit,
    taskId,
    executionIntervalMillis: EXECUTION_INTERVAL_MILLIS,
    iterations: ITERATIONS,
  }),
];
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
  throw new Error(`Gate 2 schedule is ${serializedBytes} bytes; Solana limit is 1232`);
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
  throw new Error(`Authenticated Gate 2 schedule simulation failed: ${json({
    err: simulation.value.err,
    logs: simulation.value.logs,
  })}`);
}
const [simulatedProbeAccount, simulatedDepositAccount] = simulation.value.accounts ?? [];
if (!simulatedProbeAccount || !simulatedDepositAccount) {
  throw new Error("Authenticated simulation did not return both Gate 2 post-state accounts");
}
if (
  simulatedProbeAccount.owner !== PROGRAM_ID ||
  accountBytes(simulatedProbeAccount.data).length !== 99 ||
  simulatedDepositAccount.owner !== PROGRAM_ID ||
  accountBytes(simulatedDepositAccount.data).length !== 98
) {
  throw new Error("Authenticated simulation post-state failed owner/length validation");
}
const simulatedProbe = getCrankProbeDecoder().decode(accountBytes(simulatedProbeAccount.data));
const simulatedDeposit = getDepositDecoder().decode(accountBytes(simulatedDepositAccount.data));
if (
  simulatedProbe.owner !== probe.owner ||
  simulatedProbe.deposit !== probe.deposit ||
  simulatedProbe.notBefore !== probe.notBefore ||
  simulatedProbe.taskId !== taskId ||
  simulatedProbe.transitionCount !== 0n ||
  simulatedProbe.status !== CrankProbeStatus.Pending ||
  simulatedProbe.version !== probe.version ||
  simulatedDeposit.user !== deposit.user ||
  simulatedDeposit.tokenMint !== deposit.tokenMint ||
  simulatedDeposit.available !== 0n ||
  simulatedDeposit.locked !== 0n ||
  simulatedDeposit.nextPaymentNonce !== 0n ||
  simulatedDeposit.automationPaused !== deposit.automationPaused ||
  simulatedDeposit.version !== deposit.version
) {
  throw new Error(
    `Authenticated schedule simulation returned unexpected state: ${json({ simulatedProbe, simulatedDeposit })}`,
  );
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: AUTHORITY,
      challengeService: "Query Filtering Service",
      challengeAgeSeconds: nowSeconds - challengeTimestamp,
      tokenReceived: true,
      tokenPrinted: false,
      tokenStored: false,
      hardwareAttestationIndependentlyVerified: false,
    },
    authorizedRead: {
      slot: authorizedState.context.slot,
      deposit: {
        address: addresses.deposit,
        owner: depositAccount.owner,
        dataLength: accountBytes(depositAccount.data).length,
        available: deposit.available,
        locked: deposit.locked,
        nextPaymentNonce: deposit.nextPaymentNonce,
      },
      crankProbe: {
        address: addresses.crankProbe,
        owner: probeAccount.owner,
        dataLength: accountBytes(probeAccount.data).length,
        notBefore: probe.notBefore,
        taskId: probe.taskId,
        transitionCount: probe.transitionCount,
        status: CrankProbeStatus[probe.status],
      },
      permissionsVisible: 2,
    },
    proposedTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: AUTHORITY,
      signer: AUTHORITY,
      instruction: "schedule_crank_probe",
      taskId,
      executionIntervalMillis: EXECUTION_INTERVAL_MILLIS,
      iterations: ITERATIONS,
      scheduledTarget: "advance_crank_probe",
      targetAccounts: [addresses.crankProbe, addresses.deposit],
      targetFinancialArguments: "none",
      usdcMoved: "0",
      signed: false,
      submitted: false,
    },
    authenticatedSimulation: {
      slot: simulation.context.slot,
      err: null,
      serializedBytes,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      postState: {
        taskId: simulatedProbe.taskId,
        status: CrankProbeStatus[simulatedProbe.status],
        transitionCount: simulatedProbe.transitionCount,
        depositNextPaymentNonce: simulatedDeposit.nextPaymentNonce,
        available: simulatedDeposit.available,
        locked: simulatedDeposit.locked,
      },
      logs: simulation.value.logs,
    },
  }),
);

if (SEND_REQUESTED) {
  const signedInstructions = [
    getSetComputeUnitLimitInstruction({ units: 400_000 }),
    await getScheduleCrankProbeInstructionAsync({
      payer: signerClient.identity,
      crankProbe: addresses.crankProbe,
      deposit: addresses.deposit,
      taskId,
      executionIntervalMillis: EXECUTION_INTERVAL_MILLIS,
      iterations: ITERATIONS,
    }),
  ];
  const signedMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(signedInstructions, current),
  );
  const signedTransaction = await signTransactionMessageWithSigners(signedMessage);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const signedWire = getBase64EncodedWireTransaction(signedTransaction);
  const expectedSignature = getSignatureFromTransaction(signedTransaction);
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
    throw new Error(`Signed Gate 2 schedule preflight failed: ${json(signedPreflight.value.err)}`);
  }
  const [signedProbeAccount, signedDepositAccount] = signedPreflight.value.accounts ?? [];
  if (!signedProbeAccount || !signedDepositAccount) {
    throw new Error("Signed schedule preflight returned incomplete post-state");
  }
  const signedProbe = getCrankProbeDecoder().decode(accountBytes(signedProbeAccount.data));
  const signedDeposit = getDepositDecoder().decode(accountBytes(signedDepositAccount.data));
  if (
    signedProbe.taskId !== taskId ||
    signedProbe.status !== CrankProbeStatus.Pending ||
    signedProbe.transitionCount !== 0n ||
    signedDeposit.nextPaymentNonce !== 0n ||
    signedDeposit.available !== 0n ||
    signedDeposit.locked !== 0n
  ) {
    throw new Error(`Signed schedule preflight returned unexpected state: ${json({ signedProbe, signedDeposit })}`);
  }

  console.log(
    json({
      preparedSignature: expectedSignature,
      signedPreflight: {
        err: null,
        unitsConsumed: signedPreflight.value.unitsConsumed ?? null,
        taskId: signedProbe.taskId,
        transitionCount: signedProbe.transitionCount,
        depositNextPaymentNonce: signedDeposit.nextPaymentNonce,
        usdcMoved: "0",
      },
    }),
  );

  const submittedSignature = await privateRpc
    .sendTransaction(signedWire, {
      encoding: "base64",
      maxRetries: 5n,
      preflightCommitment: "confirmed",
      skipPreflight: false,
    })
    .send();
  if (submittedSignature !== expectedSignature) {
    throw new Error("Private ER returned a signature different from the signed schedule");
  }

  let confirmation:
    | { slot: bigint; confirmationStatus?: "processed" | "confirmed" | "finalized"; err: unknown }
    | undefined;
  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const response = await privateRpc
      .getSignatureStatuses([expectedSignature], { searchTransactionHistory: true })
      .send();
    const status = response.value[0];
    if (status?.err) {
      throw new Error(`Private ER schedule failed after submission: ${json(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      confirmation = {
        slot: status.slot,
        confirmationStatus: status.confirmationStatus,
        err: status.err,
      };
      break;
    }
    const blockHeight = await privateRpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (blockHeight > latestBlockhash.lastValidBlockHeight) {
      throw new Error("Private ER schedule transaction expired before confirmation");
    }
    await wait(500);
  }
  if (!confirmation) {
    throw new Error("Private ER schedule confirmation timed out");
  }

  console.log(
    json({
      cluster: "MagicBlock Private ER on Solana Devnet",
      finalizedScheduleSignature: expectedSignature,
      confirmation,
      taskId,
      executionIntervalMillis: EXECUTION_INTERVAL_MILLIS,
      iterations: ITERATIONS,
      scheduledTarget: "advance_crank_probe",
      targetAccounts: [addresses.crankProbe, addresses.deposit],
      targetFinancialArguments: "none",
      usdcMoved: "0",
    }),
  );
}
