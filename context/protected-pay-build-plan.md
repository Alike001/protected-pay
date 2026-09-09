# Plan: Protected Pay Risk-First Hackathon Build

Status: active implementation plan. G0–G3 passed with narrowed privacy language. Phase 4's real private open and sender recovery paths pass, and the version-2 permission-topology correction now passes locally. Devnet upgrade and real Payment Crank proof remain before product UI work.

## Inputs

- [MagicBlock ecosystem research](./README.md)
- [Protected-settlement prior art](./protected-settlement-prior-art.md)
- [Resolva and product fit](./resolva-and-product-fit.md)
- [Protected Pay MVP scope](./protected-pay-mvp-scope.md)
- [Protected Pay PRD](./protected-pay-prd.md)
- [Protected Pay technical specification](./protected-pay-technical-spec.md)
- Pinned MagicBlock starter-kits clone at commit `8e6774276c77426b97852319dd40297dd650496d`
- Current MagicBlock documentation checked through Context7 on 2026-09-08
- Current Circle documentation for Solana Devnet USDC

No separate user-story document exists. The PRD's user journeys and acceptance criteria are intentionally used as the story source. No quality-profile document exists; for this time-boxed hackathon, the quality order is explicitly fixed as financial correctness, real MagicBlock integration, recoverability, privacy accuracy, understandable UX, and visual polish.

## Current Repository Reality

- The workspace now contains the Protected Pay Anchor program, generated TypeScript client, guarded Devnet/Private ER runners, feasibility evidence, and the original research/reference repositories.
- The program is deployed on Solana Devnet at `w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk`.
- G1 completed a real Circle Devnet test-USDC vault/delegation/private-mutation/commit/withdrawal round trip.
- G2 registered a real three-iteration MagicBlock schedule and recorded three autonomous validator-signed executions; the idempotent state transition occurred exactly once.
- G3 proved protected-state denial for both unauthenticated and unrelated authenticated readers. It also proved that Permission members, delegation metadata, timing, the pre-delegation snapshot, and committed terminal bytes are public.
- The Gate 2 terminal state was committed and undelegated successfully. Both state accounts are back under Protected Pay with the exact autonomous terminal values; state delegation records/metadata are closed, while Permission accounts remain delegated.
- The complete Phase 4 program is deployed. A real private Payment opened with 1 test USDC locked, then an expired-payment sender cancellation finalized and restored the sender to 3 available / 0 locked without exposing the transition publicly.
- The real Payment schedule simulation exposed a design blocker: `advance_payment` spans the sender and recipient aggregate Deposits, but the authenticated sender correctly cannot read the recipient Deposit. Granting that access would leak the recipient's aggregate balance, so the unsafe permission shortcut is rejected.
- The local version-2 state machine resolves that blocker without changing Payment account size: opening transfers liability from the sender Deposit into the shared Payment; Crank mutates only Payment; settlement/expiry claims touch only Payment plus the claimant's own Deposit; cancellation refunds and seals atomically. Twenty-two tests, IDL/client generation, TypeScript, clippy, and the optimized SBF build pass.
- Node `24.14.1`, Yarn `1.22.22`, Rust/Cargo `1.96.0`, Solana CLI `4.0.1`, Anchor CLI `1.0.2`, and AVM `1.0.1` are installed.
- The pinned MagicBlock private-payments starter uses Node 24, Anchor `0.31.1`, `ephemeral-rollups-sdk` `0.2.11`, `@solana/web3.js` `1.98.x`, and Next.js `15.3.x`. It remains prior art for the token/private-account lifecycle, not the build baseline: the current official Crank example requires Anchor `1.0.2` and SDK revision `0fc4604157de51df28693e02e5a1a6a4a08c8a03` with `crank`, so Protected Pay pins that newer stack.
- The installed Anchor CLI does not match the starter's Anchor version. The build must use AVM to pin the compatible CLI or deliberately upgrade only after the unchanged baseline is reproduced.

