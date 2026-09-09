import { ShieldCheck } from "lucide-react";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Protected Pay">
      <span className="brand-mark"><ShieldCheck aria-hidden="true" size={20} strokeWidth={2.2} /></span>
      {!compact && <span>Protected Pay</span>}
    </div>
  );
}
