import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AccountRole,
  addSignersToInstruction,
  appendTransactionMessageInstruction,
  assertIsTransactionWithinSizeLimit,
  createClient,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PROGRAM_ID =
  "w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk" as Address;
const PROGRAM_DATA =
  "BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj" as Address;
const BUFFER =
  "CjV4LC6X8pY6C2uoB7fEGFvXXZvtY7Mg2kGwPvjYhB1r" as Address;
const EXPECTED_AUTHORITY =
  "6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn" as Address;
const UPGRADEABLE_LOADER =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111" as Address;
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;
const BINARY_PATH = "target/deploy/protected_pay.so";
const EXPECTED_BINARY_SHA256 =
  "5b2f04b8b347a85e5f7f03dc9305709aaaab7fb538738d348919a8811756d6f5";
const PROGRAM_DATA_METADATA_LENGTH = 45;
const BUFFER_METADATA_LENGTH = 37;
const PROGRAM_DATA_CAPACITY = 635_136;
const UPGRADE_VARIANT = 3;
const APPROVAL_FLAG =
  "--approved-exact-v2-devnet-upgrade-signed-simulation";

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign without ${APPROVAL_FLAG}`);
}
if (process.argv.includes("--send")) {
  throw new Error("This exact-upgrade checkpoint is simulation-only and cannot broadcast");
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved upgrade-authority signer");
}

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") throw new Error("Unexpected account encoding");
  return Buffer.from(data[0], "base64");
}

function stateView(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function decodeAuthority(data: Uint8Array, optionOffset: number, keyOffset: number) {
  if (data[optionOffset] !== 1) throw new Error("Loader authority is absent");
  return getAddressDecoder().decode(data.slice(keyOffset, keyOffset + 32));
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retryRpc<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 5) await delay(attempt * 1_000);
    }
  }
  throw new Error(`${label} failed after retries`, { cause: lastError });
}

const binary = await readFile(BINARY_PATH);
const binarySha256 = createHash("sha256").update(binary).digest("hex");
if (binarySha256 !== EXPECTED_BINARY_SHA256) {
  throw new Error(
    `Refusing stale/unreviewed binary: expected ${EXPECTED_BINARY_SHA256}, got ${binarySha256}`,
  );
}

const rpc = createSolanaRpc(RPC_URL);
const genesisHash = await retryRpc("genesis-hash preflight", () =>
  rpc.getGenesisHash().send(),
);
if (genesisHash !== DEVNET_GENESIS_HASH) {
  throw new Error(`RPC is not Solana Devnet: unexpected genesis hash ${genesisHash}`);
}

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (
  signerClient.identity.address !== EXPECTED_AUTHORITY ||
  signerClient.payer.address !== EXPECTED_AUTHORITY
) {
  throw new Error("Signer does not match the onchain upgrade authority");
}

const preflight = await retryRpc("loader-account preflight", () =>
  rpc
    .getMultipleAccounts(
      [PROGRAM_ID, PROGRAM_DATA, BUFFER, EXPECTED_AUTHORITY],
      { commitment: "finalized", encoding: "base64" },
    )
    .send(),
);
const [programAccount, programDataAccount, bufferAccount, authorityAccount] =
  preflight.value;

if (
  !programAccount?.executable ||
  programAccount.owner !== UPGRADEABLE_LOADER
) {
  throw new Error("Program account failed executable/owner validation");
}
const programState = accountBytes(programAccount.data);
if (
  programState.length !== 36 ||
  stateView(programState).getUint32(0, true) !== 2 ||
  getAddressDecoder().decode(programState.slice(4, 36)) !== PROGRAM_DATA
) {
  throw new Error("Program discriminator or linked ProgramData address is invalid");
}

if (
  !programDataAccount ||
  programDataAccount.executable ||
  programDataAccount.owner !== UPGRADEABLE_LOADER
) {
  throw new Error("ProgramData account failed executable/owner validation");
}
const programDataBefore = accountBytes(programDataAccount.data);
if (
  programDataBefore.length !==
  PROGRAM_DATA_METADATA_LENGTH + PROGRAM_DATA_CAPACITY
) {
  throw new Error(`Unexpected ProgramData allocation: ${programDataBefore.length}`);
}
const programDataViewBefore = stateView(programDataBefore);
if (
  programDataViewBefore.getUint32(0, true) !== 3 ||
  decodeAuthority(programDataBefore, 12, 13) !== EXPECTED_AUTHORITY
) {
  throw new Error("ProgramData discriminator or authority is invalid");
}
const deploySlotBefore = programDataViewBefore.getBigUint64(4, true);
if (
  Buffer.from(
    programDataBefore.slice(
      PROGRAM_DATA_METADATA_LENGTH,
      PROGRAM_DATA_METADATA_LENGTH + binary.length,
    ),
  ).equals(binary)
) {
  throw new Error("Version-2 bytecode is already deployed; refusing a redundant upgrade simulation");
}

if (
  !bufferAccount ||
  bufferAccount.executable ||
  bufferAccount.owner !== UPGRADEABLE_LOADER
) {
  throw new Error("Buffer account failed executable/owner validation");
}
const bufferBefore = accountBytes(bufferAccount.data);
if (
  bufferBefore.length !== BUFFER_METADATA_LENGTH + binary.length ||
  stateView(bufferBefore).getUint32(0, true) !== 1 ||
  decodeAuthority(bufferBefore, 4, 5) !== EXPECTED_AUTHORITY
) {
  throw new Error("Buffer allocation, discriminator, or authority is invalid");
}
const finalizedBufferBytes = Buffer.from(bufferBefore.slice(BUFFER_METADATA_LENGTH));
const finalizedBufferSha256 = createHash("sha256")
  .update(finalizedBufferBytes)
  .digest("hex");
if (
  finalizedBufferSha256 !== binarySha256 ||
  !finalizedBufferBytes.equals(binary)
) {
  throw new Error("Finalized buffer does not match the reviewed version-2 artifact");
}

if (
  !authorityAccount ||
  authorityAccount.executable ||
  authorityAccount.owner !== SYSTEM_PROGRAM ||
  accountBytes(authorityAccount.data).length !== 0
) {
  throw new Error("Fee payer/spill/authority account failed validation");
}

const instructionData = new Uint8Array(4);
new DataView(instructionData.buffer).setUint32(0, UPGRADE_VARIANT, true);
const upgradeInstruction = addSignersToInstruction(
  [signerClient.identity],
  {
    programAddress: UPGRADEABLE_LOADER,
    accounts: [
      { address: PROGRAM_DATA, role: AccountRole.WRITABLE },
      { address: PROGRAM_ID, role: AccountRole.WRITABLE },
      { address: BUFFER, role: AccountRole.WRITABLE },
      { address: EXPECTED_AUTHORITY, role: AccountRole.WRITABLE },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
      { address: CLOCK_SYSVAR, role: AccountRole.READONLY },
      { address: EXPECTED_AUTHORITY, role: AccountRole.READONLY_SIGNER },
    ],
    data: instructionData,
  } satisfies Instruction,
);

const { value: latestBlockhash } = await retryRpc("latest blockhash", () =>
  rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
);
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstruction(upgradeInstruction, current),
);
const signedTransaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithinSizeLimit(signedTransaction);
const wire = getBase64EncodedWireTransaction(signedTransaction);
const preparedSignature = getSignatureFromTransaction(signedTransaction);

const simulation = await retryRpc("exact signed upgrade simulation", () =>
  rpc
    .simulateTransaction(wire, {
      accounts: {
        addresses: [PROGRAM_DATA, PROGRAM_ID, BUFFER, EXPECTED_AUTHORITY],
        encoding: "base64",
      },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send(),
);
if (simulation.value.err !== null) {
  throw new Error(
    `Exact signed upgrade simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
}