## Assumptions

- One primary builder and only a few days remain.
- Development and judged transactions use localnet, Solana Devnet, and the official MagicBlock ER/PER endpoints; no mainnet funds are used.
- Solana Devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` is the external integration target. Circle states that this test token has no financial value.
- The pinned private-payments starter is the baseline rather than a from-scratch program.
- The 60-second safety window and 300-second claim window are fixed demonstration values.
- Recipient acknowledgement is part of the judged protected-payment path.
- Session-key payment creation, fiat settlement, and Resolva integration remain deferred.
- No browser timer, fake balance, fake refund, or mocked Crank result may appear in the judged path.

## Resolved Feasibility Questions

- Private ER endpoint: `https://devnet-tee.magicblock.app`.
- Assigned validator: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`.
- Authentication: free, short-lived wallet challenge-response against the Query Filtering Service; no paid API key.
- Scheduler: `Magic11111111111111111111111111111111111111` accepted the fixed task and the validator executed all three iterations without the user online.
- Permission visibility: Permission members/capabilities and Delegation Program metadata are public; protected post-delegation state is access-controlled until commitment.

## Remaining Product And Submission Questions

- Can preparation, permissioning, delegation, and private payment opening be packaged into one post-funding wallet approval without weakening program-enforced limits?
- Should the final demo continue with Circle Devnet USDC, or does the event provide a required test mint?
- What exact submission deadline appears in the authenticated event/submission interface?
- What independent attestation evidence can be shown for the TEE, beyond trusting the official Private ER endpoint?
- How much build time remains, and should recipient acknowledgement apply to every payment or only first-time/high-risk recipients?

These questions do not block Phase 4 program work. Approval-count claims, TEE wording, and final submission logistics remain blocked until they are resolved.

## Prototype Reintegration Gate

No UI prototype exists, so there is no prototype-reintegration blocker. Reference screenshots and the MagicBlock starter frontend are inspiration only.

Any local token mint, manual clock warp, fixture validator, or test keypair is permitted only inside local automated tests. The judged product path must use real deployed program instructions, real Devnet test tokens, real ER/PER state, and real Crank execution. Deferred features must be omitted or visibly labelled unavailable; they must not be simulated as completed features.

## Gate Order

```text
G0 Reproduce baseline
        ↓
G1 Vault round-trip
        ↓
G2 Crank mutates private delegated state
        ↓
G3 Measure privacy exposure
        ↓
GO / NARROW / STOP decision
        ↓
