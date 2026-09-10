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
  signature,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getCommitAndUndelegateDepositInstruction } from "../clients/ts/src/generated/instructions/commitAndUndelegateDeposit.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { AUTHORITY, deriveAddresses, PROGRAM_ID } from "./gate1-simulate.ts";

const BASE_RPC_URL = "https://api.devnet.solana.com" as const;
const PRIVATE_ER_ORIGIN = "https://devnet-tee.magicblock.app" as const;
const APPROVAL_FLAG = "--approved-tee-auth";
const SEND_REQUESTED = process.argv.includes("--send");
const SEND_APPROVAL_FLAG = "--approved-commit-undelegate";
const TOTAL_AMOUNT = 1_000_000n;
const MAX_CHALLENGE_AGE_SECONDS = 300;
const MAX_CONFIRMATION_POLLS = 120;

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
  throw new Error(`Refusing to sign a TEE authentication message without ${APPROVAL_FLAG}`);
}
if (SEND_REQUESTED && !process.argv.includes(SEND_APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign or send the transaction without ${SEND_APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.identity.address !== AUTHORITY) {
  throw new Error("Signer address does not match the approved Private ER identity");
}

// Obtain a fresh auth token. It remains process-only and is never printed or stored.
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

// Validate the authoritative private state and the public collateral/delegation snapshot.
const [privateState, publicState] = await Promise.all([
  privateRpc
    .getAccountInfo(addresses.deposit, { commitment: "confirmed", encoding: "base64" })
    .send(),
  baseRpc
    .getMultipleAccounts(
      [addresses.deposit, addresses.vaultUsdcAta],
      { commitment: "finalized", encoding: "base64" },
    )
    .send(),
]);
const privateDepositAccount = privateState.value;
const [publicDepositAccount, vaultAccount] = publicState.value;
if (!privateDepositAccount || !publicDepositAccount || !vaultAccount) {
  throw new Error("A required private or public account is missing");
}
if (
  privateDepositAccount.owner !== PROGRAM_ID ||
  accountBytes(privateDepositAccount.data).length !== 98 ||
  publicDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(publicDepositAccount.data).length !== 98 ||
  vaultAccount.owner !== TOKEN_PROGRAM_ID ||
  tokenAmount(accountBytes(vaultAccount.data)) !== TOTAL_AMOUNT
) {
  throw new Error("Private Deposit, public delegation snapshot, or vault collateral failed validation");
}
const privateDeposit = getDepositDecoder().decode(accountBytes(privateDepositAccount.data));
const publicDeposit = getDepositDecoder().decode(accountBytes(publicDepositAccount.data));
if (
  privateDeposit.user !== AUTHORITY ||
  privateDeposit.available !== TOTAL_AMOUNT ||
  privateDeposit.locked !== 0n ||
  publicDeposit.user !== AUTHORITY ||
  publicDeposit.available !== TOTAL_AMOUNT ||
  publicDeposit.locked !== 0n
) {
  throw new Error("Deposit state differs from the finalized private-unlock checkpoint");
}

const commitInstruction = getCommitAndUndelegateDepositInstruction({
  payer: signerClient.payer,
  user: AUTHORITY,
  deposit: addresses.deposit,
});
const instructions = [
  getSetComputeUnitLimitInstruction({ units: 200_000 }),
  commitInstruction,
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
  throw new Error(`Authenticated commit/undelegate simulation failed: ${json(simulation.value.err)}`);
}
const logs = simulation.value.logs ?? [];
if (
  !logs.some((line) => line.includes("Instruction: CommitAndUndelegateDeposit")) ||
  !logs.some((line) => line.includes("Program Magic11111111111111111111111111111111111111 invoke")) ||
  !logs.some((line) => line === `Program ${PROGRAM_ID} success`)
) {
  throw new Error(`Simulation did not contain the expected program and Magic intent success logs: ${json(logs)}`);
}

const simulatedDepositAccount = simulation.value.accounts?.[0] ?? null;
let simulatedDeposit = null;
if (simulatedDepositAccount) {
  if (
    simulatedDepositAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(simulatedDepositAccount.data).length !== 98
  ) {
    throw new Error(
      `Simulation returned an unexpected transitional Deposit representation: ${json({
        owner: simulatedDepositAccount.owner,
        dataLength: accountBytes(simulatedDepositAccount.data).length,
        lamports: simulatedDepositAccount.lamports,
      })}`,
    );
  }
  simulatedDeposit = getDepositDecoder().decode(accountBytes(simulatedDepositAccount.data));
  if (simulatedDeposit.available !== TOTAL_AMOUNT || simulatedDeposit.locked !== 0n) {
    throw new Error(`Simulation changed Deposit accounting unexpectedly: ${json(simulatedDeposit)}`);
  }
}

console.log(
  json({
    authentication: {
      endpoint: PRIVATE_ER_ORIGIN,
      identity: AUTHORITY,
      challengeService: "Query Filtering Service",
      challengeAgeSeconds,
      tokenPrinted: false,
      tokenStored: false,
      hardwareAttestationIndependentlyVerified: false,
    },
    validatedPreState: {
      privateReadSlot: privateState.context.slot,
      privateOwner: privateDepositAccount.owner,
      privateAvailable: privateDeposit.available,
      privateLocked: privateDeposit.locked,
      publicReadSlot: publicState.context.slot,
      publicOwner: publicDepositAccount.owner,
      publicAvailable: publicDeposit.available,
      publicLocked: publicDeposit.locked,
      publicVaultRawUsdc: tokenAmount(accountBytes(vaultAccount.data)),
    },
    proposedTransaction: {
      cluster: "MagicBlock Private ER on Solana Devnet",
      feePayer: AUTHORITY,
      signers: [AUTHORITY],
      instruction: "commit_and_undelegate_deposit",
      deposit: addresses.deposit,
      magicProgram: commitInstruction.accounts[3]?.address ?? null,
      magicContext: commitInstruction.accounts[4]?.address ?? null,
      splTokenInstructions: "none",
      usdcMovement: "none",
      signed: SEND_REQUESTED,
      sent: false,
    },
    authenticatedSimulation: {
      slot: simulation.context.slot,
      err: simulation.value.err,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      logs,
      returnedDepositState: simulatedDeposit
        ? {
            transitionalOwner: simulatedDepositAccount?.owner ?? null,
            available: simulatedDeposit.available,
            locked: simulatedDeposit.locked,
          }
        : null,
      note: "Simulation validates the ER instruction path but cannot prove asynchronous base-layer settlement.",
    },
  }),
);

if (SEND_REQUESTED) {
  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const signedWire = getBase64EncodedWireTransaction(signedTransaction);
  const expectedSignature = getSignatureFromTransaction(signedTransaction);

  const signedPreflight = await privateRpc
    .simulateTransaction(signedWire, {
      accounts: { addresses: [addresses.deposit], encoding: "base64" },
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
  const signedPostAccount = signedPreflight.value.accounts?.[0];
  if (
    !signedPostAccount ||
    signedPostAccount.owner !== DELEGATION_PROGRAM_ID ||
    accountBytes(signedPostAccount.data).length !== 98
  ) {
    throw new Error("Signed preflight did not return the expected transitional Deposit");
  }
  const signedPostDeposit = getDepositDecoder().decode(accountBytes(signedPostAccount.data));
  if (signedPostDeposit.available !== TOTAL_AMOUNT || signedPostDeposit.locked !== 0n) {
    throw new Error(`Signed preflight changed Deposit accounting unexpectedly: ${json(signedPostDeposit)}`);
  }

  console.log(
    json({
      preparedSignature: expectedSignature,
      signedPreflight: {
        err: signedPreflight.value.err,
        unitsConsumed: signedPreflight.value.unitsConsumed ?? null,
        availableAfter: signedPostDeposit.available,
        lockedAfter: signedPostDeposit.locked,
        transitionalOwner: signedPostAccount.owner,
        splTokenMovement: "none",
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
    throw new Error("Private ER returned a signature different from the signed transaction");
  }

  let erConfirmation:
    | { slot: bigint; confirmationStatus?: "processed" | "confirmed" | "finalized"; err: unknown }
    | undefined;
  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const response = await privateRpc
      .getSignatureStatuses([expectedSignature], { searchTransactionHistory: true })
      .send();
    const status = response.value[0];
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

  let commitmentSignature;
  let erTransactionSlot: bigint | undefined;
  for (let poll = 0; poll < 30; poll += 1) {
    const transactionResponse = await privateRpc
      .getTransaction(expectedSignature, {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (transactionResponse?.meta?.err) {
      throw new Error(`Confirmed Private ER transaction contains an error: ${json(transactionResponse.meta.err)}`);
    }
    const commitmentLog = transactionResponse?.meta?.logMessages?.find((line) =>
      line.startsWith("ScheduledCommitSent signature: "),
    );
    const match = commitmentLog?.match(/^ScheduledCommitSent signature: ([1-9A-HJ-NP-Za-km-z]{64,88})$/);
    if (match?.[1] && transactionResponse) {
      commitmentSignature = signature(match[1]);
      erTransactionSlot = transactionResponse.slot;
      break;
    }
    await wait(250);
  }
  if (!commitmentSignature || erTransactionSlot === undefined) {
    throw new Error("Could not obtain a validated base-layer commitment signature from the ER transaction");
  }

  const depositDelegation = await deriveDelegationPdas(addresses.deposit, PROGRAM_ID);
  let baseSettlement:
    | {
        readSlot: bigint;
        commitmentSlot: bigint;
        depositOwner: string;
        available: bigint;
        locked: bigint;
        vaultRawUsdc: bigint;
        recordPresent: boolean;
        metadataPresent: boolean;
      }
    | undefined;
  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const [statusResponse, accountResponse] = await Promise.all([
      baseRpc
        .getSignatureStatuses([commitmentSignature], { searchTransactionHistory: true })
        .send(),
      baseRpc
        .getMultipleAccounts(
          [
            addresses.deposit,
            depositDelegation.record,
            depositDelegation.metadata,
            addresses.vaultUsdcAta,
          ],
          { commitment: "finalized", encoding: "base64" },
        )
        .send(),
    ]);
    const commitmentStatus = statusResponse.value[0];
    if (commitmentStatus?.err) {
      throw new Error(`Base-layer commitment failed: ${json(commitmentStatus.err)}`);
    }
    const [settledDepositAccount, recordAccount, metadataAccount, settledVaultAccount] =
      accountResponse.value;
    if (
      commitmentStatus?.confirmationStatus === "finalized" &&
      settledDepositAccount?.owner === PROGRAM_ID &&
      settledVaultAccount
    ) {
      if (
        accountBytes(settledDepositAccount.data).length !== 98 ||
        settledVaultAccount.owner !== TOKEN_PROGRAM_ID ||
        tokenAmount(accountBytes(settledVaultAccount.data)) !== TOTAL_AMOUNT
      ) {
        throw new Error("Finalized base-layer Deposit or vault failed validation");
      }
      const settledDeposit = getDepositDecoder().decode(accountBytes(settledDepositAccount.data));
      if (
        settledDeposit.user !== AUTHORITY ||
        settledDeposit.available !== TOTAL_AMOUNT ||
        settledDeposit.locked !== 0n
      ) {
        throw new Error(`Finalized committed Deposit state is unexpected: ${json(settledDeposit)}`);
      }
      baseSettlement = {
        readSlot: accountResponse.context.slot,
        commitmentSlot: commitmentStatus.slot,
        depositOwner: settledDepositAccount.owner,
        available: settledDeposit.available,
        locked: settledDeposit.locked,
        vaultRawUsdc: tokenAmount(accountBytes(settledVaultAccount.data)),
        recordPresent: recordAccount !== null,
        metadataPresent: metadataAccount !== null,
      };
      break;
    }
    await wait(500);
  }
  if (!baseSettlement) {
    throw new Error("Base-layer commit/undelegation did not finalize before the verification timeout");
  }

  console.log(
    json({
      cluster: "MagicBlock Private ER to Solana Devnet",
      erSignature: expectedSignature,
      erTransactionSlot,
      erConfirmation,
      baseCommitmentSignature: commitmentSignature,
      baseSettlement,
      permissionAccountAction: "none; remains delegated",
      usdcMovement: "none",
      authTokenPrinted: false,
      authTokenStored: false,
      hardwareAttestationIndependentlyVerified: false,
    }),
  );
}
