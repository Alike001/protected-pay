import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { AppClient } from "../client";

const MAX_CONFIRMATION_POLLS = 60;

export type PreparedTransaction = {
  lastValidBlockHeight: bigint;
  signature: string;
};

export async function sendPublicTransaction(
  client: AppClient,
  transactionSigner: TransactionSigner,
  instructions: readonly Instruction[],
  onPrepared?: (prepared: PreparedTransaction) => void,
) {
  // Use a finalized Devnet blockhash so Phantom's separate simulation backend
  // has already observed it. A merely-confirmed blockhash can be valid on our
  // RPC while still appearing unknown to a lagging wallet simulation node.
  const { value: latestBlockhash } = await client.rpc.getLatestBlockhash({ commitment: "finalized" }).send();
  const message = pipe(
    // MagicBlock's browser starter uses legacy public transactions. Phantom
    // supports both formats, but legacy avoids a wallet-preview compatibility
    // edge here and this transaction does not need address lookup tables.
    createTransactionMessage({ version: "legacy" }),
    (current) => setTransactionMessageFeePayerSigner(transactionSigner, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );

  // Preflight against the app's configured Solana endpoint before opening the
  // wallet. The placeholder signature cannot be verified yet, so this first
  // simulation checks only the message and program execution.
  const unsignedWire = getBase64EncodedWireTransaction(compileTransaction(message));
  const unsignedSimulation = await client.rpc.simulateTransaction(unsignedWire, {
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: false,
  }).send();
  if (unsignedSimulation.value.err !== null) {
    throw new Error(`Solana transaction preflight failed before wallet approval: ${JSON.stringify(unsignedSimulation.value.err)}`);
  }

  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const wire = getBase64EncodedWireTransaction(signedTransaction);
  const preparedSignature = getSignatureFromTransaction(signedTransaction);

  const simulation = await client.rpc.simulateTransaction(wire, {
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  }).send();
  if (simulation.value.err !== null) {
    throw new Error(`Solana transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  onPrepared?.({ lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, signature: preparedSignature });
  const submittedSignature = await client.rpc.sendTransaction(wire, {
    encoding: "base64",
    maxRetries: 5n,
    preflightCommitment: "confirmed",
    skipPreflight: false,
  }).send();
  if (submittedSignature !== preparedSignature) throw new Error("Solana returned an unexpected transaction signature.");

  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const response = await client.rpc.getSignatureStatuses([preparedSignature], { searchTransactionHistory: true }).send();
    const status = response.value[0];
    if (status?.err) throw new Error(`Solana transaction failed after submission: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return preparedSignature;
    const blockHeight = await client.rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (blockHeight > latestBlockhash.lastValidBlockHeight) throw new Error("Solana transaction expired before confirmation.");
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error("Solana transaction confirmation timed out. Its signature has been saved for safe reconciliation.");
}
