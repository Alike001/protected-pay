import {
  address,
  createClient,
  createSolanaRpc,
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { useCallback, useEffect, useState } from "react";
import { getDepositDecoder } from "../../clients/ts/src/generated/accounts/deposit";
import { findDepositPda } from "../../clients/ts/src/generated/pdas/deposit";
import { PRIVATE_ER_ORIGIN, PROGRAM_ID, USDC_MINT } from "../lib/constants";
import { errorMessage } from "../lib/format";
import { assertCanProtectPayment } from "../lib/privateBalanceGuard";
import { createBoundedSession, revokeBoundedSession } from "../lib/sessionKeys";
import type { AppClient } from "../client";

export type BalanceState = {
  available: bigint;
  exists: boolean;
  locked: bigint;
  paused: boolean;
};

type ChallengeResponse = { challenge?: unknown; error?: unknown };
type LoginResponse = { token?: unknown; error?: unknown };
const MAX_CHALLENGE_AGE_SECONDS = 300;

function decodeAccountData(value: [string, "base64"] | readonly [string, "base64"]) {
  return getBase64Encoder().encode(value[0]);
}

function createPrivateClient(
  transactionSigner: TransactionSigner,
  rpcUrl: string,
  authority: Address,
  sessionToken: Address,
  sessionExpiresAt: number,
) {
  return Object.assign(
    createClient().use(signerPlugin(transactionSigner)).use(solanaRpc({ rpcUrl })),
    { authority, sessionExpiresAt, sessionToken },
  );
}

export type PrivateClient = ReturnType<typeof createPrivateClient>;

export function usePrivateBalance(client: AppClient, walletAddress: string | null) {
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [status, setStatus] = useState<"locked" | "loading" | "ready" | "error">("locked");
  const [message, setMessage] = useState<string | null>(null);
  const [authenticatedRpc, setAuthenticatedRpc] = useState<ReturnType<typeof createSolanaRpc> | null>(null);
  const [privateClient, setPrivateClient] = useState<PrivateClient | null>(null);

  const lock = useCallback(() => {
    setBalance(null);
    setAuthenticatedRpc(null);
    setPrivateClient(null);
    setStatus("locked");
    setMessage(null);
  }, []);

  const readBalance = useCallback(async (rpc: ReturnType<typeof createSolanaRpc>, owner: string) => {
    const [deposit] = await findDepositPda({ user: address(owner), tokenMint: address(USDC_MINT) });
    const response = await rpc.getAccountInfo(deposit, { commitment: "confirmed", encoding: "base64" }).send();
    if (!response.value) {
      const nextBalance = { available: 0n, exists: false, locked: 0n, paused: false } satisfies BalanceState;
      setBalance(nextBalance);
      setMessage("No protected balance yet. Fund the vault before sending.");
      return nextBalance;
    }
    if (response.value.owner !== PROGRAM_ID) throw new Error("Protected balance account has an unexpected owner.");
    const decoded = getDepositDecoder().decode(decodeAccountData(response.value.data as [string, "base64"]));
    if (decoded.user !== owner || decoded.tokenMint !== USDC_MINT) {
      throw new Error("Protected balance account does not match this wallet.");
    }
    const nextBalance = { available: decoded.available, exists: true, locked: decoded.locked, paused: decoded.automationPaused } satisfies BalanceState;
    setBalance(nextBalance);
    setMessage(null);
    return nextBalance;
  }, []);

  const unlockSession = useCallback(async () => {
    if (!walletAddress) throw new Error("Connect a wallet before unlocking private state.");
    const sessionStillValid = privateClient && privateClient.sessionExpiresAt > Math.floor(Date.now() / 1000) + 15;
    if (sessionStillValid && authenticatedRpc) {
      setStatus("loading");
      try {
        const latestBalance = await readBalance(authenticatedRpc, walletAddress);
        setStatus("ready");
        return { balance: latestBalance, privateClient };
      } catch (error) {
        setAuthenticatedRpc(null);
        setPrivateClient(null);
        setStatus("error");
        setMessage(errorMessage(error));
        throw error;
      }
    }
    if (privateClient && !sessionStillValid) {
      setAuthenticatedRpc(null);
      setPrivateClient(null);
    }
    setStatus("loading");
    setMessage(null);
    try {
      const challengeUrl = new URL("/auth/challenge", PRIVATE_ER_ORIGIN);
      challengeUrl.searchParams.set("pubkey", walletAddress);
      const challengeResponse = await fetch(challengeUrl, { headers: { accept: "application/json" } });
      const challengeJson = (await challengeResponse.json()) as ChallengeResponse;
      if (!challengeResponse.ok || typeof challengeJson.challenge !== "string") {
        throw new Error(String(challengeJson.error ?? "The private session challenge was unavailable."));
      }
      const pattern = new RegExp(`^Login to Query Filtering Service\\nTimestamp: (\\d{10})\\nUser: ${walletAddress}$`);
      const timestamp = Number(pattern.exec(challengeJson.challenge)?.[1]);
      const challengeAgeSeconds = Math.floor(Date.now() / 1000) - timestamp;
      if (!Number.isSafeInteger(timestamp) || Math.abs(challengeAgeSeconds) > MAX_CHALLENGE_AGE_SECONDS) {
        throw new Error("The private session challenge is stale or has an unexpected format.");
      }
      const signature = await client.wallet.signMessage(new TextEncoder().encode(challengeJson.challenge));
      const loginResponse = await fetch(new URL("/auth/login", PRIVATE_ER_ORIGIN), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          pubkey: walletAddress,
          challenge: challengeJson.challenge,
          signature: getBase58Decoder().decode(signature),
        }),
      });
      const loginJson = (await loginResponse.json()) as LoginResponse;
      if (!loginResponse.ok || typeof loginJson.token !== "string") {
        throw new Error(String(loginJson.error ?? "The private session could not be unlocked."));
      }
      const authenticatedUrl = new URL(PRIVATE_ER_ORIGIN);
      authenticatedUrl.searchParams.set("token", loginJson.token);
      const rpc = createSolanaRpc(authenticatedUrl.toString());
      const transactionSigner = client.wallet.getState().connected?.signer;
      if (!transactionSigner) throw new Error("The connected wallet cannot sign Solana transactions.");
      const boundedSession = await createBoundedSession(client, transactionSigner);
      const authenticatedClient = createPrivateClient(
        boundedSession.signer,
        authenticatedUrl.toString(),
        address(walletAddress),
        boundedSession.token,
        boundedSession.expiresAt,
      );
      setAuthenticatedRpc(rpc);
      setPrivateClient(authenticatedClient);
      const latestBalance = await readBalance(rpc, walletAddress);
      setStatus("ready");
      return { balance: latestBalance, privateClient: authenticatedClient };
    } catch (error) {
      setAuthenticatedRpc(null);
      setPrivateClient(null);
      setStatus("error");
      setMessage(errorMessage(error));
      throw error;
    }
  }, [authenticatedRpc, client, privateClient, readBalance, walletAddress]);

  const unlock = useCallback(async (): Promise<PrivateClient> => {
    return (await unlockSession()).privateClient;
  }, [unlockSession]);

  const endSession = useCallback(async () => {
    const transactionSigner = client.wallet.getState().connected?.signer;
    if (!privateClient || !transactionSigner) {
      lock();
      return;
    }
    setStatus("loading");
    setMessage(null);
    try {
      await revokeBoundedSession(client, transactionSigner, privateClient.sessionToken);
      lock();
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
      throw error;
    }
  }, [client, lock, privateClient]);

  const requireAvailableBalance = useCallback(async (amount: bigint): Promise<PrivateClient> => {
    const session = await unlockSession();
    assertCanProtectPayment(session.balance, amount);
    return session.privateClient;
  }, [unlockSession]);

  const refresh = useCallback(async () => {
    if (!authenticatedRpc || !walletAddress) return;
    setStatus("loading");
    try {
      await readBalance(authenticatedRpc, walletAddress);
      setStatus("ready");
    } catch (error) {
      setAuthenticatedRpc(null);
      setPrivateClient(null);
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }, [authenticatedRpc, readBalance, walletAddress]);

  useEffect(() => {
    lock();
  }, [lock, walletAddress]);

  return { balance, endSession, lock, message, privateClient, refresh, requireAvailableBalance, status, unlock };
}
