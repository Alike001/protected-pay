import { Activity, ArrowLeftRight, LayoutDashboard, Send, Settings, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { BrandMark } from "./components/BrandMark";
import { ProofDrawer } from "./components/ProofDrawer";
import { WalletControl } from "./components/WalletControl";
import { RecipientPayment } from "./features/recipient/RecipientPayment";
import { SenderDashboard } from "./features/sender/SenderDashboard";

function getPreviewMode() {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(window.location.search).get("preview");
  return value === "sender" || value === "recipient" ? value : null;
}

export default function App() {
  const [proofOpen, setProofOpen] = useState(false);
  const preview = getPreviewMode();
  const paymentReference = new URLSearchParams(window.location.search).get("payment");

  if (preview === "recipient" || paymentReference) {
    return <><RecipientPayment preview={preview === "recipient"} paymentReference={paymentReference} onShowProof={() => setProofOpen(true)} /><ProofDrawer open={proofOpen} onClose={() => setProofOpen(false)} /></>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <BrandMark />
        <nav aria-label="Primary">
          <a className="active" href="#dashboard"><LayoutDashboard size={18} /> Overview</a>
          <a href="#send"><Send size={18} /> Send payment</a>
          <a href="#activity"><Activity size={18} /> Activity</a>
        </nav>
        <div className="sidebar-bottom">
          <a href="#proof" onClick={(event) => { event.preventDefault(); setProofOpen(true); }}><ShieldCheck size={18} /> Proof</a>
          <a href="#settings"><Settings size={18} /> Settings</a>
          <div className="network-chip"><span /> Solana Devnet</div>
        </div>
      </aside>
      <div className="app-content">
        <header className="topbar"><div className="mobile-brand"><BrandMark /></div><span className="network-note"><ArrowLeftRight size={14} /> Private safety window</span><WalletControl /></header>
        <SenderDashboard preview={preview === "sender"} onShowProof={() => setProofOpen(true)} />
      </div>
      <ProofDrawer open={proofOpen} onClose={() => setProofOpen(false)} />
    </div>
  );
}
