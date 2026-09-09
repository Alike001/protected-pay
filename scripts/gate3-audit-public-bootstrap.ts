import {
  createSolanaRpc,
  getAddressDecoder,
} from "@solana/kit";

import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import {
  AUTHORITY,
  deriveAddresses,
  PROGRAM_ID,
} from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const EXPECTED_MEMBER_FLAGS = 0b1_1111;
const FLAG_NAMES = [
  [0b0_0001, "authority"],
  [0b0_0010, "transaction_logs"],
  [0b0_0100, "transaction_balances"],
  [0b0_1000, "transaction_messages"],
  [0b1_0000, "account_signatures"],
] as const;

const rpc = createSolanaRpc(RPC_URL);
const addressDecoder = getAddressDecoder();

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

const addresses = await deriveAddresses();
const response = await rpc
  .getMultipleAccounts(
    [addresses.permission, addresses.deposit, addresses.vaultUsdcAta],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [permissionAccount, depositAccount, vaultAtaAccount] = response.value;
if (!permissionAccount || !depositAccount || !vaultAtaAccount) {
  throw new Error("A funded-bootstrap account is missing");
}

const permission = accountBytes(permissionAccount.data);
if (permission.length !== 567) {
  throw new Error(`Expected a 567-byte Permission account, received ${permission.length}`);
}
const view = new DataView(permission.buffer, permission.byteOffset, permission.byteLength);
const discriminator = permission[0];
const bump = permission[1];
const permissionedAccount = addressDecoder.decode(permission.slice(2, 34));
const membersOption = permission[34];
const memberCount = view.getUint32(35, true);
const members = Array.from({ length: memberCount }, (_value, index) => {
  const offset = 39 + index * 33;
  const flags = permission[offset];
  if (flags === undefined || offset + 33 > permission.length) {
    throw new Error("Permission member vector exceeds the account data length");
  }
  return {
    publicKey: addressDecoder.decode(permission.slice(offset + 1, offset + 33)),
    flags,
    capabilities: FLAG_NAMES.filter(([flag]) => (flags & flag) !== 0).map(
      ([, name]) => name,
    ),
  };
});
const meaningfulBytes = 39 + memberCount * 33;
const nonZeroPaddingBytes = permission.slice(meaningfulBytes).filter((byte) => byte !== 0).length;

if (
  discriminator !== 0 ||
  membersOption !== 1 ||
  memberCount !== 2 ||
  members[0]?.flags !== 0 ||
  members[0]?.publicKey !== PROGRAM_ID ||
  members[1]?.flags !== EXPECTED_MEMBER_FLAGS ||
  members[1]?.publicKey !== AUTHORITY ||
  permissionedAccount !== addresses.deposit ||
  nonZeroPaddingBytes !== 0
) {
  throw new Error(
    `Permission contents differ from the expected one-member policy: ${json({
      discriminator,
      membersOption,
      memberCount,
      members,
      permissionedAccount,
      nonZeroPaddingBytes,
    })}`,
  );
}

const depositBytes = accountBytes(depositAccount.data);
if (depositAccount.owner !== PROGRAM_ID || depositBytes.length !== 98) {
  throw new Error("Deposit owner or length mismatch");
}
const deposit = getDepositDecoder().decode(depositBytes);
const vaultBytes = accountBytes(vaultAtaAccount.data);
const vaultView = new DataView(vaultBytes.buffer, vaultBytes.byteOffset, vaultBytes.byteLength);
const vaultRawAmount = vaultView.getBigUint64(64, true);

console.log(
  json({
    cluster: "devnet",
    finalizedReadSlot: response.context.slot,
    permission: {
      address: addresses.permission,
      discriminator,
      bump,
      permissionedAccount,
      memberCount,
      members,
      allocatedBytes: permission.length,
      serializedMeaningfulBytes: meaningfulBytes,
      nonZeroPaddingBytes,
    },
    publiclyReadableDepositSnapshot: {
      address: addresses.deposit,
      user: deposit.user,
      tokenMint: deposit.tokenMint,
      available: deposit.available,
      locked: deposit.locked,
      nextPaymentNonce: deposit.nextPaymentNonce,
      automationPaused: deposit.automationPaused,
    },
    publiclyReadableVaultCollateral: {
      address: addresses.vaultUsdcAta,
      rawAmount: vaultRawAmount,
    },
    conclusion: {
      hiddenAtBootstrap: [],
      publicAtBootstrap: [
        "authority wallet public key",
        "permissioned Deposit address",
        "permission capability flags",
        "Deposit owner and token mint",
        "Deposit available and locked balances",
        "vault token balance",
      ],
      requiredClaim:
        "Privacy begins only for state transitions executed after delegation inside the authenticated Private ER; bootstrap funding, identity linkage, permissions, and the pre-delegation balance snapshot are public.",
    },
    assertions: "all passed",
  }),
);
