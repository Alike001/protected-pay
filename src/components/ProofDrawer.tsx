import { ExternalLink, LockKeyhole, X } from "lucide-react";
import { DEVNET_RPC, PRIVATE_ER_ORIGIN, PROGRAM_ID, PROOF } from "../lib/constants";
import { shortAddress } from "../lib/format";

export function ProofDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
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
          <div><dt>Public cluster</dt><dd><code>{new URL(DEVNET_RPC).host}</code></dd></div>
          <div><dt>Private runtime</dt><dd><code>{new URL(PRIVATE_ER_ORIGIN).host}</code></dd></div>
          <div><dt>Private closeout slot</dt><dd>{PROOF.privateSlot}</dd></div>
          <div><dt>Public finalized slot</dt><dd>{PROOF.publicSlot}</dd></div>
        </dl>
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
