import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  createClient,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressDecoder,
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
  buildDelegationPlan,
  DELEGATION_PROGRAM_ID,
  simulateDelegation,
} from "./gate1-simulate-delegation.ts";
import { AUTHORITY } from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const RPC_SUBSCRIPTIONS_URL = "wss://api.devnet.solana.com" as const;
const APPROVAL_FLAG = "--approved-delegation";
const EXPECTED_VAULT_AMOUNT = 1_000_000n;

if (!process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
}

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (!keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}

// Repeat the complete unsigned state validation and exact simulation immediately
// before loading a signer. Any changed owner, balance, or existing delegation PDA aborts.
await simulateDelegation();

const signerClient = await createClient().use(signerFromFile(keypairPath));
if (signerClient.payer.address !== AUTHORITY || signerClient.identity.address !== AUTHORITY) {
  throw new Error("Signer address does not match the approved fee payer and authority");
}

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_SUBSCRIPTIONS_URL);
const { addresses, depositDelegation, instructions, permissionDelegation } =
  await buildDelegationPlan(signerClient.identity);
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

const returnedAddresses = [
  addresses.permission,
  permissionDelegation.buffer,
  permissionDelegation.record,
  permissionDelegation.metadata,
  addresses.deposit,
  depositDelegation.buffer,
  depositDelegation.record,
  depositDelegation.metadata,
  addresses.vaultUsdcAta,
] as const;
const wire = getBase64EncodedWireTransaction(signedTransaction);
const signature = getSignatureFromTransaction(signedTransaction);
const signedPreflight = await rpc
  .simulateTransaction(wire, {
    accounts: { addresses: returnedAddresses, encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: false,
    replaceRecentBlockhash: false,
    sigVerify: true,
  })
  .send();
if (signedPreflight.value.err !== null) {
  throw new Error(`Signed preflight failed: ${JSON.stringify(signedPreflight.value.err)}`);
}
const postAccounts = signedPreflight.value.accounts;
if (!postAccounts || postAccounts.some((account) => account === null)) {
  throw new Error("Signed preflight did not return every requested post-state account");
}
const postPermission = postAccounts[0];
const postDeposit = postAccounts[4];
const postVaultAta = postAccounts[8];
if (!postPermission || !postDeposit || !postVaultAta) {
  throw new Error("Signed preflight returned an unexpected null account");
}
if (postPermission.owner !== DELEGATION_PROGRAM_ID || postDeposit.owner !== DELEGATION_PROGRAM_ID) {
  throw new Error("Signed preflight did not delegate both protected accounts");
}
const vaultData = Buffer.from(postVaultAta.data[0], "base64");
if (postVaultAta.data[1] !== "base64" || vaultData.length !== 165) {
  throw new Error("Signed preflight returned an invalid vault token account");
}
const vaultView = new DataView(vaultData.buffer, vaultData.byteOffset, vaultData.byteLength);
const vaultAmount = vaultView.getBigUint64(64, true);
const vaultAuthority = getAddressDecoder().decode(vaultData.slice(32, 64));
if (vaultAmount !== EXPECTED_VAULT_AMOUNT || vaultAuthority !== addresses.vault) {
  throw new Error("Signed preflight changed vault collateral or authority");
}

console.log(
  JSON.stringify({
    preparedSignature: signature,
    signedPreflight: {
      err: signedPreflight.value.err,
      unitsConsumed: signedPreflight.value.unitsConsumed?.toString() ?? null,
      permissionOwnerAfter: postPermission.owner,
      depositOwnerAfter: postDeposit.owner,
      vaultRawUsdcAfter: vaultAmount.toString(),
    },
  }),
);

const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
await sendAndConfirm(signedTransaction, { commitment: "finalized" });

console.log(
  JSON.stringify({
    cluster: "devnet",
    delegatedAccounts: [addresses.permission, addresses.deposit],
    feePayer: signerClient.payer.address,
    finalizedSignature: signature,
    privateValidator: addresses.privateValidator,
    usdcMoved: "0",
  }),
);
