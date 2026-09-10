# Phase 5 Payment-Creation Reconciliation

Command: `NO_DNA=1 npm run p5:verify:payment-reconciliation`

Across tabs in one browser profile, the client now creates and persists one payment identity before requesting any transaction signature. The checkpoint contains the sender, recipient, raw amount, payment reference/PDA, encrypted memo envelope, memo commitment, and any prepared public/private transaction signature with its blockhash lifetime. It never stores the plaintext private note. A short per-wallet lease prevents a second tab from working concurrently, while the shared checkpoint permits exact recovery after refresh, disconnect, or a stale tab.

Before retrying, the client validates the checkpoint, derives the Payment PDA again, checks transaction status and blockhash expiry, decodes the authoritative public delegated shell, and reads the authenticated private Payment. It will:

- wait instead of resending while a prepared signature can still land;
- continue to private open when the exact public shell already exists;
- finish without another transaction when the exact private Payment already opened;
- rebuild only an expired or failed step whose expected state does not exist; and
- abort if the account owner, layout, sender, recipient, mint, amount, memo commitment, or derived address differs.

The verification covers seven decision states and three tampered-checkpoint cases. It constructs no transaction, loads no wallet, produces no signature, and broadcasts nothing.
