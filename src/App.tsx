import { Activity, ArrowLeftRight, LayoutDashboard, Send, Settings, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { BrandMark } from "./components/BrandMark";
import { ProofDrawer } from "./components/ProofDrawer";
import { WalletControl } from "./components/WalletControl";
import { LandingPage } from "./features/landing/LandingPage";
import { RecipientPayment } from "./features/recipient/RecipientPayment";
import { SenderDashboard } from "./features/sender/SenderDashboard";
import { crossTabWorkflowIssue, workflowIssueFrom, type WorkflowIssue } from "./lib/workflowIssue";

function getPreviewMode() {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(window.location.search).get("preview");
  return value === "sender" || value === "recipient" ? value : null;
}

function getRecoveryPreview(): WorkflowIssue | null {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(window.location.search).get("recovery");
  if (value === "rejected") return workflowIssueFrom(Object.assign(new Error("User rejected the request"), { code: 4001 }));
  if (value === "delayed") return workflowIssueFrom(new Error("Payment preparation is still pending. Protected Pay will not send it again."));
  if (value === "disconnected") return workflowIssueFrom(new Error("Wallet disconnected while signing."));
  if (value === "expired") return workflowIssueFrom(new Error("401: private session token expired"));
  if (value === "network") return workflowIssueFrom(new Error("Failed to fetch"));
  if (value === "cross-tab") return crossTabWorkflowIssue();
  return null;
}

export default function App() {
  const [proofOpen, setProofOpen] = useState(false);
  const preview = getPreviewMode();
  const recoveryPreview = getRecoveryPreview();
  const paymentReference = new URLSearchParams(window.location.search).get("payment");
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";

  if (preview === "recipient" || paymentReference || pathname === "/pay") {
    return <><RecipientPayment preview={preview === "recipient"} paymentReference={paymentReference} onShowProof={() => setProofOpen(true)} /><ProofDrawer open={proofOpen} onClose={() => setProofOpen(false)} /></>;
  }

  if (preview !== "sender" && pathname !== "/app") {
    return <><LandingPage onShowProof={() => setProofOpen(true)} /><ProofDrawer open={proofOpen} onClose={() => setProofOpen(false)} /></>;
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
        <SenderDashboard preview={preview === "sender"} previewIssue={recoveryPreview} onShowProof={() => setProofOpen(true)} />
      </div>
      <ProofDrawer open={proofOpen} onClose={() => setProofOpen(false)} />
    </div>
  );
}
