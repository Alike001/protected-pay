# Protected Pay

Protected Pay is a private, reversible USDC payment workflow for Solana. A sender can place a payment in a protected pending state, the intended recipient can acknowledge it, and MagicBlock deadlines resolve who is entitled to the per-payment escrow.

The product is being built for the MagicBlock Blitz hackathon. MagicBlock is not a decorative dependency: delegated account state is intended to keep live balances and payment details private, Ephemeral Rollups provide fast state transitions, and MagicBlock Crank will drive deterministic settlement or expiry while users are offline.

## Current build status

The risk-first feasibility phase is complete:

1. **G1 — Core pass:** Circle Devnet test USDC completed a real vault, delegated-private-accounting, commit, and withdrawal round trip.
2. **G2 — Pass:** MagicBlock Crank executed three scheduled private transactions without the user online; the idempotent state transition occurred exactly once and committed back to Solana.
3. **G3 — Narrow pass:** unauthenticated and unrelated authenticated wallets could not read protected state, but permission membership, delegation metadata, timing, pre-delegation state, and committed terminal state are public.

The project will therefore proceed with the precise claim **“private while pending inside MagicBlock's authenticated Private ER,”** not anonymous or permanently secret payments.

Phase 4's first deployed lifecycle proved private open and sender recovery, then exposed a real permission-topology constraint: one Crank instruction cannot safely touch both users' owner-only aggregate Deposits. Version 2 moves pending liability into the shared Payment, lets Crank mutate only that Payment, and adds owner-only terminal claims. The deployed binary still contains the original five-call cadence.

The first live version-2 atomic open-plus-schedule transaction finalized and moved 1 test USDC into private per-Payment escrow. Its five Crank executions also finalized, but the live cadence proved that iteration 1 runs immediately: the five calls landed at `createdAt + 0, +60, +120, +180, +240`, one call short of the `+300` expiry boundary. The recipient client correctly refused to sign a late acknowledgement, and no recipient transaction was broadcast. Version 2.1 corrects the schedule locally to six iterations; 23 Rust tests, regenerated IDL/client, TypeScript, clippy, and the optimized SBF build pass. The compatible 633,568-byte binary is fully uploaded to a byte-verified Devnet loader buffer. The live program has not been upgraded; the next checkpoint is a separately approved exact signed simulation. The project uses only non-value Devnet test assets and is not audited or production-ready.

## Source layout

- `programs/protected-pay`: clean-room Anchor program
- `clients/ts`: generated TypeScript client for the deployed program
- `scripts`: guarded simulation, transaction, verification, and privacy-audit runners
- `context`: product, ecosystem, prior-art, requirements, and implementation research
- `artifacts/feasibility`: reproducible evidence for each technical gate

The Devnet program ID is `w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk`. Its private deployment key is generated under ignored `target/deploy/` and must never be committed or displayed.

See [`context/protected-pay-build-plan.md`](context/protected-pay-build-plan.md) for the current roadmap and [`artifacts/feasibility/`](artifacts/feasibility/) for transaction-backed evidence.
