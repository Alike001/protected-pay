# Phase 5 Frontend Recovery States

Command: `NO_DNA=1 npm run p5:verify:frontend-recovery`

The sender and recipient interfaces now translate operational failures into bounded recovery actions:

- a rejected signature states that nothing new was sent and offers another approval;
- a delayed confirmation offers an authoritative status check, never a blind resend;
- a wallet disconnect asks for the same wallet before resuming the saved identity;
- an expired Private ER session is discarded and must be unlocked again;
- a network interruption retains the recovery checkpoint; and
- another active tab makes the current tab read-only and updates it through browser storage events.

The deterministic harness proves five error categories, active-tab exclusion, non-owner release denial, shared exact-checkpoint recovery, stale-lease takeover, and absence of the plaintext memo in shared storage. It loads no wallet, signs nothing, and broadcasts nothing.

The cross-tab checkpoint is stored in the current browser profile's `localStorage`, so it is durable across tabs but not a secure enclave. It includes the payment amount and recipient plus the encrypted memo envelope. It includes no private key or plaintext memo and is removed after the receipt is reconstructed. Live wallet and network evidence remains required before submission.
