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
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";

const APPROVAL_FLAG = "--approved-p5-phantom-funding-simulations";
const BROADCAST_FLAG = "--approved-p5-phantom-funding-broadcast";
const SEND_REQUESTED = process.argv.includes("--send");
const RPC_URL = "https://api.devnet.solana.com" as const;
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const SOURCE = address("6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn");
const RECIPIENT = address("4C2GznkXgEp2EhcXkPyBQh9feYvAkCcN2bWDrGjbkwvR");
const USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const SOURCE_USDC = address("5a1yoHwrpcLiTEo4MdDcqZ82C7AemH4p1A3jBh6bvDQU");
const EXPECTED_RECIPIENT_USDC = address("GhVfyTgi5GnNrSUCVY4PPWkLGC52J1cS8vSN3tDd9Eqb");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SOL_AMOUNT = 2_000_000_000n;
const USDC_AMOUNT = 5_000_000n;

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign simulations without ${APPROVAL_FLAG}`);
}
if (SEND_REQUESTED && !process.argv.includes(BROADCAST_FLAG)) {
  throw new Error(`Refusing to broadcast without ${BROADCAST_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) throw new Error("SOLANA_KEYPAIR_PATH must name the approved local Devnet signer");

function accountBytes(data: readonly [string, string]) {
  if (data[1] !== "base64") throw new Error("Unexpected account encoding");
  return Buffer.from(data[0], "base64");
}

