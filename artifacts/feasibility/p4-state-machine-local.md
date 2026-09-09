# Phase 4 Local State-Machine Verification

Date: 2026-09-09

## Result

**LOCAL PASS / LIVE UPGRADE PASS / PAYMENT FLOW PENDING**

The Anchor program now implements the complete protected-payment lifecycle:

- public amount-free Payment preparation;
- sender/recipient private permission membership and delegation;
- private open with exact balance locking and copied immutable deadlines;
- recipient-only acknowledgement;
- sender-only cancellation and recovery;
- permissionless deterministic settlement or expiry;
- a fixed five-iteration, 60-second MagicBlock Crank schedule;
- terminal redaction before Payment commitment/undelegation;
- authority-controlled timing updates that affect only future payments.

The older `CrankProbe` remains temporarily so the already-recorded G2/G3 evidence and verification scripts stay reproducible. It is not the product workflow.

## Local checks

```text
cargo test -p protected-pay --lib --locked
PASS: 21 passed, 0 failed

NO_DNA=1 npm run idl
PASS

npm run client:generate
PASS

npm run typecheck
PASS

cargo clippy -p protected-pay --lib --tests --locked -- -D warnings
PASS
```

Optimized SBF build:

```text
NO_DNA=1 RUSTUP_TOOLCHAIN=1.89.0-sbpf-solana-v1.53 \
  cargo-build-sbf --skip-tools-install --optimize-size \
  --features no-log-ix-name,no-idl \
  --manifest-path programs/protected-pay/Cargo.toml -- --locked

PASS: target/deploy/protected_pay.so (635,136 bytes)
SHA-256: e12298b94a74a7113cde7cd0334fc0e6145e6482eda44ab9a336f0a39286d14a
```

## Covered invariants

- opening moves one exact amount from available to locked;
- acknowledgement changes no financial terms;
- acknowledgement at the expiry boundary is rejected;
- cancellation and expiry return the locked amount exactly once;
- settlement debits sender locked and credits recipient available exactly once;
- terminal Crank retries are no-ops;
- cancel-versus-settle races produce one terminal winner;
- wrong actors and substituted Deposit relationships fail;
- arithmetic overflow fails without partial balance mutation;
- terminal redaction is one-way and idempotent;
- total internal liability is conserved across internal payment transitions.

## Remaining live proofs

Before Phase 5:

1. create and delegate a real Payment shell and recipient Deposit/permissions;
2. execute open, acknowledge, cancel, settle, and expiry through the authenticated Private ER;
3. prove a real five-run Crank task advances a Payment with both users offline;
4. re-run the unauthorized-read and public metadata audit for the Payment layout;
5. redact, commit/undelegate, and verify final public state before withdrawal.

## Read-only Devnet upgrade preflight

- Current ProgramData allocation: 482,376 bytes
- New optimized binary: 635,136 bytes
- Required extension: 152,760 bytes
- Current ProgramData rent balance: 2.45134892 SOL
- New ProgramData rent minimum (including 45-byte loader metadata): 3.22736972 SOL
- Permanent extension rent: approximately 0.77602080 SOL
- Temporary upload-buffer rent (including 37-byte loader metadata): approximately 3.22732908 SOL, refundable after a successful upgrade
- Upgrade authority balance at preflight: 2.51507452 SOL
- Peak additional requirement before transaction fees: approximately 4.00334988 SOL
- Estimated shortfall before transaction fees: approximately 1.48827536 SOL

A 2 SOL Devnet top-up gives a reasonable fee cushion. This is only a calculation from read-only RPC and rent queries; no faucet request, signature, buffer creation, extension, or upgrade was attempted.

## Approved top-up and signed simulation

The approved faucet top-up was attempted at 2 SOL, 1 SOL, and 0.5 SOL. Every request was rejected by the Devnet faucet rate limiter. No SOL arrived; the authority balance remained exactly 2.51507452 SOL.

A signed, non-broadcast `ExtendProgram` transaction was then simulated against Devnet. Before signing, the script validated the Program account owner/executable flag, ProgramData owner, 482,421-byte account length, ProgramData discriminator, stored upgrade authority, fee-payer owner, and signer address.

```text
Simulation error: null
Signature verification: passed
Transaction broadcast: false
Additional bytes: 152,760
Simulated ProgramData data length: 635,181 bytes including loader metadata
Compute units consumed: 1,310
Estimated fee: 5,000 lamports
Authority: 2.51507452 SOL -> 1.73904872 SOL (simulated only)
ProgramData: 2.45134892 SOL -> 3.22736972 SOL (simulated only)
```

