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

import {
  assertExpectedAccounts,
  AUTHORITY,
  buildInstructions,
  deriveAddresses,
} from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const APPROVAL_FLAG = "--approved-funded-bootstrap";

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to send without ${APPROVAL_FLAG}`);
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.payer.address !== AUTHORITY || signerClient.identity.address !== AUTHORITY) {
  throw new Error("Signer address does not match the approved fee payer and authority");
}

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
const addresses = await deriveAddresses();
await assertExpectedAccounts(addresses);
const instructions = await buildInstructions(addresses, false, signerClient.identity);
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
const simulation = await rpc
  .simulateTransaction(wire, {
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: false,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(`Signed preflight failed: ${JSON.stringify(simulation.value.err)}`);
}

console.log(
  JSON.stringify({
    preparedSignature: signature,
    signedPreflight: {
      err: simulation.value.err,
      unitsConsumed: simulation.value.unitsConsumed?.toString() ?? null,
    },
  }),
);

const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
await sendAndConfirm(signedTransaction, { commitment: "finalized" });

console.log(
  JSON.stringify({
    cluster: "devnet",
    depositedRawUsdc: "1000000",
    feePayer: signerClient.payer.address,
    finalizedSignature: signature,
    vaultTokenAccount: addresses.vaultUsdcAta,
  }),
);
