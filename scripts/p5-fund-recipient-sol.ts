import {
  AccountRole,
  addSignersToInstruction,
  address,
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
  type Instruction,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";

const SIMULATION_APPROVAL = "--approved-p5-recipient-sol-signed-simulation";
const BROADCAST_APPROVAL = "--approved-p5-recipient-sol-broadcast";
const SEND_REQUESTED = process.argv.includes("--send");
const RPC_URL = "https://api.devnet.solana.com" as const;
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const SOURCE = address("6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn");
const RECIPIENT = address("8e1fCvNq9xWqSJVq93rXsgVMdYdamaHRciKNDyZpSg8o");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const AMOUNT = 100_000_000n;

if (!process.argv.includes(SIMULATION_APPROVAL)) {
  throw new Error(`Refusing to sign without ${SIMULATION_APPROVAL}`);
}
if (SEND_REQUESTED && !process.argv.includes(BROADCAST_APPROVAL)) {
  throw new Error(`Refusing to broadcast without ${BROADCAST_APPROVAL}`);
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) throw new Error("SOLANA_KEYPAIR_PATH must name the approved local Devnet signer");

const rpc = createSolanaRpc(RPC_URL);
const subscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.payer.address !== SOURCE || signerClient.identity.address !== SOURCE) {
  throw new Error("The local signer does not match the approved Devnet funding source");
}

const before = await rpc.getMultipleAccounts([SOURCE, RECIPIENT], { commitment: "finalized", encoding: "base64" }).send();
const [sourceAccount, recipientAccount] = before.value;
if (!sourceAccount || sourceAccount.owner !== SYSTEM_PROGRAM || sourceAccount.lamports <= AMOUNT) {
  throw new Error("Funding source failed its finalized owner or balance check");
}
const recipientBefore = recipientAccount?.lamports ?? 0n;
if (!SEND_REQUESTED && recipientBefore !== 0n) {
  throw new Error("Simulation expected the recipient to remain unfunded");
}

const transferData = new Uint8Array(12);
const transferView = new DataView(transferData.buffer);
transferView.setUint32(0, 2, true);
transferView.setBigUint64(4, AMOUNT, true);
const transfer = addSignersToInstruction([signerClient.payer], {
  programAddress: SYSTEM_PROGRAM,
  accounts: [
    { address: SOURCE, role: AccountRole.WRITABLE_SIGNER },
    { address: RECIPIENT, role: AccountRole.WRITABLE },
  ],
  data: transferData,
} satisfies Instruction);

const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send();
const message = pipe(
  createTransactionMessage({ version: "legacy" }),
  (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions([transfer], current),
);
const transaction = await signTransactionMessageWithSigners(message);
assertIsTransactionWithBlockhashLifetime(transaction);
assertIsTransactionWithinSizeLimit(transaction);
const signature = getSignatureFromTransaction(transaction);
const simulation = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
  accounts: { addresses: [SOURCE, RECIPIENT], encoding: "base64" },
  commitment: "confirmed",
  encoding: "base64",
  innerInstructions: true,
  replaceRecentBlockhash: false,
  sigVerify: true,
}).send();
if (simulation.value.err !== null) {
  throw new Error(`Signed SOL simulation failed: ${JSON.stringify(simulation.value.err)}`);
}
const [, simulatedRecipient] = simulation.value.accounts ?? [];
if (!simulatedRecipient || simulatedRecipient.lamports !== recipientBefore + AMOUNT) {
  throw new Error("Simulation did not credit the recipient exactly 0.1 SOL");
}

if (SEND_REQUESTED) {
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subscriptions });
  await sendAndConfirm(transaction, { commitment: "finalized" });
} else {
  const signatureStatus = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
  if (signatureStatus !== null) throw new Error("Simulation signature unexpectedly exists on Devnet");
}

const after = await rpc.getMultipleAccounts([SOURCE, RECIPIENT], { commitment: "finalized", encoding: "base64" }).send();
const [sourceAfter, recipientAfter] = after.value;
if (!sourceAfter) throw new Error("Funding source disappeared after verification");
const finalizedRecipient = recipientAfter?.lamports ?? 0n;
if (SEND_REQUESTED && finalizedRecipient !== recipientBefore + AMOUNT) {
  throw new Error("Finalized recipient balance did not increase by exactly 0.1 SOL");
}
if (!SEND_REQUESTED && (sourceAfter.lamports !== sourceAccount.lamports || finalizedRecipient !== recipientBefore)) {
  throw new Error("Devnet state changed during simulation-only verification");
}

console.log(JSON.stringify({
  amountLamports: AMOUNT.toString(),
  broadcast: SEND_REQUESTED,
  recipient: RECIPIENT,
  recipientFinalLamports: finalizedRecipient.toString(),
  recipientSimulatedLamports: simulatedRecipient.lamports.toString(),
  signature,
  signed: true,
  source: SOURCE,
  sourceFinalLamports: sourceAfter.lamports.toString(),
  unitsConsumed: simulation.value.unitsConsumed?.toString() ?? null,
}, null, 2));
