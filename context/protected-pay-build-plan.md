# Plan: Protected Pay Risk-First Hackathon Build

Status: active implementation plan. G0–G3 and Phase 4 are complete with narrowed privacy language. Version 2.1 is deployed, both corrected live paths pass end to end, retry safety passes, and the corrected Payment passed its field-by-field privacy audit through finalized public redacted commitment. Funded-sender packaging is measured at two transaction approvals plus one cold-session authentication message. Phase 5 now wires funded-sender open/Undo, expired sender recovery, recipient read/acknowledge/claim, first and subsequent balance funding, retry-safe withdrawal, first-time recipient onboarding, and same-tab recovery checkpoints; all browser transaction shapes and balance retry decisions are verified without signing. Payment-creation reconciliation, live browser-wallet evidence, and remaining error states are next, followed by submission.

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
- The local version-2 state machine resolves that blocker without changing Payment account size: opening transfers liability from the sender Deposit into the shared Payment; Crank mutates only Payment; settlement/expiry claims touch only Payment plus the claimant's own Deposit; cancellation refunds and seals atomically.
- The reviewed version-2.1 binary is deployed at slot `495731340`; finalized ProgramData bytecode matched SHA-256 `e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1` exactly and its unused capacity is zeroed.
- A fresh version-2 settlement Payment and permission are delegated on Devnet. Both temporary buffers closed, persistent records/metadata exist, and both user Deposits remain separately delegated and absent from the transaction.
- The sender-authenticated version-2 private-open simulation passes: 1 test USDC moves from sender available balance into individual Payment escrow, Deposit `locked` stays zero, the recipient Deposit is absent, protected arguments are absent from logs, and no state persists.
- The atomic version-2 `open_payment` + `schedule_payment` signed simulation passes. The scheduled `advance_payment` target contains only the shared Payment, needs no signer or financial arguments, and both instructions roll back together in simulation.
- The approved atomic broadcast finalized on the Private ER and opened 1 test USDC of per-Payment escrow. MagicBlock then finalized all five configured executions at `createdAt + 0, +60, +120, +180, +240`. Because expiry is `createdAt + 300`, all five were valid no-ops and the task ended with Payment still `Created`. The late recipient preflight authenticated successfully but correctly signed and broadcast no acknowledgement.
- Version 2.1 fixes the cadence to six calls without changing the IDL, account layout, or stored Payment version. A regression test models the observed immediate first run and proves only call six at `createdAt + 300` expires an unacknowledged payment. Twenty-three Rust tests, IDL/client generation, TypeScript, clippy, and the optimized 633,568-byte SBF build pass; SHA-256 is `e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1`.
- The byte-verified version-2.1 buffer `8qK2AAvUN6hmwFdMq6B3uDrqPZmk2b4RtucanEHpW48Q` was consumed and closed by the finalized upgrade. Its full 3.21936364 SOL rent returned to the authority; a separate CLI read confirms the buffer no longer exists.
- Before broadcast, the exact version-2.1 loader `Upgrade` transaction passed signature-verified Devnet simulation. Simulated ProgramData matched the reviewed bytecode, its 1,568 unused capacity bytes were zero, the buffer was drained, and rent was refunded. Post-simulation reads proved that checkpoint changed no live state and that its prepared signature was never broadcast.
- The separately approved live upgrade finalized with signature `3DEwp2XzMGeuKvZPqVh1iUiJARq2Rd2SiZKFTo7teS4pzfvCRYgyHRZXZVM9ar4fEqGHWh7ps4h8EnbuaGxPocNn`. Independent finalized reads confirm loader ownership, ProgramData link, preserved upgrade authority, deploy slot `495731340`, 635,136-byte capacity, authority balance `6.70412544 SOL`, and closed buffer.
- A guarded recovery client now packages `advance_payment` and sender-only `claim_payment` atomically for the 1 test-USDC escrow stranded by the old five-call schedule. Its unsigned preflight validates every public delegated shell and allocation, exact account identities, 3 test-USDC vault collateral, and denial of all unauthenticated protected reads. No TEE authentication or transaction signature was produced; the next checkpoint must validate the live private state and run a signed, non-broadcast simulation.
- Sender authentication confirmed the stalled Payment remains privately `Created`, more than 10,000 seconds past expiry, with exactly 1 test USDC in per-Payment escrow and 2 test USDC available to the sender. The atomic recovery passed signature-verified simulation: `advance_payment` produced `Expired`, `claim_payment` restored the sender to 3 test USDC, sensitive terms were redacted behind a matching terminal commitment, no recipient account was included, and no state persisted.
- After separate broadcast approval, a fresh signed simulation passed and the same atomic recovery bytes finalized on the Private ER at slot `300869155` with signature `4JdybQt5GuBWPxt6QBX7b7CzRMyWGDumrHSH1HM2LgvpAVLHFSnwhUq8u1NsWyedkeBUzXkaksWFDWsES5p3WX29`. Authenticated readback confirmed `Expired`, redaction, the exact terminal commitment, and sender available balance restored to 3 test USDC. An independent process confirmed unchanged public shells, 3 test-USDC vault collateral, and continued unauthenticated denial.
- The fresh version-2.1 acknowledged-payment shell `71t8qrKg2cFVSceBEFL4RtmKrfhRcMWzyvq4yh4PwikZ` and permission `CAjEn5BnHunwprwxHSoANJLCGBDkMt1YKTeqnbtVi9bP` were created in one finalized Devnet transaction. Independent CLI reads confirm the Payment is a 245-byte Protected Pay account, the permission is a 567-byte Permission Program account, and the transaction finalized. The exact version-2 shell remains empty/unopened; no USDC or private Deposit state moved.
- The fresh version-2.1 delegation runner validated that shell and the configured MagicBlock validator, proved all six required delegation PDAs were absent, and passed unsigned Devnet simulation. The 701-byte transaction delegates only Payment plus its permission, excludes both users' Deposit accounts, preserves all financial bytes, and is estimated to cost 4,617,640 lamports including fee and rent. It remains unsigned and unbroadcast.
- After separate approval, the same delegation passed a fresh signature-verified simulation and finalized on Devnet with signature `2ASiv93UVBXppn616PNHr7wcqPFDFCi3xRvQ2sV99gEUL3s75AArSufC9G7aMRd5nEzDTTRPbVV3cB1nZepPzcn3`. Independent readback at slot `495777386` confirms both temporary buffers closed, all four persistent records/metadata exist, Payment and permission are delegated, the empty version-2 shell is unchanged, and both user Deposits remain separately delegated. The exact fee plus rent was 4,617,640 lamports; no USDC moved.
- Sender authentication and signed simulation for the fresh version-2.1 fixture pass. The 494-byte atomic transaction opens 1 test USDC of individual Payment escrow and registers six 60-second `advance_payment` iterations against only the Payment. Simulation advanced the sender's private available balance `3 -> 2` test USDC and nonce `3 -> 4`, preserved `locked = 0`, found no protected arguments in logs, and persisted nothing. Unauthenticated protected reads remained null and hardware attestation remains independently unverified.
- The approved fresh atomic transaction finalized on the Private ER at slot `300991605` with signature `3Bjghwn3tehG4v9eQBAxovfXn5P7rs8bFEfs58fqQ6BXifqRoUFKrmvoMcfFXqAy8n3PHz5zEz9Qua8hFSYyHGUo`, privately escrowing 1 test USDC and registering task `1788982958472` for six iterations. The recipient then authenticated, could read Payment plus only their own Deposit, passed signed acknowledgement simulation, and finalized `Created -> Acknowledged` at slot `300991928` with signature `4VK5zGusKbr96VtiSamZ8J9vVngHgwiadMDBFza25gCVmqQ4ej1pTdq3NPdxKxVoCLYCEw9zxBHoqu5bgxTgaiKL`. Neither transaction moved SPL tokens or exposed protected arguments in logs.
- A later recipient-authenticated read at Private ER slot `301003847` proved task `1788982958472` autonomously advanced the exact Payment to `Settled` while retaining 1 test USDC in per-Payment escrow. The recipient-only claim passed signature-verified simulation at slot `301003860`: their available balance changed `0 -> 1` test USDC, the Payment redacted its sensitive fields behind the independently reproduced terminal commitment, the sender Deposit remained inaccessible and absent, protected data stayed out of logs, and no state persisted.
- After separate approval, a fresh recipient claim simulation passed and the same signed bytes finalized at Private ER slot `301012025` with signature `52Ec7dorKoShKJdtTeDogyjMt5aXwi1xcFHiKmGVwzmX6GiFwpeibALmtEsJVmp5UzeXcio5pRe8d5rrSjeuKHW9`. Authenticated readback confirms recipient available balance `1` test USDC, `locked = 0`, Payment `Settled` and redacted with the exact commitment, sender Deposit still inaccessible, and no SPL-token movement. Public delegated snapshots, 3 test-USDC vault collateral, and unauthenticated denial remain unchanged.
- The deterministic version-2.1 expiry fixture uses Payment ID `759c4e3fbf3ad9a11c1797e1db3f7e27d0cc4110956e07e0d10aaf1dd005b4a0`, Payment `AvZwmKkHPvrTHk3qyYCeuTAg2jSSrYM9tLEm4gKUD759`, and permission `Acg1YJySxHLLFwiFmQ4u5s3EpphtX2emGFGGKiPXAnPw`. After unsigned and fresh signature-verified simulations passed, its empty shell and permission finalized on Devnet at slot `495792381` with signature `3DjD3KM6Nst7AiExEDqXsCHzu3XshaedU4tjmG7Xxjr5AnWM5e5RLwUByUKji8w6BsseK2z3LSS7EPnfhfdZCkUk`. Independent confirmation reports exactly 5,430,440 lamports in fee plus rent; no USDC or private Deposit state moved.
- The expiry-only delegation mode then validated that exact shell, both existing delegated Deposits, and six absent delegation PDAs. After unsigned and fresh signature-verified simulations passed, delegation finalized at Devnet slot `495794202` with signature `63ph8Uese5MA7nhKoMrzFkyH3JYD6ysqab3NdkC5S6UFR3dSZskmwG3rr3awMMFJwNfmRDR82SKorN9HiyzGf3yN`. Independent readback confirms Payment and permission delegation, four persistent records/metadata, both temporary buffers closed, the unopened version-2 shell unchanged, and no USDC or Deposit mutation. Exact fee plus rent was 4,617,640 lamports.
- The expiry-only private-open mode authenticated the sender through the Query Filtering Service and validated the actual post-settlement private balance and nonce. Its 494-byte signature-verified simulation atomically moved 1 test USDC from sender available accounting into the Payment, registered six 60-second `advance_payment` calls against only that Payment, changed the simulated sender balance `2 -> 1` test USDC and nonce `4 -> 5`, found no protected arguments in logs, and persisted nothing. Unauthenticated reads stayed null; no transaction was broadcast.
- After separate approval, a fresh signed simulation passed and atomic open-plus-schedule finalized on the Private ER at slot `301102775` with signature `sYExmGVU4ibbpMJXJ8mMuPfLe15vZmvySLTN9rBpgAxExf4FHdkmC9D95nY2qBD6auoVsKmB3FyH7vdtbEDD8ZK`. It escrowed 1 test USDC, changed sender private available accounting `2 -> 1`, advanced nonce `4 -> 5`, and registered task `1788988515930` for six calls. A read-only authenticated monitor then proved six validator-signed executions at exact `+0, +60, +120, +180, +240, +300` timestamps. Call six finalized at slot `301108775` and changed the unacknowledged Payment to `Expired`; the escrow stayed 1 test USDC, public and vault state stayed unchanged, and unauthenticated reads stayed null.
- The sender-recovery client now has an expiry-only mode that uses just `claim_payment` because Crank already produced the `Expired` state. Its unsigned public preflight at finalized slot `495821953` validates the exact delegated fixture, public shell isolation, 3 test-USDC vault collateral, sender-only future signer, exclusion of the recipient Deposit, and outsider denial. It loaded no keypair and signed or broadcast nothing.
- After explicit simulation approval, sender authentication validated the live `Expired` Payment, 1 test-USDC escrow, 1 test-USDC sender available balance, nonce 5, owner-only Deposit visibility, and exact task/memo/deadlines. A 286-byte `claim_payment` transaction passed signature-verified simulation at Private ER slot `301126907`: sender available accounting changed `1 -> 2` test USDC, escrow and sensitive fields cleared, the independently reproduced terminal commitment matched, recipient state stayed excluded, protected data stayed out of logs, and no state persisted. Prepared signature `3ebMQvC1SGYdqgvfWbMgB333SfBmxrfiNZe9v4MHctDTPm4NJRiBvyFxgQu5H3xpG7GSU3Hw5xSoLhzXSqCE4Xvi` was not broadcast.
- After separate broadcast approval, a fresh simulation passed and sender-only claim `3aHSwTwad1nTxxGiB8DeEPPETyQkQH5B453HSVKvqej53Mz5P4HXaZHTrCG5WceXQ7484zgkEacUz3rcD2GeZPEG` finalized on the Private ER at slot `301130266`. It restored sender available accounting `1 -> 2` test USDC, cleared escrow, and redacted sensitive terms behind the exact terminal commitment. A separate authenticated verifier fetched the receipt directly through JSON-RPC after the Solana CLI failed to render the Private ER's null fee field; it confirmed `err: null`, the sender as sole signer, Protected Pay success, no protected data in logs, zero escrow, sender balance 2 test USDC, unchanged public shells and 3 test-USDC vault collateral, and continued outsider denial.
- The retry-safety runner's unsigned preflight passes at finalized slot `495828746`. It validates the terminal fixture's delegated topology, 3 test-USDC vault collateral, and outsider denial, then constructs two separately gated simulations: repeated `advance_payment` against only Payment must succeed as a byte-for-byte no-op, while repeated `claim_payment` against Payment plus only the sender Deposit must fail with `PaymentRedacted (6022)`. No keypair, TEE authentication, transaction signature, or broadcast was used.
- After explicit approval, the two signature-verified retry simulations passed against the live redacted Payment. Repeated `advance_payment` consumed 5,991 CUs at Private ER slot `301148411` and returned byte-identical state. Duplicate `claim_payment` returned the exact `PaymentRedacted (6022)` program error at slot `301148425`. Fresh reads proved sender available remained 2 test USDC, Payment and Deposit bytes were unchanged, recipient state remained excluded, public shells and vault were unchanged, outsiders remained denied, and neither prepared transaction was broadcast.
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
| G1 vault | CORE PASS | Real Devnet test USDC entered the vault, survived delegated private accounting, committed, and withdrew exactly | Retain the round-trip as regression evidence |
| G2 Crank | PASS | Probe and real Payment schedules produced autonomous validator-signed private executions; version 2.1 settles or expires at the intended boundary | Retain receipts as submission evidence |
| G3 privacy | NARROW PASS | Outsider denial and the corrected Payment's pre-commit public/private boundary measured | Independently verify TEE attestation and the public post-commit bytes |
| Decision | NARROW / PROCEED | The architecture is viable with precise privacy language | Do not claim anonymity or permanent secrecy |
| Phase 4 | COMPLETE | Settlement, unattended expiry, owner-only recovery, retry safety, corrected-layout privacy, and finalized redacted public closeout proven against live state | Preserve as regression and judge evidence |
| Phase 5 | IN PROGRESS | React/Vite surfaces, Wallet Standard connection, validated private sessions, first/subsequent funding, retry-safe withdrawal, real funded-sender open/Undo/expired recovery, recipient onboarding/read/acknowledge/claim, encrypted links, same-tab recovery, proof drawer, responsive QA | Payment-creation reconciliation, live browser-wallet proof, and remaining error states |
| Phase 6 | WAITING | — | End-to-end evidence, video, deployment, and submission |

