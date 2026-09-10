import { address, getBase58Encoder, getBase64Encoder } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { useCallback, useEffect, useState } from "react";
import { getPaymentDecoder, type Payment } from "../../clients/ts/src/generated/accounts/payment";
import { getAcknowledgePaymentInstruction } from "../../clients/ts/src/generated/instructions/acknowledgePayment";
import { getClaimPaymentInstruction } from "../../clients/ts/src/generated/instructions/claimPayment";
import { findDepositPda } from "../../clients/ts/src/generated/pdas/deposit";
import { findPaymentPda } from "../../clients/ts/src/generated/pdas/payment";
import { PROGRAM_ID, USDC_MINT } from "../lib/constants";
import { errorMessage } from "../lib/format";
import type { PrivateClient } from "./usePrivateBalance";
import { sendPrivateTransaction } from "../lib/sendPrivateTransaction";

function decodeAccountData(value: [string, "base64"] | readonly [string, "base64"]) {
  return getBase64Encoder().encode(value[0]);
}

export function usePrivatePayment(privateClient: PrivateClient | null, walletAddress: string | null, paymentReference: string | null) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [paymentAddress, setPaymentAddress] = useState<ReturnType<typeof address> | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "acting" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!privateClient || !paymentReference) return;
    setStatus("loading");
    try {
      const paymentId = getBase58Encoder().encode(paymentReference);
      if (paymentId.length !== 32) throw new Error("The payment link is malformed.");
      const [derivedPayment] = await findPaymentPda({ paymentId });
      const response = await privateClient.rpc.getAccountInfo(derivedPayment, { commitment: "confirmed", encoding: "base64" }).send();
      if (!response.value) throw new Error("This wallet cannot read the payment, or the payment no longer exists.");
      if (response.value.owner !== PROGRAM_ID) throw new Error("The payment account has an unexpected owner.");
      const decoded = getPaymentDecoder().decode(decodeAccountData(response.value.data as [string, "base64"]));
      if (!decoded.initialized) throw new Error("The payment has not opened yet.");
      if (walletAddress && decoded.recipient !== walletAddress && decoded.sender !== walletAddress) {
        throw new Error("This payment belongs to different wallets.");
      }
      setPayment(decoded);
      setPaymentAddress(derivedPayment);
      setMessage(null);
      setStatus("ready");
    } catch (error) {
      setPayment(null);
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }, [paymentReference, privateClient, walletAddress]);

  useEffect(() => {
    if (!privateClient) {
      setPayment(null);
      setPaymentAddress(null);
      setStatus("idle");
      setMessage(null);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8_000);
    return () => window.clearInterval(timer);
  }, [privateClient, refresh]);

  const acknowledge = useCallback(async () => {
    if (!privateClient || !walletAddress || !paymentAddress || !payment) throw new Error("Load the payment before acknowledging.");
    if (payment.recipient !== walletAddress) throw new Error("Only the intended recipient can acknowledge this payment.");
    setStatus("acting");
    setMessage(null);
    try {
      await sendPrivateTransaction(privateClient, [
        getSetComputeUnitLimitInstruction({ units: 200_000 }),
        getAcknowledgePaymentInstruction({
          recipient: address(walletAddress),
          payer: privateClient.identity,
          sessionToken: privateClient.sessionToken,
          payment: paymentAddress,
        }),
      ]);
      await refresh();
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
      throw error;
    }
  }, [payment, paymentAddress, privateClient, refresh, walletAddress]);

  const claim = useCallback(async () => {
    if (!privateClient || !walletAddress || !paymentAddress || !payment) throw new Error("Load the payment before claiming.");
    const [deposit] = await findDepositPda({ user: address(walletAddress), tokenMint: address(USDC_MINT) });
    setStatus("acting");
    setMessage(null);
    try {
      await sendPrivateTransaction(privateClient, [
        getSetComputeUnitLimitInstruction({ units: 200_000 }),
        getClaimPaymentInstruction({
          claimant: address(walletAddress),
          payer: privateClient.identity,
          sessionToken: privateClient.sessionToken,
          payment: paymentAddress,
          claimantDeposit: deposit,
        }),
      ]);
      await refresh();
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
      throw error;
    }
  }, [payment, paymentAddress, privateClient, refresh, walletAddress]);

  return { acknowledge, claim, message, payment, paymentAddress, refresh, status };
}
