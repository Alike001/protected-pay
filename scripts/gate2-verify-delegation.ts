import { createSolanaRpc } from "@solana/kit";

import { PROGRAM_ID } from "./gate1-simulate.ts";
import {
  DELEGATION_PROGRAM_ID,
  deriveDelegationPdas,
  PERMISSION_PROGRAM_ID,
} from "./gate1-simulate-delegation.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";

const rpc = createSolanaRpc("https://api.devnet.solana.com");
const addresses = await deriveGate2Addresses();
const [depositPermission, crankPermission, deposit, crankProbe] = await Promise.all([
  deriveDelegationPdas(addresses.permission, PERMISSION_PROGRAM_ID),
  deriveDelegationPdas(addresses.crankPermission, PERMISSION_PROGRAM_ID),
  deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
  deriveDelegationPdas(addresses.crankProbe, PROGRAM_ID),
]);
const protectedAddresses = [
  addresses.permission,
  addresses.crankPermission,
  addresses.deposit,
  addresses.crankProbe,
] as const;
const pdaSets = [depositPermission, crankPermission, deposit, crankProbe] as const;
const response = await rpc
  .getMultipleAccounts(
    [
      ...protectedAddresses,
      ...pdaSets.flatMap((set) => [set.buffer, set.record, set.metadata]),
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const protectedAccounts = response.value.slice(0, protectedAddresses.length);
if (
  protectedAccounts.some(
    (account) => !account || account.owner !== DELEGATION_PROGRAM_ID,
  )
) {
  throw new Error("Not every Gate 2 protected account is delegated");
}
const pdaAccounts = response.value.slice(protectedAddresses.length);
for (let index = 0; index < pdaSets.length; index += 1) {
  const [buffer, record, metadata] = pdaAccounts.slice(index * 3, index * 3 + 3);
  if (buffer !== null || !record || !metadata) {
    throw new Error("Delegation buffer/record/metadata invariant failed");
  }
  if (
    record.owner !== DELEGATION_PROGRAM_ID ||
    metadata.owner !== DELEGATION_PROGRAM_ID
  ) {
    throw new Error("Delegation record or metadata has the wrong owner");
  }
}

console.log(
  JSON.stringify(
    {
      cluster: "devnet",
      finalizedReadSlot: response.context.slot.toString(),
      delegatedAccounts: protectedAddresses.map((address, index) => ({
        address,
        owner: protectedAccounts[index]!.owner,
        record: pdaSets[index]!.record,
        metadata: pdaSets[index]!.metadata,
      })),
      transientBuffersPresent: false,
      assertions: "all passed",
    },
    null,
    2,
  ),
);