The newer `ExtendProgramChecked` variant was first tested and rejected by the current Devnet loader as invalid instruction data. No broadcast occurred. The successful simulation uses the legacy `ExtendProgram` wire instruction used by the installed CLI; the script still independently checks the stored upgrade authority before signing.

This initial simulation was funding-blocked at the time. The later funded and live result is recorded below.

## Funded simulation and live Devnet upgrade

The authority was manually funded to 7.51507452 SOL. The signed extension simulation was repeated against that balance and passed without broadcast:

```text
Simulation error: null
Signature verification: passed
Transaction broadcast: false
Additional bytes: 152,760
Compute units consumed: 2,520
Estimated fee: 5,000 lamports
Authority: 7.51507452 SOL -> 6.73904872 SOL (simulated only)
ProgramData: 2.45134892 SOL -> 3.22736972 SOL (simulated only)
```

The approved live deployment first extended ProgramData and created the upload buffer, then the public Devnet endpoint exhausted its write retries. The program remained recoverable: the buffer contained the full 635,136-byte allocation and 3.22736972 SOL of refundable rent. Deployment was resumed through a Devnet endpoint using the recovered one-time buffer signer.

```text
Cluster genesis hash: EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG (Devnet)
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Upgrade authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Upgrade transaction: 37vY1ceQ2xiAT4v1jBsHYLXMmkTx8XpiYLCfEt9wKMz7c5bAUJ5a31EpApTvoWT97Sx5pY1ARLXYZEpnkQtDJf1a
Confirmed slot: 495532661
ProgramData allocation: 635,136 bytes
ProgramData rent balance: 3.22736972 SOL
Authority balance after buffer refund: 6.73589872 SOL
On-chain SHA-256: e12298b94a74a7113cde7cd0334fc0e6145e6482eda44ab9a336f0a39286d14a
Local SHA-256:    e12298b94a74a7113cde7cd0334fc0e6145e6482eda44ab9a336f0a39286d14a
Remaining authority-owned buffers: none
```

The dumped on-chain bytecode and local optimized artifact were both 635,136 bytes and matched byte-for-byte by SHA-256. The temporary buffer was consumed and closed, its rent was refunded, and all temporary recovered key files were deleted from the in-memory temporary directory.

## Timing-policy update preflight and live result

The guarded Phase 4 timing-policy client validated the finalized Config owner, 154-byte allocation, discriminator, stored authority, Circle Devnet USDC mint, SPL Token program, Private ER validator, and current `300/86400` policy. It then simulated the proposed `60/300` update with a no-op signer, so no signature or broadcast was possible.

```text
Finalized pre-state slot: 495537709
Simulation slot: 495537747
Config: n7i13zNfTRnBzvB9q7CrkNP3CKZE6rZTFBrcb4cevYs
Writable accounts: Config only
Current safety/claim windows: 300 / 86,400 seconds
Proposed safety/claim windows: 60 / 300 seconds
Simulation error: null
Compute units consumed: 4,962
Estimated fee: 5,000 lamports
SOL moved: 0
Tokens moved: none
Signed: false
Broadcast: false
```

The Config allocation and rent remained unchanged in simulation. The program copies these windows into a Payment when it opens, so the policy update affects future payments and does not shorten deadlines already stored in an active Payment.

After approval, the guarded client repeated the unsigned checks, loaded the exact Config authority, and ran a signature-verified simulation before submission. The transaction finalized and a separate RPC confirmation plus Config transaction-history lookup returned the same signature.

```text
Signed preflight error: null
Signed preflight compute units: 4,962
Finalized transaction: 5S1oPJoA3xCTGcvrj5zhdEHKoXPEHHHJ7WXTPrr5QWgc38EjLWWBmoK8gFERQd3upQdUCLHyk66V8Zed2GF22Xt6
Final Config safety/claim windows: 60 / 300 seconds
Fee paid: 5,000 lamports
Authority balance: 6.73589872 SOL -> 6.73589372 SOL
SOL transferred: 0
Tokens transferred: none
```

The finalized post-state revalidated the Config program owner, 154-byte allocation, discriminator, identity fields, and exact `60/300` policy.

## Sender-only payment bootstrap preflight

The first bootstrap design created the recipient Deposit permission in the sender transaction, which required both wallets to co-sign. That was rejected as a product workflow because a sender must be able to create a payment while the recipient is offline. The corrected bootstrap creates only what the sender can safely prepare; recipient permission creation is deferred until the recipient opens the payment link.

