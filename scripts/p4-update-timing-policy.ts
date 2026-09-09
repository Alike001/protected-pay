import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createClient,
  createNoopSigner,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { signerFromFile } from "@solana/kit-plugin-signer";

import {
  CONFIG_DISCRIMINATOR,
  getConfigDecoder,
  type Config,
} from "../clients/ts/src/generated/accounts/config.ts";
import { getUpdateTimingPolicyInstructionAsync } from "../clients/ts/src/generated/instructions/updateTimingPolicy.ts";
import {
  AUTHORITY,
  deriveAddresses,
  PRIVATE_VALIDATOR,
  PROGRAM_ID,
  USDC_MINT,
} from "./gate1-simulate.ts";
import { TOKEN_PROGRAM_ID } from "./gate1-simulate-delegation.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const UPGRADEABLE_LOADER =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const CONFIG_SIZE = 154;
const CURRENT_SAFETY_WINDOW_SECONDS = 300n;
const CURRENT_CLAIM_WINDOW_SECONDS = 86_400n;
const NEW_SAFETY_WINDOW_SECONDS = 60n;
const NEW_CLAIM_WINDOW_SECONDS = 300n;
const COMPUTE_UNIT_LIMIT = 100_000;
const SEND_REQUESTED = process.argv.includes("--send");
const APPROVAL_FLAG = "--approved-p4-timing-policy";

type EncodedAccountData = readonly [string, string];

function accountBytes(data: EncodedAccountData): Uint8Array {
  if (data[1] !== "base64") {
    throw new Error(`Unexpected account encoding: ${data[1]}`);
  }
  return Buffer.from(data[0], "base64");
}

function assertBytesEqual(
  actual: ReadonlyUint8Array,
  expected: ReadonlyUint8Array,
  label: string,
): void {
  let matches = actual.length === expected.length;
  for (let index = 0; matches && index < actual.length; index += 1) {
    matches = actual[index] === expected[index];
  }
  if (!matches) {
    throw new Error(`${label} discriminator mismatch`);
  }
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function assertConfigIdentity(config: Config): void {
  assertBytesEqual(config.discriminator, CONFIG_DISCRIMINATOR, "Config");
  if (
    config.authority !== AUTHORITY ||
    config.allowedMint !== USDC_MINT ||
    config.tokenProgram !== TOKEN_PROGRAM_ID ||
    config.privateValidator !== PRIVATE_VALIDATOR ||
    config.version !== 1
  ) {
    throw new Error(`Config identity fields differ from the approved deployment: ${json(config)}`);
  }
}

function assertCurrentPolicy(config: Config): void {
  if (
    config.safetyWindowSeconds !== CURRENT_SAFETY_WINDOW_SECONDS ||
    config.claimWindowSeconds !== CURRENT_CLAIM_WINDOW_SECONDS
  ) {
    throw new Error(
      `Config timing pre-state changed: ${json({
        safetyWindowSeconds: config.safetyWindowSeconds,
        claimWindowSeconds: config.claimWindowSeconds,
      })}`,
    );
  }
}

function assertNewPolicy(config: Config): void {
  assertConfigIdentity(config);
  if (
    config.safetyWindowSeconds !== NEW_SAFETY_WINDOW_SECONDS ||
    config.claimWindowSeconds !== NEW_CLAIM_WINDOW_SECONDS
  ) {
    throw new Error(
      `Simulated timing post-state is incorrect: ${json({
        safetyWindowSeconds: config.safetyWindowSeconds,
        claimWindowSeconds: config.claimWindowSeconds,
      })}`,
    );
  }
}

async function buildInstruction(signer: TransactionSigner) {
  const { config } = await deriveAddresses();
  return getUpdateTimingPolicyInstructionAsync({
    authority: signer,
    config,
    safetyWindowSeconds: NEW_SAFETY_WINDOW_SECONDS,
    claimWindowSeconds: NEW_CLAIM_WINDOW_SECONDS,
  });
}

const rpc = createSolanaRpc(RPC_URL);
const addresses = await deriveAddresses();

async function loadValidatedPreState() {
  const response = await rpc
    .getMultipleAccounts([PROGRAM_ID, addresses.config, AUTHORITY], {
      commitment: "finalized",
      encoding: "base64",
    })
    .send();
  const [programAccount, configAccount, authorityAccount] = response.value;
  if (
    !programAccount?.executable ||
    programAccount.owner !== UPGRADEABLE_LOADER
  ) {
    throw new Error("Protected Pay program failed executable/loader validation");
  }
  if (!configAccount || configAccount.owner !== PROGRAM_ID) {
    throw new Error("Config failed program-owner validation");
  }
  const configBytes = accountBytes(configAccount.data);
  if (configBytes.length !== CONFIG_SIZE) {
    throw new Error(`Expected ${CONFIG_SIZE} Config bytes, received ${configBytes.length}`);
  }
  if (!authorityAccount || authorityAccount.owner !== SYSTEM_PROGRAM) {
    throw new Error("Authority failed system-account owner validation");
  }
  const config = getConfigDecoder().decode(configBytes);
  assertConfigIdentity(config);
  assertCurrentPolicy(config);
  return {
    authorityAccount,
    config,
    configAccount,
    finalizedReadSlot: response.context.slot,
  };
}

async function simulateUnsigned() {
  const before = await loadValidatedPreState();
  const noopSigner = createNoopSigner(AUTHORITY);
  const instruction = await buildInstruction(noopSigner);
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(AUTHORITY, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) =>
      appendTransactionMessageInstructions(
        [getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }), instruction],
        current,
      ),
  );
  const transaction = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(transaction);
  const simulation = await rpc
    .simulateTransaction(wire, {
      accounts: { addresses: [addresses.config, AUTHORITY], encoding: "base64" },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err !== null) {
    throw new Error(
      `Unsigned timing-policy simulation failed: ${json({
        err: simulation.value.err,
        logs: simulation.value.logs,
      })}`,
    );
  }
  const [simulatedConfigAccount, simulatedAuthorityAccount] =
    simulation.value.accounts ?? [];
  if (
    !simulatedConfigAccount ||
    simulatedConfigAccount.owner !== PROGRAM_ID ||
    !simulatedAuthorityAccount ||
    simulatedAuthorityAccount.owner !== SYSTEM_PROGRAM
  ) {
    throw new Error("Simulation returned invalid Config or authority post-state");
  }
  const simulatedConfigBytes = accountBytes(simulatedConfigAccount.data);
  if (simulatedConfigBytes.length !== CONFIG_SIZE) {
    throw new Error("Simulation changed the Config account allocation");
  }
  const simulatedConfig = getConfigDecoder().decode(simulatedConfigBytes);
  assertNewPolicy(simulatedConfig);

  console.log(
    json({
      validatedPreState: {
        finalizedReadSlot: before.finalizedReadSlot,
        programId: PROGRAM_ID,
        config: addresses.config,
        configOwner: before.configAccount.owner,
        authority: before.config.authority,
        authorityLamports: before.authorityAccount.lamports,
        currentPolicy: {
          safetyWindowSeconds: before.config.safetyWindowSeconds,
          claimWindowSeconds: before.config.claimWindowSeconds,
        },
      },
      proposedTransaction: {
        cluster: "Solana Devnet",
        instruction: "update_timing_policy",
        feePayer: AUTHORITY,
        signer: AUTHORITY,
        writableAccounts: [addresses.config],
        recipient: "none",
        solMoved: "0",
        tokensMoved: "none",
        newPolicy: {
          safetyWindowSeconds: NEW_SAFETY_WINDOW_SECONDS,
          claimWindowSeconds: NEW_CLAIM_WINDOW_SECONDS,
        },
        existingPaymentDeadlinesChanged: false,
        signed: false,
        sent: false,
      },
      simulation: {
        slot: simulation.context.slot,
        err: null,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        estimatedFeeLamports: simulation.value.fee ?? null,
        configLamportsBefore: before.configAccount.lamports,
        configLamportsAfter: simulatedConfigAccount.lamports,
        authorityLamportsAfter: simulatedAuthorityAccount.lamports,
        postPolicy: {
          safetyWindowSeconds: simulatedConfig.safetyWindowSeconds,
          claimWindowSeconds: simulatedConfig.claimWindowSeconds,
        },
      },
    }),
  );
}

