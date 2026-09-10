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
import { cancelProtectedPayment, fundFirstProtectedBalance, openProtectedPayment, type PaymentStage, type ProtectedPaymentReceipt } from "../../lib/paymentWorkflow";
import type { AppClient } from "../../client";
import { BalanceOperationDialog } from "./BalanceOperationDialog";

const PREVIEW_RECIPIENT = "Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ";

type Props = { preview: boolean; onShowProof: () => void };
type SavedPayment = { paymentReference: string; memoEnvelope: string | null; sender: string };

function ApprovalSteps() {
  return (
    <ol className="approval-steps">
      <li><span>1</span><div><strong>Prepare protection</strong><small>Public Solana transaction</small></div></li>
      <li><span>2</span><div><strong>Private session</strong><small>One message, only when needed</small></div></li>
      <li><span>3</span><div><strong>Protect payment</strong><small>Private transaction</small></div></li>
    </ol>
  );
}

function ReviewDialog({ recipient, amount, note, onClose, onConfirm, preview, receipt, stage, workflowError }: {
  recipient: string;
  amount: string;
  note: string;
  onClose: () => void;
  onConfirm: () => void;
  preview: boolean;
  receipt: ProtectedPaymentReceipt | null;
  stage: PaymentStage | "idle" | "error";
  workflowError: string | null;
}) {
  const busy = stage === "preparing" || stage === "authenticating" || stage === "opening";
  const actionLabel = stage === "preparing" ? "Preparing on Solana…" : stage === "authenticating" ? "Unlocking private session…" : stage === "opening" ? "Protecting payment…" : "Confirm and protect";
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="review-modal" role="dialog" aria-modal="true" aria-label="Review payment" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title"><div><span className="icon-tile"><ShieldCheck size={18} /></span><h2>Review protected payment</h2></div><button className="icon-button" onClick={onClose} aria-label="Close review"><X size={20} /></button></div>
        <p className="muted">The recipient can acknowledge during the safety window. You can undo before settlement.</p>
        <dl className="review-values">
          <div><dt>Recipient</dt><dd>{shortAddress(recipient, 7)}</dd></div>
          <div><dt>Amount</dt><dd>{amount} test USDC</dd></div>
          <div><dt>Private note</dt><dd>{note || "No note"}</dd></div>
        </dl>
        {!receipt && <ApprovalSteps />}
        <div className="privacy-note"><LockKeyhole size={16} /><span>Amount, note, and live status stay private while pending. Wallets and timing are public.</span></div>
        {workflowError && <p className="workflow-error" role="alert">{workflowError}</p>}
        {receipt ? (
          <div className="workflow-success"><Check size={18} /><div><strong>Payment protected</strong><small>Share the recipient link from the active-payment card.</small></div></div>
        ) : (
          <button className="primary-action" onClick={onConfirm} disabled={preview || busy}>{preview ? "Preview only" : actionLabel}</button>
        )}
        {!receipt && <small className="approval-disclosure">Two transaction approvals. A one-time session signature may also appear.</small>}
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

export function SenderDashboard({ preview, onShowProof }: Props) {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const walletAddress = preview ? "6Etw8jh5pDdn8ZQp2sD1HtxHf42yM8gXrY8NqFzYcm6P" : connected?.account.address ?? null;
  const privateBalance = usePrivateBalance(client, preview ? null : walletAddress);
  const [recipient, setRecipient] = useState(preview ? PREVIEW_RECIPIENT : "");
  const [amount, setAmount] = useState(preview ? "125" : "");
  const [note, setNote] = useState(preview ? "Invoice #184" : "");
  const [reviewing, setReviewing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [workflowStage, setWorkflowStage] = useState<PaymentStage | "idle" | "error">("idle");
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ProtectedPaymentReceipt | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [fundingOpen, setFundingOpen] = useState(false);
  const [fundingAmount, setFundingAmount] = useState("1");
  const [funding, setFunding] = useState(false);
  const [fundingError, setFundingError] = useState<string | null>(null);
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false);
  const [balanceKind, setBalanceKind] = useState<BalanceOperationKind>("deposit");
  const [balanceAmount, setBalanceAmount] = useState("1");
  const [balanceCheckpoint, setBalanceCheckpoint] = useState<BalanceOperationCheckpoint | null>(null);
  const [balanceStage, setBalanceStage] = useState<BalanceOperationStage>("reconciling");
  const [balanceWorking, setBalanceWorking] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [savedPayment, setSavedPayment] = useState<SavedPayment | null>(null);
  const livePayment = usePrivatePayment(privateBalance.privateClient, walletAddress, savedPayment?.paymentReference ?? null);

  useEffect(() => {
    if (!walletAddress || preview) {
      setSavedPayment(null);
      return;
    }
    try {
      const raw = sessionStorage.getItem(`protected-pay:last-payment:${walletAddress}`);
      const parsed = raw ? JSON.parse(raw) as SavedPayment : null;
      setSavedPayment(parsed?.sender === walletAddress ? parsed : null);
    } catch {
      setSavedPayment(null);
    }
  }, [preview, walletAddress]);

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
    if (!preview && privateBalance.balance && parsedAmount > privateBalance.balance.available) return "Amount exceeds your protected balance.";
    return null;
  }, [amount, preview, privateBalance.balance, recipient, walletAddress]);

  const shownBalance = preview ? 2840_500000n : privateBalance.balance?.available ?? 0n;
  const activeReference = receipt?.paymentReference ?? savedPayment?.paymentReference ?? null;
  const activeEnvelope = receipt?.memoEnvelope ?? savedPayment?.memoEnvelope ?? null;
  const recipientLink = activeReference ? `${window.location.origin}/?payment=${activeReference}${activeEnvelope ? `#memo=${encodeURIComponent(activeEnvelope)}` : ""}` : null;
  const activeAmount = livePayment.payment ? formatUsdc(livePayment.payment.amount) : amount;
  const activeRecipient = livePayment.payment?.recipient ?? recipient;
  const canUndoActive = Boolean(receipt) || livePayment.payment?.status === PaymentStatus.Created || livePayment.payment?.status === PaymentStatus.Acknowledged;
  const canRecoverExpired = livePayment.payment?.status === PaymentStatus.Expired && livePayment.payment.sender === walletAddress;

  async function confirmPayment() {
    if (!connected?.signer || !walletAddress || validation) return;
    setWorkflowError(null);
    try {
      setWorkflowStage("authenticating");
      const privateClient = privateBalance.privateClient ?? await privateBalance.unlock();
      const result = await openProtectedPayment(
        client,
        privateClient,
        connected.signer,
        address(walletAddress),
        { amount: parseUsdc(amount), memo: note, recipient: address(recipient) },
        setWorkflowStage,
      );
      setReceipt(result);
      const saved = { paymentReference: result.paymentReference, memoEnvelope: result.memoEnvelope, sender: walletAddress } satisfies SavedPayment;
      setSavedPayment(saved);
      try { sessionStorage.setItem(`protected-pay:last-payment:${walletAddress}`, JSON.stringify(saved)); } catch { /* persistence is best effort */ }
      await privateBalance.refresh();
    } catch (error) {
      setWorkflowStage("error");
      setWorkflowError(error instanceof Error ? error.message : "The payment could not be protected.");
    }
  }

  async function confirmUndo() {
    const paymentAddress = receipt?.payment ?? livePayment.paymentAddress;
    if (preview || !paymentAddress || !connected?.signer || !walletAddress || !privateBalance.privateClient) return;
    setCanceling(true);
    setCancelError(null);
    try {
      await cancelProtectedPayment(privateBalance.privateClient, connected.signer, address(walletAddress), paymentAddress);
      await privateBalance.refresh();
      setReceipt(null);
      setSavedPayment(null);
      try { sessionStorage.removeItem(`protected-pay:last-payment:${walletAddress}`); } catch { /* persistence is best effort */ }
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
      await livePayment.claim();
      await privateBalance.refresh();
      setSavedPayment(null);
      try { sessionStorage.removeItem(`protected-pay:last-payment:${walletAddress}`); } catch { /* persistence is best effort */ }
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
      await fundFirstProtectedBalance(client, connected.signer, address(walletAddress), parseUsdc(fundingAmount));
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
    <main className="dashboard-main">
      <header className="page-heading">
        <div><h1>Undo for USDC,<br />before it becomes final.</h1><p>Send test funds with a private safety window for mistakes.</p></div>
        <button className="proof-link" onClick={onShowProof}><FileText size={16} /> View technical proof</button>
      </header>

      {!preview && !connected && (
        <section className="connection-callout"><WalletCards size={22} /><div><strong>Connect a Devnet wallet to begin</strong><p>Your wallet stays in control. The interface never stores your keys.</p></div></section>
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
            <button className="secondary-action" onClick={privateBalance.unlock} disabled={privateBalance.status === "loading"}>
              <LockKeyhole size={16} /> {privateBalance.status === "loading" ? "Unlocking…" : "Unlock private balance"}
            </button>
          ) : preview ? <button className="secondary-action" onClick={() => openBalanceOperation("withdraw")}><ArrowDownToLine size={16} /> Withdraw</button>
            : connected && privateBalance.status === "ready" && privateBalance.balance?.exists === false ? <button className="secondary-action" onClick={() => setFundingOpen(true)}><ArrowDownToLine size={16} /> Set up balance</button>
            : connected && privateBalance.status === "ready" && privateBalance.balance?.exists ? <div className="balance-actions"><button className="secondary-action" onClick={() => openBalanceOperation("deposit")}><ArrowUpFromLine size={16} /> Add funds</button><button className="secondary-action" onClick={() => openBalanceOperation("withdraw")} disabled={shownBalance === 0n}><ArrowDownToLine size={16} /> Withdraw</button></div>
            : null}
          {balanceCheckpoint && !preview && <button className="balance-recovery" onClick={() => openBalanceOperation(balanceCheckpoint.kind)}><RotateCcw size={15} /> Resume {balanceCheckpoint.kind === "deposit" ? "top-up" : "withdrawal"}</button>}
          {privateBalance.message && !preview && <p className="inline-message">{privateBalance.message}</p>}
        </section>

        <section className="panel composer-panel">
          <div className="panel-label"><span>Send protected payment</span><Clock3 size={18} /></div>
          <label>Recipient wallet<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Solana wallet address" disabled={!preview && (!connected || Boolean(balanceCheckpoint))} /></label>
          <div className="form-row"><label>Amount<div className="input-suffix"><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" disabled={!preview && (!connected || Boolean(balanceCheckpoint))} /><span>USDC</span></div></label><label>Settlement window<select value="60" disabled><option value="60">1 minute after opening</option></select></label></div>
          <label>Private note <span className="optional">Optional</span><input value={note} maxLength={64} onChange={(event) => setNote(event.target.value)} placeholder="What is this for?" disabled={!preview && (!connected || Boolean(balanceCheckpoint))} /></label>
          <button className="primary-action" onClick={() => !validation && setReviewing(true)} disabled={Boolean(validation) || (!preview && (!connected || Boolean(balanceCheckpoint)))}>Review payment <ArrowUpRight size={16} /></button>
          <small className="privacy-copy"><LockKeyhole size={14} /> Amount, note, and live status stay private while pending.</small>
        </section>
      </div>

      {preview ? <ActivePayment onUndo={() => setUndoing(true)} /> : receipt || livePayment.payment ? (
        <section className="panel confirmed-payment"><span className="icon-tile success">{canRecoverExpired ? <RotateCcw size={19} /> : <Check size={19} />}</span><div><h2>{canRecoverExpired ? "Payment expired safely" : receipt ? "Payment protected" : "Payment restored"}</h2><p>{canRecoverExpired ? "The recipient did not acknowledge in time. Recover the test USDC to your protected balance." : ` ${activeAmount} test USDC to ${shortAddress(activeRecipient, 7)}. Share this private-view link with the intended recipient.`}</p>{recipientLink && <code>{recipientLink}</code>}{cancelError && <p className="workflow-error" role="alert">{cancelError}</p>}</div><div className="confirmed-actions"><button className="secondary-action" onClick={() => recipientLink && navigator.clipboard.writeText(recipientLink)} disabled={!recipientLink}>Copy link</button>{canUndoActive && <button className="undo-button" onClick={() => setUndoing(true)}><RotateCcw size={16} /> Undo</button>}{canRecoverExpired && <button className="undo-button" onClick={recoverExpiredPayment} disabled={canceling}><RotateCcw size={16} /> {canceling ? "Recovering…" : "Recover expired"}</button>}</div></section>
      ) : recovered ? (
        <section className="panel confirmed-payment recovered-payment"><span className="icon-tile success"><RotateCcw size={19} /></span><div><h2>Payment recovered</h2><p>The test USDC is back in your protected balance.</p></div></section>
      ) : (
        <section className="panel empty-payment"><span className="icon-tile"><Clock3 size={19} /></span><div><h2>No active payment</h2><p>Protected payments that need your attention will appear here.</p></div></section>
      )}

      <section className="activity-section">
        <div className="section-heading"><h2>Recent activity</h2><button className="text-button">View all</button></div>
        <div className="activity-table">
          <div className="activity-head"><span>Payment</span><span>Status</span><span>Amount</span><span>Date</span></div>
          {preview ? <>
            <div className="activity-row"><span><b>To {shortAddress(PREVIEW_RECIPIENT, 5)}</b><small>Invoice #184</small></span><span><em className="status pending">Pending</em></span><strong>125.00 USDC</strong><span>Today, 14:32</span></div>
            <div className="activity-row"><span><b>To 8Pjz…mL2q</b><small>Design retainer</small></span><span><em className="status settled">Settled</em></span><strong>420.00 USDC</strong><span>Sep 7, 10:18</span></div>
            <div className="activity-row"><span><b>To C4vQ…9zaK</b><small>Wrong address recovered</small></span><span><em className="status recovered">Recovered</em></span><strong>58.00 USDC</strong><span>Sep 5, 18:05</span></div>
          </> : <div className="activity-empty">No payments in this browser session.</div>}
        </div>
      </section>

      <footer className="disclosure"><strong>Test funds only.</strong><span>Built on Solana Devnet with a MagicBlock private execution layer.</span></footer>
      {reviewing && <ReviewDialog recipient={recipient} amount={amount} note={note} onClose={() => setReviewing(false)} onConfirm={confirmPayment} preview={preview} receipt={receipt} stage={workflowStage} workflowError={workflowError} />}
      {undoing && <div className="modal-backdrop" onMouseDown={() => !canceling && setUndoing(false)}><section className="review-modal compact" role="dialog" aria-modal="true" aria-label="Undo payment" onMouseDown={(event) => event.stopPropagation()}><span className="danger-icon"><RotateCcw size={20} /></span><h2>Undo this payment?</h2><p>The {activeAmount} test USDC returns to your protected balance. The recipient will no longer be able to claim it.</p>{cancelError && <p className="workflow-error" role="alert">{cancelError}</p>}<button className="danger-action" onClick={confirmUndo} disabled={preview || !(receipt?.payment ?? livePayment.paymentAddress) || canceling}>{preview ? "Preview only" : canceling ? "Recovering…" : "Undo and recover funds"}</button><button className="secondary-action" onClick={() => setUndoing(false)} disabled={canceling}>Keep payment</button></section></div>}
      {fundingOpen && <div className="modal-backdrop" onMouseDown={() => !funding && setFundingOpen(false)}><section className="review-modal compact" role="dialog" aria-modal="true" aria-label="Set up protected balance" onMouseDown={(event) => event.stopPropagation()}><span className="icon-tile large"><WalletCards size={22} /></span><h2>Set up protected balance</h2><p>Move Circle Devnet USDC into Protected Pay and make the balance private in one transaction.</p><label className="modal-field">Amount<div className="input-suffix"><input value={fundingAmount} onChange={(event) => setFundingAmount(event.target.value)} inputMode="decimal" /><span>USDC</span></div></label>{fundingError && <p className="workflow-error" role="alert">{fundingError}</p>}<button className="primary-action" onClick={confirmFunding} disabled={funding}>{funding ? "Setting up…" : "Approve setup and deposit"}</button><a className="faucet-link" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Need test USDC? Open Circle Faucet <ArrowUpRight size={14} /></a><button className="secondary-action" onClick={() => setFundingOpen(false)} disabled={funding}>Cancel</button></section></div>}
      {balanceDialogOpen && <BalanceOperationDialog amount={balanceAmount} checkpoint={balanceCheckpoint} error={balanceError} kind={balanceKind} onAmountChange={setBalanceAmount} onClose={() => setBalanceDialogOpen(false)} onDiscard={discardUnsentBalanceOperation} onSubmit={executeBalanceOperation} preview={preview} stage={balanceStage} wallet={walletAddress ?? "Not connected"} working={balanceWorking} />}
    </main>
  );
}
