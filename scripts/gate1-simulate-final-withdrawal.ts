import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createClient,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import { getConfigDecoder } from "../clients/ts/src/generated/accounts/config.ts";
import { getDepositDecoder } from "../clients/ts/src/generated/accounts/deposit.ts";
import { getVaultDecoder } from "../clients/ts/src/generated/accounts/vault.ts";
import { getWithdrawUsdcInstructionAsync } from "../clients/ts/src/generated/instructions/withdrawUsdc.ts";
import { TOKEN_PROGRAM_ID } from "./gate1-simulate-delegation.ts";
import { AUTHORITY, deriveAddresses, PROGRAM_ID, USDC_MINT } from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
const WITHDRAW_AMOUNT = 1_000_000n;
const WALLET_BEFORE = 19_000_000n;
const SEND_REQUESTED = process.argv.includes("--send");
const APPROVAL_FLAG = "--approved-final-withdrawal";
const MAX_CONFIRMATION_POLLS = 120;

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") throw new Error(`Unexpected account encoding: ${data[1]}`);
  return Buffer.from(data[0], "base64");
}

function decodeTokenAccount(data: Uint8Array): { mint: Address; owner: Address; amount: bigint } {
  if (data.length !== 165) throw new Error(`Expected a 165-byte token account, received ${data.length}`);
  const decoder = getAddressDecoder();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: decoder.decode(data.slice(0, 32)),
    owner: decoder.decode(data.slice(32, 64)),
    amount: view.getBigUint64(64, true),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item, 2);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (SEND_REQUESTED && !process.argv.includes(APPROVAL_FLAG)) {
  throw new Error(`Refusing to sign or send without ${APPROVAL_FLAG}`);
}
const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
if (SEND_REQUESTED && !keypairPath) {
  throw new Error("SOLANA_KEYPAIR_PATH must name the already-approved CLI signer file");
}
const signerClient = SEND_REQUESTED
  ? await createClient().use(signerFromFile(keypairPath!))
  : undefined;
if (
  signerClient &&
  (signerClient.payer.address !== AUTHORITY || signerClient.identity.address !== AUTHORITY)
) {
  throw new Error("Signer address does not match the approved fee payer and withdrawal authority");
}

const rpc = createSolanaRpc(RPC_URL);
const addresses = await deriveAddresses();
const beforeResponse = await rpc
  .getMultipleAccounts(
    [
      addresses.config,
      addresses.vault,
      addresses.deposit,
      addresses.walletUsdcAta,
      addresses.vaultUsdcAta,
    ],
    { commitment: "finalized", encoding: "base64" },
  )
  .send();
const [configAccount, vaultAccount, depositAccount, walletAtaAccount, vaultAtaAccount] =
  beforeResponse.value;
if (!configAccount || !vaultAccount || !depositAccount || !walletAtaAccount || !vaultAtaAccount) {
  throw new Error("A required finalized withdrawal account is missing");
}
if (
  configAccount.owner !== PROGRAM_ID || accountBytes(configAccount.data).length !== 154 ||
  vaultAccount.owner !== PROGRAM_ID || accountBytes(vaultAccount.data).length !== 49 ||
  depositAccount.owner !== PROGRAM_ID || accountBytes(depositAccount.data).length !== 98 ||
  walletAtaAccount.owner !== TOKEN_PROGRAM_ID ||
  vaultAtaAccount.owner !== TOKEN_PROGRAM_ID
) {
  throw new Error("A withdrawal account failed owner or length validation");
}
const config = getConfigDecoder().decode(accountBytes(configAccount.data));
const vault = getVaultDecoder().decode(accountBytes(vaultAccount.data));
const deposit = getDepositDecoder().decode(accountBytes(depositAccount.data));
const walletTokenBefore = decodeTokenAccount(accountBytes(walletAtaAccount.data));
const vaultTokenBefore = decodeTokenAccount(accountBytes(vaultAtaAccount.data));
if (
  config.allowedMint !== USDC_MINT || config.tokenProgram !== TOKEN_PROGRAM_ID ||
  vault.tokenMint !== USDC_MINT || vault.totalLiability !== WITHDRAW_AMOUNT ||
  deposit.user !== AUTHORITY || deposit.tokenMint !== USDC_MINT ||
  deposit.available !== WITHDRAW_AMOUNT || deposit.locked !== 0n ||
  walletTokenBefore.owner !== AUTHORITY || walletTokenBefore.mint !== USDC_MINT ||
  walletTokenBefore.amount !== WALLET_BEFORE ||
  vaultTokenBefore.owner !== addresses.vault || vaultTokenBefore.mint !== USDC_MINT ||
  vaultTokenBefore.amount !== WITHDRAW_AMOUNT
) {
  throw new Error("Finalized withdrawal pre-state differs from the approved round-trip checkpoint");
}

