# Phase 5.1 — Browser Payment Receipt Capture

Status: implemented and locally verified; fresh live transaction evidence remains required.

Protected Pay now retains a sanitized receipt after each successful private payment action: protected open, sender Undo, expired sender recovery, recipient acknowledgement, and recipient claim. Records are namespaced by connected wallet, validated on every read, ordered newest-first, and capped at 20 entries.

The receipt schema includes only the action, raw amount, counterparty, occurrence time, Payment account, payment reference, private transaction signature, optional related public transaction signature, role, wallet, and schema version. It cannot serialize the session signer, wallet key, authentication token, encrypted memo envelope, or plaintext note. Activity shows the captured result after reload, and Technical proof exposes the full private signature and Payment address with copy controls.

## Verification

- `npm run p5:verify:payment-receipts` proves schema validation, deterministic upsert, newest-first ordering, the 20-record bound, and omission of injected plaintext/secret fields.
- `npm run p5:verify:frontend-recovery` still passes the existing checkpoint and recovery safety matrix.
- `npm run typecheck` and `npm run build:web` pass.
- Rendered Chromium checks at 1366×900 and 390×844 confirm the receipt appears in Activity and Technical proof, the drawer has no horizontal overflow, and no console or page errors occur.

The first live expired-payment recovery happened before this feature existed, and its helper discarded the returned private signature. The historical signature cannot be reconstructed honestly from browser storage. The next fresh private action must provide the final real receipt-capture evidence.