The unsigned client validated the deployed program, finalized `60/300` Config, empty vault liability, sender Deposit and nonce, Circle Devnet USDC token accounts, existing delegated sender permission, candidate recipient system account, Permission Program, and absence of every init-only account. It then simulated with a no-op sender signer.

```text
Finalized pre-state slot: 495545767
Simulation slot: 495545804
Sender: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Candidate recipient: HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Payment ID: 5116f610de73e51223722b7aecba79d15a6f9f323c818a6d7ed20d38f01243ce
Transaction size: 765 bytes
Instructions: deposit_usdc, initialize recipient Deposit, prepare Payment, create Payment permission
Sender signature required: yes
Recipient signature required: no
Test USDC deposited: 3.000000
Payment amount in public shell: 0
Simulation error: null
Compute units consumed: 64,643
Estimated fee: 5,000 lamports
Permanent account rent plus fee: 6,578,520 lamports
Wallet test USDC: 20.000000 -> 17.000000
Vault test USDC/liability: 0 -> 3.000000
Sender available/locked: 0/0 -> 3.000000/0
Recipient available/locked: absent -> 0/0
Signed: false
Broadcast: false
```

After explicit approval, the guarded client repeated the unsigned checks, loaded only the sender signer, and passed a signature-verified simulation before submission.

```text
Signed preflight error: null
Signed preflight compute units: 64,643
Finalized transaction: 2mNPFCiSwy86BjdbxUpsWRSBCtkG2oLgyyFVD9sjxixvQ95UKNyWG9KDjcBRUprnvkwpZn92nsooCdrjU31LQQTe
Finalized verification slot: 495548220
Authority balance: 6.73589372 SOL -> 6.72931520 SOL
Sender wallet test USDC: 20.000000 -> 17.000000
Vault test USDC/liability: 0 -> 3.000000
Sender available/locked: 0/0 -> 3.000000/0
Recipient available/locked: absent -> 0/0
Payment amount/initialized: 0 / false
Recipient Deposit permission created: false
```

The independent CLI confirmation finalized and the Payment transaction history returned the same signature. The live client revalidated all token, Vault, Deposit, Payment, permission-owner, and relationship fields after finalization.

## Sender-side delegation preflight

The next unsigned client validated the finalized `60/300` Config, the amount-free Payment shell, its MagicBlock permission, the funded sender Deposit, the already-delegated sender Deposit permission, the required programs and validator, and the absence of all nine new delegation PDAs. It then simulated delegating the three sender-controlled accounts together. The recipient was not a signer.

```text
Finalized pre-state slot: 495551184
Simulation slot: 495551221
Payment: DX7ndZZSka9KzDfhzjaA4ww3T4pmXFRHUyAoZFUScidY
Payment permission: BiqbCtkzMsnNA2qVrcToSeeUTCevxzGgUsR5Zkn5qbvv
Sender Deposit: 5gUmsQ4sxHvWrKTvbt8Vn4mDzVNH3xAaC11Tarj7uehB
Private validator: MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
Transaction size: 915 bytes
Instructions: delegate Payment permission, delegate Payment, delegate sender Deposit
Sender signature required: yes
Recipient signature required: no
Simulation error: null
Compute units consumed: 159,751
Estimated fee: 5,000 lamports
Delegation-account rent: 7,091,680 lamports
Total estimated fee plus rent: 7,096,680 lamports
USDC moved: 0
SOL transferred: 0
Sender available/locked: 3.000000/0 -> 3.000000/0
Payment amount/initialized: 0/false -> 0/false
All three account owners after simulation: MagicBlock Delegation Program
Signed: false
Broadcast: false
```

The simulation compared the full Payment, Deposit, permission, and vault-token bytes before and after delegation. Their data was unchanged; only account ownership and delegation infrastructure changed. Public Solana still reveals the prepared shell relationships and delegation metadata. The payment amount, memo, and later balance transitions can become private only when they are supplied and executed inside the Private ER.

After explicit approval, the guarded client repeated all unsigned validation, loaded only the sender signer, and passed a signature-verified simulation before broadcast. The transaction finalized, and an independent non-verbose CLI confirmation plus Payment transaction-history lookup returned the same signature.

