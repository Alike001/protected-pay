import { Check, Clock3, FileText, LockKeyhole, ShieldCheck } from "lucide-react";
import { useClient } from "@solana/react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useEffect, useMemo, useState } from "react";
import { PaymentStatus } from "../../../clients/ts/src/generated/types/paymentStatus";
import { BrandMark } from "../../components/BrandMark";
import { WorkflowIssueNotice } from "../../components/WorkflowIssueNotice";
import { WalletControl } from "../../components/WalletControl";
import { usePrivateBalance } from "../../hooks/usePrivateBalance";
import { usePrivatePayment } from "../../hooks/usePrivatePayment";
import { formatUsdc, shortAddress } from "../../lib/format";
import { decryptMemoFromRecipientLink, memoEnvelopeFromLocation } from "../../lib/memoEnvelope";
import { onboardRecipientDeposit } from "../../lib/paymentWorkflow";
import { workflowIssueFrom, type WorkflowIssue } from "../../lib/workflowIssue";
import type { AppClient } from "../../client";

const PREVIEW_SENDER = "6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn";

function formatRemaining(deadlineSeconds: bigint | null, now: number) {
  if (!deadlineSeconds) return "—:—";
  const remaining = Math.max(0, Number(deadlineSeconds) - Math.floor(now / 1000));
  const minutes = Math.floor(remaining / 60).toString().padStart(2, "0");
  const seconds = (remaining % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function RecipientPayment({ preview, paymentReference, onShowProof }: { preview: boolean; paymentReference?: string | null; onShowProof: () => void }) {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const walletAddress = connected?.account.address ?? null;
  const privateSession = usePrivateBalance(client, preview ? null : walletAddress);
  const live = usePrivatePayment(privateSession.privateClient, walletAddress, preview ? null : paymentReference ?? null);
  const [now, setNow] = useState(Date.now());
  const [actionError, setActionError] = useState<WorkflowIssue | null>(null);
  const [privateMemo, setPrivateMemo] = useState<string | null>(null);
  const payment = live.payment;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!payment) {
      setPrivateMemo(null);
      return;
    }
    const envelope = memoEnvelopeFromLocation();
    if (!envelope) {
      setPrivateMemo("No note shared");
      return;
    }
    void decryptMemoFromRecipientLink(envelope, payment.memoHash)
      .then(setPrivateMemo)
      .catch((error: unknown) => setActionError(workflowIssueFrom(error, "The private note could not be opened.")));
  }, [payment]);

  const deadline = payment ? (payment.status === PaymentStatus.Acknowledged ? payment.settleAfter : payment.expiresAt) : null;
  const countdown = preview ? "03:42" : formatRemaining(deadline, now);
  const statusLabel = preview || payment?.status === PaymentStatus.Created ? "Waiting for you" : payment?.status === PaymentStatus.Acknowledged ? "Acknowledged" : payment?.status === PaymentStatus.Settled ? "Ready to claim" : payment?.status === PaymentStatus.Expired ? "Expired" : payment?.status === PaymentStatus.Cancelled ? "Cancelled" : "Private";
  const canAcknowledge = payment?.status === PaymentStatus.Created && payment.recipient === walletAddress;
  const canClaim = payment?.status === PaymentStatus.Settled && payment.recipient === walletAddress;
  const actionLabel = live.status === "acting" ? "Confirming…" : canClaim ? "Claim test USDC" : canAcknowledge ? "Acknowledge payment" : payment?.status === PaymentStatus.Acknowledged ? "Acknowledged — waiting" : "No action available";
  const visible = preview || Boolean(payment);
  const amount = preview ? "125.00" : payment ? formatUsdc(payment.amount) : "—";
  const sender = preview ? PREVIEW_SENDER : payment?.sender ?? null;
  const primaryIssue = useMemo(() => {
    if (actionError) return actionError;
    const message = live.message ?? privateSession.message;
    return message ? workflowIssueFrom(message, "The private payment needs attention.") : null;
  }, [actionError, live.message, privateSession.message]);

  useEffect(() => {
    if (primaryIssue?.kind === "authentication-expired") privateSession.lock();
  }, [primaryIssue?.kind, privateSession.lock]);

  async function unlockPayment() {
    setActionError(null);
    try {
      await privateSession.unlock();
    } catch (error) {
      setActionError(workflowIssueFrom(error, "The private payment could not be unlocked."));
    }
  }

  async function performAction() {
    setActionError(null);
    try {
      if (canClaim) await live.claim();
      else if (canAcknowledge && connected?.signer && walletAddress) {
        await onboardRecipientDeposit(client, connected.signer, connected.signer.address);
        await live.acknowledge();
      }
    } catch (error) {
      const issue = workflowIssueFrom(error, "The payment action failed.");
      if (issue.kind === "authentication-expired") privateSession.lock();
      setActionError(issue);
    }
  }

  return (
    <div className="recipient-page">
      <header className="recipient-header"><BrandMark /><WalletControl /></header>
      <main className="recipient-main">
        <div className="recipient-intro"><span className="icon-tile large"><ShieldCheck size={24} /></span><div><h1>Payment waiting for you</h1><p>Connect the intended wallet to view and acknowledge this test payment.</p></div></div>

        {!preview && !paymentReference && <div className="access-message"><strong>Payment reference missing</strong><p>Ask the sender to copy the complete recipient link.</p></div>}
        {!preview && paymentReference && !connected && <div className="access-message"><strong>Connect the recipient wallet</strong><p>Private payment fields remain hidden until the intended wallet authenticates.</p></div>}
        {!preview && connected && privateSession.status !== "ready" && (
          <button className="unlock-payment" onClick={() => void unlockPayment()} disabled={privateSession.status === "loading"}>
            <LockKeyhole size={17} /> {privateSession.status === "loading" ? "Unlocking private payment…" : "Unlock private payment"}
          </button>
        )}
        {primaryIssue && !visible && <WorkflowIssueNotice issue={primaryIssue} />}

        <section className={`recipient-card ${!visible ? "concealed" : ""}`}>
          <div className="recipient-countdown"><div className="countdown-ring large"><strong>{countdown}</strong><span>remaining</span></div><span className="status pending">{statusLabel}</span></div>
          <div className="recipient-amount"><strong>{amount}</strong><span>test USDC</span></div>
          <dl className="recipient-details">
            <div><dt>From</dt><dd>{sender ? shortAddress(sender, 7) : "Hidden"}</dd></div>
            <div><dt>Private note</dt><dd>{preview ? "Invoice #184" : payment ? privateMemo ?? "Opening encrypted note…" : "Hidden"}</dd></div>
          </dl>
          <button className="primary-action" onClick={performAction} disabled={!preview && ((!canAcknowledge && !canClaim) || live.status === "acting")}>{preview ? "Acknowledge payment" : actionLabel}</button>
          <p className="action-explainer">Acknowledging confirms this wallet is ready to receive. First-time recipients may see one setup approval before the private acknowledgement.</p>
          {primaryIssue && visible && <WorkflowIssueNotice issue={primaryIssue} />}
        </section>

        <section className="recipient-timeline">
          <h2>How this payment works</h2>
          <ol>
            <li className="done"><span><Check size={15} /></span><div><strong>Payment protected</strong><p>The sender placed test USDC into a private safety window.</p></div></li>
            <li className={payment?.status === PaymentStatus.Acknowledged || payment?.status === PaymentStatus.Settled ? "done" : "current"}><span>{payment?.status === PaymentStatus.Acknowledged || payment?.status === PaymentStatus.Settled ? <Check size={15} /> : "2"}</span><div><strong>You acknowledge</strong><p>Confirm that this is the correct recipient wallet.</p></div></li>
            <li className={payment?.status === PaymentStatus.Settled ? "done" : ""}><span>{payment?.status === PaymentStatus.Settled ? <Check size={15} /> : "3"}</span><div><strong>Funds settle</strong><p>After the deadline, the payment becomes claimable.</p></div></li>
          </ol>
        </section>

        <button className="recipient-proof" onClick={onShowProof}><FileText size={17} /><span><strong>View technical proof</strong><small>Program, cluster, and finalized transaction</small></span></button>
        <div className="privacy-note recipient-privacy"><LockKeyhole size={17} /><span><strong>Private while pending</strong><br />Amount and live status require an authorized wallet. The note is encrypted in the recipient link; wallets and timing are public.</span></div>
        <footer className="recipient-footer"><Clock3 size={15} /> Test funds only · Solana Devnet</footer>
      </main>
    </div>
  );
}
