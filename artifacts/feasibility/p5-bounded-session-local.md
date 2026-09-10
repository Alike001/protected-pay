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

## Deployment gate

The deployed ProgramData capacity is 635,136 bytes, so the binary does not fit yet. No upgrade transaction has been signed or broadcast. The next explicit gates are:

1. extend ProgramData by 65,536 bytes;
2. create and fully upload a byte-verified 677,280-byte buffer;
3. run an exact signed, non-broadcast upgrade simulation;
4. upgrade only after separate broadcast approval;
5. create a real browser Session Token and prove session-signed private open/schedule, revocation, and expired/revoked denial.
