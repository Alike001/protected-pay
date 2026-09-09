# MagicBlock GitHub Organization Map

## Inventory Snapshot

Checked through the GitHub API on 2026-09-08:

- 85 public repositories;
- 68 non-fork repositories;
- 17 forks;
- 1 archived repository;
- leading repository languages: 33 Rust, 25 TypeScript, and 14 C#.

Counts are a point-in-time snapshot and will change. The large C# and gaming footprint reflects MagicBlock's historical Unity and fully-on-chain-game work; it should not be mistaken for the complete current product focus.

## Tier 1: Core Ephemeral Rollup Stack

These five repositories are explicitly named as core repositories in MagicBlock's organization profile.

| Repository | Role in plain English | Why it matters to a hacker |
|---|---|---|
| [`magicblock-validator`](https://github.com/magicblock-labs/magicblock-validator) | The fast SVM runtime that clones delegated state, executes transactions, and settles changes. | Explains the actual engine; most hackathon teams can use hosted validators instead of operating it. |
| [`ephemeral-rollups-sdk`](https://github.com/magicblock-labs/ephemeral-rollups-sdk) | Rust and TypeScript helpers for delegation, commit, undelegation, routing resolution, and related flows. | Primary application integration dependency. |
| [`delegation-program`](https://github.com/magicblock-labs/delegation-program) | The Solana program controlling delegate, commit, finalize, and undelegate operations. | Defines the state lifecycle that distinguishes MagicBlock from a conventional L2. |
| [`magicblock-engine-examples`](https://github.com/magicblock-labs/magicblock-engine-examples) | Modular, end-to-end feature examples. | Best code-reading starting point. |
| [`ephemeral-spl-token`](https://github.com/magicblock-labs/ephemeral-spl-token) | SPL-token delegation and custody for ER execution. | Essential for payments and most financial applications. |

The validator README says the project is actively changing and includes an under-construction/unaudited warning. That warning should be treated as applying to the validator repository; audit status for other programs must be checked separately.

## Tier 2: Routing, Automation, Data, And User Experience

| Repository | Capability | Relevant tracks |
|---|---|---|
| [`magic-router`](https://github.com/magicblock-labs/magic-router) | JSON-RPC router that selects Solana or the appropriate ER. | All |
| [`magic-router-sdk`](https://github.com/magicblock-labs/magic-router-sdk) | Client-side routing helpers. | All |
| [`magicblock-sync`](https://github.com/magicblock-labs/magicblock-sync) | Synchronization of delegation status. | All |
| [`solana-vrf`](https://github.com/magicblock-labs/solana-vrf) | Verifiable random function and oracle. | Games, finance, fair allocation |
| [`hydra`](https://github.com/magicblock-labs/hydra) | Permissionless scheduler for predefined instructions. | Finance, payments, agents, DePIN |
| [`real-time-pricing-oracle`](https://github.com/magicblock-labs/real-time-pricing-oracle) | Pushes Pyth Lazer or Stork prices into ER accounts. | Finance, priced payments |
| [`session-keys`](https://github.com/magicblock-labs/session-keys) | Limited secondary signers that reduce repeated wallet approvals. | Games, trading, agents, payments |
| [`mirage`](https://github.com/magicblock-labs/mirage) | CLI for wallets, private payments, transfers, swaps, and arbitrary Solana program invocation. | Payments, privacy, AI agents |

Hydra is deliberately a minimal scheduled-instruction runner, not a general workflow automation platform. Its README lists oracle ticks, AMM updates, settlement, and liquidation gates as intended patterns.

## Tier 3: Reference Applications And Starter Points

| Repository or path | Demonstrates | Notes |
|---|---|---|
| [`starter-kits`](https://github.com/magicblock-labs/starter-kits) | Larger VRF, oracle, and private-payment demos. | Use after understanding the smaller examples. |
| [`magicblock-engine-examples/spl-tokens`](https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/spl-tokens/anchor) | Token delegation, ER transfer, and withdrawal. | Payments foundation. |
| [`magicblock-engine-examples/binary-prediction`](https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/binary-prediction/anchor) | Price-driven up/down positions with ER token custody. | Illustrative, explicitly not a production risk engine. |
| [`leveraged-prediction`](https://github.com/magicblock-labs/leveraged-prediction) | Ten-second positions, price streaming, session keys, eSPL, and automatic settlement. | Most complete finance-oriented reference found. |
| [`oracle-priced-purchase`](https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/oracle-priced-purchase/anchor) | A USD-priced purchase converted to SOL from an oracle feed. | Bridge between payments and finance. |
| [`private-payments-demo`](https://github.com/magicblock-labs/private-payments-demo) | Private transfers on a PER. | Minimal standalone README; richer explanation also exists in `starter-kits`. |
| [`starter-kits/private-payments-demo`](https://github.com/magicblock-labs/starter-kits/tree/main/private-payments-demo) | Deposit, delegate, privately transfer, undelegate, and withdraw. | Strongest documented private-payment reference. |
| [`super-smart-contracts`](https://github.com/magicblock-labs/super-smart-contracts) | LLM oracle requests, agent context, callbacks, and program actions. | Uses OpenRouter for off-chain inference. |
| [`solana-generals`](https://github.com/magicblock-labs/solana-generals) | Full game architecture with Solana and ER state. | Best full game walkthrough. |
| [`sealed-auction`](https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/sealed-auction) | Private bids with token escrow. | Useful privacy/finance crossover. |
| [`ephemeral-account-chats`](https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/ephemeral-account-chats/anchor) | Temporary ER-only accounts. | Useful mental model for conversations or other disposable state. |
| [`crank-counter`](https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/crank-counter/anchor) | Scheduled ER execution. | Smallest automation learning example. |

## Best Reading Route By Track

### Payments or privacy

1. `counter/anchor` for delegation lifecycle.
2. `spl-tokens/anchor` for token movement.
3. `starter-kits/private-payments-demo` for PER permissions and authentication.
4. `mirage` if an agent or CLI needs to initiate transfers.

### Finance

1. `real-time-pricing-oracle`.
2. `oracle-priced-purchase`.
3. `binary-prediction`.
4. `leveraged-prediction` for a more integrated example.
5. `hydra` or `crank-counter` for automatic settlement.

### AI agents

1. `super-smart-contracts` for oracle/callback architecture.
2. `session-keys` for bounded repeated actions.
3. `hydra` for scheduled actions.
4. `mirage` for wallets, transfers, swaps, and generic invocation.
5. Private-payment or PER examples if agent state or transactions must be confidential.

### DePIN

1. Core counter example for high-frequency state.
2. `hydra` for scheduled aggregation or rewards.
3. SPL-token example for device/operator payments.
4. PER examples for sensitive telemetry.
5. Bring an external device-authentication or oracle design; no dedicated application repository was located.

## Repositories Not To Start With

- Infrastructure internals such as storage/database forks unless operating a validator is the project.
- Load and black-box test tools such as `redline` and `redsuite` unless benchmarking the protocol.
- Old Unity/game repositories for a non-game project.
- Forks as authoritative MagicBlock integration guidance.
- The repository named `whitepaper`: its current public contents describe the older Garbles game, not the current Ephemeral Rollups paper linked from the docs.

## Organization Sources

- [MagicBlock Labs organization](https://github.com/magicblock-labs)
- [Organization profile and core repository list](https://github.com/magicblock-labs/.github/blob/main/profile/README.md)
- [Official docs repository](https://github.com/magicblock-labs/docs)
- [Integration examples index](https://github.com/magicblock-labs/magicblock-engine-examples)
- [Starter kits index](https://github.com/magicblock-labs/starter-kits)
