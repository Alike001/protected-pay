import {
  AccountRole,
  addSignersToInstruction,
  appendTransactionMessageInstruction,
  createClient,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
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
const CURRENT_PROGRAM_LENGTH = 635_136;
const NEW_PROGRAM_LENGTH = 700_672;
const LOADER_PROGRAM_DATA_METADATA_LENGTH = 45;
const ADDITIONAL_BYTES = NEW_PROGRAM_LENGTH - CURRENT_PROGRAM_LENGTH;
const EXTEND_PROGRAM_VARIANT = 6;
const APPROVAL_FLAG = "--approved-p5-v22-program-extension-signed-simulation";

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign without ${APPROVAL_FLAG}`);
}
if (process.argv.includes("--send")) {
  throw new Error("This checkpoint is simulation-only and cannot broadcast");
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved authority signer");
}

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") throw new Error("Unexpected account encoding");
  return Buffer.from(data[0], "base64");
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

const rpc = createSolanaRpc(RPC_URL);
const signerClient = await createClient().use(signerFromFile(keypairPath));
if (
  signerClient.identity.address !== EXPECTED_AUTHORITY ||
  signerClient.payer.address !== EXPECTED_AUTHORITY
) {
  throw new Error("Signer does not match the onchain upgrade authority");
}

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
if (
  !programDataAccount ||
  programDataAccount.owner !== UPGRADEABLE_LOADER
) {
  throw new Error("ProgramData account failed owner validation");
}
const programData = accountBytes(programDataAccount.data);
if (
  programData.length !==
  CURRENT_PROGRAM_LENGTH + LOADER_PROGRAM_DATA_METADATA_LENGTH
) {
  throw new Error("ProgramData length changed after the approved preflight");
}
const stateView = new DataView(
  programData.buffer,
  programData.byteOffset,
  programData.byteLength,
);
if (stateView.getUint32(0, true) !== 3 || programData[12] !== 1) {
  throw new Error("ProgramData discriminator or authority option is invalid");
}
const decodedAuthority = getAddressDecoder().decode(programData.slice(13, 45));
if (decodedAuthority !== EXPECTED_AUTHORITY) {
  throw new Error("ProgramData authority does not match the approved signer");
}
if (!authorityAccount || authorityAccount.owner !== SYSTEM_PROGRAM) {
  throw new Error("Fee payer account failed owner validation");
}

const instructionData = new Uint8Array(8);
const instructionView = new DataView(instructionData.buffer);
instructionView.setUint32(0, EXTEND_PROGRAM_VARIANT, true);
instructionView.setUint32(4, ADDITIONAL_BYTES, true);
const extendInstruction: Instruction = {
  programAddress: UPGRADEABLE_LOADER,
  accounts: [
    { address: PROGRAM_DATA, role: AccountRole.WRITABLE },
    { address: PROGRAM_ID, role: AccountRole.WRITABLE },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    {
      address: EXPECTED_AUTHORITY,
      role: AccountRole.WRITABLE_SIGNER,
    },
  ],
  data: instructionData,
};
const signedExtendInstruction = addSignersToInstruction(
  [signerClient.payer],
  extendInstruction,
);

const { value: latestBlockhash } = await rpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
  (current) =>
    setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) =>
    appendTransactionMessageInstruction(signedExtendInstruction, current),
);
const signedTransaction = await signTransactionMessageWithSigners(message);
const wireTransaction = getBase64EncodedWireTransaction(
  signedTransaction,
);
const simulation = await rpc
  .simulateTransaction(wireTransaction, {
    accounts: { addresses: [PROGRAM_DATA, EXPECTED_AUTHORITY], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    sigVerify: true,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(
    `Signed extension simulation failed: ${json({
      err: simulation.value.err,
      logs: simulation.value.logs,
    })}`,
  );
}
const [simulatedProgramData, simulatedAuthority] =
  simulation.value.accounts ?? [];
if (!simulatedProgramData || !simulatedAuthority) {
  throw new Error("Simulation did not return requested post-state accounts");
}
if (
  simulatedProgramData.owner !== UPGRADEABLE_LOADER ||
  accountBytes(simulatedProgramData.data).length !==
    NEW_PROGRAM_LENGTH + LOADER_PROGRAM_DATA_METADATA_LENGTH
) {
  throw new Error("Simulated ProgramData post-state failed owner/length validation");
}

console.log(
  json({
    simulationOnly: true,
    transactionBroadcast: false,
    cluster: "Solana Devnet",
    release: "version-2.2",
    instruction: "ExtendProgram",
    programId: PROGRAM_ID,
    programData: PROGRAM_DATA,
    feePayerAndAuthority: EXPECTED_AUTHORITY,
    currentProgramLength: CURRENT_PROGRAM_LENGTH,
    newProgramLength: NEW_PROGRAM_LENGTH,
    additionalBytes: ADDITIONAL_BYTES,
    signatureVerifiedBySimulation: true,
    simulationError: null,
    unitsConsumed: simulation.value.unitsConsumed,
    estimatedFeeLamports: simulation.value.fee,
    authorityLamportsBefore: authorityAccount.lamports,
    authorityLamportsAfterSimulation: simulatedAuthority.lamports,
    programDataLamportsBefore: programDataAccount.lamports,
    programDataLamportsAfterSimulation: simulatedProgramData.lamports,
  }),
);
