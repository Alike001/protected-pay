import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  createClient,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";

import { AUTHORITY } from "./gate1-simulate.ts";
import {
  buildGate2Delegation,
  simulateGate2Delegation,
} from "./gate2-simulate-delegation.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const APPROVAL_FLAG = "--approved-gate2-delegation";

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error("Refusing to sign or send without " + APPROVAL_FLAG);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the approved signer file");
}

await simulateGate2Delegation();
const signerClient = await createClient().use(signerFromFile(keypairPath));
if (
  signerClient.identity.address !== AUTHORITY ||
  signerClient.payer.address !== AUTHORITY
) {
  throw new Error("Signer does not match the approved Gate 2 authority");
}

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
const plan = await buildGate2Delegation(signerClient.identity);
const { value: latestBlockhash } = await rpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
  (current) =>
    setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) =>
    appendTransactionMessageInstructions(plan.instructions, current),
);
const signedTransaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(signedTransaction);
assertIsTransactionWithinSizeLimit(signedTransaction);
const wire = getBase64EncodedWireTransaction(signedTransaction);
const signature = getSignatureFromTransaction(signedTransaction);
const signedPreflight = await rpc
  .simulateTransaction(wire, {
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (signedPreflight.value.err !== null) {
  throw new Error(
    "Signed Gate 2 delegation preflight failed: " +
      JSON.stringify(signedPreflight.value.err),
  );
}

console.log(
  JSON.stringify({
    preparedSignature: signature,
    signedPreflight: {
      err: null,
      unitsConsumed: signedPreflight.value.unitsConsumed?.toString() ?? null,
    },
  }),
);
const sendAndConfirm = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions,
});
await sendAndConfirm(signedTransaction, { commitment: "finalized" });
console.log(
  JSON.stringify({
    cluster: "devnet",
    delegatedAccounts: [
      plan.addresses.permission,
      plan.addresses.crankPermission,
      plan.addresses.deposit,
      plan.addresses.crankProbe,
    ],
    feePayer: AUTHORITY,
    finalizedSignature: signature,
    privateValidator: plan.addresses.privateValidator,
    usdcMoved: "0",
  }),
);
