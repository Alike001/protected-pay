# MagicBlock Research Context

This folder is a reusable, evidence-backed map of the MagicBlock ecosystem for the Solana Blitz hackathon. It was researched on 2026-09-08 from MagicBlock's current documentation and public GitHub organization.

## Read In This Order

1. [Architecture and the L2 comparison](./architecture-and-l2.md) — what MagicBlock is and when the Ethereum L2 analogy stops being accurate.
2. [Use cases in plain English](./use-cases.md) — games, finance, payments, AI agents, DePIN, and privacy, plus a track-selection guide.
3. [Cross-ecosystem patterns](./cross-ecosystem-patterns.md) — what other blockchain ecosystems are building around agents, payments, finance, and privacy.
4. [Private finance and automation](./private-finance-and-automation.md) — who has money software cannot safely control, which decisions repeat, and what must remain confidential.
5. [Operation-wedge investigation](./operation-wedge-investigation.md) — compares concrete financial operations by pain, privacy, bounded authority, MagicBlock dependence, and hackathon risk.
6. [Mistaken transfers and cross-border access](./mistaken-transfer-and-cross-border-payments.md) — separates protected settlement from post-payment reversal and explains why dollar-card access is a different infrastructure problem.
7. [Protected-settlement prior art](./protected-settlement-prior-art.md) — compares open-source and winning projects, records what to retain or remove, and maps the differentiated state machine to MagicBlock.
8. [Resolva and product fit](./resolva-and-product-fit.md) — distinguishes the off-ramp from our safety layer, decides the USDC MVP, and applies the 30-second, low-friction, chain-native product filters.
9. [Protected Pay MVP scope](./protected-pay-mvp-scope.md) — fixes the target user, required lifecycle, explicit cuts, three demo scenarios, and build order.
10. [Protected Pay PRD](./protected-pay-prd.md) — defines the complete sender, recipient, settlement, expiry, recovery, error, and submission experience in testable terms.
11. [Protected Pay technical spec](./protected-pay-technical-spec.md) — defines program accounts, instructions, invariants, privacy boundaries, scheduled execution, acceptance criteria, and pass/fail feasibility gates.
12. [Protected Pay build plan](./protected-pay-build-plan.md) — sequences a reproducible baseline, the three hard feasibility gates, full state-machine work, product UI, evidence, and verification.
13. [Reference repository manifest](./reference-repos/README.md) — pinned clone commits, license cautions, and the purpose of each inspected codebase.
14. [Repository map](./repository-map.md) — which MagicBlock repositories are core infrastructure, reusable features, or examples.
15. [Reality research brief](./reality-research.md) — verified facts, inferences, unknowns, and the source trail.

## One-Sentence Mental Model

MagicBlock lets selected Solana accounts temporarily run in a faster SVM environment, then synchronizes meaningful state back to Solana; a private version places that environment inside hardware-protected compute.

## Current Hackathon Takeaway

For a non-game project, the clearest routes supported by public code are:

1. **Private payments** — strongest combination of visible user value, Private ER prize alignment, and existing examples.
2. **Real-time finance** — strong repository support through price feeds, token delegation, predictions, and scheduling, but financial correctness raises the difficulty.
3. **AI agent plus payments or privacy** — more novel, but the agent must do something that genuinely needs fast, on-chain state rather than merely wrapping an LLM chatbot.
4. **DePIN** — promising when the team already has a device or trustworthy data source; MagicBlock accelerates coordination but does not prove that physical-world data is true.

These are research-based selection observations, not a final product decision.
