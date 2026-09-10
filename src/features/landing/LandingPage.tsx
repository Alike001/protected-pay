import {
  ArrowRight,
  Check,
  Clock3,
  ExternalLink,
  FileCheck2,
  Globe2,
  LockKeyhole,
  Play,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "../../components/BrandMark";
import { PROOF } from "../../lib/constants";
import "./landing.css";

type LandingPageProps = {
  onShowProof: () => void;
};

const steps = [
  {
    title: "Send privately",
    copy: "Move USDC into a private safety window. Only the intended recipient can open it.",
  },
  {
    title: "Recipient acknowledges",
    copy: "The recipient confirms the right wallet before the payment can progress.",
  },
  {
    title: "Settle automatically—or recover",
    copy: "The payment settles after the window, or returns safely when something is wrong.",
  },
] as const;

const controls = [
  {
    icon: RotateCcw,
    title: "Undo payment",
    copy: "Cancel a pending payment during the safety window.",
    tone: "danger",
  },
  {
    icon: Clock3,
    title: "Recover expired",
    copy: "Return funds when a recipient does not acknowledge in time.",
    tone: "violet",
  },
  {
    icon: RefreshCcw,
    title: "Resume interrupted",
    copy: "Continue a balance operation safely from its last verified step.",
    tone: "violet",
  },
] as const;

const infrastructure = [
  { icon: WalletCards, title: "Solana custody", copy: "USDC stays on Solana." },
  { icon: LockKeyhole, title: "Private ER", copy: "Pending logic runs privately." },
  { icon: Clock3, title: "Crank timing", copy: "Deadlines progress automatically." },
  { icon: FileCheck2, title: "Solana settlement", copy: "Final state returns onchain." },
] as const;

function SafetyWindowDemo() {
  return (
    <div className="landing-demo" aria-label="Example protected payment">
      <div className="landing-demo-head">
        <span>Send protected payment</span>
        <Clock3 aria-hidden="true" size={18} />
      </div>
      <div className="landing-demo-field">
        <span>Recipient wallet</span>
        <strong>Hfo7LD2F…aG3qvQ</strong>
      </div>
      <div className="landing-demo-fields">
        <div><span>Amount</span><strong>125.00 <small>USDC</small></strong></div>
        <div><span>Private note</span><strong>Invoice #184</strong></div>
      </div>
      <div className="landing-demo-focus">
        <div className="landing-countdown"><strong>03:42</strong><span>remaining</span></div>
        <div className="landing-demo-status">
          <strong>Waiting for recipient</strong>
          <span>Private until the right wallet acknowledges.</span>
        </div>
        <div className="landing-undo"><RotateCcw size={16} /> Undo payment</div>
      </div>
      <div className="landing-demo-rail" aria-hidden="true">
        <span className="is-complete"><Check size={10} /></span><i />
        <span className="is-current" /><i /><span />
        <b className="landing-demo-dot" />
        <div><small>Sent</small><small>Acknowledged</small><small>Settled</small></div>
      </div>
    </div>
  );
}

function PrivacyColumn({
  icon: Icon,
  title,
  copy,
  items,
}: {
  icon: LucideIcon;
  title: string;
  copy: string;
  items: readonly string[];
}) {
  return (
    <article className="landing-privacy-column">
      <div className="landing-privacy-heading">
        <span><Icon aria-hidden="true" size={20} /></span>
        <div><h3>{title}</h3><p>{copy}</p></div>
      </div>
      <ul>
        {items.map((item) => <li key={item}><Check aria-hidden="true" size={14} />{item}</li>)}
      </ul>
    </article>
  );
}

export function LandingPage({ onShowProof }: LandingPageProps) {
  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="landing-brand-link" href="/" aria-label="Protected Pay home"><BrandMark /></a>
        <nav aria-label="Landing page">
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
          <button type="button" onClick={onShowProof}>Proof</button>
        </nav>
        <a className="landing-button primary compact" href="/app">Open Devnet app <ArrowRight size={15} /></a>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <h1>Send USDC.<br />Fix mistakes before they become final.</h1>
            <p>Protected Pay gives every payment a private safety window. The right recipient acknowledges; you can undo a mistake before settlement.</p>
            <div className="landing-actions">
              <a className="landing-button primary" href="/app">Open Devnet app <ArrowRight size={16} /></a>
              <a className="landing-button secondary" href="#how-it-works"><Play size={15} /> See how it works</a>
            </div>
          </div>
          <SafetyWindowDemo />
        </section>

        <section className="landing-section landing-how" id="how-it-works">
          <div className="landing-section-title">
            <h2>How it works</h2>
            <p>Simple, private, and safer payments.</p>
          </div>
          <ol className="landing-steps">
            {steps.map((step, index) => (
              <li key={step.title}>
                <span>{index + 1}</span>
                <div><h3>{step.title}</h3><p>{step.copy}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section landing-mistake">
          <div className="landing-mistake-copy">
            <h2>Wrong wallet?</h2>
            <p className="landing-lead">Recover it during the safety window—without asking a stranger to send it back.</p>
            <p>We have all made mistakes. Protected Pay gives you a private window to undo an incorrect transfer, so your funds can be recovered safely.</p>
          </div>
          <div className="landing-return-visual" aria-label="A mistaken payment returning to its sender">
            <article>
              <span>You sent</span>
              <strong>125.00 USDC</strong>
              <small>To Hfo7LD2F…aG3qvQ</small>
              <em><ShieldCheck size={14} /> Safety window open</em>
            </article>
            <div className="landing-return-path" aria-hidden="true">
              <span>Undo in time</span><i><b /></i><RotateCcw size={26} />
            </div>
            <article>
              <span>Returned to you</span>
              <strong>125.00 USDC</strong>
              <small>Protected balance</small>
              <em className="success"><Check size={14} /> Recovered safely</em>
            </article>
          </div>
        </section>

        <section className="landing-section landing-control">
          <div className="landing-side-title">
            <h2>Your control, always</h2>
            <p>Simple tools to keep your funds safe.</p>
          </div>
          <div className="landing-control-list">
            {controls.map(({ icon: Icon, title, copy, tone }) => (
              <article key={title}>
                <span className={tone}><Icon aria-hidden="true" size={20} /></span>
                <div><h3>{title}</h3><p>{copy}</p></div>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-privacy" id="privacy">
          <div className="landing-section-title">
            <div><h2>Privacy by design</h2><p>Your payment details stay private while the decision is still live.</p></div>
            <span>Transparent where it matters.</span>
          </div>
          <div className="landing-privacy-grid">
            <PrivacyColumn
              icon={LockKeyhole}
              title="Private while pending"
              copy="Visible only to authorized participants."
              items={["Payment amount", "Private note", "Live payment status"]}
            />
            <PrivacyColumn
              icon={Globe2}
              title="Public on Solana"
              copy="Visible at settlement or custody boundaries."
              items={["Participating wallets and timing", "Funding and withdrawal events", "Committed aggregate balance"]}
            />
          </div>
        </section>

        <section className="landing-section landing-magic">
          <div className="landing-section-title">
            <div><h2>Powered by MagicBlock</h2><p>The infrastructure for private, programmable money.</p></div>
          </div>
          <ol>
            {infrastructure.map(({ icon: Icon, title, copy }, index) => (
              <li key={title}>
                <span><Icon aria-hidden="true" size={20} /></span>
                <div><small>{index + 1}</small><h3>{title}</h3><p>{copy}</p></div>
                {index < infrastructure.length - 1 ? <ArrowRight className="landing-magic-arrow" aria-hidden="true" size={18} /> : null}
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-proof" id="proof">
          <div>
            <h2>Verified on Devnet</h2>
            <p>Open, inspectable, and built for what comes next.</p>
          </div>
          <dl>
            <div><dt>Program</dt><dd>Protected Pay</dd></div>
            <div><dt>Network</dt><dd>Solana Devnet</dd></div>
            <div><dt>Private runtime</dt><dd>MagicBlock TEE</dd></div>
          </dl>
          <div className="landing-proof-actions">
            <a className="landing-proof-app" href="/app">
              Open Devnet app <ArrowRight size={15} />
            </a>
            <a
              className="landing-proof-transaction"
              href={`https://explorer.solana.com/tx/${PROOF.publicUndelegation}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
            >
              View verified transaction <ExternalLink size={15} />
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-footer-brand">
          <BrandMark />
          <p>Safer USDC transfers with a private recovery window.</p>
        </div>
        <div className="landing-footer-note">
          <span>Built on Solana Devnet with MagicBlock.</span>
          <small>Hackathon prototype · Test USDC only · Not for real funds.</small>
        </div>
      </footer>
    </div>
  );
}
