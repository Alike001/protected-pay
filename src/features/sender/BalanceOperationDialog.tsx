import { ArrowDownToLine, ArrowUpFromLine, LockKeyhole, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { BalanceOperationCheckpoint, BalanceOperationKind, BalanceOperationStage } from "../../lib/balanceOperation";
import { formatUsdc, shortAddress } from "../../lib/format";

const STAGE_LABELS: Record<BalanceOperationStage, string> = {
  reconciling: "Checking authoritative state…",
  returning: "Approve private balance return…",
  "waiting-return": "Waiting for Solana finalization…",
  mutating: "Approve USDC update and re-protection…",
  "waiting-private": "Verifying the private balance…",
  complete: "Balance updated",
};

export function BalanceOperationDialog({
  amount,
  checkpoint,
  error,
  kind,
  onAmountChange,
  onClose,
  onDiscard,
  onSubmit,
  preview,
  stage,
  wallet,
  working,
}: {
  amount: string;
  checkpoint: BalanceOperationCheckpoint | null;
  error: string | null;
  kind: BalanceOperationKind;
  onAmountChange: (value: string) => void;
  onClose: () => void;
  onDiscard: () => void;
  onSubmit: () => void;
  preview: boolean;
  stage: BalanceOperationStage;
  wallet: string;
  working: boolean;
}) {
  const withdrawing = kind === "withdraw";
  const Icon = withdrawing ? ArrowDownToLine : ArrowUpFromLine;
  const fixedAmount = checkpoint ? formatUsdc(BigInt(checkpoint.amount)) : null;
  const hasSignedCheckpoint = Boolean(checkpoint?.returnTransaction || checkpoint?.mutationTransaction);
  return (
    <div className="modal-backdrop" onMouseDown={() => !working && onClose()}>
      <section className="review-modal" role="dialog" aria-modal="true" aria-label={withdrawing ? "Withdraw protected balance" : "Add protected balance"} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title"><div><span className="icon-tile"><Icon size={18} /></span><h2>{withdrawing ? "Withdraw test USDC" : "Add test USDC"}</h2></div><button className="icon-button" onClick={onClose} disabled={working} aria-label="Close balance operation"><X size={20} /></button></div>
        <p className="muted">{withdrawing ? "Move available test USDC back to your wallet, then automatically re-protect the remaining balance." : "Move more Circle Devnet USDC into your existing protected balance."}</p>
        <label className="modal-field">Amount<div className="input-suffix"><input value={fixedAmount ?? amount} onChange={(event) => onAmountChange(event.target.value)} inputMode="decimal" disabled={Boolean(checkpoint) || working} /><span>USDC</span></div></label>
        <dl className="review-values balance-summary">
          <div><dt>Network</dt><dd>Solana Devnet</dd></div>
          <div><dt>Wallet &amp; fee payer</dt><dd>{shortAddress(wallet, 7)}</dd></div>
          <div><dt>{withdrawing ? "Destination" : "Source"}</dt><dd>{shortAddress(wallet, 7)}</dd></div>
          <div><dt>Asset</dt><dd>Circle test USDC</dd></div>
        </dl>
        <ol className="approval-steps two-step">
          <li><span>1</span><div><strong>Return the balance account</strong><small>Private transaction; USDC does not move yet</small></div></li>
          <li><span>2</span><div><strong>{withdrawing ? "Withdraw and re-protect" : "Deposit and re-protect"}</strong><small>Public Solana transaction</small></div></li>
        </ol>
        <div className="privacy-note"><LockKeyhole size={16} /><span>Balance management is public: the aggregate balance snapshot, amount, wallet, and timing become observable during this operation.</span></div>
        {checkpoint && <div className="recovery-note"><RotateCcw size={16} /><span><strong>Safe recovery checkpoint found.</strong><br />Protected Pay checks its saved signature and authoritative balance before deciding whether another approval is needed.</span></div>}
        {working && <div className="workflow-progress"><ShieldCheck size={17} /><span>{STAGE_LABELS[stage]}</span></div>}
        {error && <p className="workflow-error" role="alert">{error}</p>}
        <button className="primary-action" onClick={onSubmit} disabled={working || preview}>{preview ? "Preview only" : working ? STAGE_LABELS[stage] : checkpoint ? "Resume safely" : withdrawing ? "Review and withdraw" : "Review and add funds"}</button>
        <small className="approval-disclosure">Up to two transaction approvals. A private-session message may appear first.</small>
        {checkpoint && !hasSignedCheckpoint && <button className="discard-operation" onClick={onDiscard}>Discard unsent operation</button>}
      </section>
    </div>
  );
}