const transactionSigner = signerClient?.identity ?? createNoopSigner(AUTHORITY);
const withdrawInstruction = await getWithdrawUsdcInstructionAsync({
  user: transactionSigner,
  config: addresses.config,
  vault: addresses.vault,
  deposit: addresses.deposit,
  userTokenAccount: addresses.walletUsdcAta,
  vaultTokenAccount: addresses.vaultUsdcAta,
  tokenMint: USDC_MINT,
  tokenProgram: TOKEN_PROGRAM_ID,
  amount: WITHDRAW_AMOUNT,
});
const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayerSigner(transactionSigner, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions([
    getSetComputeUnitLimitInstruction({ units: 200_000 }),
    withdrawInstruction,
  ], current),
);
const transaction = compileTransaction(message);
const wire = getBase64EncodedWireTransaction(transaction);
const simulation = await rpc
  .simulateTransaction(wire, {
    accounts: {
      addresses: [
        addresses.walletUsdcAta,
        addresses.vaultUsdcAta,
        addresses.vault,
        addresses.deposit,
      ],
      encoding: "base64",
    },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: true,
    sigVerify: false,
  })
  .send();
if (simulation.value.err !== null) {
  throw new Error(`Final withdrawal simulation failed: ${json(simulation.value.err)}`);
}
const postAccounts = simulation.value.accounts;
if (!postAccounts || postAccounts.some((account) => account === null)) {
  throw new Error("Simulation did not return every requested withdrawal post-state account");
}
const [walletAfterAccount, vaultAtaAfterAccount, vaultAfterAccount, depositAfterAccount] = postAccounts;
if (!walletAfterAccount || !vaultAtaAfterAccount || !vaultAfterAccount || !depositAfterAccount) {
  throw new Error("Simulation returned a null withdrawal post-state account");
}
const walletAfter = decodeTokenAccount(accountBytes(walletAfterAccount.data));
const vaultTokenAfter = decodeTokenAccount(accountBytes(vaultAtaAfterAccount.data));
const vaultAfter = getVaultDecoder().decode(accountBytes(vaultAfterAccount.data));
const depositAfter = getDepositDecoder().decode(accountBytes(depositAfterAccount.data));
if (
  walletAfter.amount !== WALLET_BEFORE + WITHDRAW_AMOUNT ||
  vaultTokenAfter.amount !== 0n || vaultAfter.totalLiability !== 0n ||
  depositAfter.available !== 0n || depositAfter.locked !== 0n
) {
  throw new Error("Simulation returned an unexpected final withdrawal state");
}

console.log(json({
  validatedPreState: {
    finalizedReadSlot: beforeResponse.context.slot,
    walletRawUsdc: walletTokenBefore.amount,
    vaultRawUsdc: vaultTokenBefore.amount,
    vaultLiability: vault.totalLiability,
    depositAvailable: deposit.available,
    depositLocked: deposit.locked,
  },
  proposedTransaction: {
    cluster: "Solana Devnet",
    feePayer: AUTHORITY,
    signer: AUTHORITY,
    instruction: "withdraw_usdc",
    recipientTokenAccount: addresses.walletUsdcAta,
    amount: "1.000000 USDC",
    tokenMint: USDC_MINT,
    signed: SEND_REQUESTED,
    sent: false,
  },
  simulation: {
    slot: simulation.context.slot,
    err: simulation.value.err,
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    feeLamports: simulation.value.fee ?? null,
    walletRawUsdcAfter: walletAfter.amount,
    vaultRawUsdcAfter: vaultTokenAfter.amount,
    vaultLiabilityAfter: vaultAfter.totalLiability,
    depositAvailableAfter: depositAfter.available,
    depositLockedAfter: depositAfter.locked,
    logs: simulation.value.logs,
  },
}));