const [simulatedProgramData, simulatedProgram, simulatedBuffer, simulatedAuthority] =
  simulation.value.accounts ?? [];
if (!simulatedProgramData || !simulatedProgram || !simulatedAuthority) {
  throw new Error("Simulation omitted required post-state accounts");
}
if (
  simulatedProgramData.owner !== UPGRADEABLE_LOADER ||
  simulatedProgramData.executable ||
  simulatedProgramData.lamports < programDataAccount.lamports
) {
  throw new Error("Simulated ProgramData owner/executable/lamports validation failed");
}
const programDataAfter = accountBytes(simulatedProgramData.data);
if (programDataAfter.length !== programDataBefore.length) {
  throw new Error("Simulated upgrade unexpectedly changed ProgramData allocation");
}
const programDataViewAfter = stateView(programDataAfter);
const deploySlotAfter = programDataViewAfter.getBigUint64(4, true);
if (
  programDataViewAfter.getUint32(0, true) !== 3 ||
  deploySlotAfter <= deploySlotBefore ||
  decodeAuthority(programDataAfter, 12, 13) !== EXPECTED_AUTHORITY
) {
  throw new Error("Simulated ProgramData metadata transition is invalid");
}
const simulatedBytecode = Buffer.from(
  programDataAfter.slice(
    PROGRAM_DATA_METADATA_LENGTH,
    PROGRAM_DATA_METADATA_LENGTH + binary.length,
  ),
);
if (!simulatedBytecode.equals(binary)) {
  throw new Error("Simulated ProgramData bytecode does not match version 2");
}
if (
  programDataAfter
    .slice(PROGRAM_DATA_METADATA_LENGTH + binary.length)
    .some((byte) => byte !== 0)
) {
  throw new Error("Simulated ProgramData trailing allocation was not zeroed");
}
if (
  simulatedProgram.owner !== UPGRADEABLE_LOADER ||
  !simulatedProgram.executable ||
  !Buffer.from(accountBytes(simulatedProgram.data)).equals(Buffer.from(programState))
) {
  throw new Error("Simulated Program account invariant failed");
}
if (simulatedBuffer !== null && simulatedBuffer.lamports !== 0n) {
  throw new Error("Simulated upgrade did not drain the buffer");
}

