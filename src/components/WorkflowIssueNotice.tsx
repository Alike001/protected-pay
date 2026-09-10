import { CircleAlert, CircleDollarSign, Clock3, Layers3, LockKeyhole, Unplug, WifiOff, XCircle } from "lucide-react";
import type { WorkflowIssue } from "../lib/workflowIssue";

const issueIcons = {
  "authentication-expired": LockKeyhole,
  "confirmation-delayed": Clock3,
  "cross-tab": Layers3,
  "funding-required": CircleDollarSign,
  "insufficient-balance": CircleAlert,
  "network": WifiOff,
  "signature-rejected": XCircle,
  "unknown": CircleAlert,
  "wallet-disconnected": Unplug,
} satisfies Record<WorkflowIssue["kind"], typeof CircleAlert>;

export function WorkflowIssueNotice({ issue }: { issue: WorkflowIssue }) {
  const Icon = issueIcons[issue.kind];
  const showDetail = Boolean(issue.detail && issue.detail !== issue.message);
  return (
    <div className={`workflow-issue ${issue.kind}`} role="alert">
      <Icon size={18} />
      <div>
        <strong>{issue.title}</strong>
        <p>{issue.message}</p>
        {showDetail && <details><summary>Technical detail</summary><code>{issue.detail}</code></details>}
      </div>
    </div>
  );
}
