# MagicBlock Architecture And The L2 Comparison

## Short Answer

Calling MagicBlock a **Solana L2** is acceptable as a first analogy because it executes activity away from the base layer and settles state back to Solana. It is not the most accurate technical label.

The safer description is:

> MagicBlock is a Solana-native, on-demand execution layer built from Ephemeral Rollups.

MagicBlock's own documentation calls an ER an **extension of Solana**, a **specialized SVM runtime**, and a **dedicated auxiliary layer**. It does not present the product as a separate general-purpose chain that users permanently move to.

## The Layman Analogy

Solana is the central bank ledger. An Ephemeral Rollup is a temporary, high-speed branch office.

- The permanent account starts at the central bank.
- The account is temporarily assigned to the branch.
- The branch processes rapid activity.
- It periodically reports the new balance or state to the central ledger.
- When the session finishes, responsibility returns to the central bank.

The technical words for that lifecycle are:

```text
Create state on Solana
        |
        v
Delegate selected accounts
        |
        v
Execute quickly on an Ephemeral Rollup
        |
        +----> Commit state to Solana periodically or on demand
        |
        v
Commit final state and undelegate
```

## MagicBlock Versus A Conventional Ethereum L2

| Question | Conventional Ethereum rollup | MagicBlock Ephemeral Rollup |
|---|---|---|
| What moves? | Users and applications usually operate on a distinct L2 network. | Selected Solana state accounts are delegated temporarily. |
| Execution environment | Usually an L2-specific chain/runtime with its own sequencer and blockspace. | A specialized SVM runtime compatible with Solana programs and RPC conventions. |
| Application state | Primarily lives on the L2 and is represented or settled on Ethereum. | Starts on Solana; delegated state is cloned into the ER and synchronized back. |
| Asset movement | Often involves a bridge between L1 and L2. | The account-delegation lifecycle is the central mechanism; eSPL provides token delegation and return to base. |
| User routing | The user normally chooses a network. | Magic Router can inspect writable accounts and send a transaction to Solana or the correct ER. |
| Lifetime | The L2 is continuously running as a network. | The rollup and delegated state are designed for on-demand or session-oriented execution. |
| Scaling unit | A whole rollup chain. | Account/state clusters can be distributed across multiple ERs. |

Therefore:

- **Good pitch shorthand:** “It gives Solana an L2-like fast execution layer.”
- **Better judge-facing wording:** “It uses Ephemeral Rollups to delegate only the state that needs real-time execution while keeping the application composable with Solana.”
- **Misleading wording:** “It is just an Ethereum-style L2 deployed on Solana.”

## What Actually Happens

1. A developer writes and deploys a normal Solana program.
2. The program adds hooks from the Ephemeral Rollups SDK.
3. One or more state accounts are delegated through the Delegation Program to a chosen ER validator.
4. The first ER interaction clones the delegated account from Solana.
5. Transactions update that delegated state on the ER.
6. The operator commits state to Solana periodically or on demand.
7. The application can continue using the account in the ER after a commit.
8. Commit-and-undelegate writes the latest state back and restores the original program as account owner.

Magic Router can hide much of the endpoint choice by inspecting transaction metadata and routing the transaction to Solana or the appropriate ER.

## What “Zero Fee” Means In Practice

Normal ER transactions are priced at zero in the documentation's current release, but using the system is not literally costless from end to end.

- Solana base transactions still have Solana fees.
- Delegation creates funded Solana records.
- A delegation session and repeated commits have charges.
- Temporary ER-only accounts reserve refundable storage funds.
- Applications can sponsor costs for their users.

This makes **gasless interaction** an accurate user-experience claim, while “the whole application costs nothing” would be inaccurate.

## Security Boundary To Remember

The ER does not mean every rapid interaction is independently executed by the full Solana validator set. The current architecture delegates execution to an ER validator and documents a fraud-proof/finalization mechanism involving a decentralized Security Committee. Commitments anchor state to Solana.

For Private ERs, confidentiality relies on an Intel TDX Trusted Execution Environment and remote attestation. This is practical hardware-based privacy, not the same trust model as zero-knowledge proofs. It introduces trust in the CPU vendor, implementation, attestation path, and operator configuration.

The validator repository also labels itself under active development and warns that APIs can change. Component audit status must be checked individually rather than assuming one audit statement covers the whole stack.

## Primary Sources

- [Delegation, commitment, and undelegation](https://github.com/magicblock-labs/docs/blob/main/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup.mdx)
- [Why Ephemeral Rollups](https://github.com/magicblock-labs/docs/blob/main/pages/ephemeral-rollups-ers/introduction/why.mdx)
- [Magic Router](https://github.com/magicblock-labs/docs/blob/main/pages/ephemeral-rollups-ers/introduction/magic-router.mdx)
- [Fees, commits, and refunds](https://github.com/magicblock-labs/docs/blob/main/pages/ephemeral-rollups-ers/introduction/fees-and-commit-economics.mdx)
- [MagicBlock validator README](https://github.com/magicblock-labs/magicblock-validator)
- [Delegation Program](https://github.com/magicblock-labs/delegation-program)
