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
  buildGate2Bootstrap,
  simulateGate2Bootstrap,
} from "./gate2-simulate-bootstrap.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const APPROVAL_FLAG = "--approved-gate2-bootstrap";

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved signer file");
}

// Repeat all unsigned owner, length, discriminator, balance, and simulation
// checks before the signer is loaded.
await simulateGate2Bootstrap();

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.identity.address !== AUTHORITY || signerClient.payer.address !== AUTHORITY) {
  throw new Error("Signer does not match the approved Gate 2 authority and fee payer");
}
const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
const { addresses, instructions } = await buildGate2Bootstrap(signerClient.identity);
const { value: latestBlockhash } = await rpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions(instructions, current),
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
  throw new Error(`Signed Gate 2 bootstrap preflight failed: ${JSON.stringify(signedPreflight.value.err)}`);
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
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
await sendAndConfirm(signedTransaction, { commitment: "finalized" });
console.log(
  JSON.stringify({
    cluster: "devnet",
    crankPermission: addresses.crankPermission,
    crankProbe: addresses.crankProbe,
    feePayer: AUTHORITY,
    finalizedSignature: signature,
    usdcMoved: "0",
  }),
);
