import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AccountRole,
  addSignersToInstruction,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  createClient,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
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

const RPC_URL = "https://api.devnet.solana.com" as const;
const PROGRAM_ID =
  "w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk" as Address;
const PROGRAM_DATA =
  "BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj" as Address;
const EXPECTED_AUTHORITY =
  "6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn" as Address;
const UPGRADEABLE_LOADER =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const BINARY_PATH = "target/deploy/protected_pay.so";
const EXPECTED_BINARY_SHA256 =
  "5b2f04b8b347a85e5f7f03dc9305709aaaab7fb538738d348919a8811756d6f5";
const PROGRAM_DATA_METADATA_LENGTH = 45;
const BUFFER_METADATA_LENGTH = 37;
const UPLOAD_PROBE_LENGTH = 512;
const APPROVAL_FLAG = "--approved-v2-devnet-upgrade-signed-simulation";

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign without ${APPROVAL_FLAG}`);
}
if (process.argv.includes("--send")) {
  throw new Error("This checkpoint is simulation-only and cannot broadcast");
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved upgrade-authority signer");
}

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") throw new Error("Unexpected account encoding");
  return Buffer.from(data[0], "base64");
}

function encodeCreateAccount(
  lamports: bigint,
  space: bigint,
  owner: Address,
): Uint8Array {
  const data = new Uint8Array(52);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0, true);
  view.setBigUint64(4, lamports, true);
  view.setBigUint64(12, space, true);
  data.set(getAddressEncoder().encode(owner), 20);
  return data;
}

function encodeInitializeBuffer(): Uint8Array {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, 0, true);
  return data;
}

function encodeWrite(offset: number, bytes: Uint8Array): Uint8Array {
  const data = new Uint8Array(16 + bytes.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, offset, true);
  view.setBigUint64(8, BigInt(bytes.length), true);
  data.set(bytes, 16);
  return data;
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

const binary = await readFile(BINARY_PATH);
const binarySha256 = createHash("sha256").update(binary).digest("hex");
if (binarySha256 !== EXPECTED_BINARY_SHA256) {
  throw new Error(
    `Refusing stale/unreviewed binary: expected ${EXPECTED_BINARY_SHA256}, got ${binarySha256}`,
  );
}

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (
  signerClient.identity.address !== EXPECTED_AUTHORITY ||
  signerClient.payer.address !== EXPECTED_AUTHORITY
) {
  throw new Error("Signer does not match the onchain upgrade authority");
}

const rpc = createSolanaRpc(RPC_URL);
const preflight = await rpc
  .getMultipleAccounts([PROGRAM_ID, PROGRAM_DATA, EXPECTED_AUTHORITY], {
    commitment: "finalized",
    encoding: "base64",
  })
  .send();
const [programAccount, programDataAccount, authorityAccount] = preflight.value;
if (
  !programAccount?.executable ||
  programAccount.owner !== UPGRADEABLE_LOADER
) {
  throw new Error("Program account failed executable/owner validation");
}
const programState = accountBytes(programAccount.data);
if (programState.length !== 36) {
  throw new Error(`Unexpected Program account size: ${programState.length}`);
}
const programStateView = new DataView(
  programState.buffer,
  programState.byteOffset,
  programState.byteLength,
);
if (programStateView.getUint32(0, true) !== 2) {
  throw new Error("Program account discriminator is not UpgradeableLoaderState::Program");
}
if (getAddressDecoder().decode(programState.slice(4, 36)) !== PROGRAM_DATA) {
  throw new Error("Program account points to an unexpected ProgramData address");
}
if (
  !programDataAccount ||
  programDataAccount.executable ||
  programDataAccount.owner !== UPGRADEABLE_LOADER
) {
  throw new Error("ProgramData account failed executable/owner validation");
}
const programDataState = accountBytes(programDataAccount.data);
if (programDataState.length < PROGRAM_DATA_METADATA_LENGTH) {
  throw new Error("ProgramData account is shorter than loader metadata");
}
const programDataView = new DataView(
  programDataState.buffer,
  programDataState.byteOffset,
  programDataState.byteLength,
);
if (programDataView.getUint32(0, true) !== 3 || programDataState[12] !== 1) {
  throw new Error("ProgramData discriminator or upgrade-authority option is invalid");
}
if (
  getAddressDecoder().decode(programDataState.slice(13, 45)) !==
  EXPECTED_AUTHORITY
) {
  throw new Error("ProgramData authority does not match the approved signer");
}
if (!authorityAccount || authorityAccount.owner !== SYSTEM_PROGRAM || authorityAccount.executable) {
  throw new Error("Fee payer account failed owner/executable validation");
}

const deployedCapacity = programDataState.length - PROGRAM_DATA_METADATA_LENGTH;
if (binary.length > deployedCapacity) {
  throw new Error(
    `Version-2 binary exceeds deployed capacity (${binary.length} > ${deployedCapacity})`,
  );
}
const bufferSpace = BigInt(binary.length + BUFFER_METADATA_LENGTH);
const bufferRent = await rpc
  .getMinimumBalanceForRentExemption(bufferSpace, { commitment: "confirmed" })
  .send();
if (authorityAccount.lamports <= bufferRent) {
  throw new Error("Upgrade authority cannot fund the temporary upload buffer and a fee");
}

// Solana simulations are stateless across transactions. This one transaction therefore
// creates an ephemeral buffer, initializes it, and writes a byte-for-byte prefix of the
// reviewed v2 artifact. It proves signatures, funding, loader ownership, allocation, and
// the upload instruction path without creating or mutating any Devnet account.
const bufferSigner = await generateKeyPairSigner();
const createBufferInstruction = addSignersToInstruction(
  [signerClient.payer, bufferSigner],
  {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: EXPECTED_AUTHORITY, role: AccountRole.WRITABLE_SIGNER },
      { address: bufferSigner.address, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: encodeCreateAccount(bufferRent, bufferSpace, UPGRADEABLE_LOADER),
  } satisfies Instruction,
);
const initializeBufferInstruction: Instruction = {
  programAddress: UPGRADEABLE_LOADER,
  accounts: [
    { address: bufferSigner.address, role: AccountRole.WRITABLE },
    { address: EXPECTED_AUTHORITY, role: AccountRole.READONLY },
  ],
  data: encodeInitializeBuffer(),
};
const writeProbeInstruction = addSignersToInstruction(
  [signerClient.identity],
  {
    programAddress: UPGRADEABLE_LOADER,
    accounts: [
      { address: bufferSigner.address, role: AccountRole.WRITABLE },
      { address: EXPECTED_AUTHORITY, role: AccountRole.READONLY_SIGNER },
    ],
    data: encodeWrite(0, binary.subarray(0, UPLOAD_PROBE_LENGTH)),
  } satisfies Instruction,
);

const { value: latestBlockhash } = await rpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) =>
    appendTransactionMessageInstructions(
      [
        createBufferInstruction,
        initializeBufferInstruction,
        writeProbeInstruction,
      ],
      current,
    ),
);
const signedTransaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithinSizeLimit(signedTransaction);
const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);
const preparedSignature = getSignatureFromTransaction(signedTransaction);
const simulation = await rpc
  .simulateTransaction(wireTransaction, {
    accounts: { addresses: [EXPECTED_AUTHORITY], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(
    `Signed version-2 upload-path simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
}
const [simulatedAuthority] = simulation.value.accounts ?? [];
if (!simulatedAuthority || simulatedAuthority.owner !== SYSTEM_PROGRAM) {
  throw new Error("Simulation did not return a valid fee-payer post-state");
}

