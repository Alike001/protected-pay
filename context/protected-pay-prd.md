# Protected Pay: Product Requirements Document

Status: hackathon PRD. This document defines what the user must experience; implementation details belong in the technical specification.

## Product Summary

Protected Pay is a Solana payment application that places USDC in a private pending state before it becomes final. The sender gets a short safety window to cancel a mistake, the intended recipient confirms the payment with the matching wallet, and MagicBlock automation determines whether pending escrow settles or expires while users are offline.

The product promise is:

> **Protect the payment. Undo mistakes. Let deadlines resolve safely.**

The product does not reverse an ordinary completed blockchain transfer. It creates a safer settlement process before finality.

## Target User

### Primary user

A person who already holds USDC on Solana and needs to pay a new or unfamiliar recipient, such as:

- a freelancer paying a collaborator;
- a small team paying a contractor;
- a community member sending a grant or reimbursement;
- an individual paying someone from a wallet address or QR code.

Their fear is not complicated DeFi risk. It is a familiar human mistake: wrong address, wrong amount, duplicated payment, or uncertainty that the address belongs to the intended person.

### Recipient

The recipient already has a Solana wallet. They should not need to create a Protected Pay account, complete KYC, install a proprietary app, or understand MagicBlock. They only need to open the shared payment link, connect the wallet named by the payment, and confirm that the payment is theirs.

### Hackathon viewer

A judge or viewer should understand the problem and result without knowing what an Ephemeral Rollup is. Technical evidence is available after the product story, not required to understand it.

## Product Principles

1. **Safety without custody confusion:** always say whether money is available, locked, recoverable, or final.
2. **One clear promise:** the interface is about protected USDC payments, not a general wallet or banking super-app.
3. **Progressive friction:** risky payments justify one recipient confirmation; correct payments then complete without more sender work.
4. **Human control:** a sender can interrupt every unsettled payment.
5. **Honest finality:** after settlement, the Undo action disappears and the product explains that a return now requires a new refund.
6. **Private, not anonymous:** privacy protects users from public-chain exposure; it is not marketed as hiding regulated activity.
7. **Infrastructure stays backstage:** users never need to press buttons labeled delegate, commit, undelegate, PDA, Crank, or ER.

## First-Run Experience

When the application opens without a connected wallet, the user sees:

- the headline **"Send USDC with an Undo window"**;
- a one-sentence explanation;
- a **Connect wallet** button;
- a 15–20 second visual explanation of `Send → Pending → Settled or Recovered`;
- no infrastructure terminology.

After connecting, the user sees their wallet address, available protected USDC balance, USDC held in individual pending payments, and one primary action: **Send protected payment**.

If the protected balance is empty, the primary action becomes **Add USDC**. The interface explains that this balance is program-controlled while payments are pending and remains withdrawable when not locked.

For the hackathon environment, the interface must clearly label test tokens and network so nobody mistakes them for production USDC.

## Core User Journey

### 1. Fund the protected balance

The sender chooses an amount of USDC to add and approves the wallet transaction. The application shows three visible stages: awaiting approval, confirming, and available.

Acceptance criteria:

- The user sees the token and amount before signing.
- A rejected wallet signature leaves the balance unchanged and provides a retry action.
- The application does not report funds as available until chain state confirms them.
- Refreshing the page restores the confirmed balance from program state.
- The user can withdraw any amount that is available and not locked.

### 2. Prepare a payment

The sender opens the send screen and provides:

- recipient Solana address;
- amount in USDC;
- optional private note;
- a fixed hackathon safety window shown before approval.

The review screen presents the full recipient address with a shortened visual form for scanning, the amount, token, safety window, and the rule that the recipient must confirm before the claim deadline.

Acceptance criteria:

- An invalid address cannot proceed to review.
- Zero and negative amounts are rejected.
- An amount larger than the available protected balance is rejected with the missing amount shown.
- Sending to the connected sender address is blocked.
- The full destination can be copied and inspected before approval.
- The optional note is labelled private and is never shown as a public memo.
- A possible duplicate—same recipient and amount while another payment remains pending—produces a strong warning before approval.

### 3. Approve once

The sender approves one payment transaction. The product creates a unique protected payment and moves the amount from the sender's aggregate available balance into that payment's private escrow.

Acceptance criteria:

- One approval creates no more than one payment.
- The payment appears in activity as **Pending** only after confirmation.
- The same click, refresh, or retry cannot create a second payment accidentally.
- The available balance and individual pending-payment amount update together.
- The user receives a shareable link and copy/share action after creation.

### 4. Private pending state

The pending-payment detail screen shows:

- amount and USDC;
- recipient address;
- time remaining in the safety window;
- time remaining before the claim expires;
- recipient-confirmation status;
- **Undo payment** as the primary recovery action;
- a sentence saying the recipient cannot spend the payment yet.

Acceptance criteria:

- The sender can revisit this screen after refresh or wallet reconnect.
- The countdown is explanatory; authoritative status always comes from program state.
- The interface does not claim that a browser timer itself will settle the payment.
- An unauthorized wallet cannot view private amount, recipient relationship, note, or recovery status.
- The status changes without requiring a full page reload.

