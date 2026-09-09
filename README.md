# Protected Pay

Protected Pay is a private, reversible USDC payment workflow for Solana. A sender can place a payment in a protected pending state, the intended recipient can acknowledge it, and the sender or an automatic deadline can recover funds before final settlement.

The product is being built for the MagicBlock Blitz hackathon. MagicBlock is not a decorative dependency: delegated account state is intended to keep live balances and payment details private, Ephemeral Rollups provide fast state transitions, and MagicBlock Crank will drive deterministic settlement or expiry while users are offline.

## Current build status

The risk-first feasibility phase is complete:

1. **G1 — Core pass:** Circle Devnet test USDC completed a real vault, delegated-private-accounting, commit, and withdrawal round trip.
2. **G2 — Pass:** MagicBlock Crank executed three scheduled private transactions without the user online; the idempotent state transition occurred exactly once and committed back to Solana.
3. **G3 — Narrow pass:** unauthenticated and unrelated authenticated wallets could not read protected state, but permission membership, delegation metadata, timing, pre-delegation state, and committed terminal state are public.

The project will therefore proceed with the precise claim **“private while pending inside MagicBlock's authenticated Private ER,”** not anonymous or permanently secret payments. The next phase replaces the feasibility `CrankProbe` with the complete protected-payment state machine before any product UI is built.

The current implementation is a deployed technical feasibility spine, not yet the finished hackathon product. It uses only non-value Devnet test assets and is not audited or production-ready.

## Source layout

- `programs/protected-pay`: clean-room Anchor program
- `clients/ts`: generated TypeScript client for the deployed program
- `scripts`: guarded simulation, transaction, verification, and privacy-audit runners
- `context`: product, ecosystem, prior-art, requirements, and implementation research
- `artifacts/feasibility`: reproducible evidence for each technical gate

The Devnet program ID is `w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk`. Its private deployment key is generated under ignored `target/deploy/` and must never be committed or displayed.

See [`context/protected-pay-build-plan.md`](context/protected-pay-build-plan.md) for the current roadmap and [`artifacts/feasibility/`](artifacts/feasibility/) for transaction-backed evidence.