Full state machine → Product UI → Submission proof
```

The first three technical risks from the accepted specification map directly to G1, G2, and G3. They may not be postponed until final integration.

## Execution Status — 2026-09-09

| Stage | Result | What is proven | Remaining work |
|---|---|---|---|
| G0 baseline | PASS | Pinned toolchain builds and tests reproducibly | Keep versions pinned |
| G1 vault | CORE PASS | Real Devnet test USDC entered the vault, survived delegated private accounting, committed, and withdrew exactly | Expand Devnet negative-case matrix during full state-machine work |
| G2 Crank | PASS | Official MagicBlock scheduling produced three autonomous private executions; one transition plus two no-ops; terminal state committed to Solana | Replace the probe with the real Payment state machine |
| G3 privacy | NARROW PASS | Outsider denial and exact public/private metadata boundary measured | Independently verify TEE attestation; re-audit the future Payment layout |
| Decision | NARROW / PROCEED | The architecture is viable with precise privacy language | Do not claim anonymity or permanent secrecy |
| Phase 4 | V1 LIVE RECOVERY PASS / V2 LOCAL PASS | Real v1 private open and recovery pass; v2 per-Payment escrow removes aggregate Deposits from the Crank target and passes all local checks | Upgrade Devnet, create fresh v2 fixtures, and prove settlement/expiry/claim/cancel-race paths |
| Phase 5 | WAITING | — | Build the 30-second product UI only after Phase 4 live tests pass |
| Phase 6 | WAITING | — | End-to-end evidence, video, deployment, and submission |

## Immediate Remaining Plan

1. **Complete locally:** keep aggregate user Deposits private to their owners and use the shared Payment as per-payment escrow; Crank now targets only Payment.
2. **Complete for the core lifecycle:** version-2 tests cover claims, cancel-versus-Crank, expiry boundaries, duplicate execution, overflow atomicity, legacy-version rejection, and conservation. Pause/revocation stays deferred with session-key automation.
3. **Next:** simulate and upgrade the Devnet program, then bootstrap fresh version-2 payment fixtures rather than reusing the terminal version-1 Payment.
4. Prove the real Crank lifecycle twice: acknowledged payment to settlement and abandoned payment to automatic expiry/refund, with both users offline and retries idempotent.
5. Repeat the privacy audit and commit/undelegate proof for the corrected Payment layout. Preserve the narrow claim: pending amount, memo hash, status, and balances are private; wallet relationships and delegation metadata are not anonymous.
6. Measure the funded-user approval count and package the normal flow as simply as the infrastructure permits.
7. Build the product UI: fund, send, share, acknowledge, countdown, Undo, activity, withdrawal, recovery, plus a separate judge-proof view.
8. Run all three end-to-end stories from fresh state, perform the final verification audit, deploy the web client, record the product-first video, confirm the authenticated submission deadline, and submit.

AI assistance, fiat/card integrations, multi-token support, and Resolva integration remain deferred. Circle Devnet test USDC stays the only MVP asset unless the organizer requires another mint.

## Phase 0: Reproducible Baseline

### Goal

Prove that the current machine can build and test the pinned MagicBlock private-payments example before Protected Pay changes are introduced.

### Work

- Create a clean root project from the pinned private-payments starter while preserving `context/reference-repos/` as read-only reference material.
- Initialize a root Git repository before product changes.
- Pin Node 24 and Yarn 1.22 as used by the starter.
- Use the installed Anchor CLI 1.0.2 for the current Crank-capable baseline.
- Preserve the starter's Rust/SDK versions and lockfiles initially.
- Configure local Solana and MagicBlock validators using non-secret environment templates.
- Run the unchanged program build and test suite.
- Run the unchanged frontend build.
- Record exact versions and commands in the project README.

Likely affected areas:

- root `Anchor.toml`, `Cargo.toml`, `package.json`, lockfiles, and `.nvmrc`;
- `programs/protected-pay/` after the baseline is copied and renamed;
- `frontend/` or `app/` for the existing Next.js client;
- `.env.example`, never committed secrets;
- `artifacts/feasibility/` for evidence.

### Real Integration Path

Use the actual MagicBlock SDK and compiled Anchor program. Baseline local tests may use the starter's fixture programs, followed by an official endpoint smoke test when credentials are available.

### Mock/Simulation Policy

Fixture validators are allowed only to reproduce upstream tests. Passing fixture tests does not satisfy any judged integration gate.

### Checks

- `NO_DNA=1 anchor build` succeeds with the pinned CLI.
- The unchanged upstream tests pass.
- Frontend type-check/build succeeds.
- No dependency is upgraded merely to silence an error.
- Toolchain mismatch and resolution are documented.

### Acceptance Criteria Covered

- Establishes the compatibility baseline required by constraints in the technical spec.
- Prevents product bugs from being confused with toolchain or upstream-version failures.

### Stop Condition

Do not implement the full payment state machine until the clean-room vault builds against the current official Crank-capable stack. Keep the older private-payments example as behavioral prior art and document compatibility differences rather than forcing its outdated toolchain into the product.

## Phase 1: G1 — Real Test-USDC Vault Round-Trip

### Goal

Prove immediately that Circle Solana Devnet test USDC can enter the program vault, be represented by delegated private accounting, commit back correctly, and withdraw to its owner without loss or inflation.

### Work

- Configure the program to accept only Circle's Solana Devnet USDC mint.
- Validate the SPL Token Program, mint, vault PDA, vault token account, user token account, and Deposit PDA.
- Split internal Deposit accounting into `available` and `locked` using checked arithmetic.
- Fund sender and recipient Devnet wallets with test SOL and Circle faucet test USDC.
- Deposit a fixed amount from sender token account into the vault.
- Create permissions and delegate the sender Deposit.
- Execute a minimal private accounting mutation: lock then unlock a portion, without changing vault collateral.
- Commit and undelegate the Deposit.
- Withdraw the original amount to the sender token account.
- Record pre/post balances, transaction signatures, account owners, mint, vault balance, and committed Deposit state.

Likely affected areas:

- Anchor account/state modules;
- deposit, vault, delegate, commit, and withdrawal instructions;
- PDA and token-account client helpers;
- local accounting tests and Devnet round-trip test;
- `artifacts/feasibility/g1-vault-roundtrip.md`.

### Real Integration Path

- Devnet mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- Real SPL-token transfers into and out of the program-controlled token account.
- Real MagicBlock delegation and commitment for the Deposit accounting state.

### Mock/Simulation Policy

A local six-decimal test mint is allowed for fast unit tests. It cannot satisfy G1 and cannot be presented as Devnet USDC in the product or submission.

### Checks

- Sender external balance decreases by the deposited raw amount.
- Vault token balance increases by the same raw amount.
- Deposit `available + locked` equals the user's internal liability.
- Lock/unlock changes only internal fields, not vault collateral.
- Commit/undelegate returns the latest internal balance to Solana.
- Withdrawal decreases both vault balance and internal liability by exactly the withdrawn amount.
- A second withdrawal of the same amount fails.
- Wrong mint, wrong vault, wrong token program, wrong owner, locked withdrawal, underflow, and overflow attempts fail.
- The final external sender balance equals the initial balance, excluding transaction fees paid in SOL.

### Acceptance Criteria Covered

- F1, F9, M2, M6, S1–S5, S8, S10.
- Accounting invariant that vault collateral covers all internal liabilities.
- Technical risk 1 in full.

### Stop Condition

G1 passes only with a recorded Devnet deposit and withdrawal plus a delegated internal mutation. No frontend product work begins if the vault cannot round-trip the exact test-USDC amount safely.

If G1 fails, first compare the custom starter vault with MagicBlock's current Ephemeral SPL Token/eATA path. Adopt the supported path if it preserves the protected-payment state machine. If neither path supports safe collateral and withdrawal, stop this product architecture.

## Phase 2: G2 — Crank Against Private Delegated State

### Goal

Prove that MagicBlock Crank can invoke an idempotent time transition that mutates the same permissioned, delegated accounts the payment will use.

### Work

- Add a minimal delegated `Payment` shell and the sender/recipient Deposit accounts required by `advance_payment`.
- Implement a temporary two-state proof: `Pending → Advanced` after a stored deadline.
- Make `advance_payment` permissionless but incapable of accepting or changing recipient, amount, or deadline.
- Create the Private ER permission configuration for the proof accounts.
- Schedule the instruction through the current MagicBlock Crank CPI.
- Disconnect both user clients and wait for scheduled execution.
- Read the new state through the authenticated PER connection.
- Invoke the handler again manually and through any remaining scheduled attempt to prove idempotency.
- Record scheduler task ID, ER signature, timing, before/after account data, and any base-layer commitment proof.

Likely affected areas:

- Payment state and `advance_payment` instruction;
- Crank scheduling CPI adapter;
- PER endpoint/auth client;
- ER integration test;
- `artifacts/feasibility/g2-private-crank.md`.

### Real Integration Path

Use the official MagicBlock scheduler and Private ER endpoint. The user browser must not send the terminal transition.

### Mock/Simulation Policy

Clock warping and direct handler invocation are allowed in unit tests. Browser `setTimeout`, a local cron process, polling code that submits the transaction, or a fabricated task response cannot satisfy G2.

### Checks

- Account is initialized on Solana and delegated before scheduling.
- Scheduled instruction references stored accounts and contains no client-selected financial terms.
- Execution before the deadline does not advance state.
- Execution at/after the deadline advances state once.
- Duplicate and late execution leave the terminal state unchanged.
- Both users can be offline during the successful transition.
- Transaction logs and signatures distinguish the Crank call from a browser call.
- Cancellation before the scheduled call causes the later call to no-op.

### Acceptance Criteria Covered

- F6, F7, F8, F12, M1, M3, M5, S6, S7.
- Technical risk 2 in full.

### Stop Condition

G2 passes only when a real Crank mutates a real private delegated account without either user online.

If permission middleware prevents scheduled execution, test the current ephemeral-permission model and obtain guidance from a MagicBlock engineer. Do not silently replace Crank with browser automation. If no supported Crank path exists, automatic recovery is blocked and the product requires a go/no-go decision.

## Phase 3: G3 — Privacy Exposure Audit

### Goal

Measure exactly which payment information is hidden and which remains observable before making any privacy claim.

### Work

- Define a fixed sample payment with recognizable test values.
- Capture every relevant account and transaction from five viewpoints:
  1. public Solana RPC before delegation;
  2. unauthenticated Private ER RPC;
  3. authenticated unrelated wallet;
  4. authenticated sender and recipient;
  5. public Solana RPC after commit/undelegation.
- Inspect Config, vault, vault token account, Deposit, Payment shell, delegation record, permission/group record, transaction logs, and committed state.
- Record visibility for sender, recipient, amount, memo, status, balances, payment ID, deadlines, group members, and timing.
- Test whether current permissions live only ephemerally or leave L1 group/member data.
- Test whether a commit exposes full Payment account contents.
- If necessary, keep Payment delegated or implement terminal redaction before any public commit.
- Rewrite product privacy copy to match measured results.

Likely affected areas:

- permission creation and update instructions;
- payment account serialization/redaction;
- authenticated RPC client;
- privacy integration tests;
- public product disclosures;
- `artifacts/feasibility/g3-privacy-matrix.md`.

### Real Integration Path

Use actual public RPC and Private ER RPC responses. Preserve sanitized raw response samples, account addresses, and explorer links so the result is independently reviewable.

### Mock/Simulation Policy

Mock authorization responses cannot prove privacy. No sensitive secret, authentication token, private key, or raw private memo may be committed to the evidence artifact.

### Checks

Use this required matrix:

| Data | Public before delegation | Unauthenticated PER | Unrelated authenticated wallet | Sender/recipient | Public after commit |
|---|---|---|---|---|---|
| Sender | Measure | Measure | Measure | Allowed | Measure |
| Recipient | Measure | Measure | Measure | Allowed | Measure |
| Amount | Must not appear in private Payment shell | Must deny | Must deny | Allowed | Must be redacted or disclosed |
| Memo | Must not appear | Must deny | Must deny | Allowed | Must never appear raw |
| Live status | Measure | Must deny | Must deny | Allowed | Measure |
| Internal balances | Measure | Must deny | Must deny | Own balance allowed | Aggregate exposure disclosed |
| Permission members | Measure | Measure | Measure | Allowed | Measure |

Additional checks:

- Wrong wallet cannot authenticate into sender or recipient view.
- Shared public URL alone reveals no private fields.
- Program logs do not print amount, memo, or entire Payment state.
- Terminal commitment never exposes a raw private memo.
- Marketing explicitly names observable funding, withdrawal, permission, and timing metadata.

### Acceptance Criteria Covered

- M3, M4, S1, privacy acceptance criteria, and technical risk 3 in full.

### Stop Condition

G3 passes when the privacy matrix is complete and every public claim is true for the observed deployment.

- If only amount, memo, status, and balances are private, narrow the claim to those fields.
- If group membership reveals sender-recipient linkage, do not claim relationship privacy unless an unlinkable access-key design is implemented and retested.
- If committed Payment data reveals sensitive fields, keep it delegated for the demo or redact it before commitment.
- If unrelated wallets can read protected fields, stop the privacy claim and fix permissions before proceeding.

## Gate Decision Checkpoint

After G1–G3, record one outcome:

### GO

All three risks pass. Build the full product as specified.

### NARROW

Collateral and Crank pass, but measured privacy is narrower than hoped. Continue with exact language such as **"private pending amount and status"** and remove unsupported claims.

### STOP / PIVOT

Collateral round-trip or scheduled private mutation cannot be proven through a supported path. Do not build a polished mock. Re-scope to the smallest real ER payment-safety primitive that passed and disclose the limitation.

## Phase 4: Complete Protected-Payment State Machine

### Goal

Replace the proof states with the complete `Created`, `Acknowledged`, `Settled`, `Cancelled`, and `Expired` financial workflow.

### Work

- Implement Config, Vault, Deposit, Payment, and status types from the specification.
- Implement base-layer initialize, deposit, prepare, delegate, commit/undelegate, and withdrawal instructions.
- Implement private `open_payment`, `acknowledge_payment`, `cancel_payment`, and `advance_payment` instructions.
- Copy immutable payment terms and deadlines into Payment state.
- Schedule the idempotent 60-second transition checks through the proven G2 path.
- Add terminal payment redaction if required by G3.
- Add client-batched cancellation for multiple recoverable payments.

Likely affected areas:

- `programs/protected-pay/src/state/`;
- `programs/protected-pay/src/instructions/`;
- program errors and events;
- generated IDL/client types;
- unit and integration tests.

### Real Integration Path

All financial state changes execute in the Anchor program against real vault/delegated accounts. Browser state only presents results.

### Mock/Simulation Policy

Local clocks and fixtures are allowed in unit tests. No judged status transition may be injected by modifying account data or browser state.

### Checks

- Recipient-only acknowledgement.
- Sender-only cancellation.
- No acknowledgement at/after expiry.
- Acknowledgement never changes payment terms.
- Cancel-versus-settle race yields one terminal state.
- Expire-versus-acknowledge boundary is deterministic.
- Duplicate settle/expire/cancel never moves value twice.
- Wrong mint, token program, Deposit, Payment, vault, or signer fails.
- Sender cannot withdraw locked value.
- Liability conservation property holds across randomized instruction sequences where feasible.

### Acceptance Criteria Covered

- F1–F12, M1–M6, S1–S10.
- All three PRD proof scenarios at the program level.

### Stop Condition

Do not start product UI until program tests cover all terminal transitions, negative authorization, race boundaries, and exact balance conservation.

## Phase 5: Product Interface

### Goal

Turn the verified state machine into a product anyone can understand within 30 seconds.

### Work

- Adapt the starter's wallet, Anchor, PER-authentication, and subscription hooks.
- Build landing/connect, protected balance, funding, send/review, pending detail, recipient acknowledgement, activity, withdrawal, and recovery surfaces.
- Hide delegation, permission, commit, and Crank terminology from the main journey.
- Show network and test-USDC labelling.
- Make every countdown reconcile authoritative state.
- Provide native copy/share for the recipient link without paid messaging APIs.
- Add a secondary judge proof view with signatures, program address, ER/Base environment, and permission/Crank evidence.
- Measure the actual number of wallet approvals from funded sender to open payment.

Likely affected areas:

- Next.js routes and components;
- program and MagicBlock adapters;
- wallet/PER authentication hooks;
- status subscriptions and reconciliation;
- UI tests and accessibility checks.

### Real Integration Path

Every visible balance and state comes from real program/PER data. Every button submits or prepares a real instruction.

### Mock/Simulation Policy

Storybook-style display fixtures may be used during component development but must not be reachable in the deployed judged flow. Empty, loading, denied, rejected-signature, and delayed-confirmation states should be tested without fabricating successful financial outcomes.

### Checks

- New viewer identifies the product as an Undo window for USDC.
- First-run user sees the test network and funding requirement.
- Invalid address, zero amount, insufficient balance, self-payment, and duplicate-looking payment are handled.
- Sender can create, revisit, and cancel a pending payment.
- Wrong recipient wallet sees no private fields.
- Correct recipient acknowledges.
- Settled, Cancelled, and Expired use visibly different terminal language.
- Page refresh and wallet reconnect restore authoritative state.
- No nonfunctional automation, fiat, AI, or bulk-recovery controls are displayed.
- Approval count is recorded honestly; product copy is updated if one-approval packaging fails.

### Acceptance Criteria Covered

- All product and UX acceptance criteria in the PRD.
- Product-not-demo and 30-second-comprehension requirements.

### Stop Condition

The interface is complete only when all three proof scenarios run through the deployed UI without manual account edits or hidden operator transactions.

## Phase 6: End-To-End Evidence And Submission

### Goal

Produce independently verifiable proof and a product-first submission.

### Work

- Deploy the final program and web client to the chosen non-mainnet environment.
- Run correct, mistaken, and abandoned payment scenarios from fresh state.
- Preserve program ID, transaction signatures, ER signatures, Crank task/result, permission checks, commitment signatures, and explorer links.
- Run all program, client, build, lint, and integration checks.
- Write a concise README with architecture, setup, privacy limitations, test-USDC warning, and demo steps.
- Record a product advertisement whose first 30 seconds show the problem and outcome.
- Follow with a compact technical proof segment.
- Submit accessible repository, deployed product, pitch/demo, explorer proof, and program address.

### Real Integration Path

The recorded product flow uses the same deployment and program ID supplied to judges.

### Mock/Simulation Policy

No fake transaction, fake timer, edited balance, simulated bank payout, or unlabelled local fixture appears in submission media. Visual animation may explain the flow but cannot replace live proof.

### Checks

- First 30 seconds communicate: wrong payment, private waiting period, Undo, automatic outcome.
- Video demonstrates at least one live transaction and one automatic Crank result.
- Explorer and proof view correspond to the submitted program ID.
- Repository is accessible and has reproducible commands.
- Privacy language matches G3's measured matrix.
- Submission never claims Resolva partnership, fiat settlement, mainnet readiness, or audited security.

### Acceptance Criteria Covered

- All submission proof points in the PRD and technical spec.
- Creativity, technical depth, compelling Solana use, and product-not-demo judging filters.

### Stop Condition

Do not call the project complete until the deployed UI, repository, transaction evidence, and submission text all describe the same real capabilities.

## Verification Checkpoint

Before completion, run a separate verification audit against:

- every PRD acceptance criterion;
- F1–F12, M1–M6, and S1–S10 in the technical spec;
- G1 vault evidence;
- G2 Crank evidence;
- G3 privacy matrix;
- the three end-to-end product scenarios;
- the submitted program address and explorer links;
- every claim made in the first 30 seconds of the video.

Any acceptance criterion without evidence is marked failed or deferred. It is not inferred from code presence.

## Handoff Notes

The correct implementation start is Phase 0 followed immediately by G1. Do not start with branding, animation, an AI agent, a Resolva adapter, or a polished dashboard.

The project remains the best researched direction while all three conditions hold:

1. collateral round-trip works;
2. scheduled private state mutation works;
3. the measured privacy boundary is valuable and can be stated honestly.

The plan deliberately prefers a narrower real product over a broader simulated one.