if (SEND_REQUESTED && signerClient) {
  const signedTransaction = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  const signedWire = getBase64EncodedWireTransaction(signedTransaction);
  const expectedSignature = getSignatureFromTransaction(signedTransaction);
  const signedPreflight = await rpc
    .simulateTransaction(signedWire, {
      accounts: {
        addresses: [
          addresses.walletUsdcAta,
          addresses.vaultUsdcAta,
          addresses.vault,
          addresses.deposit,
        ],
        encoding: "base64",
      },
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: false,
      sigVerify: true,
    })
    .send();
  if (signedPreflight.value.err !== null) {
    throw new Error(`Signed withdrawal preflight failed: ${json(signedPreflight.value.err)}`);
  }
  const signedPostAccounts = signedPreflight.value.accounts;
  if (!signedPostAccounts || signedPostAccounts.some((account) => account === null)) {
    throw new Error("Signed preflight did not return every requested post-state account");
  }
  const [signedWalletAccount, signedVaultAtaAccount, signedVaultAccount, signedDepositAccount] =
    signedPostAccounts;
  if (!signedWalletAccount || !signedVaultAtaAccount || !signedVaultAccount || !signedDepositAccount) {
    throw new Error("Signed preflight returned a null post-state account");
  }
  const signedWallet = decodeTokenAccount(accountBytes(signedWalletAccount.data));
  const signedVaultToken = decodeTokenAccount(accountBytes(signedVaultAtaAccount.data));
  const signedVault = getVaultDecoder().decode(accountBytes(signedVaultAccount.data));
  const signedDeposit = getDepositDecoder().decode(accountBytes(signedDepositAccount.data));
  if (
    signedWallet.amount !== 20_000_000n || signedVaultToken.amount !== 0n ||
    signedVault.totalLiability !== 0n || signedDeposit.available !== 0n ||
    signedDeposit.locked !== 0n
  ) {
    throw new Error("Signed withdrawal preflight returned an unexpected final state");
  }

  console.log(json({
    preparedSignature: expectedSignature,
    signedPreflight: {
      err: signedPreflight.value.err,
      unitsConsumed: signedPreflight.value.unitsConsumed ?? null,
      feeLamports: signedPreflight.value.fee ?? null,
      walletRawUsdcAfter: signedWallet.amount,
      vaultRawUsdcAfter: signedVaultToken.amount,
      vaultLiabilityAfter: signedVault.totalLiability,
      depositAvailableAfter: signedDeposit.available,
      depositLockedAfter: signedDeposit.locked,
    },
  }));

  const submittedSignature = await rpc
    .sendTransaction(signedWire, {
      encoding: "base64",
      maxRetries: 5n,
      preflightCommitment: "confirmed",
      skipPreflight: false,
    })
    .send();
  if (submittedSignature !== expectedSignature) {
    throw new Error("Devnet returned a signature different from the signed withdrawal");
  }

  let finalizedSlot: bigint | undefined;
  for (let poll = 0; poll < MAX_CONFIRMATION_POLLS; poll += 1) {
    const statusResponse = await rpc
      .getSignatureStatuses([expectedSignature], { searchTransactionHistory: true })
      .send();
    const status = statusResponse.value[0];
    if (status?.err) throw new Error(`Withdrawal failed after submission: ${json(status.err)}`);
    if (status?.confirmationStatus === "finalized") {
      finalizedSlot = status.slot;
      break;
    }
    const blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (blockHeight > latestBlockhash.lastValidBlockHeight) {
      throw new Error("Withdrawal expired before confirmation");
    }
    await wait(500);
  }
  if (finalizedSlot === undefined) throw new Error("Withdrawal confirmation timed out");

  const finalizedState = await rpc
    .getMultipleAccounts(
      [addresses.walletUsdcAta, addresses.vaultUsdcAta, addresses.vault, addresses.deposit],
      { commitment: "finalized", encoding: "base64" },
    )
    .send();
  const [finalWalletAccount, finalVaultAtaAccount, finalVaultAccount, finalDepositAccount] =
    finalizedState.value;
  if (!finalWalletAccount || !finalVaultAtaAccount || !finalVaultAccount || !finalDepositAccount) {
    throw new Error("A finalized withdrawal account is missing");
  }
  const finalWallet = decodeTokenAccount(accountBytes(finalWalletAccount.data));
  const finalVaultToken = decodeTokenAccount(accountBytes(finalVaultAtaAccount.data));
  const finalVault = getVaultDecoder().decode(accountBytes(finalVaultAccount.data));
  const finalDeposit = getDepositDecoder().decode(accountBytes(finalDepositAccount.data));
  if (
    finalWallet.amount !== 20_000_000n || finalVaultToken.amount !== 0n ||
    finalVault.totalLiability !== 0n || finalDeposit.available !== 0n ||
    finalDeposit.locked !== 0n
  ) {
    throw new Error("Finalized withdrawal state failed conservation checks");
  }

  const transactionResponse = await rpc
    .getTransaction(expectedSignature, {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  if (!transactionResponse || !transactionResponse.meta || transactionResponse.meta.err) {
    throw new Error("Finalized withdrawal transaction could not be validated");
  }

  // Prove the same withdrawal cannot be performed again. This is unsigned simulation only.
  const repeatSigner = createNoopSigner(AUTHORITY);
  const repeatInstruction = await getWithdrawUsdcInstructionAsync({
    user: repeatSigner,
    config: addresses.config,
    vault: addresses.vault,
    deposit: addresses.deposit,
    userTokenAccount: addresses.walletUsdcAta,
    vaultTokenAccount: addresses.vaultUsdcAta,
    tokenMint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM_ID,
    amount: WITHDRAW_AMOUNT,
  });
  const { value: repeatBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const repeatMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(repeatSigner, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(repeatBlockhash, current),
    (current) => appendTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 200_000 }),
      repeatInstruction,
    ], current),
  );
  const repeatWire = getBase64EncodedWireTransaction(compileTransaction(repeatMessage));
  const repeatSimulation = await rpc
    .simulateTransaction(repeatWire, {
      commitment: "confirmed",
      encoding: "base64",
      innerInstructions: true,
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  const repeatLogs = repeatSimulation.value.logs ?? [];
  if (
    repeatSimulation.value.err === null ||
    !repeatLogs.some((line) => line.includes("Error Code: InsufficientAvailable")) ||
    !repeatLogs.some((line) => line.includes("Error Number: 6003"))
  ) {
    throw new Error(`Repeat-withdrawal rejection was not the expected error: ${json({
      err: repeatSimulation.value.err,
      logs: repeatLogs,
    })}`);
  }

  console.log(json({
    cluster: "Solana Devnet",
    signature: expectedSignature,
    finalizedSlot,
    blockTime: transactionResponse.blockTime,
    feeLamports: transactionResponse.meta.fee,
    computeUnitsConsumed: transactionResponse.meta.computeUnitsConsumed ?? null,
    finalStateReadSlot: finalizedState.context.slot,
    walletRawUsdc: finalWallet.amount,
    vaultRawUsdc: finalVaultToken.amount,
    vaultLiability: finalVault.totalLiability,
    depositAvailable: finalDeposit.available,
    depositLocked: finalDeposit.locked,
    repeatWithdrawalSimulation: {
      attemptedRawUsdc: WITHDRAW_AMOUNT,
      rejected: true,
      errorCode: "InsufficientAvailable",
      errorNumber: 6003,
      err: repeatSimulation.value.err,
    },
  }));
}
