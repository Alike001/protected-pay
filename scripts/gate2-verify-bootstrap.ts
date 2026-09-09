import { createSolanaRpc, type ReadonlyUint8Array } from "@solana/kit";

import {
  CRANK_PROBE_DISCRIMINATOR,
  getCrankProbeDecoder,
} from "../clients/ts/src/generated/accounts/crankProbe.ts";
import {
  DEPOSIT_DISCRIMINATOR,
  getDepositDecoder,
} from "../clients/ts/src/generated/accounts/deposit.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import { PERMISSION_PROGRAM_ID } from "./gate1-simulate-delegation.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const rpc = createSolanaRpc(RPC_URL);

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") throw new Error(`Unexpected encoding: ${data[1]}`);
  return Buffer.from(data[0], "base64");
}

function assertDiscriminator(
  data: Uint8Array,
  expected: ReadonlyUint8Array,
  label: string,
): void {
  if (expected.some((byte, index) => data[index] !== byte)) {
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

const addresses = await deriveGate2Addresses();
const response = await rpc
  .getMultipleAccounts(
    [addresses.deposit, addresses.crankProbe, addresses.crankPermission],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [depositAccount, probeAccount, permissionAccount] = response.value;
if (!depositAccount || !probeAccount || !permissionAccount) {
  throw new Error("Finalized Gate 2 bootstrap accounts are incomplete");
}
const depositBytes = accountBytes(depositAccount.data);
const probeBytes = accountBytes(probeAccount.data);
if (depositAccount.owner !== PROGRAM_ID || depositBytes.length !== 98) {
  throw new Error("Deposit owner/length validation failed");
}
if (probeAccount.owner !== PROGRAM_ID || probeBytes.length !== 99) {
  throw new Error("CrankProbe owner/length validation failed");
}
if (
  permissionAccount.owner !== PERMISSION_PROGRAM_ID ||
  accountBytes(permissionAccount.data).length !== 567
) {
  throw new Error("CrankProbe Permission owner/length validation failed");
}
assertDiscriminator(depositBytes, DEPOSIT_DISCRIMINATOR, "Deposit");
assertDiscriminator(probeBytes, CRANK_PROBE_DISCRIMINATOR, "CrankProbe");
const deposit = getDepositDecoder().decode(depositBytes);
const probe = getCrankProbeDecoder().decode(probeBytes);
if (
  deposit.user !== AUTHORITY ||
  deposit.tokenMint !== USDC_MINT ||
  deposit.available !== 0n ||
  deposit.locked !== 0n ||
  deposit.nextPaymentNonce !== 0n ||
  deposit.automationPaused ||
  probe.owner !== AUTHORITY ||
  probe.deposit !== addresses.deposit ||
  probe.taskId !== 0n ||
  probe.transitionCount !== 0n ||
  probe.status !== CrankProbeStatus.Pending ||
  probe.version !== 1
) {
  throw new Error(`Unexpected finalized Gate 2 bootstrap state: ${json({ deposit, probe })}`);
}

console.log(
  json({
    cluster: "devnet",
    finalizedReadSlot: response.context.slot,
    crankProbe: {
      address: addresses.crankProbe,
      dataLength: probeBytes.length,
      deposit: probe.deposit,
      notBefore: probe.notBefore,
      owner: probe.owner,
      status: CrankProbeStatus[probe.status],
      taskId: probe.taskId,
      transitionCount: probe.transitionCount,
    },
    deposit: {
      address: addresses.deposit,
      available: deposit.available,
      locked: deposit.locked,
      nextPaymentNonce: deposit.nextPaymentNonce,
    },
    permission: {
      address: addresses.crankPermission,
      dataLength: accountBytes(permissionAccount.data).length,
      owner: permissionAccount.owner,
    },
    assertions: "all passed",
  }),
);