### 5. Recipient confirmation

The recipient opens the payment link and connects a wallet.

If it matches the intended recipient, the recipient sees the payer's offered amount, its pending status, the earliest settlement time, and a **Confirm this payment** action.

If it does not match, the recipient sees no private payment details and a clear wrong-wallet message.

Acceptance criteria:

- Only the named recipient wallet can confirm.
- Confirmation cannot change the amount, payer, recipient, or deadlines.
- Confirmation does not make the money spendable before the safety window ends.
- The recipient cannot confirm after the claim deadline.
- A repeated confirmation is harmless and does not settle twice.
- The recipient is clearly told that pending money must not be treated as final payment for delivered goods or services.

### 6. Correct payment resolves automatically and is claimed safely

When the recipient has confirmed and the safety window has ended, MagicBlock Crank marks the payment settled without another sender action. The escrow remains in the shared Payment until the recipient claims it into their own private balance, so automation never receives access to either user's aggregate Deposit.

Acceptance criteria:

- The payment becomes **Settled** only when both confirmation and time conditions are satisfied.
- Exactly the escrowed amount becomes claimable only by the intended recipient.
- The recipient's claim credits their own private available balance exactly once and seals the Payment.
- The sender's Undo action is removed after settlement.
- Both parties see a final receipt with payment ID, amount, parties, status, and completion time.
- A late or repeated automation attempt cannot credit the recipient twice.
- The recipient can withdraw settled USDC through the normal withdrawal flow.

### 7. Sender undoes a mistake

Before settlement, the sender selects **Undo payment**. A confirmation sheet states that the recipient will not receive this payment and that the payment escrow will return to the sender's available balance.

Acceptance criteria:

- Only the sender or an authorized recovery role can cancel.
- Cancellation remains available after recipient confirmation until settlement actually occurs.
- A cancelled payment becomes **Cancelled** and cannot later settle.
- The exact escrow amount returns to available balance.
- The sender and recipient both see the final cancelled status.
- The application never describes cancellation as a post-settlement clawback.

### 8. Abandoned payment resolves automatically and recovers safely

If the recipient has not confirmed before the claim deadline, MagicBlock Crank marks the payment expired while both users may be offline. The escrow then becomes claimable only by the sender; the recovery center can batch that claim when the sender returns.

Acceptance criteria:

- The sender does not need to remain online.
- The payment becomes **Expired**, not failed or settled.
- The exact amount becomes claimable only by the sender and returns to available balance on claim.
- The old recipient link can no longer confirm or claim.
- A delayed or repeated expiry action remains harmless.
- The activity screen explains that the payment expired because it was not confirmed.

## Human Recovery Journey

The activity screen contains an **Emergency controls** entry. It is visually distinct but not alarming during normal use.

The recovery view provides:

- pause new automated payment activity, if automation has been enabled;
- revoke temporary session authority, if one exists;
- list all unsettled payments privately;
- cancel one recoverable payment;
- cancel all recoverable payments with a deliberate confirmation;
- withdraw remaining unlocked balance;
- explain which payments are already final and cannot be undone.

Acceptance criteria:

- Emergency actions never redirect funds to a different recipient.
- Pausing automation does not prevent the owner from cancelling or withdrawing safely.
- Cancelling all shows the number and total value of affected payments before approval.
- Settled payments are excluded from the recoverable total.
- A revoked temporary authority cannot create new automated payments.
- Recovery actions produce clear final records rather than silently removing history.

If session-key automation is not implemented in time, the UI must omit pause and revoke controls rather than display nonfunctional buttons. Individual and bulk cancellation remain the required human-recovery product.

## Activity And Receipt Experience

The activity screen is grouped into:

- **Needs attention:** pending payments nearing a deadline or waiting for confirmation;
- **In progress:** normal pending payments;
- **Completed:** settled, cancelled, and expired payments.

Each row shows recipient shorthand, amount, status, and relevant time. Selecting a row opens the full authorized detail view.

Acceptance criteria:

- An empty activity screen explains how to create the first protected payment.
- Status labels use plain language and consistent colors/icons.
- Pending does not use the same success styling as settled.
- Cancelled and expired records remain visible for trust and explanation.
- A returning user sees state reconstructed from the chain rather than browser-only history.

## Status Language

| Program state | Sender-facing language | Recipient-facing language |
|---|---|---|
| `Created` | Waiting for recipient confirmation | Confirm to accept this pending payment |
| `Acknowledged` | Recipient confirmed; still undoable until settlement | Confirmed; available after the safety window |
| `Settled` | Payment completed; Undo is no longer available | Claim USDC into protected balance |
| `Cancelled` | Payment undone; USDC returned | Sender cancelled before settlement |
| `Expired` | Not confirmed; escrow ready to recover | Payment link expired |

## Fixed Hackathon Timing

To keep behavior easy to demonstrate and test:

