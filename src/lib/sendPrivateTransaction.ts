import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
} from "@solana/kit";
import type { PrivateClient } from "../hooks/usePrivateBalance";

const MAX_CONFIRMATION_POLLS = 40;

export async function sendPrivateTransaction(privateClient: PrivateClient, instructions: readonly Instruction[]) {
  const { value: latestBlockhash } = await privateClient.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(privateClient.payer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const wire = getBase64EncodedWireTransaction(signedTransaction);
  const preparedSignature = getSignatureFromTransaction(signedTransaction);

  const simulation = await privateClient.rpc.simulateTransaction(wire, {
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  }).send();
  if (simulation.value.err !== null) {
    throw new Error(`Private transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const submittedSignature = await privateClient.rpc.sendTransaction(wire, {
    encoding: "base64",
    maxRetries: 5n,
    preflightCommitment: "confirmed",
    skipPreflight: false,
  }).send();
  if (submittedSignature !== preparedSignature) throw new Error("Private runtime returned an unexpected transaction signature.");

  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const response = await privateClient.rpc.getSignatureStatuses([preparedSignature], { searchTransactionHistory: true }).send();
    const status = response.value[0];
    if (status?.err) throw new Error(`Private transaction failed after submission: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return preparedSignature;
    const blockHeight = await privateClient.rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (blockHeight > latestBlockhash.lastValidBlockHeight) throw new Error("Private transaction expired before confirmation.");
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error("Private transaction confirmation timed out.");
}
