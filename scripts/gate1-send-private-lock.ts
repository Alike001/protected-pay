import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createClient,
  createSignableMessage,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getLockBalanceInstruction } from "../clients/ts/src/generated/instructions/lockBalance.ts";
import { getUnlockBalanceInstruction } from "../clients/ts/src/generated/instructions/unlockBalance.ts";
import { DELEGATION_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./gate1-simulate-delegation.ts";
import { AUTHORITY, deriveAddresses, PROGRAM_ID } from "./gate1-simulate.ts";

const BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const PRIVATE_ER_ORIGIN = "https://devnet-tee.magicblock.app" as const;
const MODE = process.argv.includes("--unlock") ? "unlock" : "lock";
const APPROVAL_FLAG = MODE === "unlock" ? "--approved-private-unlock" : "--approved-private-lock";
const MUTATION_AMOUNT = 250_000n;
const TOTAL_AMOUNT = 1_000_000n;
const expectedPrivateBefore =
  MODE === "lock"
    ? { available: TOTAL_AMOUNT, locked: 0n }
    : { available: 750_000n, locked: MUTATION_AMOUNT };
const expectedPrivateAfter =
  MODE === "lock"
    ? { available: 750_000n, locked: MUTATION_AMOUNT }
    : { available: TOTAL_AMOUNT, locked: 0n };
const MAX_CHALLENGE_AGE_SECONDS = 300;
const MAX_CONFIRMATION_POLLS = 60;

type ChallengeResponse = { challenge?: unknown; error?: unknown };
type LoginResponse = { token?: unknown; error?: unknown };

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") {
    throw new Error(`Unexpected account encoding: ${data[1]}`);
  }
  return Buffer.from(data[0], "base64");
}

function tokenAmount(data: Uint8Array): bigint {
  if (data.length !== 165) {
    throw new Error(`Expected a 165-byte SPL Token account, received ${data.length}`);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
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
  throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.payer.address !== AUTHORITY || signerClient.identity.address !== AUTHORITY) {
  throw new Error("Signer address does not match the approved fee payer and authority");
}

// Obtain a fresh, process-only Query Filtering Service token.
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
if (!Number.isSafeInteger(challengeTimestamp) || Math.abs(challengeAgeSeconds) > MAX_CHALLENGE_AGE_SECONDS) {
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
  throw new Error(`TEE authentication failed with HTTP ${loginHttpResponse.status}: ${String(loginJson.error ?? "unknown error")}`);
}
if (typeof loginJson.token !== "string" || loginJson.token.length < 20) {
  throw new Error("TEE authentication returned no valid bearer token");
}
const authenticatedUrl = new URL(PRIVATE_ER_ORIGIN);
authenticatedUrl.searchParams.set("token", loginJson.token);

const privateRpc = createSolanaRpc(authenticatedUrl.toString());
const baseRpc = createSolanaRpc(BASE_RPC_URL);
const addresses = await deriveAddresses();

// Validate both the public collateral and current private accounting immediately before signing.
const [baseState, privateState] = await Promise.all([
  baseRpc
    .getMultipleAccounts(
      [addresses.deposit, addresses.vaultUsdcAta],
      { commitment: "finalized", encoding: "base64" },
    )
    .send(),
  privateRpc
    .getAccountInfo(addresses.deposit, { commitment: "confirmed", encoding: "base64" })
    .send(),
]);
const [baseDeposit, vaultAta] = baseState.value;
const privateDepositAccount = privateState.value;
if (!baseDeposit || !vaultAta || !privateDepositAccount) {
  throw new Error("A required public or private account is missing");
}
if (
  baseDeposit.owner !== DELEGATION_PROGRAM_ID ||
  vaultAta.owner !== TOKEN_PROGRAM_ID ||
  tokenAmount(accountBytes(vaultAta.data)) !== TOTAL_AMOUNT ||
  privateDepositAccount.owner !== PROGRAM_ID ||
  accountBytes(privateDepositAccount.data).length !== 98
) {
  throw new Error("Public delegation, vault collateral, or private Deposit failed validation");
}
const baseDepositState = getDepositDecoder().decode(accountBytes(baseDeposit.data));
const privateDepositBefore = getDepositDecoder().decode(accountBytes(privateDepositAccount.data));
if (
  baseDepositState.available !== TOTAL_AMOUNT ||
  baseDepositState.locked !== 0n ||
  privateDepositBefore.available !== expectedPrivateBefore.available ||
  privateDepositBefore.locked !== expectedPrivateBefore.locked
) {
  throw new Error("Deposit state changed after the approved simulation; refusing to sign");
}

const instructions = [
  getSetComputeUnitLimitInstruction({ units: 200_000 }),
  MODE === "lock"
    ? getLockBalanceInstruction({
        user: signerClient.identity,
        deposit: addresses.deposit,
        amount: MUTATION_AMOUNT,
      })
    : getUnlockBalanceInstruction({
        user: signerClient.identity,
        deposit: addresses.deposit,
        amount: MUTATION_AMOUNT,
      }),
];
const { value: latestBlockhash } = await privateRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions(instructions, current),
);
const signedTransaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(signedTransaction);
assertIsTransactionWithinSizeLimit(signedTransaction);
const wire = getBase64EncodedWireTransaction(signedTransaction);
const expectedSignature = getSignatureFromTransaction(signedTransaction);

