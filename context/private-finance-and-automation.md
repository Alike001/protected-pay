# Reality Research: Private Finance And Automation In Web3

Research checked on 2026-09-08. This document maps the problem space before product ideation. It does not select a hackathon idea.

## Scope

This brief answers three questions:

1. Who has money they cannot safely let ordinary software control today?
2. What repeated financial decision could software make for them?
3. Which information should not be visible to the whole blockchain?

It also explains the major private-finance and automation patterns already used across Web3 ecosystems.

## Sources Checked

- [MagicBlock Crank documentation](https://docs.magicblock.gg/pages/tools/crank/introduction)
- [Safe agent spending-limit quickstart](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit)
- [Gelato Web3 Functions](https://docs.gelato.cloud/web3-functions/introduction/overview)
- [Chainlink Automation documentation](https://docs.chain.link/chainlink-automation)
- [Superfluid documentation](https://docs.superfluid.org/)
- [Coinbase x402 documentation](https://docs.cdp.coinbase.com/x402/welcome)
- [UMA documentation](https://docs.uma.xyz/)
- [Oasis Sapphire concepts](https://docs.oasis.io/build/sapphire/develop/concept/)
- [Aztec foundational concepts](https://docs.aztec.network/developers/docs/foundational-topics)
- [Penumbra privacy guide](https://guide.penumbra.zone/overview/privacy) and [private DEX guide](https://guide.penumbra.zone/overview/dex)
- [RAILGUN privacy system](https://docs.railgun.org/wiki/learn/privacy-system)
- [Zcash payment-disclosure specification](https://zips.z.cash/zip-0311)
- [Secret Network sealed-bid auction example](https://docs.scrt.network/secret-network-documentation/confidential-computing-layer/ibc/usecases/sealed-bid-auctions)

## Verified Facts

### 1. What “private finance” means

Public blockchains are shared accounting books. Normal transactions can expose addresses, token types, amounts, timing, counterparties, and contract activity. Even when a person's legal name is absent, observers may connect addresses and behavior to a real identity.

Private finance means that some financial facts are hidden from the public while the system can still enforce valid rules. It does **not** have to mean that everything is anonymous or that nobody can audit anything.

A useful comparison is online banking:

- the bank and account owner can inspect a payment;
- the payment rules are enforced;
- every stranger on the internet cannot inspect it;
- the owner can disclose a receipt or proof when necessary.

Depending on the system, privacy may hide:

- who owns the money;
- who paid whom;
- the token or asset used;
- the amount and account balance;
- the timing and frequency of activity;
- a salary, invoice, bid, quote, or negotiated price;
- a trader's position, order size, limit, or strategy;
- credit, income, collateral, health, or claim information;
- business rules such as a treasury's approval limit;
- an agent's prompt, private input, or purchased result.

Different technologies hide different combinations. For example, RAILGUN describes hiding sender, recipient, token type, and amount; Penumbra describes private transfers and private swap/liquidity behavior; Aztec supports both private and public state; Oasis Sapphire uses confidential computation inside a trusted execution environment. These systems are not interchangeable.

Privacy also has edges. Oasis warns that applications can still leak information through transaction timing, gas use, storage-access patterns, logs, or the size and shape of state. A product is not automatically private merely because one component says “confidential.”

### 2. Selective disclosure is different from total secrecy

Real financial users may need to prove a payment, show records to an accountant, resolve a dispute, or meet legal obligations. Zcash's payment-disclosure specification is an example of producing evidence about a shielded payment without making all shielded activity public.

The practical goal is therefore often:

> Private from the public, visible to authorized participants, and provable when required.

### 3. What “financial automation” means

Financial automation is software repeatedly observing a condition, applying a policy, and executing or proposing a money action.

It can be understood as five stages:

```text
Observe → Decide → Authorize → Execute → Record / recover
```

Example: check whether an invoice is due; confirm it is from an approved vendor and below a limit; obtain the required authority; pay; save proof and allow an administrator to pause future payments.

A smart contract is closer to a locked vending machine than a robot. It reliably follows its rules when someone interacts with it, but it ordinarily does not wake itself up at 9:00 a.m. An outside transaction, keeper, crank, scheduler, user, or agent must trigger it.

MagicBlock's Crank documentation lists scheduled instructions such as recurring payments, subscriptions, rebalancing, liquidation, and yield compounding. Gelato supports condition-based transactions using onchain and offchain computation. Chainlink's documentation likewise describes externally operated automation infrastructure; its older Automation versions have been sunset in favor of its current Runtime Environment, so version choice matters.

### 4. Automation is not the same thing as AI

Most financial automation does not need a language model.

- **Time-based rule:** pay 500 USDC on the first day of each month.
- **Threshold rule:** top up collateral if a ratio falls below 150%.
- **Event rule:** release escrow after both parties approve a milestone.
- **Data-based rule:** purchase only if an authenticated market price is below a limit.
- **Judgment-assisted rule:** extract the amount and vendor from an unstructured invoice, then let fixed program rules determine whether payment is permitted.

AI is useful when the input is messy—documents, messages, classifications, or recommendations. It should not silently become the final authority over unlimited funds. The safer pattern is for AI to interpret or recommend while deterministic policies constrain the actual transaction.

Safe's official agent example demonstrates this principle with a token spending allowance that can reset periodically. It resembles giving software a prepaid company card rather than the master key to the company's bank account.

### 5. Why people cannot safely give ordinary software full control

The risk is not merely that “AI might make a mistake.” It includes:

- a stolen or leaked private key;
- a program bug that repeats or miscalculates a transfer;
- a bad or manipulated price/data source;
- an attacker changing an AI agent's instruction;
- a malicious document or webpage influencing an agent;
- unlimited approvals or an allowance that never expires;
- a failed service being paid before it delivers;
- irreversible transfers with no refund or dispute path;
- a scheduler failing silently or running twice;
- no emergency pause, revocation, or human escalation;
- public exposure of sensitive activity even when execution is correct.

The important design question is not “Can software hold a wallet?” It is:

> What narrow authority can software receive, for how long, under which limits, and how can a human stop or challenge it?

### 6. Who has this problem?

| Money owner | Money software should not control without limits | Repeated decision worth automating | Information that may need privacy |
|---|---|---|---|
| Small business or startup | Operating treasury | Which approved invoices, subscriptions, payroll items, or reimbursements should be paid | Balance, runway, salaries, vendor identity, negotiated prices, invoices |
| DAO or online team | Community treasury | Contributor payouts, grants, expense approvals, recurring services, treasury allocation | Recipient identity, grant bids, internal budgets, voting or allocation strategy |
| Freelancer or agency | Client escrow and project funds | Release, refund, or split payment when milestones are accepted | Client identity, rate, deliverables, contract value, disputes |
| Merchant or marketplace | Settlement balance | Revenue splits, refunds, supplier payments, subscription collection | Sales volume, customer graph, suppliers, margins, refund reasons |
| Trader, fund, or market maker | Trading capital and collateral | Rebalance, hedge, set limits, top up collateral, or reduce risk | Positions, order size, entry/exit limits, strategy, counterparties |
| Borrower or lender | Loan pool, repayments, and collateral | Interest collection, repayment, refinancing, collateral warnings or liquidation | Income, credit data, loan terms, collateral composition, business health |
| Insurer or mutual-aid pool | Premiums and claim reserves | Collect premiums, evaluate conditions, approve or dispute claims, pay valid claims | Medical or business evidence, exposure, claim amount, claimant identity |
| Employer or payroll operator | Payroll treasury | Salary, bonus, tax allocation, or contractor payments on a schedule | Compensation, identity, headcount, employment terms |
| Family or wealth manager | Allowance, inheritance, or managed portfolio | Allowances, bill payment, investment limits, inheritance-condition execution | Holdings, beneficiaries, family relationships, conditions |
| AI agent or automated service buyer | A small delegated wallet budget | Buy an API call, dataset, computation, or completed task within a spending policy | Budget, purchased service, request/prompt, result, business intent |

These are problem categories, not product recommendations. Each row still requires interviews or other evidence showing that the pain is frequent and serious for a specific user group.

### 7. What already falls under private finance in other ecosystems

#### Private payments

Shielded transfers hide payment details from public observers. Zcash, RAILGUN, and Penumbra demonstrate different versions of this category. Products may add receipts, payroll workflows, escrow, compliance disclosures, or spending policies around that private transfer primitive.

#### Private trading and DeFi

Penumbra hides trading and liquidity-provider information; RAILGUN enables private interactions with DeFi; Aztec exposes private and public contract state. The underlying need is to avoid broadcasting a valuable position or strategy before or during execution.

#### Confidential auctions and negotiations

Secret Network documents sealed-bid auctions: bidders submit confidential offers, and bids are not revealed to competing bidders during the auction. Similar confidentiality applies to procurement quotes, grant proposals, OTC negotiation, and credit offers.

#### Confidential financial computation

TEE-based systems such as Oasis Sapphire execute logic while application state is protected inside confidential hardware. MagicBlock's Private Ephemeral Rollups belong to this broad family, though their Solana integration and execution lifecycle differ.

#### Selective financial proof

A user may need to prove “I paid this invoice,” “my balance exceeds the required amount,” or “this policy approved the action” without exposing their entire history. Payment disclosures and zero-knowledge proofs are mechanisms used for this family of needs.

### 8. What already falls under automation in other ecosystems

#### Scheduled and streaming payments

Superfluid supports continuous money streams and lists salaries, subscriptions, grants, rewards, and automated investments among its uses. MagicBlock Cranks provide time-based scheduled Solana instructions. These mechanisms are payment rails; a product still needs to decide who is paid, why, when it can pause, and how errors are handled.

#### Conditional execution

Automation networks such as Gelato can monitor onchain or offchain conditions and submit transactions. Typical conditions include price thresholds, time, contract events, collateral levels, or signed external data.

#### Conditional settlement and disputes

UMA's optimistic oracle supports claims about real-world or cross-system facts that can be disputed. This is useful when a payment depends on a statement such as “the shipment arrived” or “the reported outcome occurred,” but it does not itself prove every real-world fact automatically.

#### Limited software spending

Safe allowances demonstrate bounded agent authority. Limits can constrain token, amount, period, and permission. This separates “software can make this specific class of payment” from “software owns the treasury.”

#### Machine-to-machine purchasing

Coinbase's x402 supports programmatic stablecoin payment for HTTP resources, including agents buying services. Olas provides a marketplace model for purchasing agent services. The financial decisions include service selection, price limit, proof of completion, release, refund, and budget replenishment.

## Inferences

### The most promising problem shape

A strong private-automation problem sits at the intersection of five properties:

1. **Repeated:** the decision happens often enough that manual work is painful.
2. **Rule-bound:** valid actions can be limited and verified.
3. **Sensitive:** public exposure creates personal, commercial, or security harm.
4. **Consequential but bounded:** real money moves, but one error cannot drain everything.
5. **Interruptible and recoverable:** the owner can pause future actions, revoke authority, inspect pending work, recover remaining funds, correct the policy, and resume safely.

If the activity is not repeated, automation adds little. If nothing sensitive exists, private execution may be decorative. If the decision cannot be checked or bounded, giving it autonomous financial authority is dangerous. If a human cannot interrupt it, a small software error can continue compounding into a financial incident.

### A useful way to separate the layers

```text
User problem        "Pay valid contractors without exposing rates"
Product workflow    invoice → policy check → approval → private payment → receipt
Automation rail     schedule, event, data condition, or external trigger
Privacy rail        hide selected inputs, state, or execution details
Settlement rail     token transfer and final onchain record
Optional AI         interpret the invoice or explain an exception
```

MagicBlock can supply some execution, privacy, and scheduling rails. It does not choose the user, define the business policy, verify every offchain fact, handle every dispute, or make an unsafe AI decision trustworthy. Those missing workflow pieces are where an application can become more than a MagicBlock feature demo.

### When AI is justified

AI is justified when software must understand unstructured information or help a human compare choices. It is unnecessary for fixed schedules, simple thresholds, or exact formulas. A paid hosted model is therefore not a requirement for the private-finance direction; the core workflow can be deterministic, and a local or free model can support a narrow optional interpretation step.

## Unknowns And Questions

These require validation before ideation becomes a scoped build:

- Which one user group can the team realistically interview or understand deeply during the hackathon?
- Which repeated task currently consumes money, time, or trust—not merely causes mild inconvenience?
- Which fields must be private from the public, which must be shared with counterparties, and which must be auditable later?
- What external event or data source triggers the decision, and how can that source be trusted?
- What maximum amount may software move per transaction and per period?
- Which actions require human approval, and what is the emergency-stop path?
- What happens if execution runs twice, runs late, fails halfway, or pays for bad work?
- Which privacy properties and production limits are available in the current hosted MagicBlock Private ER environment for hackathon teams?

## Not Included

- No final hackathon concept or target user has been chosen.
- No product requirements, smart-contract architecture, or UI has been designed.
- No claim is made that private execution alone satisfies legal, tax, accounting, or regulatory requirements.
- No claim is made that an AI model can safely validate real-world truth without trusted evidence and deterministic controls.
