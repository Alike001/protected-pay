import {
  createSolanaRpc,
  getAddressDecoder,
  getAddressEncoder,
  type Address,
} from "@solana/kit";

import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import {
  AUTHORITY,
  deriveAddresses,
  PROGRAM_ID,
  USDC_MINT,
} from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const PRIVATE_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
const EXPECTED_AMOUNT = 1_000_000n;

const rpc = createSolanaRpc(RPC_URL);
const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") {
    throw new Error(`Unexpected account encoding: ${data[1]}`);
  }
  return Buffer.from(data[0], "base64");
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function decodeDelegationRecord(data: Uint8Array) {
  if (data.length !== 96) {
    throw new Error(`Expected a 96-byte Delegation Record, received ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    discriminator: view.getBigUint64(0, true),
    authority: addressDecoder.decode(data.slice(8, 40)),
    originalOwner: addressDecoder.decode(data.slice(40, 72)),
    delegationSlot: view.getBigUint64(72, true),
    delegatedLamports: view.getBigUint64(80, true),
    commitFrequencyMs: view.getBigUint64(88, true),
  };
}

function decodeDelegationMetadata(data: Uint8Array) {
  if (data.length < 53) {
    throw new Error(`Delegation Metadata is too short: ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const discriminator = view.getBigUint64(0, true);
  const lastCommitId = view.getBigUint64(8, true);
  const undelegationRequester = data[16];
  const seedCount = view.getUint32(17, true);
  let offset = 21;
  const seeds: Uint8Array[] = [];
  for (let index = 0; index < seedCount; index += 1) {
    if (offset + 4 > data.length) {
      throw new Error("Delegation Metadata seed length exceeds account data");
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > data.length) {
      throw new Error("Delegation Metadata seed exceeds account data");
    }
    seeds.push(data.slice(offset, offset + length));
    offset += length;
  }
  if (offset + 32 !== data.length) {
    throw new Error("Delegation Metadata has unexpected trailing data");
  }
  return {
    discriminator,
    lastCommitId,
    undelegationRequester,
    seeds,
    rentPayer: addressDecoder.decode(data.slice(offset, offset + 32)),
  };
}

function bytesEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

function assertMetadata(
  metadata: ReturnType<typeof decodeDelegationMetadata>,
  expectedSeeds: Uint8Array[],
  label: string,
): void {
  if (
    metadata.discriminator !== 102n ||
    metadata.lastCommitId !== 0n ||
    metadata.undelegationRequester !== 0 ||
    metadata.rentPayer !== AUTHORITY ||
    metadata.seeds.length !== expectedSeeds.length ||
    !metadata.seeds.every((seed, index) => {
      const expected = expectedSeeds[index];
      return expected !== undefined && bytesEqual(seed, expected);
    })
  ) {
    throw new Error(`${label} metadata mismatch`);
  }
}

function decodeTokenAmount(data: Uint8Array): bigint {
  if (data.length !== 165) {
    throw new Error(`Expected a 165-byte SPL Token account, received ${data.length}`);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

const addresses = await deriveAddresses();
const [permissionDelegation, depositDelegation] = await Promise.all([
  deriveDelegationPdas(addresses.permission, PERMISSION_PROGRAM_ID),
  deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
]);
const response = await rpc
  .getMultipleAccounts(
    [
      addresses.permission,
      permissionDelegation.buffer,
      permissionDelegation.record,
      permissionDelegation.metadata,
      addresses.deposit,
      depositDelegation.buffer,
      depositDelegation.record,
      depositDelegation.metadata,
      addresses.vaultUsdcAta,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [
  permission,
  permissionBuffer,
  permissionRecordAccount,
  permissionMetadataAccount,
  deposit,
  depositBuffer,
  depositRecordAccount,
  depositMetadataAccount,
  vaultAta,
] = response.value;
if (
  !permission ||
  !permissionRecordAccount ||
  !permissionMetadataAccount ||
  !deposit ||
  !depositRecordAccount ||
  !depositMetadataAccount ||
  !vaultAta
) {
  throw new Error("One or more persistent delegated accounts are missing");
}
if (permissionBuffer !== null || depositBuffer !== null) {
  throw new Error("A temporary delegation buffer unexpectedly persisted");
}
if (permission.owner !== DELEGATION_PROGRAM_ID || deposit.owner !== DELEGATION_PROGRAM_ID) {
  throw new Error("Permission or Deposit is not owned by the Delegation Program");
}
for (const [label, account, length] of [
  ["Permission Record", permissionRecordAccount, 96],
  ["Permission Metadata", permissionMetadataAccount, 104],
  ["Deposit Record", depositRecordAccount, 96],
  ["Deposit Metadata", depositMetadataAccount, 136],
] as const) {
  if (account.owner !== DELEGATION_PROGRAM_ID || accountBytes(account.data).length !== length) {
    throw new Error(`${label} failed owner/length validation`);
  }
}
if (vaultAta.owner !== TOKEN_PROGRAM_ID || decodeTokenAmount(accountBytes(vaultAta.data)) !== EXPECTED_AMOUNT) {
  throw new Error("Vault collateral changed during delegation");
}

const permissionRecord = decodeDelegationRecord(accountBytes(permissionRecordAccount.data));
const depositRecord = decodeDelegationRecord(accountBytes(depositRecordAccount.data));
if (
  permissionRecord.discriminator !== 100n ||
  permissionRecord.authority !== PRIVATE_VALIDATOR ||
  permissionRecord.originalOwner !== PERMISSION_PROGRAM_ID ||
  permissionRecord.delegatedLamports !== permission.lamports ||
  depositRecord.discriminator !== 100n ||
  depositRecord.authority !== PRIVATE_VALIDATOR ||
  depositRecord.originalOwner !== PROGRAM_ID ||
  depositRecord.delegatedLamports !== deposit.lamports
) {
  throw new Error(`Delegation Record mismatch: ${json({ permissionRecord, depositRecord })}`);
}

const permissionMetadata = decodeDelegationMetadata(accountBytes(permissionMetadataAccount.data));
const depositMetadata = decodeDelegationMetadata(accountBytes(depositMetadataAccount.data));
assertMetadata(
  permissionMetadata,
  [Buffer.from("permission:"), Buffer.from(addressEncoder.encode(addresses.deposit))],
  "Permission",
);
assertMetadata(
  depositMetadata,
  [
    Buffer.from("deposit"),
    Buffer.from(addressEncoder.encode(AUTHORITY)),
    Buffer.from(addressEncoder.encode(USDC_MINT)),
  ],
  "Deposit",
);

const depositState = getDepositDecoder().decode(accountBytes(deposit.data));
if (depositState.available !== EXPECTED_AMOUNT || depositState.locked !== 0n) {
  throw new Error("Delegated Deposit snapshot changed unexpectedly");
}

console.log(
  json({
    cluster: "devnet",
    finalizedReadSlot: response.context.slot,
    permission: {
      address: addresses.permission,
      owner: permission.owner,
      dataLength: accountBytes(permission.data).length,
      delegationRecord: permissionRecord,
      metadata: {
        address: permissionDelegation.metadata,
        seedLabels: ["permission:", "deposit_address"],
        rentPayer: permissionMetadata.rentPayer,
      },
    },
    deposit: {
      address: addresses.deposit,
      owner: deposit.owner,
      dataLength: accountBytes(deposit.data).length,
      publicBaseSnapshot: {
        user: depositState.user,
        tokenMint: depositState.tokenMint,
        available: depositState.available,
        locked: depositState.locked,
      },
      delegationRecord: depositRecord,
      metadata: {
        address: depositDelegation.metadata,
        seedLabels: ["deposit", "authority_wallet", "usdc_mint"],
        rentPayer: depositMetadata.rentPayer,
      },
    },
    vaultRawUsdc: EXPECTED_AMOUNT,
    temporaryBuffersPersisted: false,
    assertions: "all passed",
  }),
);
