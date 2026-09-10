# Phase 5 Balance Reconciliation Verification

Date: 2026-09-10

Command: `NO_DNA=1 npm run p5:verify:balance-reconciliation`

Result: all 13 assertions passed without signing or broadcasting.

The tested decision table proves:

- an untouched delegated balance may begin private return;
- an exact public starting balance may begin one custody mutation;
- a prepared return or mutation signature is not resent while pending;
- an exact target balance is treated as complete or awaiting private re-delegation, never as permission to mutate again;
- a changed starting balance, non-zero locked value, wrong wallet, tampered target, excessive withdrawal, and `u64` overflow abort;
- transaction signatures and blockhash lifetimes are validated before a saved checkpoint is trusted.

The UI stores the reviewed start/target and a prepared transaction signature in same-tab session storage before broadcast. If that checkpoint cannot be persisted, broadcasting is aborted. On retry, the client combines signature status and last-valid block height with validated public/private Deposit ownership and exact decoded state. This is client-side protection around program-enforced balance conservation; it is not a claim that session storage is a custody mechanism.
