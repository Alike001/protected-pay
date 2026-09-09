import {
  createClient,
  createSignableMessage,
  getBase58Decoder,
  type Address,
} from "@solana/kit";
import { signerFromFile } from "@solana/kit-plugin-signer";

export const PRIVATE_ER_ORIGIN = "https://devnet-tee.magicblock.app" as const;
const MAX_CHALLENGE_AGE_SECONDS = 300;

type ChallengeResponse = { challenge?: unknown; error?: unknown };
type LoginResponse = { token?: unknown; error?: unknown };

export async function authenticatePrivateEr(keypairPath: string) {
  const signerClient = await createClient().use(signerFromFile(keypairPath));
  const identity = signerClient.identity.address as Address;
  const challengeUrl = new URL("/auth/challenge", PRIVATE_ER_ORIGIN);
  challengeUrl.searchParams.set("pubkey", identity);
  const challengeResponse = await fetch(challengeUrl, {
    headers: { accept: "application/json" },
  });
  if (!challengeResponse.ok) {
    throw new Error(`TEE challenge request failed with HTTP ${challengeResponse.status}`);
  }
  const challengeJson = (await challengeResponse.json()) as ChallengeResponse;
  if (typeof challengeJson.challenge !== "string" || challengeJson.challenge.length === 0) {
    throw new Error(`TEE returned no valid challenge: ${String(challengeJson.error ?? "unknown error")}`);
  }
  const pattern = new RegExp(
    `^Login to Query Filtering Service\\nTimestamp: (\\d{10})\\nUser: ${identity}$`,
  );
  const match = pattern.exec(challengeJson.challenge);
  if (!match?.[1]) {
    throw new Error("TEE challenge format, service name, or wallet address is unexpected");
  }
  const timestamp = Number(match[1]);
  const challengeAgeSeconds = Math.floor(Date.now() / 1000) - timestamp;
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(challengeAgeSeconds) > MAX_CHALLENGE_AGE_SECONDS
  ) {
    throw new Error("TEE challenge timestamp is stale or implausibly far in the future");
  }
  const [signatureDictionary] = await signerClient.identity.signMessages([
    createSignableMessage(new TextEncoder().encode(challengeJson.challenge)),
  ]);
  const signatureBytes = signatureDictionary[identity];
  if (!signatureBytes || signatureBytes.length !== 64) {
    throw new Error("Wallet did not produce the expected authentication signature");
  }
  const loginResponse = await fetch(new URL("/auth/login", PRIVATE_ER_ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      pubkey: identity,
      challenge: challengeJson.challenge,
      signature: getBase58Decoder().decode(signatureBytes),
    }),
  });
  const loginJson = (await loginResponse.json()) as LoginResponse;
  if (!loginResponse.ok) {
    throw new Error(
      `TEE authentication failed with HTTP ${loginResponse.status}: ${String(loginJson.error ?? "unknown error")}`,
    );
  }
  if (typeof loginJson.token !== "string" || loginJson.token.length < 20) {
    throw new Error("TEE authentication returned no valid bearer token");
  }

  // The token exists only inside the calling process and must never be printed or persisted.
  const authenticatedUrl = new URL(PRIVATE_ER_ORIGIN);
  authenticatedUrl.searchParams.set("token", loginJson.token);
  return { authenticatedUrl, challengeAgeSeconds, identity, signerClient } as const;
}
