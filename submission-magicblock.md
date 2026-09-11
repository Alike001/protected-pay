# Protected Pay — MagicBlock Blitz v8 submission packet

Status: ready to paste except for the demo-video URL, participant details, and confirmation that the authenticated Blitz v8 selector still accepts submissions.

## Form fields

### Submitting for

Solana Blitz v8

### Project name

Protected Pay

### Description

Protected Pay gives USDC transfers a private, program-enforced safety window before they become final.

A sender funds a protected balance, enters a recipient and amount, and shares a private payment link. The intended recipient confirms the correct wallet. During the safety window the sender can undo a mistake; if the recipient never acknowledges, MagicBlock Crank expires the payment without either user remaining online and only the sender can recover it. A correctly acknowledged payment settles automatically and becomes claimable only by its recipient.

The live build uses Circle Devnet USDC in a Solana program-controlled vault. Pending payment state and aggregate balances run inside MagicBlock's authenticated Private Ephemeral Rollup. Each payment schedules six idempotent one-minute Crank calls. Terminal claims clear sensitive fields and commit a redacted result back to Solana with a cryptographic commitment.

Protected Pay also uses one-hour, program-scoped MagicBlock Session Tokens. The temporary signer stays in memory and can be revoked onchain. Retry checkpoints reconcile prepared signatures and authoritative state before sending again, preventing a browser interruption from blindly duplicating value movement.

This is a real Devnet product rather than a mocked interface. Browser-wallet runs have completed funding, withdrawal, protected send, sender Undo, unattended expiry and recovery, recipient acknowledgement, unattended settlement, recipient claim, Session Token creation, and revocation. The Anchor program has 23 state-machine tests, and the public repository includes transaction-backed feasibility evidence, privacy measurements, guarded simulation/broadcast scripts, and a requirement-level verification audit.

Privacy is described narrowly and honestly: the amount, note commitment, live status, deadlines, task identifier, and aggregate balances are access-controlled while delegated inside the authenticated Private ER. Wallet identities, payment identity, mint, permissions, delegation metadata, validator, and timing remain public. This demonstration uses test assets only and is not audited or mainnet-ready.

### Categories

1. Payments
2. Privacy
3. Consumer

### Project website

https://protected-pay-azure.vercel.app

### GitHub Project Repo

https://github.com/Alike001/protected-pay

### Pitch & Demo

TODO: add a publicly playable YouTube, Vimeo, or other portal-accepted video URL.

### Explorer link — integration proof

https://explorer.solana.com/tx/2ncJVLoHZ14hwmCcPpD9Qp5GEQyyY2NeYz1EvcnWVCWATeBfN3JNMFm8e7W9J89ccZ4qWRssyQbpB7vBgJFMjXiv?cluster=devnet

### Program address

`w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk`

### Additional information

- Circle Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- MagicBlock Private ER: `https://devnet-tee.magicblock.app`
- MagicBlock validator: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`
- Verification audit: `artifacts/verification/final-verification-audit.md`
- Live browser evidence: `artifacts/ui/p5-live-browser-wallet-checklist.md`
- Transaction evidence index: `artifacts/feasibility/README.md`

### Participant details

- First name: TODO
- Last name: TODO
- Email: TODO
- Country of residence: TODO
- Role(s): TODO
- Prize wallet: connect the intended Solana wallet in the authenticated portal
- Team members / Telegram: TODO, or leave empty when working solo

## One-line pitch

Send USDC with a private safety window—undo mistakes before settlement, while correct payments finish automatically.

## Judge-facing proof points

- Real Circle Devnet USDC custody and exact balance conservation.
- Deployed version-2.2 Solana program with byte-verified upgrade evidence.
- Access-controlled pending state inside MagicBlock's authenticated Private ER.
- Six-call MagicBlock Crank schedule that settles or expires without either user online.
- Sender-only Undo and expired recovery; recipient-only acknowledgement and claim.
- One-hour, program-scoped Session Tokens with explicit onchain revocation.
- Retry-safe browser checkpoints and sanitized receipts containing no wallet key, session signer, authentication token, or plaintext note.
- Public deployment, accessible repository, green CI, 23 Anchor tests, and independent transaction receipts.

## Testing instructions

1. Open the live site and choose **Open Devnet app**.
2. Use Phantom in Testnet Mode and connect a Devnet wallet.
3. Unlock the protected balance; a cold session requests one login message and one Session Token approval.
4. Fund with Circle Devnet test USDC if needed.
5. Enter a different Devnet recipient, an amount, and an optional note.
6. Review and protect the payment. A cold funded sender sees two public transaction approvals in total: Session Token plus Payment preparation; private opening and scheduling use the bounded session signer.
7. Copy the recipient link and open it with the intended recipient wallet.
8. Acknowledge before expiry, then claim after automatic settlement; alternatively use **Undo** before settlement or **Recover expired** after unattended expiry.
9. Open **Proof** to inspect the deployed program and finalized public transaction.

Local verification:

```bash
npm ci
npm run typecheck
npm run build:web
npm run p5:verify:browser-payment-builder
npm run p5:verify:frontend-recovery
npm run p5:verify:payment-receipts
cargo test --locked -p protected-pay --lib
```

## Screenshot shot list

1. Landing hero with the live protected-payment preview and verified build facts.
2. Sender dashboard with a protected balance and the payment review dialog.
3. Active protected-payment card showing the private recipient link and Undo control.
4. Intended-recipient page showing the private countdown and acknowledgement/claim action.
5. Proof drawer plus recent activity showing protected, recovered, and claimed outcomes.

Do not use a fixture, edited balance, or fake timer in submission media. Keep **Solana Devnet** and **test USDC** visible.

## Readiness

- [x] Public repository
- [x] Public production deployment
- [x] Deployed Devnet program and explorer proof
- [x] Transaction-backed technical evidence
- [x] Green CI and production route QA
- [x] Product-first landing page
- [ ] Confirm the authenticated Blitz v8 event selector still permits submission
- [ ] Capture the final live third-wallet concealment evidence
- [ ] Record and upload the demo video
- [ ] Fill participant details and connect the prize wallet
- [ ] Paste the fields into the MagicBlock Build portal and verify the resulting entry

## Known limitations

- Devnet and test USDC only; no real funds.
- The code is not audited or production-ready.
- Privacy is access-controlled while pending, not anonymous or permanently secret.
- Wallet relationships, permissions, delegation metadata, validator, and timing remain public.
- Optional note confidentiality depends on possession of the complete recipient link.
- The current cold send flow requires a login message and two public wallet transaction approvals.
- Policy automation, fiat settlement, multi-token support, and mainnet support are deferred.
