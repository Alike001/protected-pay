import { ShieldCheck } from "lucide-react";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <a className="brand brand-home-link" href="/" aria-label="Protected Pay home">
      <span className="brand-mark"><ShieldCheck aria-hidden="true" size={20} strokeWidth={2.2} /></span>
      {!compact && <span>Protected Pay</span>}
    </a>
  );
}
