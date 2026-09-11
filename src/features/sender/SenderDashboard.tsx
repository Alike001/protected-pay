import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Check,
  Clock3,
  Eye,
  FileText,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";
import { useClient } from "@solana/react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import { useEffect, useMemo, useState } from "react";
import { address } from "@solana/kit";
import { PaymentStatus } from "../../../clients/ts/src/generated/types/paymentStatus";
import { usePrivateBalance } from "../../hooks/usePrivateBalance";
import { usePrivatePayment } from "../../hooks/usePrivatePayment";
import { createBalanceOperationCheckpoint, runBalanceOperation, validateBalanceOperationCheckpoint, type BalanceOperationCheckpoint, type BalanceOperationKind, type BalanceOperationStage } from "../../lib/balanceOperation";
import { formatUsdc, parseUsdc, shortAddress } from "../../lib/format";
import { createPaymentOperationCheckpoint, runPaymentOperation, validatePaymentOperationCheckpoint, type PaymentOperationCheckpoint } from "../../lib/paymentOperation";
import {
  acquirePaymentOperationLease,
  getPaymentTabId,
  migratePaymentOperation,
  paymentOperationKey,
  paymentOperationLeaseKey,
  paymentOperationOwnedElsewhere,
  refreshPaymentOperationLease,
  releasePaymentOperationLease,
  writePaymentOperation,
} from "../../lib/paymentCheckpointStorage";
import { recordPaymentReceipt, usePaymentReceipts, type PaymentReceiptRecord } from "../../lib/paymentReceiptStorage";
import { cancelProtectedPayment, discoverUsdcFundingSource, fundFirstProtectedBalance, type FirstFundingStage, type PaymentStage, type ProtectedPaymentReceipt } from "../../lib/paymentWorkflow";
import { crossTabWorkflowIssue, workflowIssueFrom, type WorkflowIssue } from "../../lib/workflowIssue";
import type { AppClient } from "../../client";
import { WorkflowIssueNotice } from "../../components/WorkflowIssueNotice";
import { BalanceOperationDialog } from "./BalanceOperationDialog";

const PREVIEW_RECIPIENT = "Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ";

type Props = { preview: boolean; previewIssue?: WorkflowIssue | null; onShowProof: () => void };
type SavedPayment = { paymentReference: string; memoEnvelope: string | null; sender: string };

function receiptPresentation(receipt: PaymentReceiptRecord) {
  if (receipt.action === "protected") return { label: "Payment protected", status: "Protected", statusClass: "pending" };
  if (receipt.action === "undone") return { label: "Payment undone", status: "Recovered", statusClass: "recovered" };
  if (receipt.action === "expired-recovered") return { label: "Expiry recovered", status: "Recovered", statusClass: "recovered" };
  if (receipt.action === "acknowledged") return { label: "Payment acknowledged", status: "Acknowledged", statusClass: "pending" };
  return { label: "Payment claimed", status: "Claimed", statusClass: "settled" };
}

function ApprovalSteps() {
  return (
    <ol className="approval-steps">
      <li><span>1</span><div><strong>Authorize private session</strong><small>One login message and bounded approval when cold</small></div></li>
      <li><span>2</span><div><strong>Prepare protection</strong><small>Public Solana transaction</small></div></li>
      <li><span>3</span><div><strong>Protect payment</strong><small>Session-signed private transaction</small></div></li>
    </ol>
  );
}

function ReviewDialog({ recipient, amount, note, noteRetained, onClose, onConfirm, onDiscard, preview, receipt, stage, workflowError }: {
  recipient: string;
  amount: string;
  note: string;
  noteRetained: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onDiscard: (() => void) | null;
  preview: boolean;
  receipt: ProtectedPaymentReceipt | null;
  stage: PaymentStage | "idle" | "error";
  workflowError: WorkflowIssue | null;
}) {
  const busy = stage === "reconciling" || stage === "preparing" || stage === "authenticating" || stage === "opening";
  const actionLabel = stage === "reconciling" ? "Checking payment status…" : stage === "preparing" ? "Preparing on Solana…" : stage === "authenticating" ? "Unlocking private session…" : stage === "opening" ? "Protecting payment…" : workflowError ? workflowError.retryLabel : "Confirm and protect";
  return (
    <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="review-modal" role="dialog" aria-modal="true" aria-label="Review payment" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title"><div><span className="icon-tile"><ShieldCheck size={18} /></span><h2>Review protected payment</h2></div><button className="icon-button" onClick={onClose} aria-label="Close review" disabled={busy}><X size={20} /></button></div>
        <p className="muted">The recipient can acknowledge during the safety window. You can undo before settlement.</p>
        <dl className="review-values">
          <div><dt>Recipient</dt><dd>{shortAddress(recipient, 7)}</dd></div>
          <div><dt>Amount</dt><dd>{amount} test USDC</dd></div>
          <div><dt>Private note</dt><dd>{note || (noteRetained ? "Encrypted note retained" : "No note")}</dd></div>
        </dl>
        {!receipt && <ApprovalSteps />}
        <div className="privacy-note"><LockKeyhole size={16} /><span>Amount, note, and live status stay private while pending. Wallets and timing are public.</span></div>
        {workflowError && <WorkflowIssueNotice issue={workflowError} />}
        {receipt ? (
          <div className="workflow-success"><Check size={18} /><div><strong>Payment protected</strong><small>Share the recipient link from the active-payment card.</small></div></div>
        ) : (
          <button className="primary-action" onClick={onConfirm} disabled={preview || busy}>{preview ? "Preview only" : actionLabel}</button>
        )}
        {!receipt && onDiscard && <button className="secondary-action" onClick={onDiscard} disabled={busy}>Discard unsigned payment</button>}
        {!receipt && <small className="approval-disclosure">Two wallet transaction approvals plus one login message on a new session. Private actions then use the one-hour bounded key.</small>}
      </section>
    </div>
  );
}

