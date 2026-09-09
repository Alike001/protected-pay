# Reality Research: MagicBlock Organization And Hackathon Use Cases

## Scope

This research asks what MagicBlock currently is, how its Ephemeral Rollups differ from conventional Ethereum L2s, which capabilities are represented in the public `magicblock-labs` organization, and how those capabilities map to the hackathon's games, finance, payments, AI agents, DePIN, and privacy categories.

The scope covers public repositories and official documentation available on 2026-09-08. It does not assess private services or repositories.

## Sources Checked

- The public [`magicblock-labs` GitHub organization](https://github.com/magicblock-labs) through the GitHub API and GitHub CLI.
- The organization's [profile README](https://github.com/magicblock-labs/.github/blob/main/profile/README.md).
- The current [documentation repository](https://github.com/magicblock-labs/docs), especially the ER lifecycle, routing, fee, product, privacy, and use-case pages.
- READMEs and repository trees for the validator, SDK, delegation program, examples, starter kits, eSPL token implementation, VRF, Hydra, pricing oracle, private payments, Mirage, prediction examples, and Super Smart Contracts.
- Current MagicBlock documentation indexed through Context7 under `/magicblock-labs/docs`.

## Verified Facts

### Architecture

- MagicBlock's docs describe an ER as a specialized SVM runtime and auxiliary layer that operates with Solana state.
- A state account is delegated through the Delegation Program to a specified ER validator.
- The first ER transaction clones the delegated account from the base layer.
- ER transactions can update the delegated state continuously.
- State can be committed to Solana periodically or on demand without necessarily ending the session.
- Commit-and-undelegate returns the account to its original owner program.
- Magic Router inspects transaction metadata and routes execution to Solana or an ER.
- Current docs list normal ER transaction price as zero, while delegation sessions, commits, Solana transactions, base actions, callbacks, and storage can create costs.

### Privacy

- Private Ephemeral Rollups use Intel TDX TEEs.
- The documented model supports account-level/group-level access control, wallet challenge authentication, access tokens, and selective private state.
- Private transfers are represented publicly in both a starter kit and standalone demo.
- TEE privacy carries a hardware-vendor trust assumption and is not identical to ZK privacy.

### Public repository surface

- The organization exposed 85 public repositories at the check time: 68 non-forks, 17 forks, and one archived repository.
- The organization profile identifies `magicblock-validator`, `ephemeral-rollups-sdk`, `delegation-program`, `magicblock-engine-examples`, and `ephemeral-spl-token` as core.
- Public examples cover counters, SPL tokens, VRF, oracle-priced purchases, Magic Actions, delegation actions, ephemeral accounts, cranks, session keys, binary prediction, sealed auctions, private payments, rewards, and games.
- Finance has dedicated price-oracle, prediction, token, and scheduling code.
- AI's `super-smart-contracts` reference calls OpenRouter through an oracle and processes a callback in a Solana program.
- Mirage provides agent-oriented wallet, transfer, private payment, swap, and generic program-invocation commands.
- The official DePIN use-case page discusses physical infrastructure coordination but links to the general engine examples rather than a dedicated DePIN app.

### Project status signals

- Repository activity is recent across core infrastructure and examples, but recent updates do not prove API stability.
- The validator README explicitly says it is under active development, APIs are subject to change, and the code is unaudited.
- Other documentation lists audits for specific components such as the Delegation Program and VRF, while permission-program audit status was listed separately. Audit claims must therefore be evaluated per component and current deployment.

## Inferences

- “Solana L2” is a reasonable teaching analogy but technically incomplete. The selective, temporary account-delegation model and automatic routing are materially different from treating MagicBlock as a conventional persistent Ethereum rollup chain.
- Payments plus privacy is the best-supported non-game starting area for a short hackathon because the user value is visible and public examples cover the full lifecycle.
- Finance is strongly supported but has a higher correctness burden because a polished demo can still contain unsafe pricing, liquidity, or settlement logic.
- AI projects should use MagicBlock for governed state, actions, permissions, automation, or payments. Merely placing a chatbot UI beside a wallet would not demonstrate the infrastructure's value.
- DePIN has genuine architectural fit for frequent telemetry and micro-accounting, but is a higher-risk hackathon choice without an existing data source or device-authentication plan.

## Unknowns And Questions

- The exact judging rubric and submission deadline were not available from the repository research.
- Hosted PER access, capacity, authentication-token issuance, and hackathon-specific service limits should be confirmed with MagicBlock engineers.
- The current production decentralization and fault model of the Security Committee should be verified against the linked ER paper and deployed configuration before making strong security claims.
- It is not yet known which use-case track best matches the participant's domain experience, available teammates, or data sources.
- No dedicated first-party DePIN reference application was located; one may exist privately, under a non-obvious name, or outside the organization.
- Public READMEs and docs can lag deployed endpoints and packages; versions must be rechecked immediately before implementation.

## Not Included

- No product specification or implementation plan has been selected.
- No repository was forked or modified.
- No smart contract, financial model, or privacy design has been audited.
- No claim is made that a reference example is production-ready.
- No private MagicBlock repository, hosted infrastructure, or internal roadmap was inspected.

## Source Index

- [ER lifecycle](https://github.com/magicblock-labs/docs/blob/main/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup.mdx)
- [ER benefits](https://github.com/magicblock-labs/docs/blob/main/pages/ephemeral-rollups-ers/introduction/why.mdx)
- [ER fee model](https://github.com/magicblock-labs/docs/blob/main/pages/ephemeral-rollups-ers/introduction/fees-and-commit-economics.mdx)
- [Private ER overview](https://github.com/magicblock-labs/docs/blob/main/pages/private-ephemeral-rollups-pers/introduction/onchain-privacy.mdx)
- [Use-case pages](https://github.com/magicblock-labs/docs/tree/main/pages/get-started/use-cases)
- [Core examples](https://github.com/magicblock-labs/magicblock-engine-examples)
- [Private-payment starter](https://github.com/magicblock-labs/starter-kits/tree/main/private-payments-demo)
- [Pricing oracle](https://github.com/magicblock-labs/real-time-pricing-oracle)
- [Leveraged prediction reference](https://github.com/magicblock-labs/leveraged-prediction)
- [AI agent reference](https://github.com/magicblock-labs/super-smart-contracts)
- [Agent/payment CLI](https://github.com/magicblock-labs/mirage)
- [Scheduler](https://github.com/magicblock-labs/hydra)