if (!SEND_REQUESTED) {
  await simulateUnsigned();
} else {
  if (!process.argv.includes(APPROVAL_FLAG)) {
    throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
  }
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved signer file");
  }

  // Repeat every unsigned validation and post-state check before loading a signer.
  await simulateUnsigned();

  const signerClient = await createClient().use(signerFromFile(keypairPath));
  if (
    signerClient.identity.address !== AUTHORITY ||
    signerClient.payer.address !== AUTHORITY
  ) {
    throw new Error("Signer does not match the approved Config authority and fee payer");
  }
  const instruction = await buildInstruction(signerClient.identity);
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) =>
      appendTransactionMessageInstructions(
        [getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }), instruction],
        current,
      ),
  );
  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const signedWire = getBase64EncodedWireTransaction(signedTransaction);
  const signature = getSignatureFromTransaction(signedTransaction);
  const signedSimulation = await rpc
    .simulateTransaction(signedWire, {
      accounts: { addresses: [addresses.config], encoding: "base64" },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (signedSimulation.value.err !== null) {
    throw new Error(
      `Signed timing-policy preflight failed: ${json({
        err: signedSimulation.value.err,
        logs: signedSimulation.value.logs,
      })}`,
    );
  }
  const signedConfigAccount = signedSimulation.value.accounts?.[0];
  if (!signedConfigAccount || signedConfigAccount.owner !== PROGRAM_ID) {
    throw new Error("Signed simulation returned an invalid Config post-state");
  }
  const signedConfigBytes = accountBytes(signedConfigAccount.data);
  if (signedConfigBytes.length !== CONFIG_SIZE) {
    throw new Error("Signed simulation changed the Config allocation");
  }
  assertNewPolicy(getConfigDecoder().decode(signedConfigBytes));

  console.log(
    json({
      signedPreflight: {
        preparedSignature: signature,
        err: null,
        unitsConsumed: signedSimulation.value.unitsConsumed ?? null,
      },
    }),
  );
  const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTransaction, { commitment: "finalized" });

  const verifiedConfigAccount = await rpc
    .getAccountInfo(addresses.config, {
      commitment: "finalized",
      encoding: "base64",
    })
    .send();
  if (
    !verifiedConfigAccount.value ||
    verifiedConfigAccount.value.owner !== PROGRAM_ID
  ) {
    throw new Error("Finalized Config verification failed owner validation");
  }
  const verifiedBytes = accountBytes(verifiedConfigAccount.value.data);
  if (verifiedBytes.length !== CONFIG_SIZE) {
    throw new Error("Finalized Config verification failed length validation");
  }
  const verifiedConfig = getConfigDecoder().decode(verifiedBytes);
  assertNewPolicy(verifiedConfig);
  console.log(
    json({
      finalizedTransaction: {
        cluster: "Solana Devnet",
        signature,
        config: addresses.config,
        feePayer: AUTHORITY,
        solMoved: "0",
        tokensMoved: "none",
        safetyWindowSeconds: verifiedConfig.safetyWindowSeconds,
        claimWindowSeconds: verifiedConfig.claimWindowSeconds,
      },
    }),
  );
}