```text
Signed preflight error: null
Signed preflight compute units: 159,751
Finalized transaction: 2YKheSuZdaFqfh5wyf3WbZ1xYdwJZ7tCHLcoLbUygtBBaSUoA5padMS9AU2oEudHNcBXchPRC3q92N13b5vr3fdA
Finalized verification slot: 495553995
Authority balance: 6.72931520 SOL -> 6.72221852 SOL
Fee plus delegation-account rent: 7,096,680 lamports
USDC moved: 0
SOL transferred: 0
Sender available/locked: 3.000000/0
Payment amount/initialized: 0/false
Payment permission owner: MagicBlock Delegation Program
Payment owner: MagicBlock Delegation Program
Sender Deposit owner: MagicBlock Delegation Program
Temporary delegation buffers persisted: false
Recipient signature required: false
```

The finalized read validated each delegated account's owner and allocation, all six persistent delegation record/metadata accounts, the absence of temporary buffers, the Payment and Deposit discriminators and relationships, the unchanged vault token account, and the unchanged financial state.

## Recipient one-signature onboarding preflight

The recipient can accept the prepared payment link without the sender returning online. An unsigned transaction created the recipient Deposit permission, delegated it, and delegated the recipient's zero-balance Deposit in one atomic operation. The client validated that the invitation names this recipient, the Payment and its permission are already delegated, the recipient Deposit is genuine and empty, the recipient permission and all proposed delegation PDAs are absent, and the required MagicBlock programs and validator are available.

```text
Finalized pre-state slot: 495555908
Simulation slot: 495555944
Recipient: HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Recipient Deposit: DJU7iPmejpGXAxAs3apWA7ZmWob33cnc3ebAZ7YQ5nxK
Transaction size: 750 bytes
Instructions: create recipient Deposit permission, delegate permission, delegate Deposit
Recipient signature required: yes
Sender signature required: no
Simulation error: null
Compute units consumed: 130,292
Estimated fee: 5,000 lamports
New account rent: 8,326,120 lamports
Total estimated fee plus rent: 8,331,120 lamports
USDC moved: 0
SOL transferred: 0
Recipient available/locked: 0/0 -> 0/0
Recipient permission owner after simulation: MagicBlock Delegation Program
Recipient Deposit owner after simulation: MagicBlock Delegation Program
Signed: false
Broadcast: false
```

The current proof uses one recipient signature and charges Devnet fee/rent to the recipient wallet. The production UX target is still one signature, but with a sponsor or relayer paying transaction costs. Gas sponsorship has not yet been implemented and is not claimed by this proof.

After explicit approval, the guarded client repeated the unsigned checks, loaded only the exact recipient signer, and passed a signature-verified simulation before broadcast. The transaction finalized, and an independent non-verbose CLI confirmation plus recipient Deposit transaction-history lookup returned the same signature.

```text
Signed preflight error: null
Signed preflight compute units: 130,292
Finalized transaction: 3Q3axzzAsMceVAZ6UAVwLmfnN57WAyAT5QbXGKyfF6T5hxtbfjSmPFLmZfAPVy7raM5nZUoXy55ur2bf2SBxS8Mf
Finalized verification slot: 495557646
Recipient balance: 5.950449615 SOL -> 5.942118495 SOL
Fee plus account rent: 8,331,120 lamports
USDC moved: 0
SOL transferred: 0
Recipient available/locked: 0/0
Recipient permission: AmRuy7GSJ84Bad2qoc3NF8Y3b36ScsrDCwMgnDDBjUPa
Recipient permission owner: MagicBlock Delegation Program
Recipient Deposit owner: MagicBlock Delegation Program
Temporary delegation buffers persisted: false
Sender signature required: false
```

The finalized read validated the recipient permission and Deposit owners and allocations, all four persistent delegation record/metadata accounts, the absence of temporary buffers, the Deposit discriminator and identity fields, and the unchanged vault token bytes.

## Authenticated private Payment-open simulation

After explicit approval, the sender authenticated with MagicBlock's Query Filtering Service. The client validated the challenge format, exact wallet address, and freshness before signing it. The bearer token existed only inside the process and was neither printed nor persisted. Independent hardware-attestation verification remains out of scope and is not claimed.

Before constructing the Payment instruction, the client validated the public Config and vault collateral, all six delegated Payment/Deposit/permission accounts, and the exact public shell relationships and snapshots. An unauthenticated Private ER query returned `null` for the Payment, sender Deposit, and recipient Deposit. The authenticated sender could read only the Payment and sender Deposit needed for opening.

