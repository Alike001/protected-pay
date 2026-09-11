import { Copy, ExternalLink, LockKeyhole, X } from "lucide-react";
import { MAGIC_ROUTER_RPC, PRIVATE_ER_ORIGIN, PROGRAM_ID, PROOF } from "../lib/constants";
import { formatUsdc, shortAddress } from "../lib/format";
import { usePaymentReceipts, type PaymentReceiptAction } from "../lib/paymentReceiptStorage";

function actionLabel(action: PaymentReceiptAction) {
  if (action === "protected") return "Protected payment opened";
  if (action === "undone") return "Payment undone";
  if (action === "expired-recovered") return "Expired payment recovered";
  if (action === "acknowledged") return "Recipient acknowledged";
  return "Recipient claimed";
}

export function ProofDrawer({ open, onClose, walletAddress }: { open: boolean; onClose: () => void; walletAddress: string | null }) {
  const receipts = usePaymentReceipts(walletAddress);
  const latest = receipts[0] ?? null;
  if (!open) return null;
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="proof-drawer" role="dialog" aria-modal="true" aria-label="Technical proof" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-heading">
          <div><span className="icon-tile"><LockKeyhole size={18} /></span><h2>Technical proof</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <p className="muted">Evidence from the completed Devnet round trip. No wallet secret or private session token is shown.</p>
        <dl className="proof-list">
          <div><dt>Program</dt><dd><code>{shortAddress(PROGRAM_ID, 6)}</code></dd></div>
          <div><dt>Public router</dt><dd><code>{new URL(MAGIC_ROUTER_RPC).host}</code></dd></div>
          <div><dt>Private runtime</dt><dd><code>{new URL(PRIVATE_ER_ORIGIN).host}</code></dd></div>
          <div><dt>Private closeout slot</dt><dd>{PROOF.privateSlot}</dd></div>
          <div><dt>Public finalized slot</dt><dd>{PROOF.publicSlot}</dd></div>
        </dl>
        {latest ? <section className="browser-receipt" aria-label="Latest browser payment receipt">
          <span>Latest receipt captured in this browser</span>
          <strong>{actionLabel(latest.action)} · {formatUsdc(BigInt(latest.amount))} test USDC</strong>
          <div className="browser-receipt-row"><span><small>MagicBlock Private ER signature</small><code title={latest.privateSignature}>{latest.privateSignature}</code></span><button onClick={() => void navigator.clipboard.writeText(latest.privateSignature)}><Copy size={14} /> Copy</button></div>
          <div className="browser-receipt-row"><span><small>Payment account</small><code title={latest.payment}>{latest.payment}</code></span><button onClick={() => void navigator.clipboard.writeText(latest.payment)}><Copy size={14} /> Copy</button></div>
          {latest.publicSignature && <a className="proof-link" href={`https://explorer.solana.com/tx/${latest.publicSignature}?cluster=devnet`} target="_blank" rel="noreferrer">View public preparation <ExternalLink size={15} /></a>}
          <small>Stored locally for evidence. No wallet key, session signer, authentication token, or plaintext note is retained.</small>
        </section> : <p className="muted">No payment receipt has been captured for this connected wallet yet.</p>}
        <a className="proof-link" href={`https://explorer.solana.com/tx/${PROOF.publicUndelegation}?cluster=devnet`} target="_blank" rel="noreferrer">
          View finalized undelegation <ExternalLink size={15} />
        </a>
        <div className="privacy-boundary">
          <strong>Privacy boundary</strong>
          <p>Amount, note, and live status stay private while pending. Wallets and timing are public.</p>
        </div>
      </aside>
    </div>
  );
}
