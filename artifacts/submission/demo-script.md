# Protected Pay demo script

Target length: 90 seconds. Record the deployed site at `https://protected-pay-azure.vercel.app` with Phantom in Testnet Mode. Use real Devnet state only.

## 0:00–0:08 — The problem

**Screen:** Landing hero, then zoom to “Undo it before settlement.”

**Voiceover:** “A normal USDC transfer gives you no second chance. One wrong wallet can make a simple mistake permanent.”

## 0:08–0:20 — The product

**Screen:** Open the Devnet app. Show the protected balance and compose a `0.01` test-USDC payment.

**Voiceover:** “Protected Pay adds a private, program-enforced safety window. The sender chooses a recipient and amount; the intended wallet must acknowledge before the payment can progress.”

## 0:20–0:38 — Protect and share

**Screen:** Review the approval disclosure, approve the real Devnet preparation, show **Payment protected**, and copy the recipient link.

**Voiceover:** “Solana holds Circle Devnet USDC in the program vault. MagicBlock opens the private per-payment escrow and schedules six autonomous deadline checks. The app states every approval honestly.”

## 0:38–0:51 — Intended recipient

**Screen:** Open the link with the correct recipient. Unlock, show the private countdown, and acknowledge.

**Voiceover:** “Only the intended recipient can read the pending payment and confirm the wallet. The amount, note, live status, and deadline remain access-controlled inside the authenticated Private ER while pending.”

## 0:51–1:03 — Wrong-wallet protection

**Screen:** Open a fresh active payment with Account 3. Show **Wrong wallet**, concealed fields, and the disabled action. Do not approve a transaction.

**Voiceover:** “An unrelated wallet learns no private payment details and cannot act. Protected Pay asks only for authentication; it never requests a transaction from the wrong wallet.”

## 1:03–1:14 — Undo and recovery

**Screen:** Return to the sender and use **Undo**, or show the verified recovered receipt in recent activity.

**Voiceover:** “Before settlement, the sender can undo the mistake. If nobody acknowledges, MagicBlock expires the payment without either user online, and only the sender can recover it.”

## 1:14–1:23 — Correct automatic outcome

**Screen:** Show a settled/claimed receipt from the verified recipient round trip.

**Voiceover:** “Correct payments settle automatically and become claimable only by the recipient. Terminal claims erase sensitive fields and leave a verifiable commitment.”

## 1:23–1:30 — Technical close

**Screen:** Open **Proof**, show the program ID, transaction link, repository, and the landing-page build facts.

**Voiceover:** “Protected Pay is live on Devnet with a version-2.2 program, 23 state-machine tests, bounded Session Tokens, and transaction-backed evidence. It is a safer way to send USDC—powered by MagicBlock on Solana.”

## Recording checklist

- Keep **Solana Devnet** and **test USDC** visible.
- Hide desktop notifications and unrelated tabs.
- Never reveal a seed phrase, private key, login token, or full sensitive recipient link.
- Use a fresh `0.01` test-USDC payment for the wrong-wallet segment.
- Show real wallet prompts, but cut waiting time rather than replacing it with fake UI.
- Add short labels for `Sender`, `Intended recipient`, and `Unrelated wallet` when switching Phantom accounts.
- End on the public demo URL and repository URL.
