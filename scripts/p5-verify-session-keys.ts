import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { SOLANA_DEVNET_RPC } from "../src/lib/constants.ts";
import { buildCreateSessionInstruction, findSessionToken } from "../src/lib/sessionKeys.ts";

const AUTHORITY = address("4C2GznkXgEp2EhcXkPyBQh9feYvAkCcN2bWDrGjbkwvR");
const authority = createNoopSigner(AUTHORITY);
const sessionSigner = await generateKeyPairSigner();
const sessionToken = await findSessionToken(AUTHORITY, sessionSigner.address);
const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
const rpc = createSolanaRpc(SOLANA_DEVNET_RPC);
const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send();
const instruction = buildCreateSessionInstruction(authority, sessionSigner, sessionToken, expiresAt);
const message = pipe(
  createTransactionMessage({ version: "legacy" }),
  (current) => setTransactionMessageFeePayer(AUTHORITY, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(blockhash, current),
  (current) => appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: 100_000 }),
    instruction,
  ], current),
);
const wire = getBase64EncodedWireTransaction(compileTransaction(message));
const simulation = await rpc.simulateTransaction(wire, {
  commitment: "confirmed",
  encoding: "base64",
  innerInstructions: true,
  replaceRecentBlockhash: false,
  sigVerify: false,
}).send();
if (simulation.value.err !== null) {
  throw new Error(`Session Keys Devnet simulation failed: ${JSON.stringify(simulation.value.err)}\n${simulation.value.logs?.join("\n")}`);
}

console.log(JSON.stringify({
  authority: AUTHORITY,
  broadcast: false,
  sessionSigner: sessionSigner.address,
  sessionToken,
  signed: false,
  unitsConsumed: simulation.value.unitsConsumed?.toString(),
}, null, 2));
