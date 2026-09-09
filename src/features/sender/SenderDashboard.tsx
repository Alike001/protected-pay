import {
  ArrowDownToLine,
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
import { useMemo, useState } from "react";
import { usePrivateBalance } from "../../hooks/usePrivateBalance";
import { formatUsdc, shortAddress } from "../../lib/format";
import type { AppClient } from "../../providers";

const PREVIEW_RECIPIENT = "Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ";

type Props = { preview: boolean; onShowProof: () => void };

function ApprovalSteps() {
  return (
    <ol className="approval-steps">
      <li><span>1</span><div><strong>Prepare protection</strong><small>Public Solana transaction</small></div></li>
      <li><span>2</span><div><strong>Private session</strong><small>One message, only when needed</small></div></li>
      <li><span>3</span><div><strong>Protect payment</strong><small>Private transaction</small></div></li>
    </ol>
  );
}

function ReviewDialog({ recipient, amount, note, onClose }: { recipient: string; amount: string; note: string; onClose: () => void }) {
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
        <ApprovalSteps />
        <div className="privacy-note"><LockKeyhole size={16} /><span>Amount, note, and live status stay private while pending. Wallets and timing are public.</span></div>
        <button className="primary-action" disabled>Transaction adapter coming next</button>
        <small className="approval-disclosure">Two transaction approvals. A one-time session signature may also appear.</small>
      </section>
    </div>
  );
}

function ActivePayment({ onUndo }: { onUndo: () => void }) {
  return (
    <section className="panel active-payment">
      <div className="section-heading"><div><h2>Active payment</h2><span className="status pending">Pending</span></div><button className="text-button">View details <ArrowUpRight size={15} /></button></div>
      <div className="payment-focus">
        <div className="countdown-ring"><strong>08:42</strong><span>remaining</span></div>
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

  const validation = useMemo(() => {
    if (recipient.length < 32) return "Enter a valid Solana wallet.";
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return "Enter an amount greater than zero.";
    return null;
  }, [recipient, amount]);

  const shownBalance = preview ? 2840_500000n : privateBalance.balance?.available ?? 0n;

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
          ) : (
            <button className="secondary-action" disabled={!connected && !preview}><ArrowDownToLine size={16} /> Withdraw</button>
          )}
          {privateBalance.message && !preview && <p className="inline-message">{privateBalance.message}</p>}
        </section>

        <section className="panel composer-panel">
          <div className="panel-label"><span>Send protected payment</span><Clock3 size={18} /></div>
          <label>Recipient wallet<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Solana wallet address" disabled={!preview && !connected} /></label>
          <div className="form-row"><label>Amount<div className="input-suffix"><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" disabled={!preview && !connected} /><span>USDC</span></div></label><label>Safety window<select defaultValue="10" disabled={!preview && !connected}><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="30">30 minutes</option></select></label></div>
          <label>Private note <span className="optional">Optional</span><input value={note} maxLength={64} onChange={(event) => setNote(event.target.value)} placeholder="What is this for?" disabled={!preview && !connected} /></label>
          <button className="primary-action" onClick={() => !validation && setReviewing(true)} disabled={Boolean(validation) || (!preview && !connected)}>Review payment <ArrowUpRight size={16} /></button>
          <small className="privacy-copy"><LockKeyhole size={14} /> Amount, note, and live status stay private while pending.</small>
        </section>
      </div>

      {preview ? <ActivePayment onUndo={() => setUndoing(true)} /> : (
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
      {reviewing && <ReviewDialog recipient={recipient} amount={amount} note={note} onClose={() => setReviewing(false)} />}
      {undoing && <div className="modal-backdrop" onMouseDown={() => setUndoing(false)}><section className="review-modal compact" role="dialog" onMouseDown={(event) => event.stopPropagation()}><span className="danger-icon"><RotateCcw size={20} /></span><h2>Undo this payment?</h2><p>The 125.00 test USDC returns to your protected balance. The recipient will no longer be able to claim it.</p><button className="danger-action" disabled>Recovery adapter coming next</button><button className="secondary-action" onClick={() => setUndoing(false)}>Keep payment</button></section></div>}
    </main>
  );
}
