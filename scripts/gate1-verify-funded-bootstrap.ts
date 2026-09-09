import {
  address,
  createSolanaRpc,
  getAddressDecoder,
  type Address,
} from "@solana/kit";

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
import {
  AUTHORITY,
  deriveAddresses,
  PRIVATE_VALIDATOR,
  PROGRAM_ID,
  USDC_MINT,
} from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PERMISSION_PROGRAM_ID = address("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const EXPECTED_WALLET_AMOUNT = 19_000_000n;
const EXPECTED_VAULT_AMOUNT = 1_000_000n;

const rpc = createSolanaRpc(RPC_URL);
const addressDecoder = getAddressDecoder();

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

function assertBytesEqual(
  actual: { readonly length: number; readonly [index: number]: number },
  expected: { readonly length: number; readonly [index: number]: number },
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

function assertOwnerAndLength(
  owner: Address,
  expectedOwner: Address,
  length: number,
  expectedLength: number,
  label: string,
): void {
  if (owner !== expectedOwner || length !== expectedLength) {
    throw new Error(
      `${label} expected owner ${expectedOwner} and ${expectedLength} bytes; received ${owner} and ${length} bytes`,
    );
  }
}

const addresses = await deriveAddresses();
const response = await rpc
  .getMultipleAccounts(
    [
      addresses.config,
      addresses.vault,
      addresses.vaultUsdcAta,
      addresses.deposit,
      addresses.permission,
      addresses.walletUsdcAta,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();

if (response.value.some((account) => account === null)) {
  throw new Error("One or more funded-bootstrap accounts do not exist");
}

const [configAccount, vaultAccount, vaultAtaAccount, depositAccount, permissionAccount, walletAtaAccount] =
  response.value;
if (
  !configAccount ||
  !vaultAccount ||
  !vaultAtaAccount ||
  !depositAccount ||
  !permissionAccount ||
  !walletAtaAccount
) {
  throw new Error("Unexpected null funded-bootstrap account");
}

const configBytes = accountBytes(configAccount.data);
const vaultBytes = accountBytes(vaultAccount.data);
const vaultAtaBytes = accountBytes(vaultAtaAccount.data);
const depositBytes = accountBytes(depositAccount.data);
const permissionBytes = accountBytes(permissionAccount.data);
const walletAtaBytes = accountBytes(walletAtaAccount.data);

assertOwnerAndLength(configAccount.owner, PROGRAM_ID, configBytes.length, 154, "Config");
assertOwnerAndLength(vaultAccount.owner, PROGRAM_ID, vaultBytes.length, 49, "Vault");
assertOwnerAndLength(depositAccount.owner, PROGRAM_ID, depositBytes.length, 98, "Deposit");
assertOwnerAndLength(vaultAtaAccount.owner, TOKEN_PROGRAM_ID, vaultAtaBytes.length, 165, "Vault ATA");
assertOwnerAndLength(walletAtaAccount.owner, TOKEN_PROGRAM_ID, walletAtaBytes.length, 165, "Wallet ATA");
assertOwnerAndLength(
  permissionAccount.owner,
  PERMISSION_PROGRAM_ID,
  permissionBytes.length,
  567,
  "Permission",
);

const config = getConfigDecoder().decode(configBytes);
const vault = getVaultDecoder().decode(vaultBytes);
const deposit = getDepositDecoder().decode(depositBytes);
const vaultToken = decodeTokenAccount(vaultAtaBytes);
const walletToken = decodeTokenAccount(walletAtaBytes);

assertBytesEqual(config.discriminator, CONFIG_DISCRIMINATOR, "Config");
assertBytesEqual(vault.discriminator, VAULT_DISCRIMINATOR, "Vault");
assertBytesEqual(deposit.discriminator, DEPOSIT_DISCRIMINATOR, "Deposit");

if (
  config.authority !== AUTHORITY ||
  config.allowedMint !== USDC_MINT ||
  config.tokenProgram !== TOKEN_PROGRAM_ID ||
  config.safetyWindowSeconds !== 300n ||
  config.claimWindowSeconds !== 86_400n ||
  config.privateValidator !== PRIVATE_VALIDATOR ||
  config.version !== 1
) {
  throw new Error(`Config state mismatch: ${json(config)}`);
}
if (vault.tokenMint !== USDC_MINT || vault.totalLiability !== EXPECTED_VAULT_AMOUNT) {
  throw new Error(`Vault state mismatch: ${json(vault)}`);
}
if (
  deposit.user !== AUTHORITY ||
  deposit.tokenMint !== USDC_MINT ||
  deposit.available !== EXPECTED_VAULT_AMOUNT ||
  deposit.locked !== 0n ||
  deposit.nextPaymentNonce !== 0n ||
  deposit.automationPaused ||
  deposit.version !== 1
) {
  throw new Error(`Deposit state mismatch: ${json(deposit)}`);
}
if (
  vaultToken.mint !== USDC_MINT ||
  vaultToken.owner !== addresses.vault ||
  vaultToken.amount !== EXPECTED_VAULT_AMOUNT
) {
  throw new Error(`Vault token state mismatch: ${json(vaultToken)}`);
}
if (
  walletToken.mint !== USDC_MINT ||
  walletToken.owner !== AUTHORITY ||
  walletToken.amount !== EXPECTED_WALLET_AMOUNT
) {
  throw new Error(`Wallet token state mismatch: ${json(walletToken)}`);
}

console.log(
  json({
    cluster: "devnet",
    finalizedReadSlot: response.context.slot,
    addresses,
    config: {
      authority: config.authority,
      allowedMint: config.allowedMint,
      tokenProgram: config.tokenProgram,
      safetyWindowSeconds: config.safetyWindowSeconds,
      claimWindowSeconds: config.claimWindowSeconds,
      privateValidator: config.privateValidator,
      version: config.version,
      dataLength: configBytes.length,
      owner: configAccount.owner,
    },
    vault: {
      tokenMint: vault.tokenMint,
      totalLiability: vault.totalLiability,
      tokenBalance: vaultToken.amount,
      dataLength: vaultBytes.length,
      owner: vaultAccount.owner,
    },
    deposit: {
      user: deposit.user,
      tokenMint: deposit.tokenMint,
      available: deposit.available,
      locked: deposit.locked,
      nextPaymentNonce: deposit.nextPaymentNonce,
      automationPaused: deposit.automationPaused,
      version: deposit.version,
      dataLength: depositBytes.length,
      owner: depositAccount.owner,
    },
    permission: {
      dataLength: permissionBytes.length,
      owner: permissionAccount.owner,
    },
    wallet: {
      tokenBalance: walletToken.amount,
      tokenAccount: addresses.walletUsdcAta,
    },
    assertions: "all passed",
  }),
);