## Immediate Remaining Plan

1. **Complete locally:** keep aggregate user Deposits private to their owners and use the shared Payment as per-payment escrow; Crank now targets only Payment.
2. **Complete for the core lifecycle:** version-2 tests cover claims, cancel-versus-Crank, expiry boundaries, duplicate execution, overflow atomicity, legacy-version rejection, and conservation. Pause/revocation stays deferred with session-key automation.
3. **Complete locally:** version 2.1 changes the fixed Payment schedule from five to six 60-second iterations, includes an immediate-first-run regression test, and passes the full optimized build gate without changing the IDL or account layout.
4. **Complete on Devnet:** fresh buffer `8qK2AAvUN6hmwFdMq6B3uDrqPZmk2b4RtucanEHpW48Q` contains exactly the reviewed version-2.1 binary and locks 3.21936364 Devnet SOL of refundable rent.
5. **Complete:** the exact signed version-2.1 upgrade passes signature-verified simulation without broadcast; simulated bytecode replacement, trailing-byte cleanup, buffer closure, and rent refund all match expectations.
6. **Complete on Devnet:** the separately approved version-2.1 upgrade finalized at slot `495731340`; the deployed bytes, zeroed tail, authority, closed buffer, rent refund, and transaction status were independently verified.
7. **Complete on Private ER:** atomic `advance_payment` plus `claim_payment` recovery finalized, restored the sender from 2 to 3 test USDC available, redacted the Payment terms behind the verified terminal commitment, and preserved the public/privacy boundary.
8. **Complete on Private ER:** the corrected settlement path pays the recipient, while the unattended path reached `Expired` at call six and its sender-only claim restored 1 test USDC, cleared escrow, redacted sensitive fields, and preserved the privacy boundary. Signed retry simulations prove repeated `advance_payment` is a byte-for-byte no-op and repeated `claim_payment` fails with `PaymentRedacted (6022)` without a second credit.
9. **Complete:** the 320-byte Payment-only closeout passed signature-verified simulation and finalized at Private ER slot `301184653` and Devnet slot `495841058`. Public verification proves the Payment was redacted before commitment, its terminal commitment matches, its delegation record/metadata closed, both aggregate Deposits and the Payment Permission remain delegated, vault collateral remains 3 test USDC, and neither original amount nor memo hash appears in public logs or state.
10. **Complete:** the four public Payment setup/delegation instructions fit in one 797-byte transaction and simulated successfully with 141,907 compute units. Atomic private open/schedule is 494 bytes and already proven live. A funded sender therefore sees three cold-session wallet prompts—public setup transaction, off-chain TEE authentication message, private open transaction—or two prompts while the authentication session is valid. Do not claim one-click or one-approval sending.
11. **In progress:** the product UI now covers connect, protected-balance unlock/read, first and subsequent test-USDC funding, retry-safe withdrawal, real funded-sender send/share/Undo/expired recovery, authoritative recipient Payment read/countdown, first-time recipient onboarding, real acknowledgement/claim, encrypted link-carried notes, same-tab recovery, activity layout, and judge proof. The 320-byte private return and 737-byte public mutation/re-delegation builders are now guarded by persisted pre-broadcast signatures and 13 reconciliation cases that prohibit blind custody retries. The remaining work is Payment-creation reconciliation, live browser-wallet evidence, and denied/delayed/rejected-signature variants.
12. Run all three end-to-end stories from fresh state, perform the final verification audit, deploy the web client, record the product-first video, confirm the authenticated submission deadline, and submit.

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