- safety window: 60 seconds from creation;
- recipient claim deadline: 5 minutes from creation;
- sender cancellation: any time before settlement;
- settlement: after recipient confirmation and safety-window completion;
- expiry: after the claim deadline if still unconfirmed.

These are demonstration settings, not a claim that all real-world payments should use the same timing. A production design would offer policy tiers and evaluate user behavior before choosing defaults.

## Error And Edge Cases

### Wallet and network

- Wrong network: show the required network and a switch/retry action.
- Wallet disconnected mid-flow: preserve the draft locally but do not claim payment creation.
- Signature rejected: return to review with values intact.
- Transaction submitted but status uncertain: show **Checking payment status**, then reconcile from chain state before enabling retry.

### Payment races

- Sender cancels while automation attempts settlement: only one terminal state may succeed; refresh displays the winning onchain state.
- Recipient confirms near expiry: current chain time and state determine whether confirmation is accepted.
- Two tabs submit the same draft: unique payment identity and reconciliation prevent duplicate value movement.
- Automation runs late: live state, not the original schedule, determines the allowed action.

### Funds

- Deposit succeeds but the interface loses connection: balance appears after reconnection.
- Available balance changes before approval: creation fails clearly and does not partially lock funds.
- Withdrawal requested while funds are locked: only the available amount can be withdrawn.
- Recipient has no initialized token account: the product explains whether final credit remains internal until withdrawal instead of reporting a false failure.

### Privacy

- Unauthorized viewer opens a shared link: no sensitive payment fields are revealed.
- Recipient forwards their link: the wrong wallet still cannot inspect or confirm the payment.
- Public explorer: the product never promises to hide unavoidable funding, withdrawal, timing, or base-layer metadata.

### Finality

- User tries to undo a settled payment: show **This payment is final** and explain that the recipient must send a separate refund.
- User tries to reuse an expired link: show the terminal status without allowing confirmation.

## What We Are Building

- Responsive web application.
- Solana wallet connection.
- Test USDC deposit, available balance, locked balance, and withdrawal.
- Protected payment creation with one sender approval after funding.
- Private pending detail visible only to authorized wallets.
- Shareable recipient link.
- Recipient confirmation.
- Sixty-second sender Undo window.
- Five-minute unconfirmed-payment expiry.
- Automatic settlement/expiry decisions plus owner-only escrow claims.
- Activity list and final receipts.
- Individual and bulk recovery for unsettled payments.
- Real deployed program and explorer evidence.

## What We Would Add With More Time

- Trusted-recipient mode that removes confirmation for repeat contacts.
- User-configurable safety policies and thresholds.
- Bounded recurring contractor or payroll payments.
- Separate recovery wallet or multisig guardian.
- Sponsored fees and token-paid fees.
- Solana Pay-compatible QR requests where compatible with protected routing.
- Approved USDT support.
- A documented adapter for compliant crypto-to-bank providers such as Resolva, subject to partnership and API availability.
- Local or open-model explanations of why a payment was protected.
- Notifications through opt-in channels.
- Security audit, observability, and production operational controls.

## Non-Goals

- No claim of guaranteed recovery after settlement.
- No fiat conversion, bank transfer, dollar card, or exchange operation.
- No merchant dispute resolution or AI judge.
- No support for arbitrary tokens.
- No anonymity or compliance-evasion promise.
- No browser-only mock of settlement or recovery.
- No production handling of real mainnet customer funds during the hackathon.

## Success Measures

The MVP succeeds when:

- a new viewer can repeat "Undo for USDC payments" after 30 seconds;
- a sender completes the funded send flow without learning MagicBlock terminology;
- a recipient confirms with the correct wallet and a wrong wallet learns nothing private;
- one payment becomes settled automatically and is claimed exactly once;
- one mistaken payment is undone and returns the exact amount;
- one abandoned payment expires without the sender online and only the sender can claim the exact amount;
- every visible recovery action corresponds to a real, tested program transition;
- removing MagicBlock would materially remove privacy, real-time delegated execution, and scheduled recovery.

## Submission Proof Points

The product-first video should prove three moments:

1. **The emotional hook:** a wrong payment is frightening because normal finality offers no Undo.
2. **The product moment:** one protected payment displays a private countdown and can be undone.
3. **The trust moment:** MagicBlock resolves another payment and an abandoned one without a browser timer; each resulting escrow can be claimed only by its rightful owner.

Technical evidence after the opening product story must include:

- repository link;
- deployed program address;
- explorer transaction or commitment link;
- proof that payment transitions used the Ephemeral Rollup endpoint;
- authorized-versus-unauthorized private-read demonstration;
- Crank-triggered settlement or expiry;
- tests for authorization, races, replay, terminal states, and balance conservation.

## Product Acceptance Decision

Protected Pay is ready to move into technical specification when the team accepts these constraints:

- USDC only;
- funded protected balance before repeated sends;
- recipient confirmation in the hackathon flow;
- fixed 60-second safety and 5-minute claim windows;
- no Resolva integration, fiat payout, paid AI, or post-settlement clawback;
- three end-to-end proof scenarios take priority over every optional feature.