```text
Public finalized pre-state slot: 495561010
Authenticated Private ER pre-state slot: 300256418
Signed simulation slot: 300256435
Private ER: https://devnet-tee.magicblock.app
Authenticated identity: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Payment: DX7ndZZSka9KzDfhzjaA4ww3T4pmXFRHUyAoZFUScidY
Recipient: HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Instruction: open_payment
Private amount: 1.000000 test USDC
Transaction size: 391 bytes
Prepared, unbroadcast signature: 6275T5P29Nj3RmS8pZrTAXerB53mECPtJHZjkJF17zTuuWLzduTsHnKW7HGf6oyfeeximNpttpAzJH9anLKXBPTb
Signature verification: passed
Simulation error: null
Compute units consumed: 12,843
Sender available/locked: 3.000000/0 -> 2.000000/1.000000
Sender payment nonce: 1 -> 2
Payment amount/initialized: 0/false -> 1.000000/true
Settlement delay: 60 seconds
Expiry delay: 300 seconds
SPL token movement: none
Protected amount or memo hash in program logs: false
Unauthenticated protected reads: all null
Private state persisted after simulation: false
Public state changed after simulation: false
Signed: true
Broadcast: false
```

This proves that the actual Payment state machine—not a standalone privacy demo—can privately apply an approved payment amount and memo hash while atomically locking the matching sender balance. It also proves simulation-only safety: the signed transaction was never submitted, and both the private and public pre-state remained unchanged afterward.

After explicit approval to open the real private Payment, the guarded client authenticated again, repeated the privacy and account checks, and passed a fresh signature-verified simulation. It submitted the same signed transaction to the Private ER, polled its signature status to finalization, then validated the authorized private state and the unchanged public and unauthenticated views.

```text
Public finalized pre-state slot: 495562717
Private ER simulation slot: 300262532
Finalized Private ER slot: 300262608
Finalized Private ER transaction: 4RzCbTmgQJWqPURdPbWDWmeYeYi9YfottkrsWvEgTTS1mrFdXvKuStKse9Zu75VK6JtCECPNHF2tPAheeWEdRZjW
Created at: 1788946509
Settle after: 1788946569 (+60 seconds)
Expires at: 1788946809 (+300 seconds)
Private Payment amount/status: 1.000000 test USDC / Created
Private sender available/locked: 2.000000/1.000000 test USDC
Private sender payment nonce: 2
SPL token movement: none
Public Payment amount/initialized: 0/false
Public sender available/locked: 3.000000/0
Public vault collateral: 3.000000 test USDC
Unauthenticated protected reads: all null
Private ER reported transaction fee: unavailable
Authentication token printed or persisted: false
Hardware attestation independently verified: false
```

The open is now real Private ER state. Its Payment amount, memo hash, and updated balance are visible to authorized members but remain absent from the public base snapshot and unavailable through unauthenticated Private ER reads.

## Expired-Payment Crank schedule feasibility result

The five-minute Payment expired before the separate schedule approval arrived. This exposed an important product constraint: human approval latency and a short claim window cannot be combined unless open and schedule are atomic or the demo window is longer.

After explicit approval, the sender authenticated again and the guarded client built the required MagicBlock Crank schedule: five executions at 60-second intervals, targeting signer-free `advance_payment` with no financial arguments. The Payment, sender Deposit, and recipient Deposit remained delegated, and unauthenticated reads remained hidden.

The signed simulation did not execute. The Query Filtering Service returned no RPC error, but it consumed zero compute units, emitted no program logs, and returned no simulated accounts.

```text
Observed at: 1788947766
Payment expiry: 1788946809
Expired by: 957 seconds
Private Payment status: Created
Private amount: 1.000000 test USDC
Private sender available/locked: 2.000000/1.000000 test USDC
Sender can read Payment: yes
Sender can read sender Deposit: yes
Sender can read recipient Deposit: no
Attempted instruction: schedule_payment
Task ID: 1788946809
Interval/iterations: 60,000 ms / 5
Scheduled target: advance_payment
Financial arguments in scheduled instruction: none
Simulation RPC error: null
Compute units consumed: 0
Program logs: none
Returned simulated accounts: none
Signed: true
Broadcast: false
```

Current MagicBlock documentation says a private permission presently implies account read access; separate read/write capabilities may be added later. The sender-authenticated request therefore cannot span the recipient-only aggregate Deposit. Adding every sender to that permission would leak the recipient's complete Deposit balance and is rejected as an unsafe workaround.

This is a product-architecture finding, not a passed Crank gate. The recommended correction is to move automated terminal decisions into a shared per-Payment escrow/state account, then let the sender or recipient claim the terminal result into only their own private Deposit. That keeps the automation account shared without exposing either party's aggregate balance.

For the currently locked test payment, `cancel_payment` is still available as the immediate human-recovery path because it touches only the shared Payment and sender Deposit. It will return the locked 1 test USDC to the sender's private available balance.
