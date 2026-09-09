import { createSolanaRpc } from "@solana/kit";

import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { AUTHORITY, deriveAddresses, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const EXPECTED_AMOUNT = 1_000_000n;

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

const rpc = createSolanaRpc(RPC_URL);
const addresses = await deriveAddresses();
const [permissionDelegation, depositDelegation] = await Promise.all([
  deriveDelegationPdas(addresses.permission, PERMISSION_PROGRAM_ID),
  deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
]);
const response = await rpc
  .getMultipleAccounts(
    [
      addresses.permission,
      permissionDelegation.record,
      permissionDelegation.metadata,
      addresses.deposit,
      depositDelegation.record,
      depositDelegation.metadata,
      addresses.vaultUsdcAta,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [
  permission,
  permissionRecord,
  permissionMetadata,
  deposit,
  depositRecord,
  depositMetadata,
  vault,
] = response.value;

if (!permission || !permissionRecord || !permissionMetadata || !deposit || !vault) {
  throw new Error("A required finalized account is missing");
}
if (
  permission.owner !== DELEGATION_PROGRAM_ID ||
  permissionRecord.owner !== DELEGATION_PROGRAM_ID ||
  permissionMetadata.owner !== DELEGATION_PROGRAM_ID
) {
  throw new Error("The Permission account or its delegation records changed unexpectedly");
}
if (deposit.owner !== PROGRAM_ID || accountBytes(deposit.data).length !== 98) {
  throw new Error("Deposit ownership was not restored to Protected Pay");
}
if (depositRecord !== null) {
  throw new Error("Deposit Delegation Record still exists after undelegation");
}
if (vault.owner !== TOKEN_PROGRAM_ID || tokenAmount(accountBytes(vault.data)) !== EXPECTED_AMOUNT) {
  throw new Error("Vault collateral changed during commit/undelegation");
}
const depositState = getDepositDecoder().decode(accountBytes(deposit.data));
if (
  depositState.user !== AUTHORITY ||
  depositState.tokenMint !== USDC_MINT ||
  depositState.available !== EXPECTED_AMOUNT ||
  depositState.locked !== 0n ||
  depositState.nextPaymentNonce !== 0n ||
  depositState.automationPaused ||
  depositState.version !== 1
) {
  throw new Error(`Committed Deposit state is unexpected: ${json(depositState)}`);
}

console.log(
  json({
    cluster: "devnet",
    finalizedReadSlot: response.context.slot,
    deposit: {
      address: addresses.deposit,
      owner: deposit.owner,
      dataLength: accountBytes(deposit.data).length,
      committedPublicState: {
        user: depositState.user,
        tokenMint: depositState.tokenMint,
        available: depositState.available,
        locked: depositState.locked,
        nextPaymentNonce: depositState.nextPaymentNonce,
        automationPaused: depositState.automationPaused,
        version: depositState.version,
      },
      delegationRecordPresent: false,
      delegationMetadataPresent: depositMetadata !== null,
    },
    permission: {
      address: addresses.permission,
      owner: permission.owner,
      remainsDelegated: true,
      delegationRecordPresent: true,
      delegationMetadataPresent: true,
    },
    vaultRawUsdc: tokenAmount(accountBytes(vault.data)),
    assertions: "all passed",
  }),
);
