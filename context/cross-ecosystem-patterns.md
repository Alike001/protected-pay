# Cross-Ecosystem Product Patterns

Research checked on 2026-09-08. This document explains the product categories appearing around AI agents, programmable payments, finance, and confidentiality in other blockchain ecosystems. These are patterns to understand before choosing an idea, not proposed MagicBlock projects.

## First: AI Does Not Require A Paid API

There are three sensible levels for a hackathon:

| Approach | What it means | Cost and tradeoff |
|---|---|---|
| Deterministic agent | Ordinary code follows explicit financial rules. An LLM may only translate a user's sentence into structured choices. | No model cost for the core behavior; most reliable for money. |
| Local open-source model | Run a model on the developer's machine through Ollama. | No paid hosted API or real API credential; requires enough local compute. |
| Hosted free model | Use OpenRouter's `openrouter/free` router. | Requires an API key, but not necessarily paid credits; availability and rate limits can vary. |

The MagicBlock `super-smart-contracts` repository expects `OPENROUTER_API_KEY` and currently defaults its model to `openrouter/free`. Therefore, it requires a credential but does not inherently require a paid model.

For a financial product, the safest design is:

> The model interprets or recommends; deterministic program rules authorize and move money.

The application should still demonstrate its core payment workflow if the model is unavailable.

## Pattern 1: Pay-Per-Use Internet Services

### Seen in

Coinbase/x402.

### Layman explanation

Today, software normally creates an account, receives an API key, selects a subscription, and pays a monthly bill before it can use another service.

With pay-per-use protocols, software asks for a resource, receives a response saying “this costs $0.002,” pays automatically, and receives the result. It is a vending machine for APIs.

### Typical uses

- one weather or market-data request;
- one document conversion;
- one web search;
- one AI inference;
- access to one article or dataset;
- machine-to-machine services.

### What x402 proves

Coinbase's x402 documentation supports programmatic stablecoin payments over HTTP for humans and agents. Its listed examples include pay-per-request APIs, paid content, AI agents purchasing services, and proxy services that aggregate other APIs.

### Missing pieces that products can add

- privacy for which service was purchased;
- budgets and approval rules;
- escrow when payment should follow successful work;
- refunds and disputes;
- subscriptions or negotiated pricing;
- reputation and service quality.

## Pattern 2: Bounded Agent Treasuries

### Seen in

Safe smart accounts and allowance modules.

### Layman explanation

Instead of handing an employee the company's entire bank password, the company gives them a card with a daily limit and permitted uses.

An AI agent can receive the blockchain equivalent:

- up to 100 USDC per day;
- only one selected token;
- only approved destinations or actions;
- permission that expires;
- owner revocation at any moment.

Safe's official AI-agent quickstart specifically demonstrates a treasury allowance that can reset periodically, such as 100 USDC per day.

### Missing pieces that products can add

- private balances and recipients;
- category-specific spending policies;
- multi-step approvals;
- invoice matching;
- unusual-activity detection;
- human-readable audit reports;
- agent-specific accountability.

## Pattern 3: Agent Service Marketplaces

### Seen in

Olas Mech Marketplace and x402 service discovery.

### Layman explanation

This is an app store or job board where the workers are software agents. One agent can hire another to find information, generate an asset, monitor a market, or perform a specialized task.

The marketplace must answer:

- What can this agent do?
- What does it charge?
- Can it be trusted?
- Did it complete the job?
- When should payment be released?

Olas describes its Mech Marketplace as a place to hire AI-agent services or offer an agent's services for crypto. Coinbase's x402 Bazaar provides a related service-discovery direction for payable APIs.

### Missing pieces that products can add

- private quotes;
- job escrow;
- milestone payments;
- proof of completion;
- disputes and refunds;
- provider reputation;
- confidential buyer requirements.

## Pattern 4: Streaming And Recurring Money

### Seen in

Superfluid.

### Layman explanation

A normal payment moves a lump sum: 100 USDC now. A stream changes the balance continuously: roughly 100 USDC over a month, accruing moment by moment until stopped.

This can represent:

- salary earned while working;
- a subscription active while service is available;
- continuous creator support;
- ongoing rewards;
- usage-based payment;
- recurring investing.

Superfluid's current documentation describes token streams, subscriptions, salaries, grants, rewards, automated investing, and one-to-many distributions.

### Missing pieces that products can add

- private salary or subscription amounts;
- agent-controlled start and stop decisions;
- quality-based rate changes;
- escrowed service streams;
- budget-aware distribution;
- confidential recipients.

## Pattern 5: Financing Money That Is Still On The Way

### Seen in

PayFi systems such as Huma.

### Layman explanation

A business may have earned money but not receive it for 30 or 60 days. A financing provider advances some money today and collects the delayed payment later.

Examples include:

- invoice financing;
- payroll advances;
- cross-border settlement financing;
- card-payment receivables;
- marketplace seller advances.

Huma describes PayFi as connecting capital to payment assets such as cross-border settlements, card payments, and payroll advances with on-chain settlement.

