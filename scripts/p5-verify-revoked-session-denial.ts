import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getCancelPaymentInstruction } from "../clients/ts/src/generated/instructions/cancelPayment.ts";
import { findDepositPda } from "../clients/ts/src/generated/pdas/deposit.ts";
import { PRIVATE_ER_ORIGIN, SOLANA_DEVNET_RPC, USDC_MINT } from "../src/lib/constants.ts";

const authority = address("4C2GznkXgEp2EhcXkPyBQh9feYvAkCcN2bWDrGjbkwvR");
const revokedSigner = createNoopSigner(address("2vVLDTgYrRjYza4JdLNoppaE2JGbUkPnHnLkAfCHHkiF"));
const revokedToken = address("HNQLk2tsx9FN8cAYJjecvt1zSBfFvBgjskBnW4bBrfsX");
const payment = address("2psoEtLrWyuwgJeAX1s4L9ATwv27Kz1YzvXRBtbn66n5");
const [senderDeposit] = await findDepositPda({ user: authority, tokenMint: address(USDC_MINT) });
const rpc = createSolanaRpc(PRIVATE_ER_ORIGIN);
const publicRpc = createSolanaRpc(SOLANA_DEVNET_RPC);
const revokedTokenAccount = await publicRpc.getAccountInfo(revokedToken, { commitment: "finalized" }).send();
if (revokedTokenAccount.value) throw new Error("Revoked Session Token still exists on Solana Devnet");
const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayer(revokedSigner.address, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(blockhash, current),
  (current) => appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: 250_000 }),
    getCancelPaymentInstruction({
      sender: authority,
      payer: revokedSigner,
      sessionToken: revokedToken,
      payment,
      senderDeposit,
    }),
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

const error = JSON.stringify(simulation.value.err, (_key, value) => typeof value === "bigint" ? value.toString() : value);
if (!error.includes('"Custom":"3012"')) {
  throw new Error(`Revoked Session Token did not fail with Anchor AccountNotInitialized (3012): ${error}`);
}

console.log(JSON.stringify({
  anchorError: "AccountNotInitialized",
  authority,
  broadcast: false,
  payment,
  revokedTokenExists: false,
  revokedSigner: revokedSigner.address,
  revokedToken,
  signed: false,
  simulationErrorCode: 3012,
}, null, 2));
