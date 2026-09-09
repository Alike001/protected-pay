# Reality Research: Private Protected Settlement Prior Art

Research checked on 2026-09-08. This brief examines open-source payment, escrow, delayed-execution, reversal, policy, and hackathon projects that overlap with the proposed product.

## Scope

The product idea under investigation is:

> A private protected-payment system in which money does not become irrevocably available to the recipient immediately. The intended recipient can acknowledge the payment, the sender has a bounded recovery period, unclaimed payments expire safely, and a human can pause or revoke automated authority before funds are lost.

This is **protection before final settlement**, not a promise to reverse an ordinary completed Solana transfer. The research asks:

- What parts of this idea already exist?
- Which do existing systems protect against a wrong recipient, a bad purchase, or compromised automation?
- Why is the product still distinct from MagicBlock's private-payments example?
- Which should be learned, removed, or redesigned for a one-week MagicBlock build?

The inspected repositories are pinned in [the reference-repository manifest](./reference-repos/README.md). Repository code was inspected as evidence. It should not be copied without checking the applicable license.

## Sources Checked

### Official platform and protocol sources

- Current MagicBlock documentation through Context7 (`/magicblock-labs/docs`), including [Ephemeral Rollups](https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup), [Private ER authorization](https://docs.magicblock.gg/pages/tools/tee/authorization), [Cranks](https://docs.magicblock.gg/pages/tools/crank/introduction), and [session keys](https://docs.magicblock.gg/pages/tools/session-keys/how-do-session-keys-work)
- [MagicBlock starter kits](https://github.com/magicblock-labs/starter-kits), especially `private-payments-demo`
- [MagicBlock session keys](https://github.com/magicblock-labs/session-keys)
- [Solana address-verification guidance](https://solana.com/docs/payments/send-payments/verify-address)
- [Solana spend permissions](https://solana.com/docs/payments/advanced-payments/spend-permissions)
- [Safe smart-account overview](https://github.com/safe-fndn/safe-smart-account/blob/main/docs/overview.md)
- [Safe research policy engine](https://github.com/safe-research/policy-engine)

### Direct payment and recovery precedents

- [Celo Escrow documentation](https://docs.celo.org/home/protocol/escrow) and [Escrow.sol](https://github.com/celo-org/celo-monorepo/blob/master/packages/protocol/contracts/identity/Escrow.sol)
- [TipLink open-source API](https://github.com/TipLink/tiplink-open-source)
- [Secure-Pay](https://github.com/preyanshu/secure-pay)
- [Zodiac Delay Modifier](https://github.com/gnosisguild/zodiac-modifier-delay)
- [ERC-20R reference implementation](https://github.com/kkailiwang/erc20r) and [research paper](https://arxiv.org/abs/2208.00543)
- [The Graph PaymentsEscrow](https://github.com/graphprotocol/contracts/blob/main/packages/horizon/contracts/payments/PaymentsEscrow.sol)

### Hackathon projects

- [Clawback](https://ethglobal.com/showcase/clawback-vpmw2), winner of an ENS prize at ETHGlobal New York 2026; [source](https://github.com/EdwardJXLi2/Clawback)
- [Preo](https://ethglobal.com/showcase/preo-rg0m9), winner of a Canton Foundation payments/neobanking prize at ETHGlobal New York 2026; [source](https://github.com/alycz/Preo)
- [World P2P](https://ethglobal.com/showcase/world-p2p-nxfuc), winner of a World prize at ETHGlobal Bangkok; [source](https://github.com/marciob/world-p2p)
- [Revoke.Delegate](https://ethglobal.com/showcase/revoke-delegate-usnjs), a multi-prize ETHGlobal Bangkok winner
- [SettleGuard](https://ethglobal.com/showcase/settleguard-avsgg), a close HackMoney 2026 comparison; [source](https://github.com/HitrMiss/SettleGuard)

## Verified Facts

### The idea is a combination of four existing patterns

No inspected project owns the whole combination, but each piece has precedent:

| Pattern | What already exists | What it does not solve |
|---|---|---|
| Verify before sending | Solana recommends destination-account checks and explicit user verification | It cannot recover a valid transfer sent to the wrong person |
| Deposit now, claim later | Celo Escrow, TipLink, and Secure-Pay hold funds before withdrawal | Privacy, cooling-off rules, identity, and sender/recipient fairness vary |
| Queue now, execute later | Zodiac Delay applies a cooldown and expiry to queued Safe transactions | It is generic treasury execution, not recipient-confirmed private payment |
| Freeze or dispute after an event | ERC-20R, Clawback, and marketplace escrows introduce adjudication | They add governance, judge, oracle, or buyer–seller complexity |

The proposed product is therefore not “the first escrow” or “the first reversible payment.” Its defensible combination is:

> private pending settlement + recipient verification + bounded human recovery + automatic time transitions + optional policy-controlled software.

### Celo is the closest mature claim-and-reclaim precedent

Celo's Escrow stores a token payment under a temporary payment ID. A recipient proves possession of the corresponding temporary key and, when configured, identity attestations. The sender may revoke only after the configured expiry.

The contract and tests establish several useful state rules:

- a payment ID identifies one escrowed payment;
- withdrawal deletes the payment before transferring funds;
- revocation is sender-only and unavailable before expiry;
- after either withdrawal or revocation, the other route fails because the payment was deleted.

There is an important boundary: expiry makes sender revocation *available*, but it does not itself close recipient withdrawal. Until the sender actually calls `revoke`, the recipient can still attempt withdrawal. That creates a race after expiry. A protected-payment program should instead make time part of the state-transition guard so a claim after the claim deadline is deterministically rejected.

Evidence in the local clone:

- [`EscrowedPayment`, payment ID, and indexes](./reference-repos/celo-monorepo/packages/protocol/contracts/identity/Escrow.sol)
- [`withdraw` and `revoke` implementation](./reference-repos/celo-monorepo/packages/protocol/contracts/identity/Escrow.sol)
- [revoke-path tests](./reference-repos/celo-monorepo/packages/protocol/test-sol/unit/identity/Escrow.t.sol)

### TipLink demonstrates a practical invitation-payment experience

TipLink's API creates an escrow associated with both a depositor and a receiver TipLink. Its SDK says either the original depositor or the emailed TipLink can withdraw from the onchain escrow. This is a strong user-experience precedent: a sender can pay someone who has not yet supplied or initialized a normal destination wallet.

The inspected API/IDL exposes no expiry or dispute state. The depositor's ability to withdraw is useful for mistaken invitations, but it is unsafe as a generic buyer–seller promise unless the receiver understands that funds are not final. The API code also relies on a TipLink service/API key to create the receiver link and recover the receiver email; that is not suitable as a dependency for an offline, no-paid-key hackathon core.

The `api/LICENSE` file says “all rights reserved,” so the implementation must be treated as architectural reference, not reusable source.

Evidence in the local clone:

- [EscrowTipLink API](./reference-repos/tiplink-open-source/api/src/escrow/EscrowTipLink.ts)
- [generated escrow IDL](./reference-repos/tiplink-open-source/api/src/escrow/anchor-generated/types/tiplink_escrow.ts)
- [onchain integration tests](./reference-repos/tiplink-open-source/api/test/escrow/EscrowTipLink.test.ts)

### Secure-Pay is a useful small example and a warning

Secure-Pay implements a simple public EVM mapping from `(sender, receiver)` to amount, expiry, and withdrawal status. The recipient withdraws before expiry; the sender refunds after expiry.

At the inspected commit, it has a serious overwrite problem: `depositFor` permits a new payment when the earlier payment has expired, then overwrites the previous amount without first refunding it. The old funds remain in the contract without a state reference. It also has no events, no private state, no recipient identity beyond the address, and no sender cancellation before expiry.

This is why our payment identity must be a unique payment PDA rather than one mutable slot per sender/recipient pair, and why expired state transitions must be idempotent and tested.

Evidence: [the complete escrow contract](./reference-repos/secure-pay/contract/escrow.sol).

### Zodiac Delay contributes queue discipline, not payment semantics

The Zodiac Delay Modifier maintains a FIFO queue with separate queue and execution nonces. An enabled module queues a transaction, anyone can execute the next transaction after cooldown, and the owner can invalidate queued entries by advancing the execution nonce. Optional expiration prevents stale queued transactions from remaining executable forever.

Reusable lessons are the monotonic nonce, hash-bound queued action, cooldown, expiration, and explicit skip path. The missing pieces are recipient identity, held funds, privacy, acknowledgement, and refund behavior.

Evidence: [Delay.sol](./reference-repos/zodiac-modifier-delay/contracts/Delay.sol).

### ERC-20R demonstrates why global post-settlement reversal is the wrong MVP

ERC-20R changes the token itself. It records transfer history, recursively traces downstream spending, freezes available descendant balances, records debts, and lets a governance contract reverse or reject a claim. The implementation explicitly assumes no cycles in the traced transfer graph in one part of the freeze algorithm.

That model is technically ambitious but creates broad consequences for token compatibility, storage, governance, downstream recipients, and finality. It solves theft adjudication, not the simpler mistake-prevention problem. Our project should not invent a new reversible USDC or attempt to seize funds after a normal recipient withdrawal.

Evidence: [ERC20R.sol](./reference-repos/erc20r/contracts/ERC20R.sol).

### Clawback is the strongest winning escrow state-machine reference

Clawback is an agent-to-agent service-payment product. Its contract uses explicit states (`Held`, `Released`, `Refunded`, `Disputed`), binds the buyer, seller, amount, window, specification hash, validity, and salt into the deal ID, and rejects mismatched authorization. The buyer may release early or dispute during the window; after the window, anyone can trigger release. Only the configured verifier may resolve a disputed deal.

Its tests cover early release, timed release, successful and rejected disputes, unauthorized attempts, replay/mismatched authorization, and the absence of an admin-drain selector. That breadth—not its AI judge—is what should influence our testing.

It differs from our intended product in three ways:

- it protects a purchase outcome, not an accidental person-to-person destination;
- it needs evidence and an adjudicator because seller delivery is disputed;
- its AI attester uses a confidential service and secret, whereas our first version can be deterministic and require no paid model API.

Evidence:

- [ETHGlobal winner page](https://ethglobal.com/showcase/clawback-vpmw2)
- [ClawbackEscrow.sol](./reference-repos/clawback/contracts/src/ClawbackEscrow.sol)
- [contract tests](./reference-repos/clawback/contracts/test/ClawbackEscrow.t.sol)

### Preo is the best private-policy and selective-disclosure reference

Preo is a winning private payroll-policy prototype on Canton. Its deterministic policy engine divides a paycheck according to user rules, creates pending approvals for categories such as new recipients or large transfers, and models private records with party-specific visibility.

Its privacy design separates the user's full private state from an employer notice, recipient receipt, and metadata-only operator event. This is directly reusable as a design principle: do not solve selective disclosure by putting every participant into one account that reveals everything.

For our product, the sender needs the full payment and recovery view; the recipient should see only the payment offered to them; an automation worker should see only the fields required to evaluate its policy; outsiders should see neither relationship nor reason.

Evidence:

- [ETHGlobal winner page](https://ethglobal.com/showcase/preo-rg0m9)
- [Daml payment receipt](./reference-repos/preo/daml/Preo/Payment.daml)
- [policy model](./reference-repos/preo/daml/Preo/Policy.daml)
- [privacy model](./reference-repos/preo/docs/PRIVACY_MODEL.md)
- [deterministic policy engine](./reference-repos/preo/packages/policy-engine/src/index.ts)

### World P2P and Revoke.Delegate validate two adjacent needs

World P2P won with an identity + escrow + dispute workflow for crypto-to-fiat trades. A trusted third party can resolve disputes. This confirms that judges accept escrow when it completes a real coordination workflow, but adding fiat proof and arbitration would expand our one-week scope too far.

Revoke.Delegate won with narrowly delegated authority whose only purpose is to set dangerous token allowances to zero. Its key product lesson is that recovery authority can be safer than execution authority: an emergency worker may be allowed to pause or revoke without being allowed to send money.

### SettleGuard is the closest competitive warning

SettleGuard's submission language overlaps heavily with this direction: risk-aware staged settlement, programmable holds, approval, and safe unwind for agent payments. It combines merchant identity, risk scores, bonds, an arbiter, and a payment vault.

However, the inspected commit does not establish a complete rollback path. `PaymentVault.refund` is callable only by the settlement engine, while `SettlementEngine` exposes a settlement trigger but no function that calls the vault refund. The repository has no contract test directory at the inspected commit. This does not prove the live demo never refunded, but it does mean the advertised recovery path is not demonstrated by the checked contract source.

This is a critical hackathon lesson: every button in our recovery story must correspond to a callable, authorized, tested program transition.

Evidence:

- [HackMoney project page](https://ethglobal.com/showcase/settleguard-avsgg)
- [PaymentVault.sol](./reference-repos/settleguard/contracts/contracts/PaymentVault.sol)
- [SettlementEngine.sol](./reference-repos/settleguard/contracts/contracts/SettlementEngine.sol)

### Safe and Solana delegation show where bounded automation must live

Safe warns that modules can execute arbitrary transactions and may completely take over an account. Its research policy engine therefore checks both normal Safe transactions and module-originated transactions. The general lesson is that a policy is bypassable if only the “AI route” checks it while another instruction can move the same funds.

Solana token delegation provides a useful base limit: the owner retains custody, grants one delegate a capped amount, and can revoke it. A new approval replaces the prior delegate. This limits total exposure but does not express recipient allowlists, per-payment limits, cooldowns, or purposes.

For the proposed program, every money-moving instruction—human, session key, Crank, or recovery call—must enter the same state machine and authorization checks.

### MagicBlock's starter is infrastructure, not this product

The inspected private-payments starter:

1. deposits SPL tokens into a shared vault and records a user's internal balance;
2. creates a Private ER permission group;
3. delegates deposit accounts to an ER validator;
4. performs a private internal balance transfer;
5. commits/undelegates the account;
6. allows the user to withdraw from the vault.

Its transfer instruction immediately subtracts from one deposit balance and adds to another. It has no payment object, pending state, recipient acknowledgement, cancellation, expiry, pause, or dispute. This is exactly the gap our application workflow would fill.

MagicBlock's current permission model and session implementation also require precision:

- Private ER permission membership governs who can read permissioned ER state; current documentation says a permission implies read access, while read/write separation may arrive later.
- Transaction write authorization still belongs in our Anchor account constraints and instruction logic.
- The current session token binds an authority, session signer, target program, and expiry; the inspected V2 implementation caps validity at seven days.
- It does **not** natively encode our recipient, amount, payment count, or purpose. Our target program must enforce those policy fields.
- A Crank can schedule an instruction, but the scheduled handler must re-check current payment status and time so a stale job cannot settle a cancelled payment.

Evidence:

- [MagicBlock private-payment program](./reference-repos/magicblock-starter-kits/private-payments-demo/programs/private-payments/src/lib.rs)
- [MagicBlock private-payment tests](./reference-repos/magicblock-starter-kits/private-payments-demo/tests/private-payments.ts)
- [session token implementation](./reference-repos/magicblock-session-keys/programs/gpl_session/src/lib.rs)

## Inferences

### What should be removed from the borrowed ideas

- **No post-settlement seizure.** Do not build ERC-20R or claim that completed USDC can be reversed.
- **No AI judge in the MVP.** A wrong-recipient problem does not require an LLM, paid API key, TEE adjudication, or evidence oracle.
- **No merchant bonds or reputation system.** Those belong to buyer–seller fraud, not initial payment safety.
- **No fiat/card rail.** International card access requires issuers and networks; it is a separate product.
- **No global username registry in the core.** It adds identity custody and impersonation risk before the payment state machine is proven.
- **No generic treasury platform.** It would weaken the clear story of a person protecting a risky or first-time transfer.
- **No claim that privacy is absolute.** Funding, withdrawals, timing, and eventual Solana settlement may still leak metadata and must be documented.

### What should be retained and adapted

| Prior art | Retain | Adapt for MagicBlock |
|---|---|---|
| Solana verification | Preflight destination classification and confirmation | Make high-risk or new-recipient transfers enter protected mode |
| Celo | Unique payment ID, claim proof, expiry/reclaim | Strict time guards, private state, automatic expiry, two-party visibility |
| TipLink | Invitation-style recipient onboarding | Avoid a required paid API; use a wallet-bound claim or locally generated claim secret |
| Zodiac | Cooldown, expiration, monotonic action identity | One payment PDA per operation and deterministic race handling |
| Clawback | Explicit finite states, term-bound ID, authorization and negative tests | Remove purchase dispute and AI verifier; add sender recovery and recipient acknowledgement |
| Preo | Deterministic policy, pending approval, selective views | Private ER permission groups plus separate minimal receipts |
| Revoke.Delegate | Narrow emergency authority | A recovery key may pause/revoke but never create or settle a payment |
| MagicBlock starter | Vault, internal balances, PER delegation, private transfer, withdrawal | Insert the protected-payment state machine between source and destination balances |

### Recommended product boundary

The best one-week product is a **private protected transfer**, initially for USDC between people:

1. The sender deposits funds into the program's vault or uses an existing private internal balance.
2. A transfer to a new or high-risk recipient creates a private payment PDA instead of crediting the recipient immediately.
3. The recipient authenticates and acknowledges the pending payment.
4. A minimum recovery window remains in force even after acknowledgement, or the sender explicitly confirms early finalization after reviewing the acknowledged recipient.
5. Before final settlement, the sender or a narrowly authorized recovery key can cancel.
6. If the intended recipient never acknowledges by the claim deadline, a one-shot Crank instruction returns the locked amount to the sender's available balance.
7. If all conditions pass, settlement credits the recipient's private deposit balance. A later return is a new refund payment, not a hidden clawback.

The minimum recovery window matters. If acknowledgement alone finalized instantly, a wrongly selected but active wallet could claim before the sender reacts. Conversely, the UI must tell the recipient that pending funds are not spendable, so a sender cannot pretend they are final and then cancel after receiving goods.

### Recommended state machine

```text
Created
  │
  ├── recipient acknowledges ──> Acknowledged
  │                                  │
  │                                  ├── recovery window ends ──> Settled
  │                                  └── sender/recovery key cancels ──> Cancelled
  │
  ├── sender/recovery key cancels ──> Cancelled
  └── claim deadline passes ────────> Expired/Refunded
```

Terminal states are `Settled`, `Cancelled`, and `Expired/Refunded`. Every transition must be one-way and idempotent. The settlement and expiry handlers must check both status and clock at execution time; scheduled jobs must never be trusted merely because they were scheduled earlier.

### MagicBlock requirement mapping

| Requirement or capability | Non-decorative role in the product |
|---|---|
| Mandatory Ephemeral Rollup | `create_protected_payment`, `acknowledge`, `cancel`, `settle`, and `expire` mutate delegated payment/balance state on the ER |
| Private ER | Sender, recipient, amount, memo/reason hash, acknowledgement, and recovery state are visible only to authorized members |
| Crank | Executes the one-shot deadline transition; the handler settles or refunds only if the live state permits it |
| Session keys | Let an optional automation worker prepare payments within a short session; the program enforces token, recipient, per-payment, cumulative, and expiry limits |
| Solana base layer | Holds real token collateral in a vault and receives committed account state before withdrawal |

The mandatory ER integration must be visible in the program and demo. Merely querying a private account while all payment decisions happen on ordinary Solana would be weak eligibility evidence.

### Human recovery design

```text
Pause policy
    ↓
Revoke session token
    ↓
Privately inspect pending payments
    ↓
Cancel selected or all unsettled payments
    ↓
Commit/undelegate and withdraw remaining funds if desired
    ↓
Correct policy and create a fresh session
```

Separate authorities are safer:

- **owner authority:** full create, cancel, policy, and withdrawal rights;
- **payment session:** may create only policy-compliant payments, never change policy or withdraw;
- **recipient:** may acknowledge only payments bound to that recipient;
- **recovery authority:** may pause, revoke, or cancel pending work, but may not redirect or settle funds;
- **Crank:** may call time transitions, but never choose a new recipient or amount.

No paid AI API is required. The initial “agent” can be a deterministic policy worker: protect all first-time recipients, payments above a threshold, duplicate-looking transfers, or transfers outside a configured schedule. A local open model can be added later for explanation, but must not control authorization.

### Race and abuse cases the tests must prove

1. A recipient cannot acknowledge a payment bound to another wallet or claim secret.
2. A sender cannot cancel after final settlement.
3. A recipient cannot acknowledge after the claim deadline.
4. A Crank executing late cannot settle an already-cancelled payment.
5. Two settlement attempts cannot credit the recipient twice.
6. Reusing a payment ID or authorization cannot reopen or redirect a payment.
7. Revoking a session stops new automated payments but does not destroy owner recovery.
8. Pausing blocks automation and scheduled settlement while still allowing safe cancellation/recovery.
9. A recovery key cannot create a payment, increase an amount, change a recipient, or withdraw to itself.
10. The sum of available, locked, settled, and withdrawn balances preserves the deposited total.
11. A failed or expired payment cannot be overwritten in a way that strands the original amount.
12. Outsiders cannot read private payment details through the Private ER endpoint.

### Reverse-engineering plan

This is the implementation-oriented plan derived from the inspected systems, not an instruction to copy them:

1. **Specify the state machine first.** Write state-transition and conservation invariants before choosing UI or AI behavior.
2. **Fork conceptually from the MagicBlock private-payment flow.** Preserve the vault/deposit/delegate/undelegate lifecycle, but implement a new payment PDA and locked-balance accounting.
3. **Implement only deterministic authorization.** Owner, recipient, recovery, session, and Crank capabilities must be explicit Anchor constraints.
4. **Add privacy deliberately.** Decide which accounts belong to sender-only, recipient-only, shared payment, and metadata-only permission groups.
5. **Make the Crank handler idempotent.** Prefer a one-shot job whose instruction safely no-ops or rejects after any competing terminal transition; do not depend on successful task cancellation for correctness.
6. **Prove recovery before adding an AI surface.** Demonstrate pause, revoke, review, cancel/refund, withdraw, correct, and resume.
7. **Build two demo stories.** Wrong recipient → cancel/recover; correct recipient → acknowledge/wait/settle/withdraw.
8. **Run adversarial tests.** Cover every race and abuse case above, including simultaneous cancel/settle attempts.
9. **Document privacy leakage.** State exactly what appears on Solana during deposit, commit, undelegation, and withdrawal.
10. **Add optional automation last.** A free deterministic worker can automatically select protected mode or prepare a payment, but the program remains the authority.

### Hackathon positioning

The strongest concise framing is:

> Ordinary blockchain payments force users to choose between instant finality and custodial recovery. We use MagicBlock to keep risky transfers private and pending, let recipients verify before settlement, automate expiry, and give humans a narrow emergency path to stop software without giving that software custody.

This supports the supplied judging criteria:

- **Creativity:** recovery is designed into a private payment lifecycle rather than added as a support ticket after finality.
- **Technical depth:** vault accounting, ER delegation, Private ER permissions, time-based transitions, bounded sessions, race safety, and human recovery interact.
- **Compelling Solana showcase:** the demo contrasts an irreversible direct transfer with a fast private protected transfer whose outcome can safely branch before finality.

## Unknowns And Questions

- Can one Private ER permission group currently give both sender and recipient the intended visibility without leaking their other deposit balances?
- Should the payment PDA be shared while sender and recipient balance accounts remain separately permissioned?
- Does the hosted hackathon Private ER support every account/permission CPI needed by this multi-party flow?
- What is the cleanest current Crank pattern for a one-shot task, and how are failed tasks retried?
- Which payment accounts can be committed without exposing private fields or a useful sender–recipient correlation on Solana?
- Is eSPL/private vault functionality stable enough for the event environment, or should the prototype use the starter's shared-vault accounting?
- How should a non-wallet recipient be invited without depending on a centralized paid email/API service?
- What minimum recovery period feels protective without making an ordinary payment frustrating?
- Should acknowledgement ever allow early settlement, or should only a second sender confirmation do so?
- How is a lost recipient claim secret rotated without enabling the sender to redirect the payment?

These require a small technical spike and user validation before the PRD is frozen.

## Not Included

- No final product name, UI design, PRD, or implementation specification.
- No claim that the inspected repositories are audited or production-safe.
- No code from third-party repositories has been merged into the application.
- No real-card, fiat bank reversal, or arbitrary post-finality clawback integration.
- No market-demand conclusion from hackathon awards alone.
- No security audit of MagicBlock, Solana Token Programs, or the inspected projects.
