import { Check, Clock3, FileText, LockKeyhole, ShieldCheck } from "lucide-react";
import { shortAddress } from "../../lib/format";
import { WalletControl } from "../../components/WalletControl";
import { BrandMark } from "../../components/BrandMark";

const SENDER = "6Etw8jh5pDdn8ZQp2sD1HtxHf42yM8gXrY8NqFzYcm6P";

export function RecipientPayment({ preview, onShowProof }: { preview: boolean; onShowProof: () => void }) {
  return (
    <div className="recipient-page">
      <header className="recipient-header"><BrandMark /><WalletControl /></header>
      <main className="recipient-main">
        <div className="recipient-intro"><span className="icon-tile large"><ShieldCheck size={24} /></span><div><h1>Payment waiting for you</h1><p>This test payment is protected until you acknowledge it.</p></div></div>
        <section className="recipient-card">
          <div className="recipient-countdown"><div className="countdown-ring large"><strong>{preview ? "08:42" : "—:—"}</strong><span>remaining</span></div><span className="status pending">Waiting for you</span></div>
          <div className="recipient-amount"><strong>{preview ? "125.00" : "—"}</strong><span>test USDC</span></div>
          <dl className="recipient-details">
            <div><dt>From</dt><dd>{preview ? shortAddress(SENDER, 7) : "Connect the recipient wallet"}</dd></div>
            <div><dt>Private note</dt><dd>{preview ? "Invoice #184" : "Unlock to view"}</dd></div>
          </dl>
          <button className="primary-action" disabled={!preview}>Acknowledge payment</button>
          <p className="action-explainer">Acknowledging confirms this wallet is ready to receive. Funds settle only after the safety window.</p>
        </section>

        <section className="recipient-timeline">
          <h2>How this payment works</h2>
          <ol>
            <li className="done"><span><Check size={15} /></span><div><strong>Payment protected</strong><p>The sender placed test USDC into a private safety window.</p></div></li>
            <li className="current"><span>2</span><div><strong>You acknowledge</strong><p>Confirm that this is the correct recipient wallet.</p></div></li>
            <li><span>3</span><div><strong>Funds settle</strong><p>After the deadline, the payment becomes claimable.</p></div></li>
          </ol>
        </section>

        <button className="recipient-proof" onClick={onShowProof}><FileText size={17} /><span><strong>View technical proof</strong><small>Program, cluster, and finalized transaction</small></span></button>
        <div className="privacy-note recipient-privacy"><LockKeyhole size={17} /><span><strong>Private while pending</strong><br />Amount, note, and live status are visible only to authorized wallets. Wallets and timing are public.</span></div>
        <footer className="recipient-footer"><Clock3 size={15} /> Test funds only · Solana Devnet</footer>
      </main>
    </div>
  );
}
