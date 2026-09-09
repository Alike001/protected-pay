import { createSolanaRpc, getAddressDecoder, signature, type Address } from "@solana/kit";

import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getVaultDecoder } from "../clients/ts/src/generated/accounts/vault.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { AUTHORITY, deriveAddresses, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const WITHDRAWAL_SIGNATURE = signature(
  "3vgEQBC5BNEJyx23QgkbZU8mQTFJ916184t83WRwHCK149CVySEqFuqoDK8rFuKRK4dSsaAbfKkdva3aeqp3Df92",
);

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") throw new Error(`Unexpected account encoding: ${data[1]}`);
  return Buffer.from(data[0], "base64");
}

function decodeTokenAccount(data: Uint8Array): { mint: Address; owner: Address; amount: bigint } {
  if (data.length !== 165) throw new Error(`Expected a 165-byte token account, received ${data.length}`);
  const decoder = getAddressDecoder();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: decoder.decode(data.slice(0, 32)),
    owner: decoder.decode(data.slice(32, 64)),
    amount: view.getBigUint64(64, true),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item, 2);
}

const rpc = createSolanaRpc(RPC_URL);
const addresses = await deriveAddresses();
const [permissionDelegation, depositDelegation] = await Promise.all([
  deriveDelegationPdas(addresses.permission, PERMISSION_PROGRAM_ID),
  deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
]);
const [accountsResponse, statusResponse, transactionResponse] = await Promise.all([
  rpc.getMultipleAccounts([
    addresses.vault,
    addresses.deposit,
    addresses.walletUsdcAta,
    addresses.vaultUsdcAta,
    addresses.permission,
    permissionDelegation.record,
    permissionDelegation.metadata,
    depositDelegation.record,
    depositDelegation.metadata,
  ], { commitment: "finalized", encoding: "base64" }).send(),
  rpc.getSignatureStatuses([WITHDRAWAL_SIGNATURE], { searchTransactionHistory: true }).send(),
  rpc.getTransaction(WITHDRAWAL_SIGNATURE, {
    commitment: "finalized",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send(),
]);
const [
  vaultAccount,
  depositAccount,
  walletAtaAccount,
  vaultAtaAccount,
  permissionAccount,
  permissionRecord,
  permissionMetadata,
  depositRecord,
  depositMetadata,
] = accountsResponse.value;
const status = statusResponse.value[0];
if (
  !vaultAccount || !depositAccount || !walletAtaAccount || !vaultAtaAccount ||
  !permissionAccount || !permissionRecord || !permissionMetadata ||
  !status || status.err || status.confirmationStatus !== "finalized" ||
  !transactionResponse || !transactionResponse.meta || transactionResponse.meta.err
) {
  throw new Error("A finalized round-trip account or transaction proof is missing or failed");
}
if (
  vaultAccount.owner !== PROGRAM_ID || accountBytes(vaultAccount.data).length !== 49 ||
  depositAccount.owner !== PROGRAM_ID || accountBytes(depositAccount.data).length !== 98 ||
  walletAtaAccount.owner !== TOKEN_PROGRAM_ID || vaultAtaAccount.owner !== TOKEN_PROGRAM_ID ||
  permissionAccount.owner !== DELEGATION_PROGRAM_ID ||
  permissionRecord.owner !== DELEGATION_PROGRAM_ID ||
  permissionMetadata.owner !== DELEGATION_PROGRAM_ID ||
  depositRecord !== null || depositMetadata !== null
) {
  throw new Error("Final round-trip ownership or delegation cleanup check failed");
}
const vault = getVaultDecoder().decode(accountBytes(vaultAccount.data));
const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
const walletToken = decodeTokenAccount(accountBytes(walletAtaAccount.data));
const vaultToken = decodeTokenAccount(accountBytes(vaultAtaAccount.data));
if (
  vault.tokenMint !== USDC_MINT || vault.totalLiability !== 0n ||
  deposit.user !== AUTHORITY || deposit.tokenMint !== USDC_MINT ||
  deposit.available !== 0n || deposit.locked !== 0n ||
  walletToken.mint !== USDC_MINT || walletToken.owner !== AUTHORITY ||
  walletToken.amount !== 20_000_000n ||
  vaultToken.mint !== USDC_MINT || vaultToken.owner !== addresses.vault ||
  vaultToken.amount !== 0n
) {
  throw new Error(`Final round-trip conservation check failed: ${json({ vault, deposit, walletToken, vaultToken })}`);
}

console.log(json({
  cluster: "devnet",
  finalizedReadSlot: accountsResponse.context.slot,
  withdrawal: {
    signature: WITHDRAWAL_SIGNATURE,
    slot: status.slot,
    blockTime: transactionResponse.blockTime,
    feeLamports: transactionResponse.meta.fee,
    computeUnitsConsumed: transactionResponse.meta.computeUnitsConsumed ?? null,
    status: "Ok / finalized",
  },
  walletRawUsdc: walletToken.amount,
  vaultRawUsdc: vaultToken.amount,
  vaultLiability: vault.totalLiability,
  depositAvailable: deposit.available,
  depositLocked: deposit.locked,
  depositOwner: depositAccount.owner,
  depositDelegationRecordPresent: false,
  depositDelegationMetadataPresent: false,
  permissionRemainsDelegated: true,
  assertions: "all passed",
}));
