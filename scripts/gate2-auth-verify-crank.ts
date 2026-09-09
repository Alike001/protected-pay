import {
  createClient,
  createSignableMessage,
  createSolanaRpc,
  getBase58Decoder,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";

import { getCrankProbeDecoder } from "../clients/ts/src/generated/accounts/crankProbe.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";

const PRIVATE_ER_ORIGIN = "https://devnet-tee.magicblock.app" as const;
const APPROVAL_FLAG = "--approved-gate2-tee-auth";
const MAX_CHALLENGE_AGE_SECONDS = 300;
const EXPECTED_TASK_ID = 1_788_931_901n;

type ChallengeResponse = { challenge?: unknown; error?: unknown };
type LoginResponse = { token?: unknown; error?: unknown };
type JsonRpcResponse<T> = {
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
};
type SignatureEntry = {
  signature: string;
  slot: number;
  err: unknown;
  memo: string | null;
  blockTime: number | null;
  confirmationStatus?: string;
};
type TransactionResult = {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number };
    };
  };
  meta: {
    err: unknown;
    logMessages: string[] | null;
  } | null;
};

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

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign a TEE authentication message without ${APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}
const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.identity.address !== AUTHORITY) {
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
const challengePattern = new RegExp(
  `^Login to Query Filtering Service\\nTimestamp: (\\d{10})\\nUser: ${AUTHORITY}$`,
);
const challengeMatch = challengePattern.exec(challengeJson.challenge);
if (!challengeMatch?.[1]) {
  throw new Error("TEE challenge format, service name, or wallet address is unexpected");
}
const challengeTimestamp = Number(challengeMatch[1]);
const challengeAgeSeconds = Math.floor(Date.now() / 1000) - challengeTimestamp;
if (
  !Number.isSafeInteger(challengeTimestamp) ||
  Math.abs(challengeAgeSeconds) > MAX_CHALLENGE_AGE_SECONDS
) {
  throw new Error("TEE challenge timestamp is stale or implausibly far in the future");
}
const [authSignatureDictionary] = await signerClient.identity.signMessages([
  createSignableMessage(new TextEncoder().encode(challengeJson.challenge)),
]);
const authSignatureBytes = authSignatureDictionary[AUTHORITY];
if (!authSignatureBytes || authSignatureBytes.length !== 64) {
  throw new Error("Wallet did not produce the expected authentication signature");
}
const authSignature = getBase58Decoder().decode(authSignatureBytes);
const loginHttpResponse = await fetch(new URL("/auth/login", PRIVATE_ER_ORIGIN), {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({
    pubkey: AUTHORITY,
    challenge: challengeJson.challenge,
    signature: authSignature,
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

// Keep the bearer token process-only. It is never printed or persisted.
const authenticatedUrl = new URL(PRIVATE_ER_ORIGIN);
authenticatedUrl.searchParams.set("token", loginJson.token);
const privateRpc = createSolanaRpc(authenticatedUrl.toString());
const addresses = await deriveGate2Addresses();
const stateResponse = await privateRpc
  .getMultipleAccounts(
    [addresses.crankProbe, addresses.deposit],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [probeAccount, depositAccount] = stateResponse.value;
if (!probeAccount || !depositAccount) {
  throw new Error("Authenticated Private ER did not return both Gate 2 state accounts");
}
if (
  probeAccount.owner !== PROGRAM_ID ||
  accountBytes(probeAccount.data).length !== 99 ||
  depositAccount.owner !== PROGRAM_ID ||
  accountBytes(depositAccount.data).length !== 98
) {
  throw new Error("Private Gate 2 state failed owner/length validation");
}
const probe = getCrankProbeDecoder().decode(accountBytes(probeAccount.data));
const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
if (
  probe.owner !== AUTHORITY ||
  probe.deposit !== addresses.deposit ||
  probe.taskId !== EXPECTED_TASK_ID ||
  probe.status !== CrankProbeStatus.Advanced ||
  probe.transitionCount !== 1n ||
  deposit.user !== AUTHORITY ||
  deposit.tokenMint !== USDC_MINT ||
  deposit.nextPaymentNonce !== 1n ||
  deposit.available !== 0n ||
  deposit.locked !== 0n ||
  deposit.automationPaused
) {
  throw new Error(`Autonomous crank post-state invariant failed: ${json({ probe, deposit })}`);
}

let rpcRequestId = 1;
async function rawRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(authenticatedUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcRequestId++, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Private RPC ${method} failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as JsonRpcResponse<T>;
  if (body.error || body.result === undefined) {
    throw new Error(`Private RPC ${method} failed: ${json(body.error ?? "missing result")}`);
  }
  return body.result;
}

const signatureEntries = await rawRpc<SignatureEntry[]>("getSignaturesForAddress", [
  addresses.crankProbe,
  { commitment: "confirmed", limit: 10 },
]);
const transactionResults = await Promise.all(
  signatureEntries.map(async (entry) => ({
    entry,
    transaction: await rawRpc<TransactionResult | null>("getTransaction", [
      entry.signature,
      {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      },
    ]),
  })),
);
const relevantTransactions = transactionResults
  .filter(({ transaction }) =>
    transaction?.meta?.logMessages?.some((line) =>
      line.includes(`Program ${PROGRAM_ID} invoke`),
    ),
  )
  .map(({ entry, transaction }) => {
    const message = transaction!.transaction.message;
    const logs = transaction!.meta?.logMessages ?? [];
    return {
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime,
      err: transaction!.meta?.err ?? entry.err,
      feePayer: message.accountKeys[0] ?? null,
      requiredSigners: message.accountKeys.slice(0, message.header.numRequiredSignatures),
      isUserScheduleTransaction: message.accountKeys
        .slice(0, message.header.numRequiredSignatures)
        .includes(AUTHORITY),
      invokedProtectedPay: logs.some((line) => line.includes(`Program ${PROGRAM_ID} invoke`)),
      succeeded: logs.some((line) => line === `Program ${PROGRAM_ID} success`),
    };
  });

const scheduleTransactions = relevantTransactions.filter(
  (transaction) => transaction.isUserScheduleTransaction,
);
if (scheduleTransactions.length < 1) {
  throw new Error("Private transaction history did not contain the finalized schedule transaction");
}
const autonomousTransactions = relevantTransactions.filter(
  (transaction) => !transaction.isUserScheduleTransaction,
);
if (autonomousTransactions.length < 1) {
  throw new Error("No scheduler-generated Protected Pay transaction was found in private history");
}
if (
  autonomousTransactions.some(
    (transaction) =>
      transaction.err !== null ||
      !transaction.invokedProtectedPay ||
      !transaction.succeeded ||
      transaction.requiredSigners.includes(AUTHORITY),
  )
) {
  throw new Error(`A scheduler receipt failed the signer/success invariant: ${json(autonomousTransactions)}`);
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: AUTHORITY,
      challengeAgeSeconds,
      tokenReceived: true,
      tokenPrinted: false,
      tokenStored: false,
    },
    privatePostState: {
      slot: stateResponse.context.slot,
      crankProbe: {
        address: addresses.crankProbe,
        taskId: probe.taskId,
        status: CrankProbeStatus[probe.status],
        transitionCount: probe.transitionCount,
      },
      deposit: {
        address: addresses.deposit,
        nextPaymentNonce: deposit.nextPaymentNonce,
        available: deposit.available,
        locked: deposit.locked,
      },
      usdcMoved: "0",
    },
    receipts: {
      scheduleTransactions,
      relevantTransactionCount: relevantTransactions.length,
      autonomousTransactionCount: autonomousTransactions.length,
      autonomousTransactions,
      userAuthorityAbsentFromAutonomousRequiredSigners: true,
    },
    assertions: "all passed",
  }),
);