const fee = simulation.value.fee;
if (fee === null) throw new Error("Simulation did not report a transaction fee");
const programDataTopUp = simulatedProgramData.lamports - programDataAccount.lamports;
const expectedAuthorityLamportsAfter =
  authorityAccount.lamports - fee + bufferAccount.lamports - programDataTopUp;
if (simulatedAuthority.lamports !== expectedAuthorityLamportsAfter) {
  throw new Error("Simulated spill/refund accounting invariant failed");
}

const postCheck = await retryRpc("post-simulation live-state check", () =>
  rpc
    .getMultipleAccounts([PROGRAM_DATA, BUFFER, EXPECTED_AUTHORITY], {
      commitment: "finalized",
      encoding: "base64",
    })
    .send(),
);
const [liveProgramData, liveBuffer, liveAuthority] = postCheck.value;
if (!liveProgramData || !liveBuffer || !liveAuthority) {
  throw new Error("Post-simulation live-state verification omitted an account");
}
const liveProgramDataBytes = accountBytes(liveProgramData.data);
const liveBufferBytes = accountBytes(liveBuffer.data);
if (
  stateView(liveProgramDataBytes).getBigUint64(4, true) !== deploySlotBefore ||
  !Buffer.from(liveBufferBytes).equals(Buffer.from(bufferBefore)) ||
  liveAuthority.lamports !== authorityAccount.lamports
) {
  throw new Error("Simulation unexpectedly changed live Devnet state");
}
const signatureStatus = await retryRpc("prepared-signature absence check", () =>
  rpc
    .getSignatureStatuses([preparedSignature], {
      searchTransactionHistory: true,
    })
    .send(),
);
if (signatureStatus.value[0] !== null) {
  throw new Error("Prepared simulation signature unexpectedly exists on Devnet");
}

console.log(
  json({
    simulationOnly: true,
    transactionBroadcast: false,
    cluster: "Solana Devnet",
    rpcHost: new URL(RPC_URL).hostname,
    instruction: "UpgradeableLoaderInstruction::Upgrade",
    programId: PROGRAM_ID,
    programData: PROGRAM_DATA,
    buffer: BUFFER,
    feePayerSpillAndUpgradeAuthority: EXPECTED_AUTHORITY,
    binaryLength: binary.length,
    binarySha256,
    finalizedBufferSha256,
    programDataCapacity: PROGRAM_DATA_CAPACITY,
    deploySlotBefore,
    simulatedDeploySlotAfter: deploySlotAfter,
    simulatedProgramDataBytecodeMatches: true,
    simulatedTrailingAllocationZeroed: true,
    simulatedBufferDrained: simulatedBuffer === null || simulatedBuffer.lamports === 0n,
    bufferRentRefundedInSimulation: bufferAccount.lamports - programDataTopUp,
    programDataRentTopUpInSimulation: programDataTopUp,
    estimatedFeeLamports: fee,
    authorityLamportsBefore: authorityAccount.lamports,
    authorityLamportsAfterSimulation: simulatedAuthority.lamports,
    preparedSignature,
    signatureVerifiedBySimulation: true,
    simulationError: null,
    unitsConsumed: simulation.value.unitsConsumed,
    liveDeploySlotAfterSimulation: stateView(liveProgramDataBytes).getBigUint64(4, true),
    liveBufferStillPresent: true,
    liveBufferStillMatchesReviewedArtifact: true,
    liveAuthorityBalanceUnchanged: true,
    preparedSignatureFoundOnDevnet: false,
  }),
);
