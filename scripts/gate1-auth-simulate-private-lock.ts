import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createClient,
  createNoopSigner,
  createSignableMessage,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getLockBalanceInstruction } from "../clients/ts/src/generated/instructions/lockBalance.ts";
import { getUnlockBalanceInstruction } from "../clients/ts/src/generated/instructions/unlockBalance.ts";
import { PROGRAM_ID, AUTHORITY, deriveAddresses } from "./gate1-simulate.ts";

const PRIVATE_ER_ORIGIN = "https://devnet-tee.magicblock.app" as const;
const APPROVAL_FLAG = "--approved-tee-auth";
const LOCK_AMOUNT = 250_000n;
const MAX_CHALLENGE_AGE_SECONDS = 300;
const mode = process.argv.includes("--unlock") ? "unlock" : "lock";
const expectedBefore = mode === "lock"
  ? { available: 1_000_000n, locked: 0n }
  : { available: 750_000n, locked: LOCK_AMOUNT };
const expectedAfter = mode === "lock"
  ? { available: 750_000n, locked: LOCK_AMOUNT }
  : { available: 1_000_000n, locked: 0n };

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

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign a TEE authentication message without ${APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.identity.address !== AUTHORITY) {
  throw new Error("Signer address does not match the approved Private ER identity");
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
  throw new Error(`TEE authentication failed with HTTP ${loginHttpResponse.status}: ${String(loginJson.error ?? "unknown error")}`);
}
if (typeof loginJson.token !== "string" || loginJson.token.length < 20) {
  throw new Error("TEE authentication returned no valid bearer token");
}

// Keep the bearer token only in this process. Never print it or write it to disk.
const authenticatedUrl = new URL(PRIVATE_ER_ORIGIN);
authenticatedUrl.searchParams.set("token", loginJson.token);
const privateRpc = createSolanaRpc(authenticatedUrl.toString());
const addresses = await deriveAddresses();
const authorizedState = await privateRpc
  .getMultipleAccounts(
    [addresses.deposit, addresses.permission],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [privateDepositAccount, privatePermissionAccount] = authorizedState.value;
if (!privateDepositAccount || !privatePermissionAccount) {
  throw new Error("Authenticated Private ER did not return both protected accounts");
}
if (privateDepositAccount.owner !== PROGRAM_ID || accountBytes(privateDepositAccount.data).length !== 98) {
  throw new Error("Authenticated Private ER Deposit failed owner/length validation");
}
const privateDeposit = getDepositDecoder().decode(accountBytes(privateDepositAccount.data));
if (
  privateDeposit.available !== expectedBefore.available ||
  privateDeposit.locked !== expectedBefore.locked
) {
  throw new Error(`Unexpected authenticated Private ER Deposit state: ${json(privateDeposit)}`);
}

const noopSigner = createNoopSigner(AUTHORITY);
const instructions = [
  getSetComputeUnitLimitInstruction({ units: 200_000 }),
  mode === "lock"
    ? getLockBalanceInstruction({
        user: noopSigner,
        deposit: addresses.deposit,
        amount: LOCK_AMOUNT,
      })
    : getUnlockBalanceInstruction({
        user: noopSigner,
        deposit: addresses.deposit,
        amount: LOCK_AMOUNT,
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
const simulation = await privateRpc
  .simulateTransaction(wire, {
    accounts: { addresses: [addresses.deposit], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: true,
    sigVerify: false,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(`Authenticated private-lock simulation failed: ${json(simulation.value.err)}`);
}
const simulatedDepositAccount = simulation.value.accounts?.[0];
if (!simulatedDepositAccount) {
  throw new Error("Authenticated simulation did not return the private Deposit post-state");
}
const simulatedDeposit = getDepositDecoder().decode(accountBytes(simulatedDepositAccount.data));
if (
  simulatedDeposit.available !== expectedAfter.available ||
  simulatedDeposit.locked !== expectedAfter.locked
) {
  throw new Error(`Authenticated simulation returned an unexpected state: ${json(simulatedDeposit)}`);
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
      depositOwner: privateDepositAccount.owner,
      available: privateDeposit.available,
      locked: privateDeposit.locked,
      permissionVisible: true,
    },
    proposedTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: AUTHORITY,
      signer: AUTHORITY,
      instruction: `${mode}_balance`,
      amount: `0.250000 USDC internal accounting ${mode}`,
      splTokenMovement: "none",
    },
    authenticatedSimulation: {
      slot: simulation.context.slot,
      err: simulation.value.err,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      logs: simulation.value.logs,
      postState: {
        available: simulatedDeposit.available,
        locked: simulatedDeposit.locked,
      },
    },
  }),
);
