# Phase 4 — Funded-Sender Approval Count

Status: **PASS — two transaction approvals plus one cold-session authentication signature**

This measurement covers a sender whose USDC is already funded into a delegated Protected Pay Deposit. Initial funding and one-time Deposit setup are onboarding actions and are deliberately excluded. Recipient Deposit onboarding is also excluded because it can happen after the protected payment is shared and before terminal claim.

## Measured packaging

A new unused Payment fixture was used to combine all public setup into one versioned Solana transaction:

1. `prepare_payment`;
2. `create_payment_permission`;
3. `delegate_payment_permission`;
4. `delegate_payment`.

The no-sign transaction was 797 bytes, below Solana's 1,232-byte limit. Devnet simulation succeeded at slot `495846629`, consumed 141,907 compute units, and returned both Payment and Permission owned by the Delegation Program. Fresh reads confirmed simulation created no accounts or persistent state.

The private value-moving step remains the already-proven atomic `open_payment + schedule_payment` transaction. Its new no-op transaction shape is 494 bytes. That step requires one transaction approval against the authenticated Private ER.

```text
Scenario: funded sender with delegated Deposit
Recipient input: wallet address

Prompt 1: Solana transaction
  Create Payment + Permission and delegate both
  Size: 797 bytes
  Simulated compute: 141,907

Prompt 2 on a cold session: off-chain wallet message
  Authenticate to MagicBlock Query Filtering Service
  Paid API key: not required

Prompt 3: Private ER transaction
  Open 1 test-USDC escrow + register six-call schedule atomically
  Size: 494 bytes

Cold-session wallet prompts: 3
Valid-session wallet prompts: 2
Onchain transaction approvals: 2
```

## Product decision

The UI should present this as two comprehensible stages:

1. **Prepare protection** — public Payment setup and delegation.
2. **Protect payment** — private escrow and automatic deadline registration.

Authentication is a wallet message, not a transaction and not a paid API key. If the session is still valid, that prompt disappears. The product must not claim a one-click or one-approval payment. The honest concise copy is:

> One Solana setup approval, one private payment approval, and a one-time session signature when authentication is not cached.

## Reproduction

```sh
NO_DNA=1 npm run p4:measure:approval-count
```

The runner cannot broadcast, loads no keypair, performs no TEE authentication, moves no USDC, and leaves no persistent state.
