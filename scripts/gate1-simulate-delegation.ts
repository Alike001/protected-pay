import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import {
  CONFIG_DISCRIMINATOR,
  getConfigDecoder,
} from "../clients/ts/src/generated/accounts/config.ts";
import {
  DEPOSIT_DISCRIMINATOR,
  getDepositDecoder,
} from "../clients/ts/src/generated/accounts/deposit.ts";
import { getDelegateDepositInstructionAsync } from "../clients/ts/src/generated/instructions/delegateDeposit.ts";
import { getDelegateDepositPermissionInstructionAsync } from "../clients/ts/src/generated/instructions/delegateDepositPermission.ts";
import {
  AUTHORITY,
  deriveAddresses,
  PRIVATE_VALIDATOR,
  PROGRAM_ID,
  USDC_MINT,
} from "./gate1-simulate.ts";

const RPC_URL = "https://api.devnet.solana.com" as const;
export const DELEGATION_PROGRAM_ID = address("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const PERMISSION_PROGRAM_ID = address("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const EXPECTED_AMOUNT = 1_000_000n;

const rpc = createSolanaRpc(RPC_URL);
const signer = createNoopSigner(AUTHORITY);
const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function accountBytes(data: readonly [string, string]): Uint8Array {
  if (data[1] !== "base64") {
    throw new Error(`Unexpected account encoding: ${data[1]}`);
  }
  return Buffer.from(data[0], "base64");
}

function decodeTokenAccount(data: Uint8Array): {
  amount: bigint;
  mint: Address;
  owner: Address;
} {
  if (data.length !== 165) {
    throw new Error(`Expected a 165-byte SPL Token account, received ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    amount: view.getBigUint64(64, true),
    mint: addressDecoder.decode(data.slice(0, 32)),
    owner: addressDecoder.decode(data.slice(32, 64)),
  };
}

function assertBytesEqual(
  actual: { readonly length: number; readonly [index: number]: number },
  expected: { readonly length: number; readonly [index: number]: number },
  label: string,
): void {
  let matches = actual.length === expected.length;
  for (let index = 0; matches && index < actual.length; index += 1) {
    matches = actual[index] === expected[index];
  }
  if (!matches) {
    throw new Error(`${label} discriminator mismatch`);
  }
}

export async function deriveDelegationPdas(delegatedAccount: Address, ownerProgram: Address) {
  const accountSeed = Buffer.from(addressEncoder.encode(delegatedAccount));
  const [[buffer], [record], [metadata]] = await Promise.all([
    getProgramDerivedAddress({
      programAddress: ownerProgram,
      seeds: [Buffer.from("buffer"), accountSeed],
    }),
    getProgramDerivedAddress({
      programAddress: DELEGATION_PROGRAM_ID,
      seeds: [Buffer.from("delegation"), accountSeed],
    }),
    getProgramDerivedAddress({
      programAddress: DELEGATION_PROGRAM_ID,
      seeds: [Buffer.from("delegation-metadata"), accountSeed],
    }),
  ]);
  return { buffer, metadata, record } as const;
}

export async function buildDelegationPlan(transactionSigner: TransactionSigner = signer) {
  const addresses = await deriveAddresses();
  const [permissionDelegation, depositDelegation] = await Promise.all([
    deriveDelegationPdas(addresses.permission, PERMISSION_PROGRAM_ID),
    deriveDelegationPdas(addresses.deposit, PROGRAM_ID),
  ]);
  const instructions = [
    getSetComputeUnitLimitInstruction({ units: 500_000 }),
    await getDelegateDepositPermissionInstructionAsync({
      payer: transactionSigner,
      user: transactionSigner,
      config: addresses.config,
      deposit: addresses.deposit,
      permission: addresses.permission,
      delegationBuffer: permissionDelegation.buffer,
      delegationRecord: permissionDelegation.record,
      delegationMetadata: permissionDelegation.metadata,
      validator: PRIVATE_VALIDATOR,
    }),
    await getDelegateDepositInstructionAsync({
      payer: transactionSigner,
      owner: transactionSigner,
      config: addresses.config,
      validator: PRIVATE_VALIDATOR,
      bufferDeposit: depositDelegation.buffer,
      delegationRecordDeposit: depositDelegation.record,
      delegationMetadataDeposit: depositDelegation.metadata,
      deposit: addresses.deposit,
      user: AUTHORITY,
      tokenMint: USDC_MINT,
    }),
  ];
  return { addresses, depositDelegation, instructions, permissionDelegation } as const;
}

export async function simulateDelegation(): Promise<void> {
const { addresses, depositDelegation, instructions, permissionDelegation } =
  await buildDelegationPlan();

const preflightAddresses = [
  addresses.config,
  addresses.deposit,
  addresses.permission,
  addresses.vaultUsdcAta,
  DELEGATION_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  PRIVATE_VALIDATOR,
  permissionDelegation.buffer,
  permissionDelegation.record,
  permissionDelegation.metadata,
  depositDelegation.buffer,
  depositDelegation.record,
  depositDelegation.metadata,
] as const;
const preflight = await rpc
  .getMultipleAccounts(preflightAddresses, { commitment: "finalized", encoding: "base64" })
  .send();
const [
  configAccount,
  depositAccount,
  permissionAccount,
  vaultAtaAccount,
  delegationProgram,
  permissionProgram,
  validator,
  ...delegationPdaAccounts
] = preflight.value;

if (!configAccount || configAccount.owner !== PROGRAM_ID || accountBytes(configAccount.data).length !== 154) {
  throw new Error("Config failed owner/length validation");
}
if (!depositAccount || depositAccount.owner !== PROGRAM_ID || accountBytes(depositAccount.data).length !== 98) {
  throw new Error("Deposit failed owner/length validation");
}
if (
  !permissionAccount ||
  permissionAccount.owner !== PERMISSION_PROGRAM_ID ||
  accountBytes(permissionAccount.data).length !== 567
) {
  throw new Error("Permission failed owner/length validation");
}
if (!vaultAtaAccount || vaultAtaAccount.owner !== TOKEN_PROGRAM_ID) {
  throw new Error("Vault token account failed owner validation");
}
if (!delegationProgram?.executable || !permissionProgram?.executable || !validator) {
  throw new Error("A required MagicBlock program or Private ER validator is unavailable on Devnet");
}
if (delegationPdaAccounts.some((account) => account !== null)) {
  throw new Error("One or more delegation PDAs already exist; refusing a bootstrap-only simulation");
}

const configState = getConfigDecoder().decode(accountBytes(configAccount.data));
const depositState = getDepositDecoder().decode(accountBytes(depositAccount.data));
const vaultTokenState = decodeTokenAccount(accountBytes(vaultAtaAccount.data));
assertBytesEqual(configState.discriminator, CONFIG_DISCRIMINATOR, "Config");
assertBytesEqual(depositState.discriminator, DEPOSIT_DISCRIMINATOR, "Deposit");
if (
  configState.authority !== AUTHORITY ||
  configState.allowedMint !== USDC_MINT ||
  configState.tokenProgram !== TOKEN_PROGRAM_ID ||
  configState.privateValidator !== PRIVATE_VALIDATOR ||
  configState.version !== 1
) {
  throw new Error(`Unexpected Config state: ${json(configState)}`);
}
if (
  depositState.user !== AUTHORITY ||
  depositState.tokenMint !== USDC_MINT ||
  depositState.available !== EXPECTED_AMOUNT ||
  depositState.locked !== 0n ||
  depositState.nextPaymentNonce !== 0n ||
  depositState.automationPaused ||
  depositState.version !== 1
) {
  throw new Error(`Unexpected Deposit state: ${json(depositState)}`);
}
if (
  vaultTokenState.mint !== USDC_MINT ||
  vaultTokenState.owner !== addresses.vault ||
  vaultTokenState.amount !== EXPECTED_AMOUNT
) {
  throw new Error(`Unexpected vault token state: ${json(vaultTokenState)}`);
}

const { value: latestBlockhash } = await rpc
  .getLatestBlockhash({ commitment: "confirmed" })
  .send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (current) => setTransactionMessageFeePayer(AUTHORITY, current),
  (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
  (current) => appendTransactionMessageInstructions(instructions, current),
);
const transaction = compileTransaction(message);
const wire = getBase64EncodedWireTransaction(transaction);
const serializedSize = Buffer.from(wire, "base64").length;
if (serializedSize > 1_232) {
  throw new Error(`Transaction is ${serializedSize} bytes; Solana limit is 1232 bytes`);
}

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
const simulation = await rpc
  .simulateTransaction(wire, {
    accounts: { addresses: returnedAddresses, encoding: "base64" },
    commitment: "confirmed",
    encoding: "base64",
    innerInstructions: true,
    replaceRecentBlockhash: true,
    sigVerify: false,
  })
  .send();

if (simulation.value.err !== null) {
  console.log(json({ err: simulation.value.err, logs: simulation.value.logs }));
  throw new Error("Delegation simulation failed");
}
const postAccounts = simulation.value.accounts;
if (!postAccounts || postAccounts.some((account) => account === null)) {
  throw new Error("Simulation did not return every delegated post-state account");
}
const [
  postPermission,
  postPermissionBuffer,
  postPermissionRecord,
  postPermissionMetadata,
  postDeposit,
  postDepositBuffer,
  postDepositRecord,
  postDepositMetadata,
  postVaultAta,
] = postAccounts;
if (
  !postPermission ||
  !postPermissionBuffer ||
  !postPermissionRecord ||
  !postPermissionMetadata ||
  !postDeposit ||
  !postDepositBuffer ||
  !postDepositRecord ||
  !postDepositMetadata ||
  !postVaultAta
) {
  throw new Error("Unexpected null delegation post-state account");
}
if (postPermission.owner !== DELEGATION_PROGRAM_ID || postDeposit.owner !== DELEGATION_PROGRAM_ID) {
  throw new Error("Permission or Deposit was not assigned to the Delegation Program in simulation");
}

const postDepositState = getDepositDecoder().decode(accountBytes(postDeposit.data));
const postVaultTokenState = decodeTokenAccount(accountBytes(postVaultAta.data));
assertBytesEqual(postDepositState.discriminator, DEPOSIT_DISCRIMINATOR, "Post-delegation Deposit");
if (
  postDepositState.available !== EXPECTED_AMOUNT ||
  postDepositState.locked !== 0n ||
  postVaultTokenState.amount !== EXPECTED_AMOUNT
) {
  throw new Error("Delegation changed Deposit accounting or vault collateral");
}

const createdAccounts = [
  postPermissionBuffer,
  postPermissionRecord,
  postPermissionMetadata,
  postDepositBuffer,
  postDepositRecord,
  postDepositMetadata,
];
const createdAccountRent = createdAccounts.reduce(
  (total, account) => total + account.lamports,
  0n,
);
const knownLogs = (simulation.value.logs ?? []).filter(
  (line) =>
    line.startsWith("Program log: Instruction:") ||
    line.startsWith("Program log: ProtectedPay") ||
    line.endsWith(" success") ||
    line.includes(" failed:"),
);

console.log(
  json({
    cluster: "devnet",
    rpcUrl: RPC_URL,
    feePayer: AUTHORITY,
    signer: AUTHORITY,
    validator: PRIVATE_VALIDATOR,
    instructions: [
      "set_compute_unit_limit",
      "delegate_deposit_permission",
      "delegate_deposit",
    ],
    effectIfSent: {
      usdcMovement: "none",
      vaultUsdcRawBefore: vaultTokenState.amount,
      vaultUsdcRawAfter: postVaultTokenState.amount,
      depositAvailableBefore: depositState.available,
      depositAvailableAfter: postDepositState.available,
      depositLockedBefore: depositState.locked,
      depositLockedAfter: postDepositState.locked,
      permissionOwnerBefore: permissionAccount.owner,
      permissionOwnerAfter: postPermission.owner,
      depositOwnerBefore: depositAccount.owner,
      depositOwnerAfter: postDeposit.owner,
      creates: {
        permissionDelegation,
        depositDelegation,
      },
    },
    preflightValidation: {
      finalizedSlot: preflight.context.slot,
      config: "validated",
      deposit: "validated",
      permission: "validated",
      vaultCollateral: "validated",
      programsAndValidator: "validated",
      delegationPdasAbsent: true,
    },
    simulation: {
      slot: simulation.context.slot,
      err: simulation.value.err,
      unitsConsumed: simulation.value.unitsConsumed ?? null,
      feeLamports: simulation.value.fee ?? null,
      newAccountRentLamports: createdAccountRent,
      serializedTransactionBytes: serializedSize,
      knownLogs,
      createdAccounts: createdAccounts.map((account, index) => ({
        address: returnedAddresses[index < 3 ? index + 1 : index + 2],
        dataLength: accountBytes(account.data).length,
        lamports: account.lamports,
        owner: account.owner,
      })),
    },
    privacyBoundary: {
      publicNow: [
        "the wallet deposited 1 USDC",
        "the Permission and Deposit addresses",
        "the pinned Private ER validator",
        "the delegation itself",
        "the pre-delegation Deposit snapshot",
      ],
      privateAfterDelegation: [
        "subsequent authorized Deposit state transitions while executed inside the Private ER",
      ],
      warning: "This does not provide sender anonymity or hide the initial deposit amount.",
    },
  }),
);
}

if (process.argv[1]?.endsWith("gate1-simulate-delegation.ts")) {
  await simulateDelegation();
}
