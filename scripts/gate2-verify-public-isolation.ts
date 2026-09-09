import { createSolanaRpc } from "@solana/kit";

import { getCrankProbeDecoder } from "../clients/ts/src/generated/accounts/crankProbe.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { CrankProbeStatus } from "../clients/ts/src/generated/types/crankProbeStatus.ts";
import { AUTHORITY, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";
import { DELEGATION_PROGRAM_ID } from "./gate1-simulate-delegation.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";

const rpc = createSolanaRpc("https://api.devnet.solana.com");

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

const addresses = await deriveGate2Addresses();
const response = await rpc
  .getMultipleAccounts(
    [addresses.crankProbe, addresses.deposit],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [probeAccount, depositAccount] = response.value;
if (!probeAccount || !depositAccount) {
  throw new Error("Public Devnet did not return both delegated Gate 2 snapshots");
}
if (
  probeAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(probeAccount.data).length !== 99 ||
  depositAccount.owner !== DELEGATION_PROGRAM_ID ||
  accountBytes(depositAccount.data).length !== 98
) {
  throw new Error("Public delegated snapshots failed owner/length validation");
}
const probe = getCrankProbeDecoder().decode(accountBytes(probeAccount.data));
const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
if (
  probe.owner !== AUTHORITY ||
  probe.deposit !== addresses.deposit ||
  probe.taskId !== 0n ||
  probe.status !== CrankProbeStatus.Pending ||
  probe.transitionCount !== 0n ||
  deposit.user !== AUTHORITY ||
  deposit.tokenMint !== USDC_MINT ||
  deposit.nextPaymentNonce !== 0n ||
  deposit.available !== 0n ||
  deposit.locked !== 0n
) {
  throw new Error(`Public snapshot changed during private execution: ${json({ probe, deposit })}`);
}

console.log(
  json({
    cluster: "Solana Devnet public RPC",
    finalizedReadSlot: response.context.slot,
    delegatedSnapshot: {
      crankProbe: {
        address: addresses.crankProbe,
        accountOwner: probeAccount.owner,
        originalProgram: PROGRAM_ID,
        taskId: probe.taskId,
        status: CrankProbeStatus[probe.status],
        transitionCount: probe.transitionCount,
      },
      deposit: {
        address: addresses.deposit,
        accountOwner: depositAccount.owner,
        nextPaymentNonce: deposit.nextPaymentNonce,
        available: deposit.available,
        locked: deposit.locked,
      },
    },
    privateTerminalValuesNotPublicBeforeCommit: {
      taskId: "1788931901",
      status: "Advanced",
      transitionCount: "1",
      nextPaymentNonce: "1",
    },
    privacyBoundary: {
      hiddenUntilCommit: [
        "scheduled task ID",
        "terminal status",
        "private transition count",
        "private payment nonce",
      ],
      stillPublic: [
        "authority wallet public key",
        "Deposit and CrankProbe addresses",
        "pre-delegation account contents",
        "delegation relationship and validator metadata",
      ],
    },
    usdcMoved: "0",
    assertions: "all passed",
  }),
);
