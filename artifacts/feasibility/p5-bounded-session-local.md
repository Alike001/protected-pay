# Phase 5.1 — Bounded Session Authorization (Local)

Date: 2026-09-10

## Outcome

Protected Pay now has a locally verified MagicBlock Session Keys integration. Phantom authorizes a public, expiring Session Token once; a temporary in-memory key then signs Private ER instructions. The key is never written to browser storage and receives no SOL.

This changes authorization, not custody. Phantom remains mandatory for test-USDC deposits, withdrawals, Payment shell creation, permission creation, and delegation. A session can only act as its recorded wallet authority against the Protected Pay program, and each instruction still enforces the stored sender, recipient, claimant, Deposit, Payment, and PDA relationships.

Session-enabled private instructions:

- `open_payment` and fixed-cadence `schedule_payment`
- `acknowledge_payment`
- `cancel_payment`
- `claim_payment`
- terminal redaction and Payment commit/undelegation
- Deposit commit/undelegation before a separately wallet-approved custody mutation

The sender UI exposes **End private session**, which closes the Session Token on Solana. Sessions also expire after one hour and the browser rejects a cached signer within 15 seconds of expiry.

## Privacy disclosure

The Session Token is public Solana state. It reveals the wallet authority, temporary signer public key, target program, and expiry. It does not contain the payment amount, memo, status, deadlines, aggregate private balance, or any private key. This metadata must remain in the product's privacy disclosure.

## Verification

- Official Session Keys program `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` exists and is executable on Devnet.
- Its exact create-session instruction passed unsigned Devnet simulation for browser wallet `4C2GznkXgEp2EhcXkPyBQh9feYvAkCcN2bWDrGjbkwvR`.
- Simulation consumed `11,296` compute units; no signature or broadcast occurred.
- Rust: 23 tests passed; clippy passed with warnings denied.
- Anchor IDL and Codama client generation passed.
- Root and web TypeScript checks passed.
- Browser workflow/recovery checks passed.
- Production web build passed.
- Session-aware private open/schedule: 626 bytes, below Solana's 1,232-byte packet limit.
- Session-aware Deposit return: 449 bytes.
- Optimized SBF binary: 677,280 bytes.
- SHA-256: `4ed1f10108d2a62c7be3f10d8201ac440fcaaef1725952538b540d3c8ba080dd`.

## Devnet deployment preparation

The separately approved version-2.2 preparation checkpoint is complete. A signature-verified simulation first proved the exact 65,536-byte `ExtendProgram` transition. The extension then finalized on Devnet and increased executable capacity from 635,136 to 700,672 bytes without changing the deployed program slot.

The reviewed 677,280-byte binary was then simulated through temporary Buffer creation, initialization, and a 512-byte loader write. The public Solana uploader created the persistent Buffer but exhausted retries after completing part of the upload. Its one-time signer was recovered, verified against the exact Buffer address, and retained only until the initialized Buffer was confirmed recoverable. A guarded resumable uploader then scanned existing bytes, preserved 60 matching chunks, sent the remaining 693 chunks through MagicBlock Router with node preflight, and confirmed every batch before advancing.

Finalized evidence:

- ProgramData extension transaction: `3zUxd4p4V8jCc1GS8UJiDTVfP4RhpEVi5vHWyArf44RxekCEkHE4w8iQ5VVQXWKkFUDxbiFSspzEfLBKmFgHS`
- ProgramData capacity: 700,672 bytes plus 45-byte loader metadata
- Buffer: `AZxR3hGpicvWYwSbHUt3a3jhFYawBSBsEdpLuY9pheq6`
- Buffer authority: `6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn`
- Buffer allocation: 677,317 bytes including 37-byte loader metadata
- Refundable Buffer rent: 3.4414206 SOL
- Local and finalized Buffer SHA-256: `4ed1f10108d2a62c7be3f10d8201ac440fcaaef1725952538b540d3c8ba080dd`
- Finalized byte-verification slot: 496377687
- First Buffer transaction: `2pCsoZJTveVdHDjZdQ3WTcqcMjdwEaxuDApB7sQbX41dSBDBKVuL2hhVraPtvg33VPTemTpYonUeta14yN34nptZ`
- Last Buffer write: `Gx2rFPkyoUhdWdriAowuJGjSRncB7jmLSxF1dQR2ZVdz8XJMmf4uCTGbj7AcF316zxXBgHwjaSdEMCChUDB5MpG`
- Failed finalized Buffer transactions: zero
- Program deploy slot before and after upload: 496343964
- Program upgrade executed: false
- One-time Buffer signer retained: no

The remaining explicit gates are:

1. run an exact signed, non-broadcast version-2.2 upgrade simulation against the finalized Buffer;
2. upgrade only after separate broadcast approval;
3. create a real browser Session Token and prove session-signed private open/schedule, revocation, and expired/revoked denial.