function ActivePayment({ onUndo }: { onUndo: () => void }) {
  return (
    <section className="panel active-payment">
      <div className="section-heading"><div><h2>Active payment</h2><span className="status pending">Pending</span></div><button className="text-button">View details <ArrowUpRight size={15} /></button></div>
      <div className="payment-focus">
        <div className="countdown-ring"><strong>03:42</strong><span>remaining</span></div>
        <div className="payment-summary">
          <span className="eyeline">Waiting for recipient</span>
          <strong>125.00 <small>test USDC</small></strong>
          <p>To {shortAddress(PREVIEW_RECIPIENT, 6)}</p>
          <span className="private-label"><Eye size={14} /> Invoice #184 · private</span>
        </div>
        <button className="undo-button" onClick={onUndo}><RotateCcw size={17} /> Undo payment</button>
      </div>
      <div className="time-rail"><span className="complete"><Check size={12} /></span><i /><span className="current" /><i /><span /><div><b>Created</b><b>Acknowledged</b><b>Settled or recovered</b></div></div>
    </section>
  );
}

  export function SenderDashboard({ preview, previewIssue = null, onShowProof }: Props) {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const walletAddress = preview ? "6Etw8jh5pDdn8ZQp2sD1HtxHf42yM8gXrY8NqFzYcm6P" : connected?.account.address ?? null;
  const privateBalance = usePrivateBalance(client, preview ? null : walletAddress);
  const [recipient, setRecipient] = useState(preview ? PREVIEW_RECIPIENT : "");
  const [amount, setAmount] = useState(preview ? "125" : "");
  const [note, setNote] = useState(preview ? "Invoice #184" : "");
  const [reviewing, setReviewing] = useState(Boolean(previewIssue));
  const [undoing, setUndoing] = useState(false);
  const [workflowStage, setWorkflowStage] = useState<PaymentStage | "idle" | "error">(previewIssue ? "error" : "idle");
  const [workflowError, setWorkflowError] = useState<WorkflowIssue | null>(previewIssue);
  const [receipt, setReceipt] = useState<ProtectedPaymentReceipt | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [fundingOpen, setFundingOpen] = useState(false);
  const [fundingAmount, setFundingAmount] = useState("1");
  const [funding, setFunding] = useState(false);
  const [fundingStage, setFundingStage] = useState<FirstFundingStage>("checking");
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false);
  const [balanceKind, setBalanceKind] = useState<BalanceOperationKind>("deposit");
  const [balanceAmount, setBalanceAmount] = useState("1");
  const [balanceCheckpoint, setBalanceCheckpoint] = useState<BalanceOperationCheckpoint | null>(null);
  const [balanceStage, setBalanceStage] = useState<BalanceOperationStage>("reconciling");
  const [balanceWorking, setBalanceWorking] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [savedPayment, setSavedPayment] = useState<SavedPayment | null>(null);
  const [paymentCheckpoint, setPaymentCheckpoint] = useState<PaymentOperationCheckpoint | null>(null);
  const [paymentRecoveryLoaded, setPaymentRecoveryLoaded] = useState(preview);
  const [paymentOwnedElsewhere, setPaymentOwnedElsewhere] = useState(false);
  const [paymentTabId] = useState(() => preview ? "preview" : getPaymentTabId());
  const livePayment = usePrivatePayment(privateBalance.privateClient, walletAddress, savedPayment?.paymentReference ?? null);
  const paymentReceipts = usePaymentReceipts(walletAddress);

  useEffect(() => {
    if (!fundingOpen || !walletAddress || preview) return;
    let active = true;
    const refreshFundingSource = async () => {
      try {
        await discoverUsdcFundingSource(address(walletAddress), 1n);
        if (active) {
          setFundingError((current) => current === "No valid Circle Devnet USDC account was found for this wallet." ? null : current);
        }
      } catch {
        // The submit action owns user-facing errors. This background read only
        // clears the specific stale "not funded" state after external funding.
      }
    };
    void refreshFundingSource();
    window.addEventListener("focus", refreshFundingSource);
    return () => {
      active = false;
      window.removeEventListener("focus", refreshFundingSource);
    };
  }, [fundingOpen, preview, walletAddress]);

  useEffect(() => {
    if (!walletAddress || preview) {
      setSavedPayment(null);
      return;
    }
    const storageKey = `protected-pay:last-payment:${walletAddress}`;
    const readSavedPayment = (raw: string | null) => {
      try {
        const parsed = raw ? JSON.parse(raw) as SavedPayment : null;
        setSavedPayment(parsed?.sender === walletAddress ? parsed : null);
      } catch {
        setSavedPayment(null);
      }
    };
    try {
      const legacy = sessionStorage.getItem(storageKey);
      if (!localStorage.getItem(storageKey) && legacy) localStorage.setItem(storageKey, legacy);
      if (legacy) sessionStorage.removeItem(storageKey);
      readSavedPayment(localStorage.getItem(storageKey));
    } catch {
      setSavedPayment(null);
    }
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key === storageKey) readSavedPayment(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [preview, walletAddress]);

  useEffect(() => {
    let active = true;
    setPaymentRecoveryLoaded(preview);
    if (preview) {
      setPaymentCheckpoint(null);
      setPaymentOwnedElsewhere(false);
      return () => { active = false; };
    }
    if (!walletAddress) {
      setPaymentRecoveryLoaded(true);
      return () => { active = false; };
    }
    const storageKey = paymentOperationKey(walletAddress);
    const leaseKey = paymentOperationLeaseKey(walletAddress);
    const applyCheckpoint = async (raw: string | null) => {
      try {
        const checkpoint = raw ? await validatePaymentOperationCheckpoint(JSON.parse(raw), walletAddress) : null;
        if (!active) return;
        setPaymentCheckpoint(checkpoint);
        if (checkpoint) {
          setRecipient(checkpoint.recipient);
          setAmount(formatUsdc(BigInt(checkpoint.amount)));
          setNote("");
        }
        setPaymentRecoveryLoaded(true);
      } catch {
        localStorage.removeItem(storageKey);
        if (active) {
          setPaymentCheckpoint(null);
          setPaymentRecoveryLoaded(true);
        }
      }
    };
    const updateLease = () => setPaymentOwnedElsewhere(paymentOperationOwnedElsewhere(walletAddress, paymentTabId));
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key === storageKey) void applyCheckpoint(event.newValue);
      if (event.key === leaseKey) updateLease();
    };
    try {
      void applyCheckpoint(migratePaymentOperation(walletAddress));
    } catch {
      setPaymentCheckpoint(null);
      setPaymentRecoveryLoaded(true);
      setWorkflowError(workflowIssueFrom(
        new Error("This browser could not open shared recovery storage."),
        "Protected Pay cannot safely save a resumable payment in this browser.",
      ));
    }
    updateLease();
    window.addEventListener("storage", onStorage);
    const leaseTimer = window.setInterval(updateLease, 2_000);
    return () => {
      active = false;
      window.removeEventListener("storage", onStorage);
      window.clearInterval(leaseTimer);
    };
  }, [paymentTabId, preview, walletAddress]);

  useEffect(() => {
    if (!walletAddress || preview) {
      setBalanceCheckpoint(null);
      return;
    }
    const storageKey = `protected-pay:balance-operation:${walletAddress}`;
    try {
      const raw = sessionStorage.getItem(storageKey);
      const checkpoint = raw ? validateBalanceOperationCheckpoint(JSON.parse(raw), walletAddress) : null;
      setBalanceCheckpoint(checkpoint);
      if (checkpoint) setBalanceKind(checkpoint.kind);
    } catch {
      sessionStorage.removeItem(storageKey);
      setBalanceCheckpoint(null);
    }
  }, [preview, walletAddress]);

  const validation = useMemo(() => {
    try {
      const parsedRecipient = address(recipient);
      if (walletAddress && parsedRecipient === walletAddress) return "Choose a recipient other than your own wallet.";
    } catch {
      return "Enter a valid Solana wallet.";
    }
    let parsedAmount: bigint;
    try { parsedAmount = parseUsdc(amount); } catch { return "Enter an amount greater than zero with up to six decimals."; }
    if (parsedAmount <= 0n) return "Enter an amount greater than zero.";
    return null;
  }, [amount, recipient, walletAddress]);

  const shownBalance = preview ? 2840_500000n : privateBalance.balance?.available ?? 0n;
  const privateBalanceIssue = useMemo(() => {
    if (privateBalance.status !== "error" || !privateBalance.message) return null;
    return workflowIssueFrom(privateBalance.message, "The private balance could not be unlocked.");
  }, [privateBalance.message, privateBalance.status]);
  const activeReference = receipt?.paymentReference ?? savedPayment?.paymentReference ?? null;
  const activeEnvelope = receipt?.memoEnvelope ?? savedPayment?.memoEnvelope ?? null;
  const recipientLink = activeReference ? `${window.location.origin}/pay?payment=${activeReference}${activeEnvelope ? `#memo=${encodeURIComponent(activeEnvelope)}` : ""}` : null;
  const activeAmount = livePayment.payment ? formatUsdc(livePayment.payment.amount) : amount;
  const activeRecipient = livePayment.payment?.recipient ?? recipient;
  const canUndoActive = Boolean(receipt) || livePayment.payment?.status === PaymentStatus.Created || livePayment.payment?.status === PaymentStatus.Acknowledged;
  const canRecoverExpired = !recovered
    && livePayment.payment?.status === PaymentStatus.Expired
    && !livePayment.payment.redacted
    && livePayment.payment.amount > 0n
    && livePayment.payment.sender === walletAddress;
  const hasCurrentPayment = Boolean(receipt)
    || Boolean(
      livePayment.payment
      && !livePayment.payment.redacted
      && livePayment.payment.amount > 0n
      && livePayment.payment.sender === walletAddress,
    );

  useEffect(() => {
    if (hasCurrentPayment) setRecovered(false);
  }, [hasCurrentPayment]);

  async function confirmPayment() {
    if (!connected?.signer || !walletAddress || !paymentRecoveryLoaded || validation) return;
    setWorkflowError(null);
    try {
      if (!acquirePaymentOperationLease(walletAddress, paymentTabId)) {
        setPaymentOwnedElsewhere(true);
        setWorkflowError(crossTabWorkflowIssue());
        return;
      }
    } catch (error) {
      setWorkflowError(workflowIssueFrom(error, "Protected Pay cannot safely coordinate this payment between browser tabs."));
      return;
    }
    setPaymentOwnedElsewhere(false);
    const releaseLease = () => {
      try { releasePaymentOperationLease(walletAddress, paymentTabId); } catch { /* the lease expires automatically */ }
    };
    window.addEventListener("pagehide", releaseLease);
    const heartbeat = window.setInterval(() => {
      try {
        if (!refreshPaymentOperationLease(walletAddress, paymentTabId)) setPaymentOwnedElsewhere(true);
      } catch {
        // The pre-transaction lease assertion below remains the hard safety boundary.
      }
    }, 5_000);
    try {
      let checkpoint = paymentCheckpoint;
      if (!checkpoint) {
        checkpoint = await createPaymentOperationCheckpoint(walletAddress, {
          amount: parseUsdc(amount),
          memo: note,
          recipient: address(recipient),
        });
        persistPaymentCheckpoint(checkpoint);
      }
      setWorkflowStage("authenticating");
      // This authoritative read is deliberately awaited in the transaction path.
      // React state from the unlock render is not a safe financial precondition.
      const privateClient = await privateBalance.requireAvailableBalance(BigInt(checkpoint.amount));
      const result = await runPaymentOperation(
        client,
        privateClient,
        connected.signer,
        checkpoint,
        persistPaymentCheckpoint,
        setWorkflowStage,
        () => {
          if (!refreshPaymentOperationLease(walletAddress, paymentTabId)) {
            throw new Error("The payment coordination lease was lost to another browser tab.");
          }
        },
      );
      recordPaymentReceipt({
        action: "protected",
        amount: checkpoint.amount,
        counterparty: checkpoint.recipient,
        occurredAt: Date.now(),
        payment: result.payment,
        paymentReference: result.paymentReference,
        privateSignature: result.privateSignature,
        publicSignature: result.publicSignature,
        role: "sender",
        wallet: walletAddress,
      });
      setRecovered(false);
      setReceipt(result);
      const saved = { paymentReference: result.paymentReference, memoEnvelope: result.memoEnvelope, sender: walletAddress } satisfies SavedPayment;
      setSavedPayment(saved);
      try {
        localStorage.setItem(`protected-pay:last-payment:${walletAddress}`, JSON.stringify(saved));
        persistPaymentCheckpoint(null);
      } catch {
        // Keep the operation checkpoint so a refresh can reconstruct the receipt safely.
      }
      await privateBalance.refresh();
    } catch (error) {
      setWorkflowStage("error");
      const issue = workflowIssueFrom(error, "The payment could not be protected.");
      if (issue.kind === "authentication-expired") privateBalance.lock();
      setWorkflowError(issue);
    } finally {
      window.clearInterval(heartbeat);
      window.removeEventListener("pagehide", releaseLease);
      releaseLease();
      setPaymentOwnedElsewhere(false);
    }
  }

  function persistPaymentCheckpoint(checkpoint: PaymentOperationCheckpoint | null) {
    setPaymentCheckpoint(checkpoint);
    if (!walletAddress) return;
    try {
      writePaymentOperation(walletAddress, checkpoint);
    } catch {
      if (checkpoint) throw new Error("This browser cannot save the payment recovery checkpoint, so Protected Pay will not broadcast a transaction.");
    }
  }

  function discardUnsentPayment() {
    if (paymentCheckpoint?.publicTransaction || paymentCheckpoint?.privateTransaction) return;
    persistPaymentCheckpoint(null);
    setWorkflowError(null);
    setWorkflowStage("idle");
    setReviewing(false);
  }

  async function confirmUndo() {
    const paymentAddress = receipt?.payment ?? livePayment.paymentAddress;
    if (preview || !paymentAddress || !connected?.signer || !walletAddress || !privateBalance.privateClient) return;
    setCanceling(true);
    setCancelError(null);
    try {
      const signature = await cancelProtectedPayment(privateBalance.privateClient, address(walletAddress), paymentAddress);
      if (activeReference && livePayment.payment) {
        recordPaymentReceipt({
          action: "undone",
          amount: livePayment.payment.amount.toString(),
          counterparty: livePayment.payment.recipient,
          occurredAt: Date.now(),
          payment: paymentAddress,
          paymentReference: activeReference,
          privateSignature: signature,
          publicSignature: receipt?.publicSignature ?? paymentReceipts.find((item) => item.paymentReference === activeReference)?.publicSignature ?? null,
          role: "sender",
          wallet: walletAddress,
        });
      }
      await privateBalance.refresh();
      setReceipt(null);
      setSavedPayment(null);
      try { localStorage.removeItem(`protected-pay:last-payment:${walletAddress}`); } catch { /* persistence is best effort */ }
      setRecovered(true);
      setUndoing(false);
      setReviewing(false);
      setWorkflowStage("idle");
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "The payment could not be recovered.");
    } finally {
      setCanceling(false);
    }
  }

  async function recoverExpiredPayment() {
    if (!canRecoverExpired) return;
    setCanceling(true);
    setCancelError(null);
    try {
      const payment = livePayment.payment;
      const paymentAddress = livePayment.paymentAddress;
      const signature = await livePayment.claim();
      if (signature && payment && paymentAddress && activeReference) {
        recordPaymentReceipt({
          action: "expired-recovered",
          amount: payment.amount.toString(),
          counterparty: payment.recipient,
          occurredAt: Date.now(),
          payment: paymentAddress,
          paymentReference: activeReference,
          privateSignature: signature,
          publicSignature: paymentReceipts.find((item) => item.paymentReference === activeReference)?.publicSignature ?? null,
          role: "sender",
          wallet: walletAddress,
        });
      }
      await privateBalance.refresh();
      setSavedPayment(null);
      try { localStorage.removeItem(`protected-pay:last-payment:${walletAddress}`); } catch { /* persistence is best effort */ }
      setRecovered(true);
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "The expired payment could not be recovered.");
    } finally {
      setCanceling(false);
    }
  }

  async function confirmFunding() {
    if (!connected?.signer || !walletAddress) return;
    setFunding(true);
    setFundingError(null);
    try {
      await fundFirstProtectedBalance(client, connected.signer, address(walletAddress), parseUsdc(fundingAmount), setFundingStage);
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      await privateBalance.refresh();
      setFundingOpen(false);
    } catch (error) {
      setFundingError(error instanceof Error ? error.message : "The protected balance could not be funded.");
    } finally {
      setFunding(false);
    }
  }

  function persistBalanceCheckpoint(checkpoint: BalanceOperationCheckpoint | null) {
    setBalanceCheckpoint(checkpoint);
    if (!walletAddress) return;
    const storageKey = `protected-pay:balance-operation:${walletAddress}`;
    try {
      if (checkpoint) sessionStorage.setItem(storageKey, JSON.stringify(checkpoint));
      else sessionStorage.removeItem(storageKey);
    } catch {
      if (checkpoint) throw new Error("This browser cannot save the recovery checkpoint, so Protected Pay will not broadcast the balance transaction.");
    }
  }

  function openBalanceOperation(kind: BalanceOperationKind) {
    setBalanceKind(balanceCheckpoint?.kind ?? kind);
    setBalanceError(null);
    setBalanceStage("reconciling");
    setBalanceDialogOpen(true);
  }

  async function executeBalanceOperation() {
    if (!connected?.signer || !walletAddress || (!balanceCheckpoint && !privateBalance.balance)) return;
    setBalanceError(null);
    let checkpoint = balanceCheckpoint;
    try {
      if (!checkpoint) {
        checkpoint = createBalanceOperationCheckpoint(walletAddress, balanceKind, parseUsdc(balanceAmount), privateBalance.balance!.available);
        persistBalanceCheckpoint(checkpoint);
      }
      setBalanceWorking(true);
      const privateClient = privateBalance.privateClient ?? await privateBalance.unlock();
      await runBalanceOperation(client, privateClient, connected.signer, checkpoint, persistBalanceCheckpoint, setBalanceStage);
      persistBalanceCheckpoint(null);
      await privateBalance.refresh();
      setBalanceDialogOpen(false);
      setBalanceAmount("1");
    } catch (error) {
      setBalanceError(error instanceof Error ? error.message : "The protected balance operation could not be reconciled.");
    } finally {
      setBalanceWorking(false);
    }
  }

  function discardUnsentBalanceOperation() {
    if (balanceCheckpoint?.returnTransaction || balanceCheckpoint?.mutationTransaction) return;
    persistBalanceCheckpoint(null);
    setBalanceError(null);
    setBalanceDialogOpen(false);
  }

  return (
    <main className="dashboard-main" id="dashboard">
      <header className="page-heading">
        <div><h1>Undo for USDC,<br />before it becomes final.</h1><p>Send test funds with a private safety window for mistakes.</p></div>
        <button className="proof-link" onClick={onShowProof}><FileText size={16} /> View technical proof</button>
      </header>

      {!preview && !connected && (
        <section className="connection-callout"><WalletCards size={22} /><div><strong>{paymentCheckpoint ? "Reconnect the same wallet to resume" : "Connect a Devnet wallet to begin"}</strong><p>{paymentCheckpoint ? `The saved payment for ${shortAddress(paymentCheckpoint.wallet, 7)} will be checked before any transaction is sent.` : "Your wallet stays in control. The interface never stores your keys."}</p></div></section>
      )}

      <div className="dashboard-grid">
        <section className="panel balance-panel">
          <div className="panel-label"><span>Protected balance</span><ShieldCheck size={18} /></div>
          {preview || privateBalance.status === "ready" ? (
            <><strong className="balance-value">{formatUsdc(shownBalance)}</strong><span className="balance-unit">test USDC available</span></>
          ) : (
            <><strong className="balance-value masked">••••••</strong><span className="balance-unit">Private until you unlock it</span></>
          )}
          {!preview && connected && privateBalance.status !== "ready" ? (
            <button className="secondary-action" onClick={() => void privateBalance.unlock().catch(() => undefined)} disabled={privateBalance.status === "loading"}>
              <LockKeyhole size={16} /> {privateBalance.status === "loading" ? "Unlocking…" : "Unlock private balance"}
            </button>
          ) : preview ? <button className="secondary-action" onClick={() => openBalanceOperation("withdraw")}><ArrowDownToLine size={16} /> Withdraw</button>
            : connected && privateBalance.status === "ready" && privateBalance.balance?.exists === false ? <button className="secondary-action" onClick={() => { setFundingError(null); setFundingOpen(true); }}><ArrowDownToLine size={16} /> Set up balance</button>
            : connected && privateBalance.status === "ready" && privateBalance.balance?.exists ? <div className="balance-actions"><button className="secondary-action" onClick={() => openBalanceOperation("deposit")}><ArrowUpFromLine size={16} /> Add funds</button><button className="secondary-action" onClick={() => openBalanceOperation("withdraw")} disabled={shownBalance === 0n}><ArrowDownToLine size={16} /> Withdraw</button></div>
            : null}
          {!preview && connected && privateBalance.status === "ready" && <button className="balance-recovery" onClick={() => void privateBalance.endSession().catch(() => undefined)}><LockKeyhole size={15} /> End private session</button>}
          {balanceCheckpoint && !preview && <button className="balance-recovery" onClick={() => openBalanceOperation(balanceCheckpoint.kind)}><RotateCcw size={15} /> Resume {balanceCheckpoint.kind === "deposit" ? "top-up" : "withdrawal"}</button>}
          {privateBalanceIssue && !preview ? <WorkflowIssueNotice issue={privateBalanceIssue} /> : privateBalance.message && !preview ? <p className="inline-message">{privateBalance.message}</p> : null}
        </section>

        <section className="panel composer-panel" id="send">
          <div className="panel-label"><span>Send protected payment</span><Clock3 size={18} /></div>
          {paymentOwnedElsewhere && <WorkflowIssueNotice issue={crossTabWorkflowIssue()} />}
          {workflowError && !reviewing && !paymentOwnedElsewhere && <WorkflowIssueNotice issue={workflowError} />}
          <label>Recipient wallet<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Solana wallet address" disabled={!preview && (!connected || !paymentRecoveryLoaded || paymentOwnedElsewhere || Boolean(balanceCheckpoint) || Boolean(paymentCheckpoint))} /></label>
          <div className="form-row"><label>Amount<div className="input-suffix"><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" disabled={!preview && (!connected || !paymentRecoveryLoaded || paymentOwnedElsewhere || Boolean(balanceCheckpoint) || Boolean(paymentCheckpoint))} /><span>USDC</span></div></label><label>Settlement window<select value="60" disabled><option value="60">1 minute after opening</option></select></label></div>
          <label>Private note <span className="optional">Optional</span><input value={note} maxLength={64} onChange={(event) => setNote(event.target.value)} placeholder={paymentCheckpoint?.memoEnvelope ? "Encrypted note retained" : "What is this for?"} disabled={!preview && (!connected || !paymentRecoveryLoaded || paymentOwnedElsewhere || Boolean(balanceCheckpoint) || Boolean(paymentCheckpoint))} /></label>
          <button className="primary-action" onClick={() => !validation && setReviewing(true)} disabled={Boolean(validation) || (!preview && (!connected || !paymentRecoveryLoaded || paymentOwnedElsewhere || Boolean(balanceCheckpoint)))}>{!preview && connected && !paymentRecoveryLoaded ? "Checking saved payment…" : paymentOwnedElsewhere ? "Continue in other tab" : paymentCheckpoint ? "Resume payment" : "Review payment"} <ArrowUpRight size={16} /></button>
          <small className="privacy-copy"><LockKeyhole size={14} /> Amount, note, and live status stay private while pending.</small>
        </section>
      </div>

      {preview ? <ActivePayment onUndo={() => setUndoing(true)} /> : recovered ? (
        <section className="panel confirmed-payment recovered-payment"><span className="icon-tile success"><RotateCcw size={19} /></span><div><h2>Payment recovered</h2><p>The test USDC is back in your protected balance.</p></div></section>
      ) : receipt || livePayment.payment ? (
        <section className="panel confirmed-payment"><span className="icon-tile success">{canRecoverExpired ? <RotateCcw size={19} /> : <Check size={19} />}</span><div><h2>{canRecoverExpired ? "Payment expired safely" : receipt ? "Payment protected" : "Payment restored"}</h2><p>{canRecoverExpired ? "The recipient did not acknowledge in time. Recover the test USDC to your protected balance." : ` ${activeAmount} test USDC to ${shortAddress(activeRecipient, 7)}. Share this private-view link with the intended recipient.`}</p>{recipientLink && <code>{recipientLink}</code>}{cancelError && <p className="workflow-error" role="alert">{cancelError}</p>}</div><div className="confirmed-actions"><button className="secondary-action" onClick={() => recipientLink && navigator.clipboard.writeText(recipientLink)} disabled={!recipientLink}>Copy link</button>{canUndoActive && <button className="undo-button" onClick={() => setUndoing(true)}><RotateCcw size={16} /> Undo</button>}{canRecoverExpired && <button className="undo-button" onClick={recoverExpiredPayment} disabled={canceling}><RotateCcw size={16} /> {canceling ? "Recovering…" : "Recover expired"}</button>}</div></section>
      ) : (
        <section className="panel empty-payment"><span className="icon-tile"><Clock3 size={19} /></span><div><h2>No active payment</h2><p>Protected payments that need your attention will appear here.</p></div></section>
      )}

      <section className="activity-section" id="activity">
        <div className="section-heading"><h2>Recent activity</h2><button className="text-button">View all</button></div>
        <div className="activity-table">
          <div className="activity-head"><span>Payment</span><span>Status</span><span>Amount</span><span>Date</span></div>
          {paymentReceipts.length > 0 ? paymentReceipts.slice(0, 5).map((item) => {
            const presentation = receiptPresentation(item);
            return <div className="activity-row" key={`${item.action}:${item.privateSignature}`}><span><b>{presentation.label}</b><small>With {shortAddress(item.counterparty, 5)} · Private receipt {shortAddress(item.privateSignature, 5)}</small></span><span><em className={`status ${presentation.statusClass}`}>{presentation.status}</em></span><strong>{formatUsdc(BigInt(item.amount))} USDC</strong><span>{new Date(item.occurredAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span></div>;
          }) : preview ? <>
            <div className="activity-row"><span><b>To {shortAddress(PREVIEW_RECIPIENT, 5)}</b><small>Invoice #184</small></span><span><em className="status pending">Pending</em></span><strong>125.00 USDC</strong><span>Today, 14:32</span></div>
            <div className="activity-row"><span><b>To 8Pjz…mL2q</b><small>Design retainer</small></span><span><em className="status settled">Settled</em></span><strong>420.00 USDC</strong><span>Sep 7, 10:18</span></div>
            <div className="activity-row"><span><b>To C4vQ…9zaK</b><small>Wrong address recovered</small></span><span><em className="status recovered">Recovered</em></span><strong>58.00 USDC</strong><span>Sep 5, 18:05</span></div>
          </> : <div className="activity-empty">No captured payment receipts in this browser yet.</div>}
        </div>
      </section>

      <footer className="disclosure"><strong>Test funds only.</strong><span>Built on Solana Devnet with a MagicBlock private execution layer.</span></footer>
      {reviewing && <ReviewDialog recipient={recipient} amount={amount} note={note} noteRetained={Boolean(paymentCheckpoint?.memoEnvelope)} onClose={() => setReviewing(false)} onConfirm={confirmPayment} onDiscard={paymentCheckpoint && !paymentCheckpoint.publicTransaction && !paymentCheckpoint.privateTransaction ? discardUnsentPayment : null} preview={preview} receipt={receipt} stage={workflowStage} workflowError={workflowError} />}
      {undoing && <div className="modal-backdrop" onMouseDown={() => !canceling && setUndoing(false)}><section className="review-modal compact" role="dialog" aria-modal="true" aria-label="Undo payment" onMouseDown={(event) => event.stopPropagation()}><span className="danger-icon"><RotateCcw size={20} /></span><h2>Undo this payment?</h2><p>The {activeAmount} test USDC returns to your protected balance. The recipient will no longer be able to claim it.</p>{cancelError && <p className="workflow-error" role="alert">{cancelError}</p>}<button className="danger-action" onClick={confirmUndo} disabled={preview || !(receipt?.payment ?? livePayment.paymentAddress) || canceling}>{preview ? "Preview only" : canceling ? "Recovering…" : "Undo and recover funds"}</button><button className="secondary-action" onClick={() => setUndoing(false)} disabled={canceling}>Keep payment</button></section></div>}
      {fundingOpen && <div className="modal-backdrop" onMouseDown={() => !funding && setFundingOpen(false)}><section className="review-modal compact" role="dialog" aria-modal="true" aria-label="Set up protected balance" onMouseDown={(event) => event.stopPropagation()}><span className="icon-tile large"><WalletCards size={22} /></span><h2>Set up protected balance</h2><p>First deposit Circle Devnet USDC, then approve a separate privacy step. Each transaction is checked before Phantom opens.</p><label className="modal-field">Amount<div className="input-suffix"><input value={fundingAmount} onChange={(event) => setFundingAmount(event.target.value)} inputMode="decimal" disabled={funding} /><span>USDC</span></div></label>{funding && <p className="funding-progress" role="status">{fundingStage === "checking" ? "Checking your Devnet balance…" : fundingStage === "depositing" ? "Step 1 of 2 — approve the USDC deposit" : fundingStage === "delegating" ? "Step 2 of 2 — approve privacy protection" : "Protected balance ready"}</p>}{fundingError && <p className="workflow-error" role="alert">{fundingError}</p>}<button className="primary-action" onClick={confirmFunding} disabled={funding}>{funding ? fundingStage === "delegating" ? "Waiting for privacy approval…" : "Waiting for deposit approval…" : fundingError ? "Check again and set up" : "Start safe setup"}</button><a className="faucet-link" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Need test USDC? Open Circle Faucet <ArrowUpRight size={14} /></a><button className="secondary-action" onClick={() => setFundingOpen(false)} disabled={funding}>Cancel</button></section></div>}
      {balanceDialogOpen && <BalanceOperationDialog amount={balanceAmount} checkpoint={balanceCheckpoint} error={balanceError} kind={balanceKind} onAmountChange={setBalanceAmount} onClose={() => setBalanceDialogOpen(false)} onDiscard={discardUnsentBalanceOperation} onSubmit={executeBalanceOperation} preview={preview} stage={balanceStage} wallet={walletAddress ?? "Not connected"} working={balanceWorking} />}
    </main>
  );
}
