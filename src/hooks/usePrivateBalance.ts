import {
  address,
  createClient,
  createSolanaRpc,
  getBase58Decoder,
  getBase64Encoder,
  type TransactionSigner,
} from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { signer as signerPlugin } from "@solana/kit-plugin-signer";
import { useCallback, useEffect, useState } from "react";
import { getDepositDecoder } from "../../clients/ts/src/generated/accounts/deposit";
import { findDepositPda } from "../../clients/ts/src/generated/pdas/deposit";
import { PRIVATE_ER_ORIGIN, PROGRAM_ID, USDC_MINT } from "../lib/constants";
import { errorMessage } from "../lib/format";
import type { AppClient } from "../client";

type BalanceState = {
  available: bigint;
  locked: bigint;
  paused: boolean;
};

type ChallengeResponse = { challenge?: unknown; error?: unknown };
type LoginResponse = { token?: unknown; error?: unknown };
const MAX_CHALLENGE_AGE_SECONDS = 300;

function decodeAccountData(value: [string, "base64"] | readonly [string, "base64"]) {
  return getBase64Encoder().encode(value[0]);
}

function createPrivateClient(transactionSigner: TransactionSigner, rpcUrl: string) {
  return createClient().use(signerPlugin(transactionSigner)).use(solanaRpc({ rpcUrl }));
}

export type PrivateClient = ReturnType<typeof createPrivateClient>;

export function usePrivateBalance(client: AppClient, walletAddress: string | null) {
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [status, setStatus] = useState<"locked" | "loading" | "ready" | "error">("locked");
  const [message, setMessage] = useState<string | null>(null);
  const [authenticatedRpc, setAuthenticatedRpc] = useState<ReturnType<typeof createSolanaRpc> | null>(null);
  const [privateClient, setPrivateClient] = useState<PrivateClient | null>(null);

  const readBalance = useCallback(async (rpc: ReturnType<typeof createSolanaRpc>, owner: string) => {
    const [deposit] = await findDepositPda({ user: address(owner), tokenMint: address(USDC_MINT) });
    const response = await rpc.getAccountInfo(deposit, { commitment: "confirmed", encoding: "base64" }).send();
    if (!response.value) {
      setBalance({ available: 0n, locked: 0n, paused: false });
      setMessage("No protected balance yet. Fund the vault before sending.");
      return;
    }
    if (response.value.owner !== PROGRAM_ID) throw new Error("Protected balance account has an unexpected owner.");
    const decoded = getDepositDecoder().decode(decodeAccountData(response.value.data as [string, "base64"]));
    if (decoded.user !== owner || decoded.tokenMint !== USDC_MINT) {
      throw new Error("Protected balance account does not match this wallet.");
    }
    setBalance({ available: decoded.available, locked: decoded.locked, paused: decoded.automationPaused });
    setMessage(null);
  }, []);

  const unlock = useCallback(async (): Promise<PrivateClient> => {
    if (privateClient) return privateClient;
    if (!walletAddress) throw new Error("Connect a wallet before unlocking private state.");
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
      const authenticatedClient = createPrivateClient(transactionSigner, authenticatedUrl.toString());
      setAuthenticatedRpc(rpc);
      setPrivateClient(authenticatedClient);
      await readBalance(rpc, walletAddress);
      setStatus("ready");
      return authenticatedClient;
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
      throw error;
    }
  }, [client, privateClient, readBalance, walletAddress]);

  const refresh = useCallback(async () => {
    if (!authenticatedRpc || !walletAddress) return;
    setStatus("loading");
    try {
      await readBalance(authenticatedRpc, walletAddress);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }, [authenticatedRpc, readBalance, walletAddress]);

  useEffect(() => {
    setBalance(null);
    setAuthenticatedRpc(null);
    setPrivateClient(null);
    setStatus("locked");
    setMessage(null);
  }, [walletAddress]);

  return { balance, message, privateClient, refresh, status, unlock };
}
