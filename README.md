# Protected Pay

Protected Pay is a private, reversible USDC payment workflow for Solana. A sender can place a payment in a protected pending state, the intended recipient can acknowledge it, and MagicBlock deadlines resolve who is entitled to the per-payment escrow.

The product is being built for the MagicBlock Blitz hackathon. MagicBlock is not a decorative dependency: delegated account state is intended to keep live balances and payment details private, Ephemeral Rollups provide fast state transitions, and MagicBlock Crank will drive deterministic settlement or expiry while users are offline.

## Current build status

The risk-first feasibility phase is complete:

1. **G1 — Core pass:** Circle Devnet test USDC completed a real vault, delegated-private-accounting, commit, and withdrawal round trip.
2. **G2 — Pass:** MagicBlock Crank executed three scheduled private transactions without the user online; the idempotent state transition occurred exactly once and committed back to Solana.
3. **G3 — Narrow pass:** unauthenticated and unrelated authenticated wallets could not read protected state, but permission membership, delegation metadata, timing, pre-delegation state, and committed terminal state are public.

The project will therefore proceed with the precise claim **“private while pending inside MagicBlock's authenticated Private ER,”** not anonymous or permanently secret payments.

Phase 4's first deployed lifecycle proved private open and sender recovery, then exposed a real permission-topology constraint: one Crank instruction cannot safely touch both users' owner-only aggregate Deposits. Version 2 moves pending liability into the shared Payment, lets Crank mutate only that Payment, and adds owner-only terminal claims. Version 2.1 is now deployed with the corrected six-call cadence.

The first live version-2 atomic open-plus-schedule transaction finalized and moved 1 test USDC into private per-Payment escrow. Its five Crank executions also finalized, but the live cadence proved that iteration 1 runs immediately: the five calls landed at `createdAt + 0, +60, +120, +180, +240`, one call short of the `+300` expiry boundary. The recipient client correctly refused to sign a late acknowledgement, and no recipient transaction was broadcast. Version 2.1 corrects the schedule to six iterations; 23 Rust tests, regenerated IDL/client, TypeScript, clippy, and the optimized SBF build pass. The exact 633,568-byte binary was byte-verified, signature-verified in simulation, and finalized on Devnet at slot `495731340`. An atomic `advance_payment` plus sender-only `claim_payment` recovery finalized on the Private ER, returning the 1 test-USDC escrow stranded by the old schedule and redacting its terminal terms. A fresh acknowledged-payment shell and permission are now delegated on Devnet with both private Deposits excluded and all financial data unchanged. The project uses only non-value Devnet test assets and is not audited or production-ready.

The fresh version-2.1 Payment now passes sender-authenticated, signature-verified simulation of atomic private open plus a six-iteration Payment-only Crank schedule. The simulated 1 test-USDC escrow did not persist, both aggregate Deposits are absent from the scheduled instruction, protected arguments are absent from program logs, and unauthenticated reads remain denied. Live broadcast remains separately gated.

The separately approved live version-2.1 open and six-call schedule finalized on the Private ER, followed immediately by a recipient-authenticated acknowledgement that also passed signed simulation before broadcast. The Payment is privately `Acknowledged`, 1 test USDC remains in its individual escrow, neither aggregate Deposit was exposed to the other party, and the next Crank observation must prove automatic settlement before recipient claim.

Recipient-authenticated readback now confirms the live Payment autonomously reached `Settled`. A signature-verified claim simulation credits the recipient's private available balance from 0 to 1 test USDC and redacts the Payment behind the verified terminal commitment; the simulation persisted nothing and claim broadcast remains separately gated.

The approved recipient claim subsequently finalized on the Private ER. The recipient now holds 1 test USDC in private available accounting, the Payment remains `Settled` with sensitive terms redacted and escrow cleared, and the public vault still holds all 3 test USDC collateral. This completes the corrected live settlement path; the fresh unattended-expiry path remains next.

A separate deterministic version-2.1 expiry fixture is now delegated on Devnet. Its empty Payment shell and permission were created and then delegated in separately approved, simulation-first transactions. Both temporary delegation buffers closed, persistent records and metadata exist, no USDC moved, and neither private Deposit changed.

The separately approved sender-authenticated expiry transaction finalized on the Private ER, moving 1 test USDC from the sender's private available balance into individual Payment escrow and registering six Payment-only Crank calls. All six validator-signed executions finalized exactly 60 seconds apart without the sender online; the first five were safe no-ops and call six changed the Payment from `Created` to `Expired` at the exact 300-second boundary. The escrow remains intact for the sender's separately gated recovery claim, protected arguments stayed out of logs, public state did not change, and unauthenticated reads remain denied.

The sender-only expiry claim now passes signature-verified simulation. It restores the simulated sender balance from 1 to 2 test USDC, clears the escrow, and redacts sensitive Payment fields behind an independently reproduced terminal commitment. The recipient signature and Deposit are unnecessary, and the simulation changed no live state. Claim broadcast remains separately approval-gated.

## Source layout

- `programs/protected-pay`: clean-room Anchor program
- `clients/ts`: generated TypeScript client for the deployed program
- `scripts`: guarded simulation, transaction, verification, and privacy-audit runners
- `context`: product, ecosystem, prior-art, requirements, and implementation research
- `artifacts/feasibility`: reproducible evidence for each technical gate

The Devnet program ID is `w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk`. Its private deployment key is generated under ignored `target/deploy/` and must never be committed or displayed.

See [`context/protected-pay-build-plan.md`](context/protected-pay-build-plan.md) for the current roadmap and [`artifacts/feasibility/`](artifacts/feasibility/) for transaction-backed evidence.
