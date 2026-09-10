import {
  AccountRole,
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getAddressDecoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Address,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import type { AppClient } from "../client";
import { PROGRAM_ID } from "./constants";
import { sendPublicTransaction } from "./sendPublicTransaction";

export const SESSION_KEYS_PROGRAM = address("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const SESSION_DURATION_SECONDS = 60 * 60;
const CREATE_SESSION_DISCRIMINATOR = new Uint8Array([242, 193, 143, 179, 150, 25, 122, 227]);
const REVOKE_SESSION_DISCRIMINATOR = new Uint8Array([86, 92, 198, 120, 144, 2, 7, 194]);

export type BoundedSession = {
  authority: Address;
  expiresAt: number;
  signer: KeyPairSigner;
  token: Address;
};

export async function findSessionToken(
  authority: Address,
  sessionSigner: Address,
): Promise<Address> {
  const addressEncoder = getAddressEncoder();
  const [token] = await getProgramDerivedAddress({
    programAddress: SESSION_KEYS_PROGRAM,
    seeds: [
      new TextEncoder().encode("session_token"),
      addressEncoder.encode(address(PROGRAM_ID)),
      addressEncoder.encode(sessionSigner),
      addressEncoder.encode(authority),
    ],
  });
  return token;
}

function encodeCreateSession(validUntil: number) {
  const data = new Uint8Array(20);
  data.set(CREATE_SESSION_DISCRIMINATOR);
  data[8] = 1; // Some(top_up)
  data[9] = 0; // false: the Private ER does not charge the session signer fees
  data[10] = 1; // Some(valid_until)
  new DataView(data.buffer).setBigInt64(11, BigInt(validUntil), true);
  data[19] = 0; // None(lamports)
  return data;
}

export function buildCreateSessionInstruction(
  authority: TransactionSigner,
  sessionSigner: KeyPairSigner,
  sessionToken: Address,
  validUntil: number,
) {
  return {
    programAddress: SESSION_KEYS_PROGRAM,
    accounts: [
      { address: sessionToken, role: AccountRole.WRITABLE },
      { address: sessionSigner.address, role: AccountRole.WRITABLE_SIGNER, signer: sessionSigner },
      { address: authority.address, role: AccountRole.WRITABLE_SIGNER, signer: authority },
      { address: address(PROGRAM_ID), role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: encodeCreateSession(validUntil),
  };
}

/**
 * Creates a one-hour, in-memory signer scoped by MagicBlock's Session Token
 * program to Protected Pay only. The key is never written to browser storage,
 * and it receives no SOL because Private ER transactions have zero fees.
 */
export async function createBoundedSession(
  client: AppClient,
  authority: TransactionSigner,
): Promise<BoundedSession> {
  const signer = await generateKeyPairSigner();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
  const token = await findSessionToken(authority.address, signer.address);
  const instruction = buildCreateSessionInstruction(authority, signer, token, expiresAt);
  await sendPublicTransaction(client, authority, [
    getSetComputeUnitLimitInstruction({ units: 100_000 }),
    instruction,
  ]);

  const account = await client.rpc.getAccountInfo(token, { commitment: "confirmed", encoding: "base64" }).send();
  if (!account.value || account.value.owner !== SESSION_KEYS_PROGRAM || Number(account.value.space) !== 112) {
    throw new Error("The bounded private session was not created correctly on Solana Devnet.");
  }
  const bytes = getBase64Encoder().encode((account.value.data as readonly [string, "base64"])[0]);
  const decodeAddress = (offset: number) => getAddressDecoder().decode(bytes.slice(offset, offset + 32));
  const storedExpiry = new DataView(bytes.buffer, bytes.byteOffset + 104, 8).getBigInt64(0, true);
  if (
    decodeAddress(8) !== authority.address ||
    decodeAddress(40) !== PROGRAM_ID ||
    decodeAddress(72) !== signer.address ||
    storedExpiry !== BigInt(expiresAt)
  ) {
    throw new Error("The bounded private session does not match the wallet, program, signer, or expiry.");
  }

  return { authority: authority.address, expiresAt, signer, token };
}

export async function revokeBoundedSession(
  client: AppClient,
  authority: TransactionSigner,
  sessionToken: Address,
) {
  await sendPublicTransaction(client, authority, [{
    programAddress: SESSION_KEYS_PROGRAM,
    accounts: [
      { address: sessionToken, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: REVOKE_SESSION_DISCRIMINATOR,
  }]);
  const account = await client.rpc.getAccountInfo(sessionToken, { commitment: "confirmed" }).send();
  if (account.value) throw new Error("The private Session Token still exists after revocation.");
}
