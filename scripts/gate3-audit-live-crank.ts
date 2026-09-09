import { createSolanaRpc, getAddressDecoder, signature, type Address } from "@solana/kit";

import { getCrankProbeDecoder } from "../clients/ts/src/generated/accounts/crankProbe.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { AUTHORITY, PROGRAM_ID } from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";
import { PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";

const PUBLIC_RPC_URL = "https://api.devnet.solana.com" as const;
const SCHEDULE_SIGNATURE =
  "4YCD7bUdsM6QEyCWjCti191ATmaqH5EvwC53DzdHj5Rzo3GMNga2zstsJazRLpmrM1W8WQ77Mdjxu7u2HQkAe2gK";
const EXPECTED_MEMBER_FLAGS = 0b1_1111;
const FLAG_NAMES = [
  [0b0_0001, "authority"],
  [0b0_0010, "transaction_logs"],
  [0b0_0100, "transaction_balances"],
  [0b0_1000, "transaction_messages"],
  [0b1_0000, "account_signatures"],
] as const;
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

function decodePermission(data: Uint8Array, expectedProtectedAccount: Address) {
  if (data.length !== 567) {
    throw new Error(`Expected a 567-byte Permission account, received ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const protectedAccount = addressDecoder.decode(data.slice(2, 34));
  const memberCount = view.getUint32(35, true);
  const members = Array.from({ length: memberCount }, (_value, index) => {
    const offset = 39 + index * 33;
    const flags = data[offset];
    if (flags === undefined || offset + 33 > data.length) {
      throw new Error("Permission member vector exceeds account data");
    }
    return {
      publicKey: addressDecoder.decode(data.slice(offset + 1, offset + 33)),
      flags,
      capabilities: FLAG_NAMES.filter(([flag]) => (flags & flag) !== 0).map(([, name]) => name),
    };
  });
  const meaningfulBytes = 39 + memberCount * 33;
  const nonZeroPaddingBytes = data.slice(meaningfulBytes).filter((byte) => byte !== 0).length;
  if (
    data[0] !== 0 ||
    data[34] !== 1 ||
    protectedAccount !== expectedProtectedAccount ||
    memberCount !== 2 ||
    members[0]?.publicKey !== PROGRAM_ID ||
    members[0]?.flags !== 0 ||
    members[1]?.publicKey !== AUTHORITY ||
    members[1]?.flags !== EXPECTED_MEMBER_FLAGS ||
    nonZeroPaddingBytes !== 0
  ) {
    throw new Error(`Permission layout differs from the expected policy: ${json({ protectedAccount, members })}`);
  }
  return { protectedAccount, memberCount, members, meaningfulBytes, nonZeroPaddingBytes };
}

const addresses = await deriveGate2Addresses();
const pdaSets = await Promise.all([
  deriveDelegationPdas(addresses.permission, PERMISSION_PROGRAM_ID),
  deriveDelegationPdas(addresses.crankPermission, PERMISSION_PROGRAM_ID),
  deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
  deriveDelegationPdas(addresses.crankProbe, PROGRAM_ID),
]);
const publicRpc = createSolanaRpc(PUBLIC_RPC_URL);
const publicResponse = await publicRpc
  .getMultipleAccounts(
    [
      addresses.permission,
      addresses.crankPermission,
      addresses.deposit,
      addresses.crankProbe,
      ...pdaSets.flatMap((set) => [set.record, set.metadata]),
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [depositPermissionAccount, probePermissionAccount, depositAccount, probeAccount, ...pdaAccounts] =
  publicResponse.value;
if (!depositPermissionAccount || !probePermissionAccount || !depositAccount || !probeAccount) {
  throw new Error("A required public Gate 3 account is missing");
}
for (const account of [depositPermissionAccount, probePermissionAccount, depositAccount, probeAccount]) {
  if (account.owner !== DELEGATION_PROGRAM_ID) {
    throw new Error("A protected account is not owned by the Delegation Program");
  }
}
for (const account of pdaAccounts) {
  if (!account || account.owner !== DELEGATION_PROGRAM_ID) {
    throw new Error("A public delegation record or metadata account is missing");
  }
}
const depositPermission = decodePermission(accountBytes(depositPermissionAccount.data), addresses.deposit);
const probePermission = decodePermission(accountBytes(probePermissionAccount.data), addresses.crankProbe);
const publicDeposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
const publicProbe = getCrankProbeDecoder().decode(accountBytes(probeAccount.data));
if (
  publicDeposit.nextPaymentNonce !== 0n ||
  publicProbe.taskId !== 0n ||
  publicProbe.transitionCount !== 0n ||
  publicProbe.status !== CrankProbeStatus.Pending
) {
  throw new Error(`Public base-layer snapshot unexpectedly contains private terminal state: ${json({ publicDeposit, publicProbe })}`);
}

const unauthenticatedRpc = createSolanaRpc(PRIVATE_ER_ORIGIN);
const unauthenticatedAccounts = await unauthenticatedRpc
  .getMultipleAccounts(
    [addresses.permission, addresses.crankPermission, addresses.deposit, addresses.crankProbe],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [unauthDepositPermission, unauthProbePermission, unauthDeposit, unauthProbe] =
  unauthenticatedAccounts.value;
if (!unauthDepositPermission || !unauthProbePermission || unauthDeposit !== null || unauthProbe !== null) {
  throw new Error("Unauthenticated Private ER visibility differs from the expected redaction boundary");
}
const unauthenticatedTransaction = await unauthenticatedRpc
  .getTransaction(signature(SCHEDULE_SIGNATURE), {
    commitment: "confirmed",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  })
  .send();
if (!unauthenticatedTransaction) {
  throw new Error("Unauthenticated Private ER did not return the known schedule receipt");
}
const publicMessage = unauthenticatedTransaction.transaction.message;
const publicMeta = unauthenticatedTransaction.meta;
const accountKeyCount = publicMessage.accountKeys.length;
const instructionCount = publicMessage.instructions.length;
const logCount = publicMeta?.logMessages?.length ?? 0;
if (accountKeyCount !== 0 || instructionCount !== 0 || logCount !== 0) {
  throw new Error("Unauthenticated Private ER transaction response exposed protected execution details");
}

console.log(
  json({
    publicSolana: {
      finalizedReadSlot: publicResponse.context.slot,
      protectedAccountOwners: {
        depositPermission: depositPermissionAccount.owner,
        crankPermission: probePermissionAccount.owner,
        deposit: depositAccount.owner,
        crankProbe: probeAccount.owner,
      },
      permissions: {
        deposit: depositPermission,
        crankProbe: probePermission,
      },
      publicDelegationRecords: pdaSets.map((set, index) => ({
        protectedAccount: [addresses.permission, addresses.crankPermission, addresses.deposit, addresses.crankProbe][index],
        record: set.record,
        metadata: set.metadata,
        recordDataLength: accountBytes(pdaAccounts[index * 2]!.data).length,
        metadataDataLength: accountBytes(pdaAccounts[index * 2 + 1]!.data).length,
      })),
      staleStateSnapshot: {
        depositNextPaymentNonce: publicDeposit.nextPaymentNonce,
        crankTaskId: publicProbe.taskId,
        crankStatus: CrankProbeStatus[publicProbe.status],
        crankTransitionCount: publicProbe.transitionCount,
      },
    },
    unauthenticatedPrivateEr: {
      readSlot: unauthenticatedAccounts.context.slot,
      permissionAccountsVisible: 2,
      protectedStateAccountsVisible: 0,
      knownTransaction: {
        signature: SCHEDULE_SIGNATURE,
        slot: unauthenticatedTransaction.slot,
        blockTime: unauthenticatedTransaction.blockTime,
        err: publicMeta?.err ?? null,
        accountKeyCount,
        instructionCount,
        logCount,
      },
    },
    measuredPrivacyClaim: {
      privateUntilCommit: ["task ID", "terminal status", "transition count", "payment nonce"],
      publicNow: [
        "authority wallet",
        "protected account addresses",
        "permission members and capability flags",
        "delegation record and metadata addresses",
        "pre-delegation state snapshot",
        "private transaction signature, timing, slot, and success/failure",
      ],
      publicAfterCommit: ["complete committed CrankProbe and Deposit byte layouts"],
    },
    assertions: "all passed",
  }),
);
