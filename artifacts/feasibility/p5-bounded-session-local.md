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

## Version-2.2 exact signed upgrade simulation

After separate approval, the guarded client loaded the approved upgrade-authority signer and built the exact upgradeable-loader `Upgrade` transaction against the finalized Buffer. The signed wire transaction was submitted only to `simulateTransaction` with signature verification enabled. The independent broadcast flag was absent.

The simulation replaced the program bytes with the complete reviewed artifact, preserved the ProgramData allocation and authority, zeroed all unused capacity, drained the Buffer, and returned its full 3.4414206 SOL rent to the authority. The simulated authority balance reconciled exactly after the 5,000-lamport fee. A finalized post-check read then proved the live deploy slot, Buffer bytes, and authority balance were unchanged, and the prepared signature was absent from Devnet.

```text
Cluster: Solana Devnet
Release: version-2.2
Instruction: UpgradeableLoaderInstruction::Upgrade
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Buffer: AZxR3hGpicvWYwSbHUt3a3jhFYawBSBsEdpLuY9pheq6
Authority, fee payer, and spill destination: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Binary length: 677,280 bytes
Binary and Buffer SHA-256: 4ed1f10108d2a62c7be3f10d8201ac440fcaaef1725952538b540d3c8ba080dd
ProgramData capacity: 700,672 bytes
Live deploy slot before and after simulation: 496343964
Simulated deploy slot: 496386474
Simulated Buffer drained: true
Simulated Buffer rent refund: 3.4414206 SOL
Simulated ProgramData rent top-up: 0 SOL
Estimated fee: 5,000 lamports
Compute units: 2,370
Signature verification: passed
Simulation error: none
Transaction broadcast: false
Prepared signature found on Devnet: false
Live Buffer still present and byte-identical: true
```

## Version-2.2 finalized Devnet upgrade

After a separate broadcast approval, the guarded client repeated all finalized account, authority, capacity, and bytecode checks. It signed a fresh transaction, simulated those exact wire bytes with signature verification enabled, and broadcast the same bytes. The upgrade finalized successfully.

An independent finalized RPC audit then reconstructed the deployed bytecode directly from ProgramData. Its SHA-256 matches the reviewed local artifact, all 23,392 unused capacity bytes are zero, the Program account remains executable under the upgradeable loader, the Buffer is closed, and the recorded authority remains present. No browser or private-state transaction was part of this upgrade.

```text
Cluster: Solana Devnet
Release: version-2.2
Finalized signature: 5sf55FjtBCzsXi8VbnjqJfy6gZ2HbyR2Bbc3d7rmit8yT4grnSGwcxKvxhygW26Uisg3RLkSyJki9X3x7dP677Kc
Finalized slot and deploy slot: 496387711
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Deployed binary length: 677,280 bytes
Deployed SHA-256: 4ed1f10108d2a62c7be3f10d8201ac440fcaaef1725952538b540d3c8ba080dd
ProgramData capacity: 700,672 bytes
Trailing zero bytes: 23,392
Closed Buffer: AZxR3hGpicvWYwSbHUt3a3jhFYawBSBsEdpLuY9pheq6
Buffer rent refunded: 3.4414206 SOL
ProgramData rent top-up: 0 SOL
Fee: 5,000 lamports
Authority balance before: 1.40439008 SOL
Authority balance after: 4.84580568 SOL
Signed simulation passed before broadcast: true
Independent finalized audit: passed
```

The live browser gate is now complete. Wallet `4C2Gz…bkvvR` created bounded Session Token `HNQLk2…BrfsX`, used its in-memory signer for a private `0.01` test-USDC open and sender Undo, and explicitly revoked the token in finalized public Devnet transaction `4tHz2r…oDCTx` at slot `496542267`. The 112-byte token closed, its rent returned to the authority, public test-USDC custody stayed unchanged, and the app erased the signer and masked private state. A subsequent unsigned, non-broadcast Private ER simulation referencing that closed token failed at the session constraint with Anchor `AccountNotInitialized (3012)`, proving the authorization account cannot be reused without reconstructing or persisting the destroyed in-memory key.