const signedPreflight = await privateRpc
  .simulateTransaction(wire, {
    accounts: { addresses: [addresses.deposit], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (signedPreflight.value.err !== null) {
  throw new Error(`Signed private-${MODE} preflight failed: ${json(signedPreflight.value.err)}`);
}
const simulatedDepositAccount = signedPreflight.value.accounts?.[0];
if (!simulatedDepositAccount) {
  throw new Error("Signed preflight did not return the private Deposit post-state");
}
const simulatedDeposit = getDepositDecoder().decode(accountBytes(simulatedDepositAccount.data));
if (
  simulatedDeposit.available !== expectedPrivateAfter.available ||
  simulatedDeposit.locked !== expectedPrivateAfter.locked
) {
  throw new Error(`Signed preflight returned an unexpected state: ${json(simulatedDeposit)}`);
}

console.log(
  json({
    preparedSignature: expectedSignature,
    instruction: `${MODE}_balance`,
    amount: MUTATION_AMOUNT,
    signedPreflight: {
      err: signedPreflight.value.err,
      unitsConsumed: signedPreflight.value.unitsConsumed ?? null,
      availableAfter: simulatedDeposit.available,
      lockedAfter: simulatedDeposit.locked,
      splTokenMovement: "none",
    },
  }),
);

const submittedSignature = await privateRpc
  .sendTransaction(wire, {
    encoding: "base64",
    maxRetries: 5n,
    preflightCommitment: "confirmed",
    skipPreflight: false,
  })
  .send();
if (submittedSignature !== expectedSignature) {
  throw new Error("Private ER returned a transaction signature different from the signed transaction");
}

let confirmedStatus:
  | { slot: bigint; confirmationStatus?: "processed" | "confirmed" | "finalized"; err: unknown }
  | undefined;
for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
  const statusResponse = await privateRpc
    .getSignatureStatuses([expectedSignature], { searchTransactionHistory: true })
    .send();
  const status = statusResponse.value[0];
  if (status?.err) {
    throw new Error(`Private ${MODE} failed after submission: ${json(status.err)}`);
  }
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
    confirmedStatus = {
      slot: status.slot,
      confirmationStatus: status.confirmationStatus,
      err: status.err,
    };
    break;
  }
  const blockHeight = await privateRpc.getBlockHeight({ commitment: "confirmed" }).send();
  if (blockHeight > latestBlockhash.lastValidBlockHeight) {
    throw new Error(`Private ${MODE} transaction expired before confirmation`);
  }
  await wait(500);
}
if (!confirmedStatus) {
  throw new Error(`Private ${MODE} confirmation timed out`);
}

let privateDepositAfter;
for (let poll = 0; poll < 20; poll += 1) {
  const response = await privateRpc
    .getAccountInfo(addresses.deposit, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (response.value) {
    const decoded = getDepositDecoder().decode(accountBytes(response.value.data));
    if (
      decoded.available === expectedPrivateAfter.available &&
      decoded.locked === expectedPrivateAfter.locked
    ) {
      privateDepositAfter = decoded;
      break;
    }
  }
  await wait(250);
}
if (!privateDepositAfter) {
  throw new Error(`Confirmed private ${MODE} was not visible in the authorized Deposit readback`);
}

const [publicAfter, unauthenticatedAfter] = await Promise.all([
  baseRpc
    .getMultipleAccounts(
      [addresses.deposit, addresses.vaultUsdcAta],
      { commitment: "finalized", encoding: "base64" },
    )
    .send(),
  createSolanaRpc(PRIVATE_ER_ORIGIN)
    .getAccountInfo(addresses.deposit, { commitment: "confirmed", encoding: "base64" })
    .send(),
]);
const [publicDepositAfter, publicVaultAfter] = publicAfter.value;
if (!publicDepositAfter || !publicVaultAfter) {
  throw new Error("Public post-state accounts are missing");
}
const publicDepositSnapshotAfter = getDepositDecoder().decode(accountBytes(publicDepositAfter.data));
if (
  publicDepositSnapshotAfter.available !== TOTAL_AMOUNT ||
  publicDepositSnapshotAfter.locked !== 0n ||
  tokenAmount(accountBytes(publicVaultAfter.data)) !== TOTAL_AMOUNT ||
  unauthenticatedAfter.value !== null
) {
  throw new Error("Public collateral/snapshot or unauthenticated privacy boundary changed unexpectedly");
}

console.log(
  json({
    cluster: "MagicBlock Private ER on Solana Devnet",
    instruction: `${MODE}_balance`,
    amount: MUTATION_AMOUNT,
    signature: expectedSignature,
    confirmation: confirmedStatus,
    privateState: {
      available: privateDepositAfter.available,
      locked: privateDepositAfter.locked,
    },
    publicBaseState: {
      available: publicDepositSnapshotAfter.available,
      locked: publicDepositSnapshotAfter.locked,
      vaultRawUsdc: tokenAmount(accountBytes(publicVaultAfter.data)),
    },
    unauthenticatedPrivateRead: "null",
    authTokenPrinted: false,
    authTokenStored: false,
    hardwareAttestationIndependentlyVerified: false,
  }),
);
