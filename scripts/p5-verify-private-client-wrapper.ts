import { address, generateKeyPairSigner } from "@solana/kit";

import { createPrivateClient } from "../src/hooks/usePrivateBalance.ts";

const signer = await generateKeyPairSigner();
const authority = address("4C2GznkXgEp2EhcXkPyBQh9feYvAkCcN2bWDrGjbkwvR");
const sessionToken = address("4tns379VDqSugAohaUmNygBSCuBHB8V7d8a64k3TA59s");
const sessionExpiresAt = 1_789_087_709;
const client = createPrivateClient(
  signer,
  "https://devnet-tee.magicblock.app?token=regression-test",
  authority,
  sessionToken,
  sessionExpiresAt,
);

if (
  client.authority !== authority ||
  client.sessionToken !== sessionToken ||
  client.sessionExpiresAt !== sessionExpiresAt
) {
  throw new Error("Private client session metadata was not preserved");
}
if (!("rpc" in client) || !("identity" in client) || !("payer" in client)) {
  throw new Error("Private client lost a required Solana client plugin");
}

console.log(JSON.stringify({
  authority: client.authority,
  clientCreated: true,
  metadataPreserved: true,
  pluginsPreserved: true,
  sessionToken: client.sessionToken,
}, null, 2));
