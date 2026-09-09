import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { useClient } from "@solana/react";
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useIsWalletReady,
  useWallets,
} from "@solana/kit-plugin-wallet/react";
import { useState } from "react";
import { shortAddress } from "../lib/format";
import type { AppClient } from "../providers";

export function WalletControl() {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const wallets = useWallets(client);
  const ready = useIsWalletReady(client);
  const connect = useConnect(client);
  const disconnect = useDisconnect(client);
  const [open, setOpen] = useState(false);

  if (!ready) return <button className="wallet-button" disabled>Finding wallets…</button>;

  if (connected) {
    return (
      <div className="wallet-menu-wrap">
        <button className="wallet-button connected" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="wallet-dot" />
          {shortAddress(connected.account.address, 5)}
          <ChevronDown size={15} />
        </button>
        {open && (
          <div className="wallet-menu">
            <span>{connected.wallet.name}</span>
            <code>{connected.account.address}</code>
            <button onClick={() => { setOpen(false); disconnect.dispatch(); }} disabled={disconnect.isRunning}>
              <LogOut size={15} /> Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  if (wallets.length === 0) {
    return <a className="wallet-button" href="https://phantom.app/" target="_blank" rel="noreferrer"><Wallet size={16} /> Install wallet</a>;
  }

  if (wallets.length === 1) {
    return (
      <button className="wallet-button primary" onClick={() => connect.dispatch(wallets[0])} disabled={connect.isRunning}>
        <Wallet size={16} /> {connect.isRunning ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  return (
    <div className="wallet-menu-wrap">
      <button className="wallet-button primary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Wallet size={16} /> Connect wallet <ChevronDown size={15} />
      </button>
      {open && (
        <div className="wallet-menu wallet-list">
          {wallets.map((wallet) => (
            <button key={wallet.name} onClick={() => { setOpen(false); connect.dispatch(wallet); }}>
              {wallet.icon && <img src={wallet.icon} alt="" />} {wallet.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
