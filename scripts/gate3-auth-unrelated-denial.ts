import { createSolanaRpc } from "@solana/kit";

import { AUTHORITY } from "./gate1-simulate.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";
import { authenticatePrivateEr, PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";

const APPROVAL_FLAG = "--approved-gate3-unrelated-auth";
if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign an unrelated-wallet authentication message without ${APPROVAL_FLAG}`);
}
const keypairPath = process.env.UNRELATED_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("UNRELATED_KEYPAIR_PATH must name the approved unrelated test signer file");
}

const authentication = await authenticatePrivateEr(keypairPath);
if (authentication.identity === AUTHORITY) {
  throw new Error("The unrelated-wallet audit signer unexpectedly matches the protected owner");
}
const rpc = createSolanaRpc(authentication.authenticatedUrl.toString());
const addresses = await deriveGate2Addresses();
const response = await rpc
  .getMultipleAccounts(
    [addresses.permission, addresses.crankPermission, addresses.deposit, addresses.crankProbe],
    { commitment: "confirmed", encoding: "base64" },
  )
  .send();
const [depositPermission, crankPermission, deposit, crankProbe] = response.value;
if (!depositPermission || !crankPermission || deposit !== null || crankProbe !== null) {
  throw new Error("Unrelated authenticated wallet visibility differs from the expected denial boundary");
}

console.log(
  JSON.stringify(
    {
      authentication: {
        endpoint: PRIVATE_ER_ORIGIN,
        identity: authentication.identity,
        protectedOwner: AUTHORITY,
        challengeAgeSeconds: authentication.challengeAgeSeconds,
        tokenReceived: true,
        tokenPrinted: false,
        tokenStored: false,
      },
      authenticatedUnrelatedRead: {
        slot: response.context.slot.toString(),
        permissionAccountsVisible: 2,
        protectedDepositVisible: false,
        protectedCrankProbeVisible: false,
      },
      conclusion: "Authentication alone does not grant access; Permission membership controls protected state reads.",
      assertions: "all passed",
    },
    null,
    2,
  ),
);
