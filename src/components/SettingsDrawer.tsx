import { Settings, X } from "lucide-react";
import { PROGRAM_ID, SOLANA_DEVNET_RPC, USDC_MINT } from "../lib/constants";
import { shortAddress } from "../lib/format";
import { usePaymentReceipts } from "../lib/paymentReceiptStorage";

export function SettingsDrawer({ open, onClose, walletAddress }: { open: boolean; onClose: () => void; walletAddress: string | null }) {
  const receipts = usePaymentReceipts(walletAddress);
  if (!open) return null;

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="proof-drawer settings-drawer" role="dialog" aria-modal="true" aria-label="App settings" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-heading">
          <div><span className="icon-tile"><Settings size={18} /></span><h2>Settings</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={20} /></button>
        </div>
        <p className="muted">Network, asset, privacy, and browser-evidence configuration for this test build.</p>
        <dl className="proof-list">
          <div><dt>Network</dt><dd>Solana Devnet</dd></div>
          <div><dt>Asset</dt><dd>Circle Devnet USDC</dd></div>
          <div><dt>Public RPC</dt><dd><code>{new URL(SOLANA_DEVNET_RPC).host}</code></dd></div>
          <div><dt>Program</dt><dd><code title={PROGRAM_ID}>{shortAddress(PROGRAM_ID, 6)}</code></dd></div>
          <div><dt>USDC mint</dt><dd><code title={USDC_MINT}>{shortAddress(USDC_MINT, 6)}</code></dd></div>
          <div><dt>Connected wallet</dt><dd><code title={walletAddress ?? undefined}>{walletAddress ? shortAddress(walletAddress, 7) : "Not connected"}</code></dd></div>
          <div><dt>Saved receipts</dt><dd>{walletAddress ? receipts.length : "—"}</dd></div>
        </dl>
        <div className="privacy-boundary">
          <strong>Private-session policy</strong>
          <p>Session signers stay in memory, are scoped to Protected Pay for one hour, and are discarded when you end the session or leave the browser process.</p>
        </div>
        <div className="privacy-boundary settings-storage-note">
          <strong>Browser evidence</strong>
          <p>Sanitized transaction receipts are stored only in this browser profile. Wallet keys, session signers, authentication tokens, and plaintext notes are never included.</p>
        </div>
      </aside>
    </div>
  );
}
