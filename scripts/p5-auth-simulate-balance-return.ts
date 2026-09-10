import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import {
  DEPOSIT_DISCRIMINATOR,
  getDepositDecoder,
} from "../clients/ts/src/generated/accounts/deposit.ts";
import { getCommitAndUndelegateDepositInstruction } from "../clients/ts/src/generated/instructions/commitAndUndelegateDeposit.ts";
import { DELEGATION_PROGRAM_ID } from "./gate1-simulate-delegation.ts";
import { AUTHORITY, deriveAddresses, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import { authenticatePrivateEr, PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";

const BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const APPROVAL_FLAG = "--approved-p5-balance-return-tee-simulation";
const DEPOSIT_SIZE = 98;

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") {
    throw new Error(`Unexpected account encoding: ${data[1]}`);
  }
  return Buffer.from(data[0], "base64");
}

function assertDiscriminator(
  data: Uint8Array,
  expected: { readonly length: number; readonly [index: number]: number },
): void {
  let matches = data.length >= expected.length;
  for (let index = 0; matches && index < expected.length; index += 1) {
    matches = data[index] === expected[index];
  }
  if (!matches) {
    throw new Error("Deposit discriminator mismatch");
  }
}

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to authenticate or sign without ${APPROVAL_FLAG}`);
}
if (process.argv.includes("--send")) {
  throw new Error("This harness is simulation-only and has no broadcast path");
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}

const { authenticatedUrl, challengeAgeSeconds, identity, signerClient } =
  await authenticatePrivateEr(keypairPath);
if (identity !== AUTHORITY || signerClient.payer.address !== AUTHORITY) {
  throw new Error("Signer and fee payer do not match the approved Devnet wallet");
}

const privateRpc = createSolanaRpc(authenticatedUrl.toString());
const publicRpc = createSolanaRpc(BASE_RPC_URL);
const addresses = await deriveAddresses();

const [privateResponse, publicResponse] = await Promise.all([
  privateRpc
    .getAccountInfo(addresses.deposit, { commitment: "confirmed", encoding: "base64" })
    .send(),
  publicRpc
    .getAccountInfo(addresses.deposit, { commitment: "finalized", encoding: "base64" })
    .send(),
]);
const privateAccount = privateResponse.value;
const publicAccount = publicResponse.value;
if (!privateAccount || !publicAccount) {
  throw new Error("The private or public Deposit account is missing");
}
const privateBytes = accountBytes(privateAccount.data);
const publicBytes = accountBytes(publicAccount.data);
if (privateAccount.owner !== PROGRAM_ID || privateBytes.length !== DEPOSIT_SIZE) {
  throw new Error("The authenticated private Deposit owner or size is invalid");
}
if (publicAccount.owner !== DELEGATION_PROGRAM_ID || publicBytes.length !== DEPOSIT_SIZE) {
  throw new Error("The finalized public Deposit is not a valid delegated snapshot");
}
assertDiscriminator(privateBytes, DEPOSIT_DISCRIMINATOR);
assertDiscriminator(publicBytes, DEPOSIT_DISCRIMINATOR);

const privateDeposit = getDepositDecoder().decode(privateBytes);
const publicDeposit = getDepositDecoder().decode(publicBytes);
for (const [label, deposit] of [
  ["private", privateDeposit],
  ["public", publicDeposit],
] as const) {
  if (deposit.user !== AUTHORITY || deposit.tokenMint !== USDC_MINT || deposit.version !== 1) {
    throw new Error(`The ${label} Deposit identity, mint, or version is invalid`);
  }
}
if (privateDeposit.locked !== 0n) {
  throw new Error("Cannot return the Deposit while private funds are locked");
}
if (privateDeposit.available <= 0n) {
  throw new Error("The private Deposit has no balance to round-trip");
}

const commitInstruction = getCommitAndUndelegateDepositInstruction({
  payer: signerClient.payer,
  user: AUTHORITY,
  deposit: addresses.deposit,
});
const { value: latestBlockhash } = await privateRpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) =>
    appendTransactionMessageInstructions(
      [getSetComputeUnitLimitInstruction({ units: 200_000 }), commitInstruction],
      current,
    ),
);

const signedTransaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(signedTransaction);
assertIsTransactionWithinSizeLimit(signedTransaction);
const signedWire = getBase64EncodedWireTransaction(signedTransaction);
const preparedSignature = getSignatureFromTransaction(signedTransaction);

const simulation = await privateRpc
  .simulateTransaction(signedWire, {
    accounts: { addresses: [addresses.deposit], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(`Signed balance-return simulation failed: ${json(simulation.value.err)}`);
}
const logs = simulation.value.logs ?? [];
if (
  !logs.some((line) => line === `ScheduleCommit: parent program id: ${PROGRAM_ID}`) ||
  !logs.some(
    (line) => line === `Scheduling undelegation for accounts: ${addresses.deposit}`,
  ) ||
  !logs.some((line) => line.includes("Program Magic11111111111111111111111111111111111111 invoke")) ||
  !logs.some((line) => line === `Program ${PROGRAM_ID} success`)
) {
  throw new Error(`Simulation logs did not prove the expected program path: ${json(logs)}`);
}

const returnedAccount = simulation.value.accounts?.[0] ?? null;
if (
  !returnedAccount ||
  returnedAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(returnedAccount.data).length !== DEPOSIT_SIZE
) {
  throw new Error("Simulation did not return the expected transitional Deposit account");
}
const returnedBytes = accountBytes(returnedAccount.data);
assertDiscriminator(returnedBytes, DEPOSIT_DISCRIMINATOR);
const returnedDeposit = getDepositDecoder().decode(returnedBytes);
if (
  returnedDeposit.user !== privateDeposit.user ||
  returnedDeposit.tokenMint !== privateDeposit.tokenMint ||
  returnedDeposit.available !== privateDeposit.available ||
  returnedDeposit.locked !== privateDeposit.locked ||
  returnedDeposit.nextPaymentNonce !== privateDeposit.nextPaymentNonce ||
  returnedDeposit.automationPaused !== privateDeposit.automationPaused ||
  returnedDeposit.version !== privateDeposit.version
) {
  throw new Error("Signed simulation changed protected balance accounting unexpectedly");
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity,
      challengeAgeSeconds,
      tokenPrinted: false,
      tokenStored: false,
    },
    validatedPreState: {
      deposit: addresses.deposit,
      privateReadSlot: privateResponse.context.slot,
      privateOwner: privateAccount.owner,
      privateAvailableRawUsdc: privateDeposit.available,
      privateLockedRawUsdc: privateDeposit.locked,
      privateAutomationPaused: privateDeposit.automationPaused,
      publicReadSlot: publicResponse.context.slot,
      publicOwner: publicAccount.owner,
      publicSnapshotAvailableRawUsdc: publicDeposit.available,
      publicSnapshotLockedRawUsdc: publicDeposit.locked,
    },
    signedReturnSimulation: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: identity,
      signers: [identity],
      instruction: "commit_and_undelegate_deposit",
      tokenMint: USDC_MINT,
      usdcMovement: "none",
      preparedSignature,
      signatureVerification: true,
      replaceRecentBlockhash: false,
      simulationSlot: simulation.context.slot,
      err: simulation.value.err,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      returnedOwner: returnedAccount.owner,
      returnedAvailableRawUsdc: returnedDeposit.available,
      returnedLockedRawUsdc: returnedDeposit.locked,
      signed: true,
      broadcast: false,
    },
  }),
);