console.log(
  json({
    simulationOnly: true,
    transactionBroadcast: false,
    cluster: "Solana Devnet",
    checkpoint: "version-2 upgrade signed simulation",
    provenInSignedSimulation: [
      "temporary loader buffer creation",
      "buffer initialization under the approved authority",
      `write of the first ${UPLOAD_PROBE_LENGTH} reviewed artifact bytes`,
    ],
    intentionallyNotAttempted: [
      "persistent buffer creation",
      "full bytecode upload",
      "Upgrade instruction",
      "program mutation",
    ],
    programId: PROGRAM_ID,
    programData: PROGRAM_DATA,
    feePayerAndUpgradeAuthority: EXPECTED_AUTHORITY,
    ephemeralSimulationBuffer: bufferSigner.address,
    binaryPath: BINARY_PATH,
    binaryLength: binary.length,
    binarySha256,
    deployedCapacity,
    capacityHeadroom: deployedCapacity - binary.length,
    temporaryBufferSpace: bufferSpace,
    temporaryBufferRentLamports: bufferRent,
    temporaryBufferRentRefundableAfterUpgrade: true,
    authorityLamportsBefore: authorityAccount.lamports,
    authorityLamportsAfterSimulation: simulatedAuthority.lamports,
    preparedSignature,
    signatureVerifiedBySimulation: true,
    simulationError: null,
    unitsConsumed: simulation.value.unitsConsumed,
    estimatedFeeLamports: simulation.value.fee,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    limitation:
      "Devnet simulations do not persist the upload buffer between transactions; the exact final Upgrade instruction can be simulated only after an approved real buffer upload.",
  }),
);