### Missing pieces that products can add

- private invoices and customer relationships;
- automated risk assessment;
- proof that a receivable exists;
- real-time repayment allocation;
- fraud monitoring;
- selective disclosure to lenders.

This category has strong real-world value but is difficult for a short hackathon because identity, credit, legal rights, and trustworthy input data matter.

## Pattern 6: Pay Only When A Claim Is True

### Seen in

UMA's Optimistic Oracle, insurance, and prediction-market patterns.

### Layman explanation

Someone makes a claim: “The package arrived,” “the flight was cancelled,” or “the contractor completed the work.” The system assumes the claim is true unless somebody challenges it before a deadline. A disputed claim moves to a resolution process.

This supports:

- insurance payouts;
- prediction-market settlement;
- delivery escrow;
- milestone verification;
- content or transaction disputes;
- results based on real-world events.

UMA's documentation includes insurance, prediction markets, transaction verification, and arbitrary data assertions.

### Missing pieces that products can add

- confidential claim evidence;
- AI-assisted review of documents;
- small instant undisputed payments;
- specialized dispute rules;
- private counterparties;
- reputation for proposers and challengers.

An AI opinion alone is not proof. The application still needs signed evidence, a trusted oracle, human approval, or a dispute mechanism.

## Pattern 7: Confidential Applications

### Seen in

Oasis Sapphire, Secret Network, and other confidential-compute systems.

### Layman explanation

Normal blockchains are glass rooms. Confidential-compute chains and layers let programs operate in a locked room while still producing a blockchain result.

Official examples across these ecosystems include:

- sealed-bid auctions;
- private voting;
- access-controlled secrets;
- confidential wallet control;
- protected identity or invoice data;
- private contract state;
- delayed public results from private inputs.

### Important lesson

“Private” is not one switch. A product must separately consider:

- transaction inputs;
- stored state;
- query access;
- logs and events;
- output and withdrawal behavior;
- timing and data-size leaks;
- who is allowed to decrypt what.

Oasis documentation explicitly warns that timing, gas usage, storage-access patterns, state size, and ordinary contract events can leak information even when state is encrypted. MagicBlock projects using PERs should apply the same cautious mental model.

## Pattern 8: Intent-Based Finance

### Seen in

CoW Protocol and similar solver-based trading systems.

### Layman explanation

Instead of specifying every step of a trade, a user states the desired outcome: “Swap this asset, but never give me less than this amount.” Competing solvers search for the best way to satisfy the request.

CoW Protocol uses batch auctions and “coincidences of wants,” where matching users can trade with each other before external liquidity is needed.

### Missing pieces that products can add

- private intents that hide strategy;
- AI assistance expressing a user's goal;
- bounded autonomous execution;
- private solver quotes;
- protection against information leakage;
- continuous or scheduled intents.

## What These Ecosystems Teach Us

The recurring valuable building blocks are:

1. **Delegated authority** — software can act, but only inside hard limits.
2. **Machine-native payment** — software can buy something without a checkout page.
3. **Conditional settlement** — payment depends on time, delivery, or a verified claim.
4. **Continuous money** — value can accrue with time or usage rather than moving only in lump sums.
5. **Confidential coordination** — amounts, counterparties, strategies, or evidence are hidden from unauthorized observers.
6. **Verifiable outcomes** — a model's answer is not blindly trusted; rules, signatures, evidence, or disputes govern consequences.

MagicBlock can combine several of these inside one Solana-native real-time environment. The opportunity is not to recreate its private transfer or AI callback example. It is to choose one real coordination problem and add the policies, evidence, roles, and user workflow that the infrastructure does not provide.

## Decision Before Idea Generation

Do not ask “Which technologies can we combine?” Ask:

> Who has money they cannot safely let software control today, what repeated decision do they need automated, and what information must remain private?

That question distinguishes a product from an infrastructure demonstration.

## Primary Sources

- [MagicBlock Super Smart Contracts](https://github.com/magicblock-labs/super-smart-contracts)
- [OpenRouter free model router](https://github.com/openrouterteam/docs/blob/main/guides/routing/routers/free-router.mdx)
- [Ollama OpenAI-compatible local API](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)
- [Coinbase x402 overview](https://docs.cdp.coinbase.com/x402/welcome)
- [Safe AI agent with a treasury spending limit](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit)
- [Olas agent marketplace](https://docs.olas.network/)
- [Superfluid money streaming](https://docs.superfluid.org/)
- [Huma PayFi overview](https://docs.huma.finance/about-huma/what-is-huma)
- [UMA oracle use cases](https://docs.uma.xyz/)
- [Oasis confidential application examples](https://docs.oasis.io/build/sapphire/examples/)
- [Oasis confidentiality security considerations](https://docs.oasis.io/build/sapphire/develop/concept/)
- [Secret Network sealed-bid auction](https://docs.scrt.network/secret-network-documentation/confidential-computing-layer/ibc/usecases/sealed-bid-auctions)
- [CoW Protocol overview](https://docs.cow.fi/)
