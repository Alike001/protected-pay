# Reality Research: Resolva And Protected-Payment Product Fit

Research checked on 2026-09-08. "Resolva" in this brief means Resolva Solutions Limited at `useresolva.io`, not the unrelated Resolv stablecoin protocol.

## Scope

This investigation asks:

- what Resolva already provides;
- whether protected settlement would copy or complement it;
- whether the hackathon MVP should support only USDC;
- how the idea can be understood in 30 seconds with near-zero friction;
- how MagicBlock is essential to the product rather than added as a demo feature.

## Sources Checked

- [Solana Blitz v8 event page](https://luma.com/j13m2kqc)
- [MagicBlock Build submission page](https://build.magicblock.app/?stage=blitz#submit)
- Current MagicBlock documentation through Context7 (`/magicblock-labs/docs`), covering Ephemeral Rollup delegation and commitment, Private ER permissions, Cranks, and session keys
- [Resolva website](https://useresolva.io/)
- [Resolva mobile app listing](https://play.google.com/store/apps/details?id=com.useresolva.resolva)
- [Resolva Merchant setup and QR flow](https://blog.useresolva.io/how-to-set-up-your-resolva-merchant-account/)
- [Resolva's Solana-to-bank flow](https://blog.useresolva.io/spend-solana-in-nigeria-with-resolva/)
- [Resolva Terms of Service](https://useresolva.io/terms-conditions)
- [Resolva Privacy Policy](https://useresolva.io/privacy-policy)
- [Resolva AML/CFT/CPF policy](https://useresolva.io/aml-compliance)
- The prior-art repositories and analysis recorded in [protected-settlement-prior-art.md](./protected-settlement-prior-art.md)

## Verified Facts

### What Resolva is

Resolva is a Nigerian crypto-to-bank settlement product. A user selects a supported crypto asset and Naira, supplies a beneficiary's bank details, sends crypto to a Resolva-provided address, and Resolva converts it and pays the bank account. Its public product supports assets including USDC, USDT, BTC, SOL, and ETH across multiple networks.

Resolva Merchant lets a verified Nigerian business present a QR code. A customer scans it, enters the Naira amount, chooses crypto, and pays from an external wallet; the merchant receives Naira. The customer does not need a Resolva account.

Resolva therefore solves:

> "I own crypto, but the person or business I need to pay only accepts Naira in a bank account."

It does not primarily solve:

> "I approved the wrong recipient or amount and need a guaranteed sender-controlled undo after final settlement."

### Where Resolva's protection ends

Resolva already performs sensible prevention. Its published Solana flow resolves and displays the beneficiary's bank-account name, shows a review screen, and remembers previous beneficiaries.

Its Terms nevertheless say that users and merchants are responsible for accurate transaction instructions. Resolva disclaims liability for failures or reversals caused by incorrect or incomplete recipient details. It also says that underlying commercial disputes and refunds remain between the payer and recipient; Resolva does not adjudicate them.

Resolva has reversal and clawback rights for compliance, fraud, banking, and regulatory reasons. Those are platform/compliance powers, not a general consumer "I made a mistake" button.

Once crypto has been transferred to a Resolva address and the corresponding fiat settlement occurs, its Terms say the user's interest in that crypto passes to Resolva, subject to Resolva's compliance rights. A protected-payment layer must therefore act **before** this handoff, not promise to reverse the bank payout afterward.

### Privacy cannot mean hiding from compliance

Resolva's policies require KYC, transaction monitoring, record retention, and information sharing when legally required. Its privacy policy lists wallet addresses, transaction hashes, amounts, bank details, beneficiary details, and reversal or exception records among the data it may process.

For this product, "private" must mean:

- pending payment relationships and policies are not exposed to the public blockchain;
- only the payer, intended recipient, and necessary operator can inspect the pending state;
- a regulated fiat off-ramp can still receive the information it legally needs.

The product must never be marketed as a way to conceal payments from an off-ramp, bank, or regulator.

### Current event and submission status

The Solana Blitz v8 Luma page currently shows registration and links to the MagicBlock submission page. The public logged-out Build page currently renders a submission section but also the text "No open events to submit to right now." This conflicts with the user's authenticated/open-submission information. The safest operational action is to continue building while confirming the visible deadline after logging in or with the organizer; no exact deadline is asserted in this brief.

### Current MagicBlock mechanics fit the state machine

MagicBlock's current documentation supports:

- delegating program-owned accounts to an Ephemeral Rollup;
- running state transitions there, then committing or committing-and-undelegating state to Solana;
- Private ER permission accounts that restrict who may read the delegated state;
- Cranks that schedule an instruction to run later;
- session tokens that bind a temporary signer to an authority, target program, and expiry.

Private ER membership is not enough to authorize money movement. The Anchor program must separately enforce which signer may create, acknowledge, cancel, settle, pause, or withdraw. Crank handlers must re-check current state and time when they execute.

## Inferences

### Resolva is a complement, not the product to copy

A simple analogy:

- **Resolva is the delivery truck:** it converts crypto and delivers Naira to a bank account.
- **Protected Pay is the sealed dispatch desk:** it checks the parcel, holds it briefly, allows cancellation, and releases it to the truck only when the rules pass.

Building another off-ramp would require liquidity, bank integrations, KYC, transaction monitoring, and operational partnerships. It would also make MagicBlock incidental. The hackathon product should instead build the missing programmable safety layer. A future payout adapter could send a finalized payment to Resolva or another compliant off-ramp, but the MVP must not depend on an undocumented Resolva API or imply a partnership.

### Product decision

The recommended one-week product is:

> **Protected Pay — a private safety window for USDC payments on Solana.**

The everyday version is:

> Send USDC normally. For a new or risky payment, the money waits privately instead of becoming final immediately. You can undo it during the safety window; the recipient can confirm it; and an unclaimed payment returns automatically.

This protects **before final settlement**. After funds have finally settled and become withdrawable, a return is a new refund transaction; the sender cannot secretly seize the recipient's money.

### Why USDC only for the MVP

The program should be designed around an allowlisted token mint, but the hackathon interface should enable only Solana USDC.

USDC gives the MVP:

- a stable unit ordinary users can understand;
- one mint and one decimals rule to test;
- no swap, price oracle, slippage, or volatile SOL accounting;
- a direct connection to real payments and the USDC-denominated prize;
- a clean path to add approved SPL stablecoins later.

This is **USDC at launch, not USDC forever**. USDT can be the next allowlisted mint. Native SOL should wait because it introduces volatility and a different custody/accounting path.

### The 30-second explanation

> Have you ever sent money to the wrong person and realized one second too late? Protected Pay gives USDC payments on Solana a private undo window. Send once as usual; the payment waits privately, you can cancel a mistake, and unclaimed money returns automatically. MagicBlock makes the private real-time payment state and timed recovery run on Solana.

Short version:

> **Undo for USDC payments—before they become final.**

### Near-zero-friction rule

Literal zero friction is impossible for a non-custodial payment because the owner must authorize it. The measurable product target is:

1. scan a QR code, open a payment link, or select a saved recipient;
2. see the recipient, amount, and USDC clearly;
3. approve one wallet transaction;
4. see an unobtrusive countdown with an **Undo** action;
5. do nothing else when the payment is correct.

The safety work happens underneath. Recipient acknowledgement should be required only for first-time, high-value, or link-based payments; requiring two-party approval for every small repeat payment would destroy the experience. A recipient should not need to install a proprietary app merely to receive a normal wallet payment.

### Product flow

```text
Scan / choose recipient
          ↓
Review name, amount, USDC
          ↓
Approve once
          ↓
Private pending payment
     ├── Undo → sender recovers USDC
     ├── Unclaimed/expired → automatic recovery
     └── Rules pass → recipient receives final USDC
```

For the first build, the product should support two concrete entry points:

- **Wallet payment:** paste or scan a Solana address.
- **Payment link:** create a locally generated claim link or QR code that can be shared without a paid SMS, email, or AI API.

Fiat-bank settlement is a later adapter, not part of the core promise.

### Why this is a product rather than a MagicBlock demo

The user never sees buttons named `delegate`, `commit`, or `undelegate` in the primary experience. They see a payment product with a complete lifecycle:

- a clear customer: people, freelancers, and small teams paying a new recipient in USDC;
- a repeated job: send a payment without one typo becoming permanent loss;
- a visible outcome: paid, undone, or automatically recovered;
- a payment history and receipt;
- an emergency recovery center;
- rules for first-time, large, duplicate-looking, or automated payments;
- honest finality boundaries.

Technical proof belongs in a secondary judge view, repository, test suite, program address, and explorer link.

### Non-decorative MagicBlock integration

| Capability | Required product job |
|---|---|
| Ephemeral Rollup | `create`, `acknowledge`, `cancel`, `settle`, `expire`, and `pause` change delegated payment/balance state on the ER. |
| Private ER | Pending sender, recipient, amount, acknowledgement, and recovery state are restricted to the authorized parties while delegated. |
| Crank | A one-shot scheduled call settles or refunds after the deadline; the instruction validates live state so a stale task cannot move money twice. |
| Session key | Optional automation may prepare policy-compliant payments for a short period but cannot change policy, redirect money, or withdraw. |
| Solana | An SPL-token vault holds the actual USDC collateral, and committed state provides verifiable settlement and withdrawal. |

Removing MagicBlock would remove the private real-time pending workflow and scheduled onchain recovery. That makes the integration central enough for the hackathon.

### Human recovery is a first-class screen

```text
Pause automation
      ↓
Revoke temporary permission
      ↓
Review private pending payments
      ↓
Cancel one or cancel all unsettled payments
      ↓
Withdraw remaining USDC if desired
      ↓
Correct policy and resume with a fresh session
```

The recovery authority may pause, revoke, and cancel. It may never create a payment, change the recipient, settle early, or withdraw to itself.

### No paid AI key is required

The first automation engine should be deterministic:

- protect a first-time recipient;
- protect an amount above a user-set limit;
- flag a possible duplicate;
- stop when a daily budget is reached;
- pause outside an allowed schedule.

This is safer, testable, and needs no OpenAI, Anthropic, or other paid model API. An AI explanation layer can be added later, but it must not control authorization. The strongest initial submission categories are **Payments**, **Privacy**, and **Consumer** if the form offers them; do not claim an AI-agent category unless the agent is genuinely implemented.

### Product-ad presentation

The submission media should feel like an advertisement but contain real proof inside the story:

| Time | What the viewer sees | Message |
|---|---|---|
| 0–5s | "Transfer successful" followed by panic: wrong recipient | One mistake can become permanent. |
| 5–10s | Protected Pay's simple send screen | Send USDC with a safety window. |
| 10–18s | One approval, then a private countdown and Undo button | No new payment ritual. Safety runs underneath. |
| 18–24s | Undo succeeds; a second correct payment auto-settles | Cancel mistakes; correct payments complete automatically. |
| 24–30s | Private, real-time, automatic recovery badges | Powered by MagicBlock on Solana. |

The first 30 seconds sell the problem and outcome. A longer version can then show the explorer transaction, Private ER endpoint behavior, and automatic Crank transition for technical judging. A concept-only advertisement with no real transaction would weaken the technical-depth score.

### Hackathon filter

| Filter | Decision | Reason |
|---|---|---|
| Understood in 30 seconds | Pass | "Undo for USDC payments before finality" is one familiar promise. |
| Near-zero friction | Pass with discipline | One sender signature; no extra step for correct low-risk payments. |
| MagicBlock/Solana native | Pass | ER state transitions, Private ER visibility, Crank expiry, SPL USDC collateral, and Solana settlement are core. |
| Product, not demo | Pass if the full lifecycle ships | Send, pending, undo, auto-recover, settle, history, and recovery center—not infrastructure buttons. |
| Creativity | Strong | It combines privacy, staged finality, adaptive protection, and human recovery. |
| Technical depth | Strong but achievable | Real vault accounting, permissions, ER delegation, timed idempotent transitions, and adversarial tests. |
| One-week scope | Plausible only with USDC and no fiat/AI dependency | Off-ramp, multi-token swaps, AI adjudication, and card issuing are excluded. |

## Unknowns And Questions

- What exact safety window feels useful without annoying users: 30 seconds, two minutes, or user-configurable tiers?
- Can recipient acknowledgement be optional while keeping one simple state machine?
- What minimal payment metadata can be committed to Solana without weakening the privacy promise?
- Does the current authenticated Blitz v8 form expose a deadline or event selector that the logged-out page does not?
- Is there an official Resolva developer/sandbox API and partnership permission? No public integration contract was verified, so it is not an MVP dependency.
- Which QR standard should the product use in the first build: a normal Solana payment request, a protected-payment deep link, or both?

## Not Included

- No claim of partnership or integration with Resolva.
- No attempt to clone Resolva, hold fiat, issue cards, or bypass KYC/AML obligations.
- No promise to reverse a completed bank payment or ordinary settled USDC transfer.
- No support for SOL, USDT, swaps, exchange rates, or bank payout in the first MVP.
- No paid AI service and no AI judge.
- No legal, regulatory, or security-audit assurance.
