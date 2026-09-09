# Reality Research: The Operation Wedge For Private Programmable Finance

Research checked on 2026-09-08. This brief tests concrete financial operations against the product thesis:

> How can software perform financial work on someone's behalf without receiving unrestricted control over the money or exposing the financial activity publicly?

## Scope

The goal is to identify which operation deserves deeper user validation. Candidates are assessed for recurring work, sensitive information, bounded delegation, MagicBlock dependence, and one-week hackathon feasibility.

This is a current-reality and comparison brief. It does not finalize the product or its architecture.

## Sources Checked

- Current MagicBlock documentation through Context7 (`/magicblock-labs/docs`), including Private Ephemeral Rollups, permissions, session keys, and Cranks.
- [MagicBlock Private Payments demo](https://github.com/magicblock-labs/private-payments-demo)
- [MagicBlock private-payment starter](https://github.com/magicblock-labs/starter-kits/tree/main/private-payments-demo)
- [MagicBlock session keys](https://github.com/magicblock-labs/session-keys)
- [MagicBlock Cranks](https://docs.magicblock.gg/pages/tools/crank/introduction)
- [MagicBlock Build Graveyard](https://build.magicblock.app/graveyard) and its public [`/api/ideas`](https://build.magicblock.app/api/ideas) dataset
- [Safe agent spending limit](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit)
- [Coinbase x402](https://docs.cdp.coinbase.com/x402/welcome) and [x402 FAQ](https://docs.cdp.coinbase.com/x402/support/faq)
- [Request Finance API](https://docs.request.finance/) and [payroll API](https://docs.request.finance/salaries)
- [Union private-payroll use case](https://docs.payments.union.build/use-cases/payroll/)
- [Solana escrow program reference](https://github.com/solana-foundation/escrow/blob/main/docs/PROGRAM_OVERVIEW.md)
- [Superfluid money-streaming documentation](https://docs.superfluid.org/)
- Examples of existing onchain payment splitting and recurring billing, including [Volet revenue sharing](https://docs.volet.com/guides/accept-payments/platform-integrations/revenue-sharing/) and [Cloudflare stablecoin billing](https://developers.cloudflare.com/billing/payment-methods/stablecoin-payments/).

## Verified Facts

### The thesis describes a control layer, not yet a product

“Private programmable financial operations” is an umbrella category. It defines how money should be controlled but does not yet specify whose workflow is being completed.

Existing ecosystems already separate financial authority in several ways:

- Safe allows a treasury to grant an agent a token allowance that may reset periodically.
- Coinbase's agent payment tooling applies configured spending limits to x402 purchases.
- MagicBlock session keys are secondary signers whose token is checked by the target program for scope and expiry; MagicBlock documentation also describes application-specific duration, maximum-spend, and transaction limits.
- MagicBlock Private ER permissions control access to delegated account state. Current documentation says a permission presently implies read access; finer read/write separation may be added later.

The policy must ultimately be enforced by a program. An instruction sent by an AI agent is not safe merely because the agent describes it as safe.

### What MagicBlock currently contributes

| Capability | Current role |
|---|---|
| Private Ephemeral Rollup | Runs delegated Solana account state inside a TEE and limits who can query permissioned state. |
| Ephemeral Rollup | Processes frequent interactions with low latency, then commits relevant state back to Solana. |
| Crank | Schedules onchain instructions at predetermined intervals without a fresh manual transaction for every run. |
| Session key | Lets a secondary signer act within program-validated scope and expiry instead of using the owner's primary key repeatedly. |
| eSPL/private payment flow | Deposits tokens, represents balances in delegated accounts, performs private ER transfers, then undelegates/withdraws. |

MagicBlock does not itself decide whether an invoice is valid, whether work was completed, whether a merchant deserves a refund, or whether an AI recommendation is correct.

### Operations that already have obvious standalone primitives

- Private transfer demos already exist in MagicBlock's repositories.
- Scheduled instruction demos already exist through Cranks.
- Standard escrow programs already support deposits, withdrawals, timelocks, and hooks on Solana.
- Revenue-splitting contracts already divide incoming payments among recipients.
- Request Finance already exposes invoice, accounts-payable/receivable, and payroll workflows.
- Union documents a private-payroll product in which employees cannot inspect colleagues' salaries or the employer's treasury.
- x402 already lets humans and software pay per HTTP request on Solana and EVM networks.

Therefore, “private payment,” “scheduled payment,” “escrow,” “payment split,” “crypto payroll,” or “agent wallet” alone would be a primitive demo or an existing product category rather than a sufficiently differentiated workflow.

### What the MagicBlock Graveyard currently shows

The public Graveyard API returned 26 idea cards: 12 marked attempted and 14 marked unclaimed at the time of research. These labels describe whether the site has linked submissions; they do not prove market demand, technical feasibility, or judge preference.

Relevant signals include:

- **Pay-Per-Second Streaming** is marked attempted with six linked builds.
- **Private Sealed-Bid Auctions** is marked attempted with six linked builds.
- **Sub-Second Order Book** and **Live-Event Prediction Markets** are each marked attempted with six linked builds.
- **Invisible Retail Payments** is marked unclaimed. Its card describes private SPL transfers and rapid receipts for invoices and salaries.
- **Dark-Pool Trading Venue** and **Never-Miss Trigger Orders** are marked unclaimed.

This makes a basic streaming-payments, sealed-auction, order-book, or prediction-market submission especially likely to resemble prior work. “Invisible Retail Payments” is less attempted on the site, but its card still describes a payment primitive rather than policy, exception handling, or human recovery.

### Candidate operation comparison

The table separates observable workflow evidence from the later product decision.

| Operation | Evidence that the workflow exists | Repetition | Sensitive information | Authority can be bounded by | Obvious MagicBlock contribution |
|---|---|---:|---|---|---|
| Business invoices and operating expenses | Request Finance exposes accounts payable/receivable and invoice status tracking | Weekly/daily for active businesses | Vendor, invoice, amount, balance, runway, approval policy | Vendor allowlist, category, amount, period, due date, approval threshold | PER privacy, session policy, scheduled or event-triggered execution |
| Contractor payroll | Request Finance and Union both document crypto payroll; Union specifically documents private salary requirements | Weekly/monthly | Salary, identity, employer balance, headcount | Recipient, salary cap, schedule, employment period | PER privacy and Crank scheduling |
| Software/agent purchase of digital services | x402 explicitly supports AI agents buying APIs per request; Coinbase's agent tooling enforces configured limits | Potentially many times per task/day | Budget, purchased service, request, result, business intent | Per call, service, workflow, day, token, destination | Low-latency execution, private policy/state, session authority |
| Merchant revenue splitting and refunds | Current payment products document automatic onchain revenue splitting | Per sale/refund | Sales volume, margins, partners, supplier relationships | Split formula, approved refund reason, per-order maximum | Frequent execution plus private balances and commercial terms |
| Treasury rebalancing and collateral protection | MagicBlock lists rebalancing/liquidation as Crank uses and publishes price-oracle/finance examples | Continuous or threshold-based | Position, strategy, limits, collateral | Asset, venue, price deviation, exposure, loss limit | Real-time oracle state, low latency, privacy, automation |
| Milestone escrow | Solana and other ecosystems already expose escrow and milestone-release patterns | Per milestone, relatively infrequent | Contract value, deliverable, dispute, counterparties | Milestone amount, approvers, deadline, refund rule | Private terms; little inherent need for continuous ER execution |

## Inferences

### Current shortlist

No candidate wins every test. The evidence produces three distinct leaders:

1. **Private operating-expense execution** has the clearest established business workflow. It can go beyond a payment demo through invoice matching, policy checks, exceptions, approvals, receipts, and recovery. Its weakness is that low latency is helpful but not essential.
2. **Private software/agent procurement** has the strongest need for frequent, immediate, bounded transactions. It gives low-latency ER execution a genuine job. Its weakness is that the market is newer, and compatibility between an ER-private payment and existing x402 settlement requires technical investigation.
3. **Private merchant splits/refunds** combines real transaction frequency, sensitive commercial terms, and bounded policies. Its weakness is that basic splitting is already commoditized, so the missing workflow must be more substantial than a hidden percentage splitter.

Payroll is easy to understand and technically feasible, but a payroll-only submission would sit close to existing private-payment and scheduling demonstrations. Milestone escrow has strong control and recovery concepts but weak dependence on fast execution. Treasury rebalancing uses nearly every MagicBlock capability, but introduces the highest financial-correctness and oracle risk for a one-week build.

### The strongest MagicBlock-dependence test

For any operation under consideration, remove each MagicBlock capability mentally:

| Removal test | What should break if the fit is genuine |
|---|---|
| Remove Private ER | Valuable business, identity, balance, policy, or strategy data becomes publicly visible. |
| Remove session authority/policies | Software requires repeated owner signatures or receives dangerously broad authority. |
| Remove Crank | A genuinely scheduled operation returns to manual triggering. |
| Remove fast ER execution | A frequent or interactive workflow becomes too slow, expensive, or awkward. |

An operation does not have to require all four. However, if removing every MagicBlock-specific capability leaves essentially the same product, the project is using MagicBlock decoratively.

### Required workflow beyond MagicBlock

Whichever operation is selected, the application—not MagicBlock—must answer:

```text
Owner       Who controls and can recover the funds?
Worker      What software or agent may act?
Purpose     Which real task is it completing?
Trigger     Time, request, event, price, document, or approval?
Policy      Token, recipient, action, amount, frequency, expiry?
Privacy     Which state is hidden, and from whom?
Evidence    How is the condition or completed work proven?
Exception   When must a human approve or reject?
Recovery    Pause, revoke, retry, refund, dispute, and undelegate?
Audit       What selective receipt can an authorized person inspect?
```

That workflow is the defensible product layer. Private transfer, scheduling, and delegated execution are its rails.

### Human recovery is a first-class financial operation

The control loop is incomplete unless the owner can interrupt it:

```text
Active automation
      ↓
Pause future execution
      ↓
Revoke the software's session or permission
      ↓
Review pending and completed actions privately
      ↓
Cancel pending work and recover unspent/delegated funds
      ↓
Correct the policy
      ↓
Resume with new authority
```

“Recover funds” has a precise limit. An unexecuted instruction can be cancelled, and remaining delegated or escrowed funds can potentially be withdrawn. A finalized transfer cannot generally be clawed back without a programmed escrow/refund path or cooperation from the recipient. Coinbase's x402 FAQ, for example, states that its current push-payment schemes are irreversible and that refunds require a new return transfer; conditional escrow is described as a future scheme.

Recovery therefore breaks into separate controls:

| Control | What it protects |
|---|---|
| Pause | Stops new scheduled or agent-initiated actions from executing. |
| Revoke | Removes the session key or delegated software authority. |
| Review | Lets an authorized owner inspect queued, blocked, failed, and completed actions without publishing private details. |
| Cancel | Removes an instruction that has not executed yet. |
| Recover remaining funds | Undelegates or withdraws money that has not already been paid. |
| Refund/dispute | Handles money that left through an explicit return-payment, escrow, or dispute path. |
| Correct and resume | Installs a new policy and grants fresh, bounded authority. |

The application program must enforce these states. A visual “pause” button is not a safety control unless the onchain program rejects execution while paused.

### Recovery test by candidate

| Candidate | Natural recovery demonstration | Hard boundary |
|---|---|---|
| Operating expenses | Pause future bills, revoke operator, inspect pending invoice, cancel duplicate, withdraw remaining budget, correct vendor limit | A completed direct vendor transfer needs a refund or dispute path |
| Agent procurement | Stop purchases during a task, revoke session, block service, recover remaining budget | A completed x402 purchase is normally irreversible |
| Merchant splits/refunds | Pause settlement, revoke refund operator, inspect held orders, recover unallocated funds | Money already split to recipients cannot simply be recalled |

Operating expenses currently offers the richest understandable recovery story because pending, duplicate, exceptional, and completed payments have visibly different treatment.

### Implications of the supplied hackathon criteria

The supplied eligibility rule makes Ephemeral Rollup integration mandatory. The stated judging dimensions—creativity, technical depth, and a compelling demonstration of what is possible on Solana—make recovery useful beyond safety:

- **Creativity:** the project is not merely another private transfer; it models safe delegation and human intervention.
- **Technical depth:** private state, bounded authority, scheduled execution, policy enforcement, pause/revoke states, and fund withdrawal interact in one lifecycle.
- **Compelling demonstration:** the demo can deliberately make the software attempt an excessive or invalid payment, show the program block or queue it, then pause, revoke, review, correct, and resume.

Recovery must remain real program behavior rather than dashboard theatre. The ER integration is strongest when policy checks, private pending actions, and lifecycle state actually execute through MagicBlock.

### AI is optional and subordinate

The “software worker” can initially be deterministic automation. AI is justified only when the selected operation contains unstructured input, such as reading an invoice or interpreting a service request. Program rules should retain final authority over money.

## Unknowns And Questions

- Which candidate user can be reached for even two or three short problem interviews during the hackathon?
- Do Web3 teams consider public vendor payments, salaries, revenue shares, or agent purchases harmful enough to change tools?
- Which information must be hidden from the public but disclosed to the payer, recipient, accountant, or dispute resolver?
- Can the current hackathon PER environment support the required private-token flow, permission updates, Crank behavior, and selective receipt flow?
- Can an x402-compatible service accept settlement originating inside a Private ER, or would settlement require a custom payment scheme/facilitator or a public withdrawal first?
- Does MagicBlock's current session-key implementation enforce the desired cumulative limits directly, or must the target financial program store and check them?
- Which failure is most important to demonstrate: overspend prevention, duplicate-payment prevention, emergency revocation, failed-service refund, or human escalation?

## Not Included

- No final operation or target user has been selected.
- No product name, user interface, contract architecture, or build plan has been created.
- Candidate ordering is an inference from documented workflows and technical fit, not proof of market demand.
- No real funds should be placed in hackathon code without component-specific audit and deployment review.