function decodeTokenAccount(data: Uint8Array) {
  if (data.length !== 165) throw new Error(`Expected a 165-byte SPL token account, received ${data.length}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    amount: view.getBigUint64(64, true),
    mint: getAddressDecoder().decode(data.slice(0, 32)),
    owner: getAddressDecoder().decode(data.slice(32, 64)),
  };
}

function json(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2);
}

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.payer.address !== SOURCE || signerClient.identity.address !== SOURCE) {
  throw new Error("The local signer does not match the approved Devnet funding source");
}

const [recipientUsdc] = await getProgramDerivedAddress({
  programAddress: ASSOCIATED_TOKEN_PROGRAM,
  seeds: [
    getAddressEncoder().encode(RECIPIENT),
    getAddressEncoder().encode(TOKEN_PROGRAM),
    getAddressEncoder().encode(USDC_MINT),
  ],
});
if (recipientUsdc !== EXPECTED_RECIPIENT_USDC) throw new Error("Recipient USDC ATA derivation mismatch");

const before = await rpc.getMultipleAccounts(
  [SOURCE, RECIPIENT, USDC_MINT, SOURCE_USDC, recipientUsdc],
  { commitment: "finalized", encoding: "base64" },
).send();
const [sourceAccount, recipientAccount, mintAccount, sourceTokenAccount, recipientTokenAccount] = before.value;
if (!sourceAccount || sourceAccount.owner !== SYSTEM_PROGRAM || sourceAccount.lamports < SOL_AMOUNT) {
  throw new Error("Funding source SOL account failed owner or balance validation");
}
if (recipientAccount !== null || recipientTokenAccount !== null) {
  throw new Error("Recipient state changed: expected an unfunded wallet with no USDC token account");
}
if (!mintAccount || mintAccount.owner !== TOKEN_PROGRAM) throw new Error("Circle Devnet USDC mint failed owner validation");
if (!sourceTokenAccount || sourceTokenAccount.owner !== TOKEN_PROGRAM) throw new Error("Source USDC account failed owner validation");
const sourceTokenBefore = decodeTokenAccount(accountBytes(sourceTokenAccount.data));
if (sourceTokenBefore.mint !== USDC_MINT || sourceTokenBefore.owner !== SOURCE || sourceTokenBefore.amount < USDC_AMOUNT) {
  throw new Error("Source USDC account failed mint, authority, or balance validation");
}

const solTransferData = new Uint8Array(12);
const solTransferView = new DataView(solTransferData.buffer);
solTransferView.setUint32(0, 2, true);
solTransferView.setBigUint64(4, SOL_AMOUNT, true);
const solTransfer = addSignersToInstruction([signerClient.payer], {
  programAddress: SYSTEM_PROGRAM,
  accounts: [
    { address: SOURCE, role: AccountRole.WRITABLE_SIGNER },
    { address: RECIPIENT, role: AccountRole.WRITABLE },
  ],
  data: solTransferData,
} satisfies Instruction);

const createRecipientAta = addSignersToInstruction([signerClient.payer], {
  programAddress: ASSOCIATED_TOKEN_PROGRAM,
  accounts: [
    { address: SOURCE, role: AccountRole.WRITABLE_SIGNER },
    { address: recipientUsdc, role: AccountRole.WRITABLE },
    { address: RECIPIENT, role: AccountRole.READONLY },
    { address: USDC_MINT, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
  ],
  data: new Uint8Array([1]),
} satisfies Instruction);

const tokenTransferData = new Uint8Array(10);
const tokenTransferView = new DataView(tokenTransferData.buffer);
tokenTransferData[0] = 12;
tokenTransferView.setBigUint64(1, USDC_AMOUNT, true);
tokenTransferData[9] = 6;
const tokenTransfer = addSignersToInstruction([signerClient.identity], {
  programAddress: TOKEN_PROGRAM,
  accounts: [
    { address: SOURCE_USDC, role: AccountRole.WRITABLE },
    { address: USDC_MINT, role: AccountRole.READONLY },
    { address: recipientUsdc, role: AccountRole.WRITABLE },
    { address: SOURCE, role: AccountRole.READONLY_SIGNER },
  ],
  data: tokenTransferData,
} satisfies Instruction);

async function signAndSimulate(label: string, instructions: readonly Instruction[], accounts: readonly Address[]) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signerClient.payer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(transaction);
  assertIsTransactionWithinSizeLimit(transaction);
  const signature = getSignatureFromTransaction(transaction);
  const simulation = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
    accounts: { addresses: [...accounts], encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: false,
    sigVerify: true,
  }).send();
  if (simulation.value.err !== null) {
    throw new Error(`${label} signed simulation failed: ${json({ err: simulation.value.err, logs: simulation.value.logs })}`);
  }
  const signatureStatus = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
  if (signatureStatus !== null) throw new Error(`${label} signature unexpectedly exists onchain`);
  return { signature, simulation, transaction } as const;
}

const solSimulation = await signAndSimulate("SOL transfer", [solTransfer], [SOURCE, RECIPIENT]);
const [simulatedSolSource, simulatedSolRecipient] = solSimulation.simulation.value.accounts ?? [];
if (!simulatedSolSource || !simulatedSolRecipient || simulatedSolRecipient.lamports !== SOL_AMOUNT) {
  throw new Error("SOL simulation did not produce the expected 2 SOL recipient balance");
}

if (SEND_REQUESTED) {
  await sendAndConfirm(solSimulation.transaction, { commitment: "finalized" });
  const fundedRecipient = await rpc.getBalance(RECIPIENT, { commitment: "finalized" }).send();
  if (fundedRecipient.value !== SOL_AMOUNT) throw new Error("Finalized recipient SOL balance is not exactly 2 SOL");
}

const usdcSimulation = await signAndSimulate(
  "USDC transfer",
  [createRecipientAta, tokenTransfer],
  [SOURCE_USDC, recipientUsdc, SOURCE],
);
const [simulatedSourceToken, simulatedRecipientToken] = usdcSimulation.simulation.value.accounts ?? [];
if (!simulatedSourceToken || !simulatedRecipientToken) throw new Error("USDC simulation omitted requested post-state accounts");
const sourceTokenAfter = decodeTokenAccount(accountBytes(simulatedSourceToken.data));
const recipientTokenAfter = decodeTokenAccount(accountBytes(simulatedRecipientToken.data));
if (
  sourceTokenAfter.amount !== sourceTokenBefore.amount - USDC_AMOUNT
  || recipientTokenAfter.amount !== USDC_AMOUNT
  || recipientTokenAfter.mint !== USDC_MINT
  || recipientTokenAfter.owner !== RECIPIENT
) throw new Error("USDC simulation post-state failed amount, mint, or owner validation");

if (SEND_REQUESTED) {
  await sendAndConfirm(usdcSimulation.transaction, { commitment: "finalized" });
  const finalized = await rpc.getMultipleAccounts(
    [RECIPIENT, SOURCE_USDC, recipientUsdc],
    { commitment: "finalized", encoding: "base64" },
  ).send();
  const [finalRecipient, finalSourceToken, finalRecipientToken] = finalized.value;
  if (!finalRecipient || finalRecipient.lamports !== SOL_AMOUNT || !finalSourceToken || !finalRecipientToken) {
    throw new Error("Finalized funding accounts are incomplete or the SOL balance is incorrect");
  }
  const finalSourceTokenState = decodeTokenAccount(accountBytes(finalSourceToken.data));
  const finalRecipientTokenState = decodeTokenAccount(accountBytes(finalRecipientToken.data));
  if (
    finalSourceTokenState.amount !== sourceTokenBefore.amount - USDC_AMOUNT
    || finalRecipientTokenState.amount !== USDC_AMOUNT
    || finalRecipientTokenState.mint !== USDC_MINT
    || finalRecipientTokenState.owner !== RECIPIENT
  ) throw new Error("Finalized USDC balances failed amount, mint, or owner validation");
} else {
  const unchanged = await rpc.getMultipleAccounts(
    [SOURCE, RECIPIENT, SOURCE_USDC, recipientUsdc],
    { commitment: "finalized", encoding: "base64" },
  ).send();
  const [sourceAfterSimulation, recipientAfterSimulation, sourceTokenAfterSimulation, recipientTokenAfterSimulation] = unchanged.value;
  if (
    !sourceAfterSimulation
    || sourceAfterSimulation.lamports !== sourceAccount.lamports
    || recipientAfterSimulation !== null
    || !sourceTokenAfterSimulation
    || decodeTokenAccount(accountBytes(sourceTokenAfterSimulation.data)).amount !== sourceTokenBefore.amount
    || recipientTokenAfterSimulation !== null
  ) throw new Error("Onchain balances changed even though broadcast was not authorized");
}

console.log(json({
  approvalScope: SEND_REQUESTED ? "fresh simulations and approved broadcasts" : "signed simulations only",
  broadcast: SEND_REQUESTED,
  cluster: "Solana Devnet",
  feePayerAndSource: SOURCE,
  recipient: RECIPIENT,
  sol: {
    amountLamports: SOL_AMOUNT,
    preparedSignature: solSimulation.signature,
    unitsConsumed: solSimulation.simulation.value.unitsConsumed ?? null,
  },
  usdc: {
    amountRaw: USDC_AMOUNT,
    mint: USDC_MINT,
    recipientTokenAccount: recipientUsdc,
    preparedSignature: usdcSimulation.signature,
    sourceBalanceBefore: sourceTokenBefore.amount,
    simulatedSourceBalanceAfter: sourceTokenAfter.amount,
    simulatedRecipientBalanceAfter: recipientTokenAfter.amount,
    unitsConsumed: usdcSimulation.simulation.value.unitsConsumed ?? null,
  },
  finalizedStateUnchanged: !SEND_REQUESTED,
  finalizedFundingVerified: SEND_REQUESTED,
}));
