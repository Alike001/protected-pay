import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AccountRole,
  addSignersToInstruction,
  appendTransactionMessageInstruction,
  assertIsTransactionWithinSizeLimit,
  createClient,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";

const ROUTER_RPC_URL = "https://devnet-router.magicblock.app";
const PROGRAM_ID =
  "w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk" as Address;
const PROGRAM_DATA =
  "BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj" as Address;
const EXPECTED_AUTHORITY =
  "6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn" as Address;
const UPGRADEABLE_LOADER =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const BINARY_PATH = "target/deploy/protected_pay.so";
const V22_APPROVAL_FLAG = "--approved-p5-v22-devnet-buffer-upload";
const isVersion22 = process.argv.includes(V22_APPROVAL_FLAG);
const EXPECTED_BINARY_SHA256 = isVersion22
  ? "4ed1f10108d2a62c7be3f10d8201ac440fcaaef1725952538b540d3c8ba080dd"
  : "e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1";
const BUFFER_METADATA_LENGTH = 37;
const LOADER_WRITE_VARIANT = 1;
const WRITE_CHUNK_LENGTH = 900;
const BATCH_SIZE = 4;
const VERIFY_CHUNK_LENGTH = 32_768;
const APPROVAL_FLAG = isVersion22
  ? V22_APPROVAL_FLAG
  : "--approved-v21-devnet-buffer-upload";

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to broadcast without ${APPROVAL_FLAG}`);
}
if (process.argv.includes("--upgrade")) {
  throw new Error("This checkpoint may upload a buffer but may not upgrade the program");
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved buffer-authority signer");
}
const bufferAddressText = process.env.PROGRAM_BUFFER_ADDRESS;
if (!bufferAddressText) {
  throw new Error("PROGRAM_BUFFER_ADDRESS must name the already-created Devnet buffer");
}
const bufferAddress = bufferAddressText as Address;

interface RpcEnvelope<T> {
  error?: { code: number; message: string; data?: unknown };
  result?: T;
}

interface AccountInfoResult {
  context: { slot: number };
  value: null | {
    data: [string, "base64"];
    executable: boolean;
    lamports: number;
    owner: string;
    space: number;
  };
}

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(ROUTER_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const envelope = (await response.json()) as RpcEnvelope<T>;
      if (envelope.error) {
        const rpcError = new Error(
          `${method} RPC ${envelope.error.code}: ${envelope.error.message}`,
        );
        if (envelope.error.message.includes("Blockhash not found")) {
          throw rpcError;
        }
        throw rpcError;
      }
      if (envelope.result === undefined) {
        throw new Error(`${method} returned no result`);
      }
      return envelope.result;
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        error.message.includes("Blockhash not found")
      ) {
        break;
      }
      if (attempt === 10) break;
      await delay(Math.min(500 * 2 ** (attempt - 1), 15_000));
    }
  }
  throw lastError;
}

async function getAccountSlice(
  address: Address,
  offset: number,
  length: number,
  commitment: "confirmed" | "finalized",
): Promise<AccountInfoResult> {
  return rpcCall<AccountInfoResult>("getAccountInfo", [
    address,
    { commitment, encoding: "base64", dataSlice: { offset, length } },
  ]);
}

function encodeWrite(offset: number, bytes: Uint8Array): Uint8Array {
  const data = new Uint8Array(16 + bytes.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, LOADER_WRITE_VARIANT, true);
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
    `Refusing stale/unreviewed ${isVersion22 ? "version-2.2" : "version-2.1"} binary: expected ${EXPECTED_BINARY_SHA256}, got ${binarySha256}`,
  );
}

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (
  signerClient.identity.address !== EXPECTED_AUTHORITY ||
  signerClient.payer.address !== EXPECTED_AUTHORITY
) {
  throw new Error("Signer does not match the approved buffer authority and fee payer");
}

const [bufferPreflight, programDataPreflight] = await Promise.all([
  getAccountSlice(bufferAddress, 0, BUFFER_METADATA_LENGTH, "confirmed"),
  getAccountSlice(PROGRAM_DATA, 0, 45, "confirmed"),
]);
const bufferAccount = bufferPreflight.value;
if (
  !bufferAccount ||
  bufferAccount.executable ||
  bufferAccount.owner !== UPGRADEABLE_LOADER ||
  bufferAccount.space !== binary.length + BUFFER_METADATA_LENGTH
) {
  throw new Error("Buffer failed existence, owner, executable, or allocation validation");
}
const bufferMetadata = Buffer.from(bufferAccount.data[0], "base64");
const bufferView = new DataView(
  bufferMetadata.buffer,
  bufferMetadata.byteOffset,
  bufferMetadata.byteLength,
);
if (bufferMetadata.length !== BUFFER_METADATA_LENGTH || bufferView.getUint32(0, true) !== 1) {
  throw new Error("Buffer discriminator or metadata length is invalid");
}
if (
  bufferMetadata[4] !== 1 ||
  getAddressDecoder().decode(bufferMetadata.subarray(5, 37)) !== EXPECTED_AUTHORITY
) {
  throw new Error("Buffer authority does not match the approved signer");
}

const programDataAccount = programDataPreflight.value;
if (
  !programDataAccount ||
  programDataAccount.executable ||
  programDataAccount.owner !== UPGRADEABLE_LOADER
) {
  throw new Error("ProgramData failed owner/executable validation");
}
const programDataMetadata = Buffer.from(programDataAccount.data[0], "base64");
const programDataView = new DataView(
  programDataMetadata.buffer,
  programDataMetadata.byteOffset,
  programDataMetadata.byteLength,
);
if (
  programDataMetadata.length !== 45 ||
  programDataView.getUint32(0, true) !== 3 ||
  programDataMetadata[12] !== 1 ||
  getAddressDecoder().decode(programDataMetadata.subarray(13, 45)) !==
    EXPECTED_AUTHORITY
) {
  throw new Error("ProgramData discriminator or authority validation failed");
}
const lastDeploySlotBefore = programDataView.getBigUint64(4, true);

type PreparedWrite = {
  offset: number;
  signature: string;
  wire: string;
};

async function prepareWrite(offset: number, blockhash: Blockhash, lastValidBlockHeight: bigint) {
  const instruction = addSignersToInstruction(
    [signerClient.identity],
    {
      programAddress: UPGRADEABLE_LOADER,
      accounts: [
        { address: bufferAddress, role: AccountRole.WRITABLE },
        { address: EXPECTED_AUTHORITY, role: AccountRole.READONLY_SIGNER },
      ],
      data: encodeWrite(
        offset,
        binary.subarray(offset, Math.min(offset + WRITE_CHUNK_LENGTH, binary.length)),
      ),
    } satisfies Instruction,
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash, lastValidBlockHeight },
        current,
      ),
    (current) => appendTransactionMessageInstruction(instruction, current),
  );
  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  return {
    offset,
    signature: getSignatureFromTransaction(signedTransaction),
    wire: getBase64EncodedWireTransaction(signedTransaction),
  } satisfies PreparedWrite;
}

async function sendWrite(write: PreparedWrite) {
  const signature = await rpcCall<string>("sendTransaction", [
    write.wire,
    {
      encoding: "base64",
      maxRetries: 5,
      preflightCommitment: "confirmed",
      skipPreflight: false,
    },
  ]);
  if (signature !== write.signature) {
    throw new Error(`Router returned an unexpected signature for offset ${write.offset}`);
  }
}

async function waitForConfirmation(writes: PreparedWrite[]) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const response = await rpcCall<{
      value: Array<null | { confirmationStatus: string | null; err: unknown }>;
    }>("getSignatureStatuses", [
      writes.map((write) => write.signature),
      { searchTransactionHistory: true },
    ]);
    const failures = response.value.filter((status) => status?.err != null);
    if (failures.length > 0) {
      throw new Error(`A buffer write failed: ${json(failures)}`);
    }
    if (
      response.value.every(
        (status) =>
          status?.confirmationStatus === "confirmed" ||
          status?.confirmationStatus === "finalized",
      )
    ) {
      return;
    }
    await delay(1_000);
  }
  throw new Error("Timed out waiting for a buffer-write batch to confirm");
}

const allOffsets = Array.from(
  { length: Math.ceil(binary.length / WRITE_CHUNK_LENGTH) },
  (_unused, index) => index * WRITE_CHUNK_LENGTH,
);
const currentBuffer = Buffer.alloc(binary.length);
for (let offset = 0; offset < binary.length; offset += VERIFY_CHUNK_LENGTH) {
  const length = Math.min(VERIFY_CHUNK_LENGTH, binary.length - offset);
  const response = await getAccountSlice(
    bufferAddress,
    BUFFER_METADATA_LENGTH + offset,
    length,
    "confirmed",
  );
  if (!response.value || response.value.owner !== UPGRADEABLE_LOADER) {
    throw new Error(`Resume scan failed at byte offset ${offset}`);
  }
  Buffer.from(response.value.data[0], "base64").copy(currentBuffer, offset);
}
const offsets = allOffsets.filter((offset) => {
  const end = Math.min(offset + WRITE_CHUNK_LENGTH, binary.length);
  return !currentBuffer.subarray(offset, end).equals(binary.subarray(offset, end));
});
console.log(
  json({
    totalChunks: allOffsets.length,
    alreadyMatchingChunks: allOffsets.length - offsets.length,
    chunksRemaining: offsets.length,
  }),
);
const signatures: string[] = [];
for (let batchStart = 0; batchStart < offsets.length; batchStart += BATCH_SIZE) {
  const batchOffsets = offsets.slice(batchStart, batchStart + BATCH_SIZE);
  let writes: PreparedWrite[] | undefined;
  for (let batchAttempt = 1; batchAttempt <= 10; batchAttempt += 1) {
    const lifetime = await rpcCall<{
      blockhash: string;
      lastValidBlockHeight: number;
    }>("getBlockhashForAccounts", [[bufferAddress, EXPECTED_AUTHORITY]]);
    const candidateWrites = await Promise.all(
      batchOffsets.map((offset) =>
        prepareWrite(
          offset,
          lifetime.blockhash as Blockhash,
          BigInt(lifetime.lastValidBlockHeight),
        ),
      ),
    );
    try {
      await Promise.all(candidateWrites.map(sendWrite));
      await waitForConfirmation(candidateWrites);
      writes = candidateWrites;
      break;
    } catch (error) {
      if (batchAttempt === 10) throw error;
      console.log(
        json({
          batchRetry: batchAttempt,
          firstOffset: batchOffsets[0],
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      await delay(1_000);
    }
  }
  if (!writes) throw new Error("Buffer-write batch exhausted retries");
  signatures.push(...writes.map((write) => write.signature));
  if (
    batchStart === 0 ||
    batchStart + BATCH_SIZE >= offsets.length ||
    (batchStart / BATCH_SIZE + 1) % 20 === 0
  ) {
    console.log(
      json({
        remainingChunkProgress: `${Math.min(batchStart + BATCH_SIZE, offsets.length)}/${offsets.length}`,
        highestOffsetConfirmed: Math.min(
          batchOffsets[batchOffsets.length - 1] + WRITE_CHUNK_LENGTH,
          binary.length,
        ),
      }),
    );
  }
}

const verified = Buffer.alloc(binary.length);
let verificationSlot = 0;
for (let offset = 0; offset < binary.length; offset += VERIFY_CHUNK_LENGTH) {
  const length = Math.min(VERIFY_CHUNK_LENGTH, binary.length - offset);
  const response = await getAccountSlice(
    bufferAddress,
    BUFFER_METADATA_LENGTH + offset,
    length,
    "finalized",
  );
  if (
    !response.value ||
    response.value.owner !== UPGRADEABLE_LOADER ||
    response.value.space !== binary.length + BUFFER_METADATA_LENGTH
  ) {
    throw new Error(`Final buffer validation failed at byte offset ${offset}`);
  }
  const bytes = Buffer.from(response.value.data[0], "base64");
  if (bytes.length !== length) {
    throw new Error(`Final buffer slice length failed at byte offset ${offset}`);
  }
  bytes.copy(verified, offset);
  verificationSlot = Math.max(verificationSlot, response.context.slot);
}
const uploadedSha256 = createHash("sha256").update(verified).digest("hex");
if (uploadedSha256 !== binarySha256 || !verified.equals(binary)) {
  throw new Error(
    `Finalized buffer does not match the reviewed artifact: ${uploadedSha256}`,
  );
}

const programDataAfter = await getAccountSlice(PROGRAM_DATA, 0, 45, "finalized");
if (!programDataAfter.value || programDataAfter.value.owner !== UPGRADEABLE_LOADER) {
  throw new Error("Post-upload ProgramData validation failed");
}
const programDataAfterBytes = Buffer.from(programDataAfter.value.data[0], "base64");
const lastDeploySlotAfter = new DataView(
  programDataAfterBytes.buffer,
  programDataAfterBytes.byteOffset,
  programDataAfterBytes.byteLength,
).getBigUint64(4, true);
if (lastDeploySlotAfter !== lastDeploySlotBefore) {
  throw new Error("Program deploy slot changed during the buffer-only checkpoint");
}

console.log(
  json({
    cluster: "Solana Devnet",
    router: ROUTER_RPC_URL,
    bufferUploadComplete: true,
    release: isVersion22 ? "version-2.2" : "version-2.1",
    programUpgradeExecuted: false,
    programId: PROGRAM_ID,
    programData: PROGRAM_DATA,
    programDeploySlotBefore: lastDeploySlotBefore,
    programDeploySlotAfter: lastDeploySlotAfter,
    buffer: bufferAddress,
    bufferAuthority: EXPECTED_AUTHORITY,
    bufferAllocation: binary.length + BUFFER_METADATA_LENGTH,
    bufferRentLamports: bufferAccount.lamports,
    binaryLength: binary.length,
    localBinarySha256: binarySha256,
    finalizedBufferSha256: uploadedSha256,
    finalizedVerificationSlot: verificationSlot,
    writeTransactions: signatures.length,
    chunksAlreadyMatchingAtResume: allOffsets.length - offsets.length,
    firstWriteSignature: signatures[0],
    lastWriteSignature: signatures[signatures.length - 1],
    allWritesSignedBeforeSend: true,
    representativeLoaderWriteSignedSimulationPassed: true,
    nodePreflightEnabledForEveryWrite: true,
    allWritesConfirmed: true,
    approximateBaseFeesLamports: signatures.length * 5_000,
  }),
);
