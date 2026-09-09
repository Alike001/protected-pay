# Protected Pay: Hackathon MVP Scope

Status: proposed scope, awaiting confirmation of the team's remaining build time and technical comfort.

## Product In One Sentence

Protected Pay gives USDC payments on Solana a private safety window so a sender can undo a mistake before the payment becomes final, while abandoned payments recover automatically.

## Target User

The first user is a Solana wallet holder, freelancer, or small team member who needs to send USDC to a new or unfamiliar recipient and is worried that one wrong address, wrong amount, or duplicate action will become permanent.

This MVP is not for every kind of payment. It is specifically for a payment where the sender thinks:

> "I need to pay this person, but I want a short chance to catch a mistake before they can spend the money."

## Core Promise

> Approve once. Undo mistakes. Correct payments settle automatically.

The product protects a payment before final settlement. It never claims to seize funds from a recipient after settlement.

## Required User Flow

### Sender

1. Connect a Solana wallet.
2. Enter or scan the recipient address.
3. Enter a USDC amount.
4. Review the recipient and amount.
5. Approve one protected-payment transaction.
6. See the privately pending payment and countdown.
7. Either tap **Undo** or let the payment complete automatically.

### Recipient

1. Open the payment link or recipient view.
2. See only the payment offered to their wallet.
3. Acknowledge the payment when the policy requires it.
4. Receive the final private balance credit after the safety rules pass.
5. Withdraw settled USDC through the normal settlement path.

### Recovery

1. Pause automated activity.
2. Revoke any temporary session authority.
3. Review unsettled payments privately.
4. Cancel one or all recoverable payments.
5. Withdraw remaining funds or correct the policy and resume.

## MVP Features

### Must Ship

- Solana wallet connection.
- USDC-only deposit or funded test balance.
- One unique payment record per protected payment.
- Private pending-payment state.
- Sender-controlled cancellation during the safety window.
- Strict final settlement after the required conditions and time pass.
- Automatic expiry and refund for an unclaimed payment.
- Payment status: `Created`, `Acknowledged`, `Settled`, `Cancelled`, or `Expired`.
- A simple activity/history screen.
- A recovery center with pause, revoke, review, and cancel controls.
- Clear UI language distinguishing pending funds from settled funds.
- Program tests for authorization, time boundaries, duplicate execution, and balance conservation.
- A deployed program address and explorer proof.

### Should Ship If Time Allows

- QR/deep link that pre-fills recipient and amount.
- Optional recipient acknowledgement for first-time or high-value payments.
- Deterministic policy rules for first-time, large, or duplicate-looking payments.
- A separate judge/proof view showing ER execution, private access, and Crank completion.

### Explicitly Cut From The Hackathon MVP

- Resolva or other fiat off-ramp integration.
- Nigerian bank-account payouts.
- Visa or Mastercard issuance.
- SOL, USDT, swaps, price oracles, and exchange rates.
- Paid AI APIs or an AI adjudicator.
- Buyer-versus-seller disputes and human arbitration.
- Global username or identity registry.
- Native mobile applications.
- Arbitrary post-settlement clawback.
- Production claims, security-audit claims, or custody of mainnet user funds.

These cuts preserve the one promise judges and users need to remember: **undo USDC before finality**.

## MagicBlock Must Be Visible In The Working Product

| Component | Required proof |
|---|---|
| Ephemeral Rollup | The payment state transitions actually execute against delegated accounts through the ER endpoint. |
| Private ER | An authorized sender or recipient can read the pending payment; an outsider cannot read the same private details. |
| Crank | A scheduled deadline instruction settles or expires a payment without a user manually clicking finalize. |
| Solana program | USDC accounting, roles, time guards, and terminal states are enforced by the program rather than the browser. |
| Base-layer settlement | Committed state and withdrawal provide an explorer-verifiable result. |

Session keys are valuable for bounded automation but are not allowed to delay the core send, undo, settle, and expire flows. If included, the program—not the session token alone—must enforce the recipient, amount, count, and expiry policy.

## Three Demo-Proof Scenarios

### 1. Correct Payment

The sender creates a protected USDC payment. The countdown ends, the Crank invokes settlement, and the recipient balance is credited exactly once.

### 2. Mistaken Payment

The sender notices the wrong address or amount, taps **Undo**, and the locked USDC returns to the sender's available balance. A later Crank call cannot settle it.

### 3. Abandoned Payment

The required recipient acknowledgement never arrives. The claim deadline passes and the Crank expires the payment, returning the funds automatically.

These three scenarios make the product understandable while proving its most important security invariants.

## Build Order

### Phase 1: Technical Feasibility Spike

- Create the smallest Anchor program with deposit balance and payment PDAs.
- Implement `create_payment`, `cancel_payment`, `acknowledge_payment`, `settle_payment`, and `expire_payment`.
- Enforce one-way states, signer roles, time guards, and exact balance accounting.
- Delegate the relevant accounts and prove at least one transition executes on an Ephemeral Rollup.
- Stop and reconsider architecture if real token custody, delegated state, or deadline execution cannot work together safely.

### Phase 2: MagicBlock Core

- Add the Private ER permission configuration.
- Prove authorized and unauthorized reads.
- Add the scheduled Crank instruction.
- Make scheduled handlers idempotent and safe when called late or more than once.
- Add a narrow pause/recovery authority.

### Phase 3: Product Interface

- Build the send screen, pending countdown, Undo action, activity history, and recovery center.
- Hide infrastructure terminology from the normal user journey.
- Add clear pending-versus-final language.
- Add a QR or shareable payment link only after the base flow works.

### Phase 4: Verification

- Test unauthorized acknowledgement and cancellation.
- Test cancel-versus-Crank and settle-versus-expire races.
- Test double settlement and replay.
- Test pause and revoked-session behavior.
- Test that the total of available, locked, settled, and withdrawn amounts remains conserved.
- Run a devnet/ER end-to-end smoke test and preserve transaction links.

### Phase 5: Submission

- Record a product-first video whose first 30 seconds show the problem, one approval, Undo, and automatic settlement.
- Continue with a short technical proof section rather than making infrastructure the opening story.
- Publish the accessible repository, deployed program address, explorer link, product URL, and concise project description.

## Definition Of Done

The MVP is done when a new viewer can perform and understand all three proof scenarios without being taught MagicBlock terminology, and the repository proves that the private ER and Crank—not browser timers or mocked buttons—caused the relevant state transitions.

## Decisions Still Needed

Only decisions that materially change implementation remain:

1. How many focused build hours remain before submission?
2. Is the builder comfortable with Rust/Anchor and React/TypeScript, or should the scope assume substantial learning time?
3. What safety-window values should the demonstration use? A short demo window can stand in for a longer real-world policy.
4. Is recipient acknowledgement mandatory for every protected payment or only for first-time/high-risk payments?
