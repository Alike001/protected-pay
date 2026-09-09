import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import {
  CONFIG_DISCRIMINATOR,
  getConfigDecoder,
} from "../clients/ts/src/generated/accounts/config.ts";
import {
  DEPOSIT_DISCRIMINATOR,
  getDepositDecoder,
} from "../clients/ts/src/generated/accounts/deposit.ts";
import {
  getVaultDecoder,
  VAULT_DISCRIMINATOR,
} from "../clients/ts/src/generated/accounts/vault.ts";
import { getCreateDepositPermissionInstruction } from "../clients/ts/src/generated/instructions/createDepositPermission.ts";
import { getDepositUsdcInstructionAsync } from "../clients/ts/src/generated/instructions/depositUsdc.ts";
import { getInitializeConfigInstructionAsync } from "../clients/ts/src/generated/instructions/initializeConfig.ts";
import { getInitializeDepositInstructionAsync } from "../clients/ts/src/generated/instructions/initializeDeposit.ts";
import { getInitializeVaultInstructionAsync } from "../clients/ts/src/generated/instructions/initializeVault.ts";
import { getWithdrawUsdcInstructionAsync } from "../clients/ts/src/generated/instructions/withdrawUsdc.ts";
import { findConfigPda } from "../clients/ts/src/generated/pdas/config.ts";
import { findDepositPda } from "../clients/ts/src/generated/pdas/deposit.ts";
import { findVaultPda } from "../clients/ts/src/generated/pdas/vault.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const CLUSTER = "devnet";
export const PROGRAM_ID = address("w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk");
export const AUTHORITY = address("6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn");
export const USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const PRIVATE_VALIDATOR = address("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const PERMISSION_PROGRAM_ID = address("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const UPGRADEABLE_LOADER_ID = address("BPFLoaderUpgradeab1e11111111111111111111111");

const SAFETY_WINDOW_SECONDS = 300n;
const CLAIM_WINDOW_SECONDS = 86_400n;
const ROUND_TRIP_AMOUNT = 1_000_000n;

const rpc = createSolanaRpc(RPC_URL);
const authoritySigner = createNoopSigner(AUTHORITY);
const addressDecoder = getAddressDecoder();
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

function decodeTokenAccount(data: Uint8Array): {
  amount: bigint;
  mint: Address;
  owner: Address;
} {
  if (data.length !== 165) {
    throw new Error(`Expected a 165-byte SPL Token account, received ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    amount: view.getBigUint64(64, true),
    mint: addressDecoder.decode(data.slice(0, 32)),
    owner: addressDecoder.decode(data.slice(32, 64)),
  };
}

type ReadonlyBytes = { readonly length: number; readonly [index: number]: number };

function assertBytesEqual(actual: ReadonlyBytes, expected: ReadonlyBytes, label: string): void {
  let matches = actual.length === expected.length;
  for (let index = 0; matches && index < actual.length; index += 1) {
    matches = actual[index] === expected[index];
  }
  if (!matches) {
    throw new Error(`${label} discriminator mismatch`);
  }
}

export async function deriveAddresses() {
  const [[config], [vault], [deposit]] = await Promise.all([
    findConfigPda({ programAddress: PROGRAM_ID }),
    findVaultPda({ tokenMint: USDC_MINT }, { programAddress: PROGRAM_ID }),
    findDepositPda(
      { user: AUTHORITY, tokenMint: USDC_MINT },
      { programAddress: PROGRAM_ID },
    ),
  ]);

  const [[permission], [walletUsdcAta], [vaultUsdcAta]] = await Promise.all([
    getProgramDerivedAddress({
      programAddress: PERMISSION_PROGRAM_ID,
      seeds: [Buffer.from("permission:"), Buffer.from(addressEncoder.encode(deposit))],
    }),
    getProgramDerivedAddress({
      programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
      seeds: [
        Buffer.from(addressEncoder.encode(AUTHORITY)),
        Buffer.from(addressEncoder.encode(TOKEN_PROGRAM_ID)),
        Buffer.from(addressEncoder.encode(USDC_MINT)),
      ],
    }),
    getProgramDerivedAddress({
      programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
      seeds: [
        Buffer.from(addressEncoder.encode(vault)),
        Buffer.from(addressEncoder.encode(TOKEN_PROGRAM_ID)),
        Buffer.from(addressEncoder.encode(USDC_MINT)),
      ],
    }),
  ]);

  return {
    authority: AUTHORITY,
    config,
    deposit,
    permission,
    privateValidator: PRIVATE_VALIDATOR,
    program: PROGRAM_ID,
    tokenMint: USDC_MINT,
    vault,
    vaultUsdcAta,
    walletUsdcAta,
  } as const;
}

export async function assertExpectedAccounts(addresses: Awaited<ReturnType<typeof deriveAddresses>>) {
  const response = await rpc
    .getMultipleAccounts(
      [
        PROGRAM_ID,
        USDC_MINT,
        addresses.walletUsdcAta,
        addresses.config,
        PERMISSION_PROGRAM_ID,
        PRIVATE_VALIDATOR,
      ],
      { commitment: "confirmed", encoding: "base64" },
    )
    .send();
  const [program, mint, walletAta, config, permissionProgram, validator] = response.value;

  if (!program || !program.executable || program.owner !== UPGRADEABLE_LOADER_ID) {
    throw new Error("Protected Pay failed executable/loader validation");
  }
  if (!mint || mint.owner !== TOKEN_PROGRAM_ID) {
    throw new Error("Circle Devnet USDC mint failed owner validation");
  }
  const mintData = accountBytes(mint.data);
  if (mintData.length !== 82 || mintData[44] !== 6 || mintData[45] !== 1) {
    throw new Error("Circle Devnet USDC mint failed length/decimals/state validation");
  }
  if (!walletAta || walletAta.owner !== TOKEN_PROGRAM_ID) {
    throw new Error("Wallet USDC ATA failed program-owner validation");
  }
  const walletTokenState = decodeTokenAccount(accountBytes(walletAta.data));
  if (
    walletTokenState.mint !== USDC_MINT ||
    walletTokenState.owner !== AUTHORITY ||
    walletTokenState.amount !== 20_000_000n
  ) {
    throw new Error(`Unexpected wallet USDC state: ${json(walletTokenState)}`);
  }
  if (config !== null) {
    throw new Error("Config already exists; bootstrap simulation is no longer applicable");
  }
  if (!permissionProgram?.executable) {
    throw new Error("MagicBlock Permission Program is missing or not executable on Devnet");
  }
  if (!validator) {
    throw new Error("Configured MagicBlock Private ER validator is missing on Devnet");
  }

  return { contextSlot: response.context.slot, walletTokenState };
}

export async function buildInstructions(
  addresses: Awaited<ReturnType<typeof deriveAddresses>>,
  includeWithdrawal: boolean,
  signer: TransactionSigner = authoritySigner,
): Promise<Instruction[]> {
  const instructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 500_000 }),
    await getInitializeConfigInstructionAsync({
      authority: signer,
      config: addresses.config,
      tokenMint: USDC_MINT,
      safetyWindowSeconds: SAFETY_WINDOW_SECONDS,
      claimWindowSeconds: CLAIM_WINDOW_SECONDS,
      privateValidator: PRIVATE_VALIDATOR,
    }),
    await getInitializeVaultInstructionAsync({
      authority: signer,
      config: addresses.config,
      vault: addresses.vault,
      vaultTokenAccount: addresses.vaultUsdcAta,
      tokenMint: USDC_MINT,
    }),
    await getInitializeDepositInstructionAsync({
      payer: signer,
      user: AUTHORITY,
      config: addresses.config,
      deposit: addresses.deposit,
      tokenMint: USDC_MINT,
    }),
    getCreateDepositPermissionInstruction({
      payer: signer,
      user: signer,
      deposit: addresses.deposit,
      permission: addresses.permission,
    }),
    await getDepositUsdcInstructionAsync({
      user: signer,
      config: addresses.config,
      vault: addresses.vault,
      deposit: addresses.deposit,
      userTokenAccount: addresses.walletUsdcAta,
      vaultTokenAccount: addresses.vaultUsdcAta,
      tokenMint: USDC_MINT,
      amount: ROUND_TRIP_AMOUNT,
    }),
  ];
  if (includeWithdrawal) {
    instructions.push(await getWithdrawUsdcInstructionAsync({
      user: signer,
      config: addresses.config,
      vault: addresses.vault,
      deposit: addresses.deposit,
      userTokenAccount: addresses.walletUsdcAta,
      vaultTokenAccount: addresses.vaultUsdcAta,
      tokenMint: USDC_MINT,
      amount: ROUND_TRIP_AMOUNT,
    }));
  }
  return instructions;
}

function printPlan(
  addresses: Awaited<ReturnType<typeof deriveAddresses>>,
  includeWithdrawal: boolean,
  serializedSize?: number,
): void {
  console.log(
    json({
      cluster: CLUSTER,
      rpcUrl: RPC_URL,
      feePayer: AUTHORITY,
      token: {
        amount: "1.000000 USDC",
        mint: USDC_MINT,
        rawAmount: ROUND_TRIP_AMOUNT,
      },
      policy: {
        claimWindowSeconds: CLAIM_WINDOW_SECONDS,
        privateValidator: PRIVATE_VALIDATOR,
        safetyWindowSeconds: SAFETY_WINDOW_SECONDS,
      },
      addresses,
      instructions: [
        "set_compute_unit_limit",
        "initialize_config",
        "initialize_vault",
        "initialize_deposit",
        "create_deposit_permission",
        "deposit_usdc",
        ...(includeWithdrawal ? ["withdraw_usdc"] : []),
      ],
      effectIfSent: {
        creates: ["Config", "Vault", "Vault USDC ATA", "Deposit", "Permission"],
        persistentUsdcMovement: includeWithdrawal
          ? "none after the atomic 1-USDC round trip"
          : "1 USDC remains in the program vault for delegation testing",
        walletUsdcBefore: "20.000000 USDC",
        walletUsdcAfter: includeWithdrawal ? "20.000000 USDC" : "19.000000 USDC",
        vaultUsdcAfter: includeWithdrawal ? "0.000000 USDC" : "1.000000 USDC",
      },
      serializedTransactionBytes: serializedSize ?? "not built in --plan mode",
    }),
  );
}

async function simulate(includeWithdrawal: boolean): Promise<void> {
  const addresses = await deriveAddresses();
  const validation = await assertExpectedAccounts(addresses);
  const instructions = await buildInstructions(addresses, includeWithdrawal);
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
  const serializedSize = Buffer.from(wire, "base64").length;
  printPlan(addresses, includeWithdrawal, serializedSize);

  if (serializedSize > 1_232) {
    throw new Error(`Transaction is ${serializedSize} bytes; Solana limit is 1232 bytes`);
  }

  const response = await rpc
    .simulateTransaction(wire, {
      accounts: {
        addresses: [
          addresses.config,
          addresses.vault,
          addresses.vaultUsdcAta,
          addresses.deposit,
          addresses.permission,
          addresses.walletUsdcAta,
        ],
        encoding: "base64",
      },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();

  const knownLogs = (response.value.logs ?? []).filter(
    (line) =>
      line.startsWith("Program log: Instruction:") ||
      line.startsWith("Program log: ProtectedPay") ||
      line.endsWith(" success") ||
      line.includes(" failed:"),
  );
  const returnedAccounts = response.value.accounts;
  if (!returnedAccounts || returnedAccounts.some((account) => account === null)) {
    throw new Error("Simulation did not return every requested post-state account");
  }
  const [configAccount, vaultAccount, vaultAtaAccount, depositAccount, permissionAccount, walletAtaAccount] =
    returnedAccounts;
  if (
    !configAccount ||
    !vaultAccount ||
    !vaultAtaAccount ||
    !depositAccount ||
    !permissionAccount ||
    !walletAtaAccount
  ) {
    throw new Error("Simulation returned an unexpected null post-state account");
  }

  const configState = getConfigDecoder().decode(accountBytes(configAccount.data));
  const vaultState = getVaultDecoder().decode(accountBytes(vaultAccount.data));
  const depositState = getDepositDecoder().decode(accountBytes(depositAccount.data));
  const vaultTokenState = decodeTokenAccount(accountBytes(vaultAtaAccount.data));
  const walletTokenState = decodeTokenAccount(accountBytes(walletAtaAccount.data));

  assertBytesEqual(configState.discriminator, CONFIG_DISCRIMINATOR, "Config");
  assertBytesEqual(vaultState.discriminator, VAULT_DISCRIMINATOR, "Vault");
  assertBytesEqual(depositState.discriminator, DEPOSIT_DISCRIMINATOR, "Deposit");
  if (
    configState.authority !== AUTHORITY ||
    configState.allowedMint !== USDC_MINT ||
    configState.tokenProgram !== TOKEN_PROGRAM_ID ||
    configState.safetyWindowSeconds !== SAFETY_WINDOW_SECONDS ||
    configState.claimWindowSeconds !== CLAIM_WINDOW_SECONDS ||
    configState.privateValidator !== PRIVATE_VALIDATOR ||
    configState.version !== 1
  ) {
    throw new Error(`Unexpected simulated Config state: ${json(configState)}`);
  }
  const expectedDepositedAmount = includeWithdrawal ? 0n : ROUND_TRIP_AMOUNT;
  if (vaultState.tokenMint !== USDC_MINT || vaultState.totalLiability !== expectedDepositedAmount) {
    throw new Error(`Unexpected simulated Vault state: ${json(vaultState)}`);
  }
  if (
    depositState.user !== AUTHORITY ||
    depositState.tokenMint !== USDC_MINT ||
    depositState.available !== expectedDepositedAmount ||
    depositState.locked !== 0n ||
    depositState.nextPaymentNonce !== 0n ||
    depositState.automationPaused ||
    depositState.version !== 1
  ) {
    throw new Error(`Unexpected simulated Deposit state: ${json(depositState)}`);
  }
  if (
    vaultTokenState.mint !== USDC_MINT ||
    vaultTokenState.owner !== addresses.vault ||
    vaultTokenState.amount !== expectedDepositedAmount
  ) {
    throw new Error(`Unexpected simulated vault token state: ${json(vaultTokenState)}`);
  }
  if (
    walletTokenState.mint !== USDC_MINT ||
    walletTokenState.owner !== AUTHORITY ||
    walletTokenState.amount !== 20_000_000n - expectedDepositedAmount
  ) {
    throw new Error(`Unexpected simulated wallet token state: ${json(walletTokenState)}`);
  }
  if (permissionAccount.owner !== PERMISSION_PROGRAM_ID || accountBytes(permissionAccount.data).length !== 567) {
    throw new Error("Unexpected simulated Permission account owner or length");
  }

  const decodedPostState = {
    config: {
      allowedMint: configState.allowedMint,
      authority: configState.authority,
      claimWindowSeconds: configState.claimWindowSeconds,
      privateValidator: configState.privateValidator,
      safetyWindowSeconds: configState.safetyWindowSeconds,
      version: configState.version,
    },
    deposit: {
      automationPaused: depositState.automationPaused,
      available: depositState.available,
      locked: depositState.locked,
      nextPaymentNonce: depositState.nextPaymentNonce,
    },
    permission: {
      dataLength: accountBytes(permissionAccount.data).length,
      owner: permissionAccount.owner,
    },
    tokenBalances: {
      vaultRawAmount: vaultTokenState.amount,
      walletRawAmount: walletTokenState.amount,
    },
    vault: { totalLiability: vaultState.totalLiability },
  };
  const postAccounts = response.value.accounts?.map((account) =>
    account
      ? {
          dataLength: accountBytes(account.data).length,
          executable: account.executable,
          lamports: account.lamports,
          owner: account.owner,
        }
      : null,
  );

  console.log(
    json({
      preflightValidation: validation,
      simulation: {
        decodedPostState,
        err: response.value.err,
        feeLamports: response.value.fee ?? null,
        knownLogs,
        postAccounts,
        slot: response.context.slot,
        unitsConsumed: response.value.unitsConsumed ?? null,
      },
    }),
  );

  if (response.value.err !== null) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("gate1-simulate.ts")) {
  const mode = process.argv[2];
  const addresses = await deriveAddresses();
  if (mode === "--plan") {
    printPlan(addresses, false);
  } else if (mode === "--simulate" || mode === "--simulate-roundtrip") {
    await simulate(true);
  } else if (mode === "--simulate-funded-bootstrap") {
    await simulate(false);
  } else {
    throw new Error("Use --plan, --simulate-roundtrip, or --simulate-funded-bootstrap");
  }
}
