import { createSolanaRpc } from "@solana/kit";

import { AUTHORITY, PROGRAM_ID } from "./gate1-simulate.ts";
import { deriveGate2Addresses } from "./gate2-simulate-bootstrap.ts";
import { authenticatePrivateEr, PRIVATE_ER_ORIGIN } from "./private-er-auth.ts";

const APPROVAL_FLAG = "--approved-gate3-tee-auth";
const EXPECTED_SCHEDULED_COMMIT_RECEIPT =
  "Cp31gU4z8Y6hEn6jZYNXYBsUbrEjyN93VBYVgqLCk47KTFtAFDswx54t7QBJKtGLNycxB4S1ycwMiLtDNUq2hhC";

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item, 2);
}

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign a TEE authentication message without ${APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) throw new Error("SOLANA_KEYPAIR_PATH must name the approved signer file");
const authentication = await authenticatePrivateEr(keypairPath);
if (authentication.identity !== AUTHORITY) {
  throw new Error("Signer does not match the protected owner");
}
const rpc = createSolanaRpc(authentication.authenticatedUrl.toString());
const addresses = await deriveGate2Addresses();
const entries = await rpc
  .getSignaturesForAddress(AUTHORITY, { commitment: "confirmed", limit: 20 })
  .send();
let receipt:
  | {
      erSignature: string;
      erSlot: bigint;
      blockTime: bigint | null;
      err: unknown;
      feePayer: string | null;
      committedAccounts: string[];
      scheduledCommitReceiptSignature: string;
    }
  | undefined;
for (const entry of entries) {
  const transaction = await rpc.getTransaction(entry.signature, {
    commitment: "confirmed",
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send();
  const logs = transaction?.meta?.logMessages ?? [];
  const scheduledAccountsLog = logs.find((line) => line.startsWith("Scheduling undelegation for accounts: "));
  const commitmentLog = logs.find((line) => line.startsWith("ScheduledCommitSent signature: "));
  if (
    scheduledAccountsLog?.includes(addresses.crankProbe) &&
    scheduledAccountsLog.includes(addresses.deposit) &&
    commitmentLog
  ) {
    const match = commitmentLog.match(/^ScheduledCommitSent signature: ([1-9A-HJ-NP-Za-km-z]{64,88})$/);
    if (!match?.[1]) throw new Error("Commit receipt contained an invalid base signature");
    receipt = {
      erSignature: entry.signature,
      erSlot: entry.slot,
      blockTime: entry.blockTime,
      err: transaction?.meta?.err ?? entry.err,
      feePayer: transaction?.transaction.message.accountKeys[0] ?? null,
      committedAccounts: [addresses.crankProbe, addresses.deposit],
      scheduledCommitReceiptSignature: match[1],
    };
    break;
  }
}
if (!receipt) throw new Error("Could not locate the Gate 3 commit/undelegate receipt");
if (
  receipt.err !== null ||
  receipt.feePayer !== AUTHORITY ||
  receipt.scheduledCommitReceiptSignature !== EXPECTED_SCHEDULED_COMMIT_RECEIPT
) {
  throw new Error(`Recovered commit receipt failed validation: ${json(receipt)}`);
}

console.log(JSON.stringify({
  authentication: {
    endpoint: PRIVATE_ER_ORIGIN,
    identity: authentication.identity,
    challengeAgeSeconds: authentication.challengeAgeSeconds,
    tokenPrinted: false,
    tokenStored: false,
  },
  protectedProgram: PROGRAM_ID,
  receipt: {
    ...receipt,
    erSlot: receipt.erSlot.toString(),
    blockTime: receipt.blockTime?.toString() ?? null,
  },
  assertions: "all passed",
}, null, 2));
