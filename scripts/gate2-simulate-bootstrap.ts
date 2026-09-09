import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getCrankProbeDecoder } from "../clients/ts/src/generated/accounts/crankProbe.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getCreateCrankProbePermissionInstructionAsync } from "../clients/ts/src/generated/instructions/createCrankProbePermission.ts";
import { getInitializeCrankProbeInstruction } from "../clients/ts/src/generated/instructions/initializeCrankProbe.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { AUTHORITY, deriveAddresses, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import { PERMISSION_PROGRAM_ID } from "./gate1-simulate-delegation.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const UPGRADEABLE_LOADER_ID = address("BPFLoaderUpgradeab1e11111111111111111111111");
const DELAY_SECONDS = 60n;
const rpc = createSolanaRpc(RPC_URL);
const noopSigner = createNoopSigner(AUTHORITY);
const addressEncoder = getAddressEncoder();

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

export async function deriveGate2Addresses() {
  const gate1 = await deriveAddresses();
  const [[crankProbe], [crankPermission]] = await Promise.all([
    getProgramDerivedAddress({
      programAddress: PROGRAM_ID,
      seeds: [
        Buffer.from("crank-probe"),
        Buffer.from(addressEncoder.encode(AUTHORITY)),
      ],
    }),
    (async () => {
      const [probe] = await getProgramDerivedAddress({
        programAddress: PROGRAM_ID,
        seeds: [
          Buffer.from("crank-probe"),
          Buffer.from(addressEncoder.encode(AUTHORITY)),
        ],
      });
      return getProgramDerivedAddress({
        programAddress: PERMISSION_PROGRAM_ID,
        seeds: [
          Buffer.from("permission:"),
          Buffer.from(addressEncoder.encode(probe)),
        ],
      });
    })(),
  ]);
  return { ...gate1, crankPermission, crankProbe } as const;
}

export async function buildGate2Bootstrap(
  signer: TransactionSigner = noopSigner,
) {
  const addresses = await deriveGate2Addresses();
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: 400_000 }),
    getInitializeCrankProbeInstruction({
      payer: signer,
      deposit: addresses.deposit,
      crankProbe: addresses.crankProbe,
      delaySeconds: DELAY_SECONDS,
    }),
    await getCreateCrankProbePermissionInstructionAsync({
      payer: signer,
      owner: signer,
      crankProbe: addresses.crankProbe,
      permission: addresses.crankPermission,
    }),
  ];
  return { addresses, instructions } as const;
}

export async function simulateGate2Bootstrap(): Promise<void> {
  const { addresses, instructions } = await buildGate2Bootstrap();
  const preflight = await rpc
    .getMultipleAccounts(
      [
        PROGRAM_ID,
        addresses.deposit,
        addresses.crankProbe,
        addresses.crankPermission,
        PERMISSION_PROGRAM_ID,
      ],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [program, depositAccount, crankProbe, crankPermission, permissionProgram] =
    preflight.value;
  if (!program?.executable || program.owner !== UPGRADEABLE_LOADER_ID) {
    throw new Error("Protected Pay failed executable/loader validation");
  }
  if (!depositAccount || depositAccount.owner !== PROGRAM_ID || accountBytes(depositAccount.data).length !== 98) {
    throw new Error("Deposit failed owner/length validation");
  }
  const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
  if (
    deposit.user !== AUTHORITY ||
    deposit.tokenMint !== USDC_MINT ||
    deposit.available !== 0n ||
    deposit.locked !== 0n ||
    deposit.nextPaymentNonce !== 0n ||
    deposit.automationPaused ||
    deposit.version !== 1
  ) {
    throw new Error(`Unexpected pre-bootstrap Deposit: ${json(deposit)}`);
  }
  if (crankProbe !== null || crankPermission !== null) {
    throw new Error("Gate 2 bootstrap accounts already exist; refusing an init-only simulation");
  }
  if (!permissionProgram?.executable) {
    throw new Error("MagicBlock Permission Program is unavailable");
  }

  const { value: latestBlockhash } = await rpc
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
  const serializedBytes = Buffer.from(wire, "base64").length;
  if (serializedBytes > 1_232) {
    throw new Error(`Gate 2 bootstrap is ${serializedBytes} bytes; Solana limit is 1232`);
  }
  const simulation = await rpc
    .simulateTransaction(wire, {
      accounts: {
        addresses: [addresses.deposit, addresses.crankProbe, addresses.crankPermission],
        encoding: "base64",
      },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err !== null) {
    throw new Error(`Gate 2 bootstrap simulation failed: ${json(simulation.value.err)}`);
  }
  const [postDepositAccount, postProbeAccount, postPermissionAccount] =
    simulation.value.accounts ?? [];
  if (!postDepositAccount || !postProbeAccount || !postPermissionAccount) {
    throw new Error("Gate 2 bootstrap simulation returned incomplete post-state");
  }
  if (postProbeAccount.owner !== PROGRAM_ID || accountBytes(postProbeAccount.data).length !== 99) {
    throw new Error("Simulated CrankProbe failed owner/length validation");
  }
  if (
    postPermissionAccount.owner !== PERMISSION_PROGRAM_ID ||
    accountBytes(postPermissionAccount.data).length !== 567
  ) {
    throw new Error("Simulated CrankProbe Permission failed owner/length validation");
  }
  const postDeposit = getDepositDecoder().decode(accountBytes(postDepositAccount.data));
  const postProbe = getCrankProbeDecoder().decode(accountBytes(postProbeAccount.data));
  if (
    postDeposit.nextPaymentNonce !== 0n ||
    postProbe.owner !== AUTHORITY ||
    postProbe.deposit !== addresses.deposit ||
    postProbe.taskId !== 0n ||
    postProbe.transitionCount !== 0n ||
    postProbe.status !== CrankProbeStatus.Pending ||
    postProbe.version !== 1
  ) {
    throw new Error(`Unexpected simulated Gate 2 state: ${json({ postDeposit, postProbe })}`);
  }

  console.log(
    json({
      cluster: "Solana Devnet",
      proposedTransaction: {
        feePayer: AUTHORITY,
        signer: AUTHORITY,
        instructions: [
          "set compute limit",
          "initialize payment-shaped CrankProbe",
          "create its MagicBlock Permission",
        ],
        usdcMoved: "0",
      },
      serializedBytes,
      simulation: {
        err: null,
        unitsConsumed: simulation.value.unitsConsumed ?? null,
        crankProbe: {
          address: addresses.crankProbe,
          dataLength: accountBytes(postProbeAccount.data).length,
          deposit: postProbe.deposit,
          owner: postProbe.owner,
          status: CrankProbeStatus[postProbe.status],
          taskId: postProbe.taskId,
          transitionCount: postProbe.transitionCount,
        },
        permission: {
          address: addresses.crankPermission,
          dataLength: accountBytes(postPermissionAccount.data).length,
          owner: postPermissionAccount.owner,
        },
      },
    }),
  );
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  await simulateGate2Bootstrap();
}
