export type WorkflowIssueKind =
  | "authentication-expired"
  | "confirmation-delayed"
  | "cross-tab"
  | "funding-required"
  | "insufficient-balance"
  | "network"
  | "signature-rejected"
  | "wallet-disconnected"
  | "unknown";

export type WorkflowIssue = {
  detail?: string;
  kind: WorkflowIssueKind;
  message: string;
  retryLabel: string;
  title: string;
};

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "";
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "number" || typeof error.code === "string" ? String(error.code) : null;
}

export function workflowIssueFrom(error: unknown, fallback = "The operation could not be completed."): WorkflowIssue {
  const detail = errorText(error) || fallback;
  const normalized = detail.toLowerCase();
  const code = errorCode(error);

  if (/another (browser )?tab|coordination lease|active in another tab/.test(normalized)) {
    return { ...crossTabWorkflowIssue(), detail };
  }

  if (/set up your protected balance|no protected balance|fund the vault/.test(normalized)) {
    return {
      detail,
      kind: "funding-required",
      message: "Your protected balance is not set up yet. Close this review and choose Set up balance before sending.",
      retryLabel: "Check balance again",
      title: "Protected balance required",
    };
  }

  if (/exceeds your available protected balance|amount exceeds your protected balance/.test(normalized)) {
    return {
      detail,
      kind: "insufficient-balance",
      message: "This payment is larger than the test USDC available in your protected balance.",
      retryLabel: "Check balance again",
      title: "Not enough protected USDC",
    };
  }

  if (
    code === "4001" ||
    /user (rejected|declined|cancelled|canceled)|request (rejected|declined)|signature request.*(cancelled|canceled)/.test(normalized)
  ) {
    return {
      detail,
      kind: "signature-rejected",
      message: "Nothing new was sent. Review the payment and approve again when you are ready.",
      retryLabel: "Try approval again",
      title: "Signature request cancelled",
    };
  }

  if (/disconnect|wallet.*not connected|connect a wallet|account changed|cannot sign/.test(normalized)) {
    return {
      detail,
      kind: "wallet-disconnected",
      message: "Reconnect the same wallet. Protected Pay will inspect the saved checkpoint before doing anything else.",
      retryLabel: "Reconnect, then continue",
      title: "Wallet disconnected",
    };
  }

  if (/unauthori[sz]ed|forbidden|token.*expir|session.*expir|authentication.*expir|challenge.*stale|invalid token|\b401\b|\b403\b/.test(normalized)) {
    return {
      detail,
      kind: "authentication-expired",
      message: "Your private session ended. Unlock it again; the saved payment identity will be reused.",
      retryLabel: "Unlock and continue",
      title: "Private session expired",
    };
  }

  if (/still pending|still reconciling|timed? out|timeout|not send it again|not be created twice|not be locked twice/.test(normalized)) {
    return {
      detail,
      kind: "confirmation-delayed",
      message: "The network has not reached a final answer yet. Protected Pay saved the transaction and will check it instead of sending a duplicate.",
      retryLabel: "Check status again",
      title: "Confirmation is taking longer",
    };
  }

  if (/failed to fetch|network|rpc|rate limit|too many requests|service unavailable|\b429\b|\b502\b|\b503\b|\b504\b/.test(normalized)) {
    return {
      detail,
      kind: "network",
      message: "The network could not be reached. Your saved checkpoint remains available for a safe retry.",
      retryLabel: "Retry connection",
      title: "Network connection interrupted",
    };
  }

  return {
    detail,
    kind: "unknown",
    message: fallback,
    retryLabel: "Check and continue safely",
    title: "Payment needs attention",
  };
}

export function crossTabWorkflowIssue(): WorkflowIssue {
  return {
    kind: "cross-tab",
    message: "This tab is read-only while the other tab is signing or checking the payment. It will update automatically.",
    retryLabel: "Continue in the active tab",
    title: "Payment active in another tab",
  };
}
