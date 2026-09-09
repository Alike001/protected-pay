# Phase 4 Local State-Machine Verification

Date: 2026-09-09

## Result

**V1 LIVE RECOVERY PASS / V2 ATOMIC LIVE / V2.1 SIX-ITERATION LOCAL PASS**

The Anchor program now implements the complete protected-payment lifecycle:

- public amount-free Payment preparation;
- sender/recipient private permission membership and delegation;
- private open with exact per-payment escrow and copied immutable deadlines;
- recipient-only acknowledgement;
- sender-only cancellation and recovery;
- permissionless deterministic settlement or expiry;
- a fixed six-iteration, 60-second MagicBlock Crank schedule that reaches the 300-second expiry boundary;
- owner-only settlement/expiry claims followed by atomic terminal redaction;
- authority-controlled timing updates that affect only future payments.

The older `CrankProbe` remains temporarily so the already-recorded G2/G3 evidence and verification scripts stay reproducible. It is not the product workflow.

## Local checks

```text
cargo test -p protected-pay --lib --locked
PASS: 23 passed, 0 failed

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

PASS: target/deploy/protected_pay.so (633,568 bytes)
SHA-256: e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1
```

## Covered invariants

- opening moves one exact amount from the sender's aggregate Deposit into the individual Payment escrow;
- acknowledgement changes no financial terms;
- acknowledgement at the expiry boundary is rejected;
- cancellation returns and seals the Payment escrow exactly once;
- settlement and expiry mutate only Payment; the entitled owner claims into only their own Deposit exactly once;
- terminal Crank retries are no-ops;
- cancel-versus-settle races produce one terminal winner;
- wrong actors and substituted Deposit relationships fail;
- arithmetic overflow fails without partial balance mutation;
- terminal redaction is one-way and idempotent;
- total internal liability is conserved across internal payment transitions.

## Remaining live proofs

Before Phase 5:

1. upgrade the Devnet program to the locally verified version-2 state machine;
2. create and delegate fresh version-2 Payment shells;
3. execute open, acknowledge, cancel, settle, expiry, and owner-only claim through the authenticated Private ER;
4. prove a real five-run Crank task advances only Payment with both users offline;
5. re-run the unauthorized-read and public metadata audit for the Payment layout;
6. commit/undelegate a sealed Payment and verify final public state before withdrawal.

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

## Expired-Payment human-recovery simulation

After explicit approval, the sender authenticated with the Query Filtering Service and simulated `cancel_payment` against the expired private Payment. The guarded client rejected broadcast mode, verified the exact sender identity, validated the public delegated snapshots and vault collateral, then validated the authenticated Payment, sender Deposit, and permission accounts before decoding them.

The cancellation instruction contained only the sender, shared Payment, and sender Deposit. It did not request the recipient wallet or recipient Deposit, so it stayed within the sender's privacy permissions and executed normally.

```text
Observed at: 1788949430
Payment expiry: 1788946809
Expired by: 2,621 seconds
Private Payment before/after: Created -> Cancelled
Private sender available: 2.000000 -> 3.000000 test USDC
Private sender locked: 1.000000 -> 0 test USDC
Private sender payment nonce: 2 -> 2
Payment terms changed: status only
Instruction accounts: sender, Payment, sender Deposit
Recipient account required: no
Transaction size: 286 bytes
Prepared, unbroadcast signature: 2UfdXjNdPdaNiuAnyna5nkdzjRiMVwPLpL3zG52eXsHCCmxrRw88SEEyGijdcMLmNfizCKGs5NZXArM1uwAo3DmM
Signature verification: passed
Simulation error: null
Compute units consumed: 9,810
Private ER reported transaction fee: unavailable
SPL token movement: none
Protected amount or memo hash in program logs: false
Unauthenticated protected reads: all null
Private state persisted after simulation: false
Public state changed after simulation: false
Vault balance changed after simulation: false
Signed: true
Broadcast: false
```

This passes the immediate human-recovery proof: even after expiry, the sender can interrupt the failed workflow and recover the entire reserved balance without learning or modifying the recipient's aggregate private balance. Because this was simulation-only, the live private Payment remains `Created` and the live 1 test USDC remains locked until a separately approved cancellation is broadcast.

After separate explicit approval, the guarded client authenticated again, rebuilt the cancellation from the still-live `Created` state, and passed a fresh signature-verified simulation. It then submitted that exact signed transaction, waited for Private ER finalization, and independently decoded the protected Payment and sender Deposit.

```text
Finalized Private ER transaction: 49YRj4WXZchmcioscE8b3fkMBBU7DKwSc7HuqSrSfsbpnvJtfciBrPR5XrNRtqXZFrMKRabMu8YkA5YNh5T4KmaY
Finalized Private ER slot: 300327313
Confirmation status: finalized
Private Payment status: Cancelled
Private sender available: 3.000000 test USDC
Private sender locked: 0 test USDC
Private sender payment nonce: 2
Internal amount recovered: 1.000000 test USDC
Recipient signature required: false
SPL token movement: none
Public state changed: false
Vault balance changed: false
Unauthenticated protected reads: all null
Authentication token printed or persisted: false
Hardware attestation independently verified: false
```

The live recovery is complete. The three real test USDC remain fully collateralized in the public vault while all three are once again available to the sender in private accounting. This proves the manual recovery path; it does not resolve the separate Crank permission-topology blocker documented above.

## Version-2 per-Payment escrow correction

Current MagicBlock documentation was rechecked through Context7 on 2026-09-09. It confirms that permission to a delegated private account currently implies read access; a separate read/write split may be added later. Therefore, allowing a sender-authenticated schedule to touch the recipient's aggregate Deposit would weaken the privacy claim and remains rejected.

The version-2 state machine instead uses the existing nonzero `Payment.amount` as the individual payment's unclaimed escrow liability:

```text
Open:       sender Deposit available -> Payment escrow
Crank:      Payment Created/Acknowledged -> Expired/Settled
Claim:      Payment escrow -> entitled owner's Deposit available
Cancel:     Payment escrow -> sender Deposit available, atomically
After pay:  terminal commitment created; private fields zeroed
```

The Crank target now has exactly one writable financial account: the shared Payment. Settlement and expiry claims contain only the shared Payment and the claimant's own Deposit. No flow grants either party read access to the other's aggregate balance. Newly prepared payments are version 2; all version-1 payments are rejected by the new escrow methods to prevent legacy state from being interpreted or credited twice.

The fixed Payment layout remains 245 bytes, so no Payment account reallocation was introduced. Local verification produced:

```text
Rust unit tests: 22 passed, 0 failed
Clippy with warnings denied: passed
Anchor IDL build: passed
Codama TypeScript generation: passed
TypeScript check: passed
Optimized SBF build: passed
Optimized binary size: 633,568 bytes
Optimized binary SHA-256: 5b2f04b8b347a85e5f7f03dc9305709aaaab7fb538738d348919a8811756d6f5
Generated advance_payment writable accounts: Payment only
Generated claim_payment accounts: claimant, Payment, claimant Deposit
Devnet upgrade: not attempted
Transaction signatures: none
```

This resolves the permission topology in code and local tests, not yet on the live deployment. It also narrows the automation promise honestly: Crank determines the terminal outcome while users are offline; the entitled owner later claims the escrow into their private available balance. Manual Undo still returns the sender's escrow immediately in one sender-authorized operation.

A read-only Devnet upgrade preflight confirmed that the new binary fits inside the existing ProgramData allocation:

```text
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Upgrade authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Current allocation: 635,136 bytes
Version-2 binary: 633,568 bytes
Remaining allocation headroom: 1,568 bytes
Permanent extension required: no
Authority balance: 6.72221852 SOL
Signature requested: no
Transaction broadcast: no
```

## Version-2 Devnet signed upgrade simulation

After explicit approval, a guarded simulation-only client loaded the approved upgrade-authority signer and revalidated the complete public loader relationship before signing: the executable Program owner and discriminator, its linked ProgramData address, the ProgramData owner and discriminator, the stored upgrade authority, and the authority system account. It also pinned the exact reviewed artifact by SHA-256 and rejected any `--send` argument.

Because Solana RPC simulations do not persist account state between transactions, an exact final `Upgrade` instruction cannot succeed until a real upload buffer exists. The signed transaction therefore exercised the maximum honest non-persistent preflight: it created a full-size ephemeral loader buffer, initialized it under the approved authority, and wrote the first 512 bytes of the reviewed version-2 artifact in one transaction.

```text
Cluster: Solana Devnet
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Fee payer and upgrade authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Binary size: 633,568 bytes
Binary SHA-256: 5b2f04b8b347a85e5f7f03dc9305709aaaab7fb538738d348919a8811756d6f5
Deployed capacity: 635,136 bytes
Headroom: 1,568 bytes
Simulated buffer allocation: 633,605 bytes
Temporary buffer rent: 3.21936364 SOL (refundable after upgrade)
Artifact-prefix write tested: 512 bytes
Prepared, unbroadcast signature: 4BLDwgPhBwhatAxrYxanuuypbgn4kV3vLNT8PtYMbojuKdSy8n5uZs7A98bQyaFc836mqERJHEt8cp4uiGNtivME
Signature verification: passed
Simulation error: null
Compute units consumed: 4,890
Estimated fee: 10,000 lamports (0.00001 SOL)
Authority balance before simulation: 6.72221852 SOL
Authority balance after simulation-only follow-up: 6.72221852 SOL
Prepared signature found on Devnet: no
Ephemeral simulated buffer found on Devnet: no
Persistent buffer creation: not attempted
Full bytecode upload: not attempted
Upgrade instruction: not attempted
Program mutation: none
```

This passes the signed authority, funding, loader-buffer allocation, initialization, and bytecode-write-path checks without changing Devnet. The remaining dependency is structural rather than a failed test: a separately approved real buffer upload is required before the exact signed `Upgrade` transaction can be simulated against Devnet. The eventual upgrade broadcast must remain a third, separately approved action after that exact simulation passes.

## Version-2 Devnet buffer upload

After separate explicit approval, the 633,605-byte upgradeable-loader buffer was created on base Devnet and funded with the previously calculated rent. The official public endpoint accepted the creation and an initial portion of the upload, then rate-limited the machine. A second public endpoint also rate-limited the CLI uploader. Both uploaders were stopped without abandoning the buffer.

Current MagicBlock Router documentation was checked through Context7 and its official repository. The router inspects writable accounts and routes non-delegated state to Solana. A guarded resumable uploader was therefore added using the router's account-aware `getBlockhashForAccounts` method. Each transaction was signed by the validated buffer authority, used node preflight, wrote only the reviewed artifact bytes, and was confirmed before its batch advanced. Resume scans skipped byte-identical chunks.

```text
Cluster: Solana Devnet
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Program deploy slot before upload: 495532661
Program deploy slot after upload: 495532661
Program upgraded: no
Buffer: CjV4LC6X8pY6C2uoB7fEGFvXXZvtY7Mg2kGwPvjYhB1r
Buffer owner: BPFLoaderUpgradeab1e11111111111111111111111
Buffer authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Buffer allocation: 633,605 bytes
Buffer rent: 3.21936364 SOL (still locked and refundable)
Uploaded bytecode length: 633,568 bytes
Logical 900-byte chunks verified: 704 / 704
Local binary SHA-256: 5b2f04b8b347a85e5f7f03dc9305709aaaab7fb538738d348919a8811756d6f5
Finalized buffer SHA-256: 5b2f04b8b347a85e5f7f03dc9305709aaaab7fb538738d348919a8811756d6f5
Finalized verification slot: 495639933
Authority balance before upload: 6.72221852 SOL
Authority balance after upload: 3.49903488 SOL
Actual transaction fees and retries: 0.00382 SOL
Temporary buffer signer file retained: no
```

A fresh second pass reconstructed the entire buffer at finalized commitment and found all 704 logical chunks already byte-identical, providing an independent no-write verification. The exact `Upgrade` instruction has not been signed or broadcast. Its next checkpoint is a signed, non-broadcast simulation against this finalized buffer; only a later, separately approved transaction may mutate the ProgramData account and consume/refund the buffer.

## Exact version-2 Devnet upgrade simulation

After explicit approval, the finalized buffer was fetched again from base Devnet and compared byte-for-byte with the pinned local artifact. The guarded client validated the Devnet genesis hash, Program → ProgramData link, loader owners and discriminators, ProgramData and buffer authorities, allocation lengths, fee payer/system ownership, and the complete buffer hash before loading the authority signer.

The exact `UpgradeableLoaderInstruction::Upgrade` account order was taken from the current Solana loader-v3 interface: ProgramData, Program, Buffer, spill account, Rent sysvar, Clock sysvar, and upgrade-authority signer. The authority wallet was also the spill destination and fee payer. The signed transaction was submitted only to `simulateTransaction` with signature verification enabled. The simulation command omits the independent broadcast-approval flag; the later broadcast path remains guarded by both explicit approval flags.

```text
Cluster: Solana Devnet
Instruction: UpgradeableLoaderInstruction::Upgrade
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Buffer: CjV4LC6X8pY6C2uoB7fEGFvXXZvtY7Mg2kGwPvjYhB1r
Fee payer, spill, and upgrade authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Binary length: 633,568 bytes
Binary and finalized-buffer SHA-256: 5b2f04b8b347a85e5f7f03dc9305709aaaab7fb538738d348919a8811756d6f5
ProgramData capacity: 635,136 bytes
Live deploy slot before simulation: 495532661
Simulated deploy slot after upgrade: 495647054
Simulated ProgramData bytecode matched: true
Simulated 1,568-byte trailing allocation zeroed: true
Simulated buffer drained: true
Simulated buffer-rent refund: 3.21936364 SOL
Simulated ProgramData rent top-up: 0 SOL
Estimated fee: 5,000 lamports (0.000005 SOL)
Authority before simulation: 3.49903488 SOL
Authority after simulated refund and fee: 6.71839352 SOL
Compute units consumed: 2,370
Prepared, unbroadcast signature: 2Pq6fGnBJxBeMBsmyP86brymdw7L4gCJkV26x5Kk4PiWAsJaDZgAtjK62oPp1MiLAvNMHtAMiBFBmwEaW5EyqEGh
Signature verification: passed
Simulation error: null
Prepared signature found on Devnet: no
Live deploy slot after simulation: 495532661
Live buffer still present and byte-identical: true
Live authority balance unchanged: true
Transaction broadcast: no
```

The simulation proves the exact loader transition, bytecode replacement, trailing-byte cleanup, buffer closure/refund, and authority accounting. A separate approval is still required to sign and broadcast a fresh transaction with a fresh blockhash. The simulation signature itself is intentionally unbroadcast and will expire.

## Version-2 Devnet program upgrade

After separate explicit broadcast approval, the guarded client repeated every finalized-state and bytecode check, signed a fresh transaction, successfully simulated its exact wire bytes with signature verification enabled, and sent those same bytes to Solana Devnet. The transaction finalized, the loader replaced the live bytecode, preserved the upgrade authority, closed the upload buffer, and refunded its rent.

```text
Cluster: Solana Devnet
Instruction: UpgradeableLoaderInstruction::Upgrade
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Upgrade authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Closed buffer: CjV4LC6X8pY6C2uoB7fEGFvXXZvtY7Mg2kGwPvjYhB1r
Finalized transaction: QrQYw5iREXnDsb3Weq9F3QcCHG9vm8UZ91szBCwFzwcMF42kJZpJfBVwADmCPEqAkDXQLcfXoJ1eBRefhisxusL
Deploy slot before upgrade: 495532661
Deploy slot after upgrade: 495652516
ProgramData capacity: 635,136 bytes
Deployed binary length: 633,568 bytes
Deployed binary SHA-256: 5b2f04b8b347a85e5f7f03dc9305709aaaab7fb538738d348919a8811756d6f5
Independent on-chain dump prefix matched local artifact: true
Trailing 1,568-byte allocation zeroed: true
ProgramData rent top-up: 0 SOL
Buffer-rent refund: 3.21936364 SOL
Transaction fee: 0.000005 SOL
Authority balance before: 3.49903488 SOL
Authority balance after: 6.71839352 SOL
Exact signed simulation passed immediately before broadcast: true
Simulation compute units consumed: 2,370
Finalized confirmation independently checked with Solana CLI: true
Buffer account absent after finalization: true
USDC movement: none
Payment-state mutation: none
```

This completes the version-2 deployment checkpoint. It changes only executable program bytecode and loader-owned deployment accounts; it does not create a payment, move user funds, or modify an existing payment account. The next checkpoint must exercise the live version-2 state machine through its separately approved product flow.

## Version-2 settlement bootstrap simulation

The first live version-2 fixture reuses the funded sender Deposit, empty recipient Deposit, and both existing delegated Deposit permissions. It creates only a fresh public Payment shell and its MagicBlock permission. The unsigned client validated the deployed program, exact Config and timing policy, both delegated Deposit identities and permissions, both proposed account absences, the two wallets, and the Permission Program before simulation.

```text
Finalized pre-state slot: 495658166
Simulation slot: 495658206
Sender: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Recipient: HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Payment label: protected-pay:phase4:v2:settlement:1
Payment ID: e415db75d70ee2d9e9a82606d0fabf29b8a1bce2a6043ccab479238ed70f4be0
Payment: 83JoRQii6JKQV5hziNgrrpoYmrzTom8h25gSVWEGpjNK
Payment permission: 3phccDv3mz1jPfHqPcF5qW83hB46M2tcAazqNDtWmvnU
Instructions: prepare_payment, create_payment_permission
Payment version after simulation: 2
Payment amount/initialized: 0 / false
Sender signature required: yes
Recipient signature required: no
Transaction size: 464 bytes
Simulation error: null
Compute units consumed: 27,814
Estimated fee: 5,000 lamports
Estimated fee plus new-account rent: 5,430,440 lamports
USDC moved: 0
SOL transferred: 0
Existing private Deposits mutated: false
Signed: false
Broadcast: false
```

This proves that the upgraded program creates version-2 shells and that the cheapest safe fixture path can reuse the already onboarded users. The shell necessarily reveals sender, recipient, mint, and Payment address on Solana L1; the amount, memo, timestamps, and active status remain zero/uninitialized until the later private open. A separate sender approval is required before this bootstrap can be signed and broadcast.

## Version-2 settlement bootstrap broadcast

After explicit approval, the guarded client repeated the complete unsigned pre-state check, then loaded only the approved sender signer. It signed a fresh transaction, simulated those exact wire bytes with signature verification enabled, submitted the same transaction, waited for finalization, and decoded the resulting accounts again.

```text
Unsigned finalized pre-state slot: 495660207
Signature-verified simulation slot: 495660245
Finalized verification slot: 495660270
Finalized transaction: CJmjsbgZAsEUXK7o3H5LNKzUwstpjSxW98R8oK4XpkLESZB6dKj8vifVJ2fuUmfEV3YEdeP9jU3pyeqyDG8Cnve
Sender and fee payer: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Recipient recorded in shell: HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Payment: 83JoRQii6JKQV5hziNgrrpoYmrzTom8h25gSVWEGpjNK
Payment permission: 3phccDv3mz1jPfHqPcF5qW83hB46M2tcAazqNDtWmvnU
Instructions: prepare_payment, create_payment_permission
Payment version: 2
Payment amount/initialized: 0 / false
Signature verification: passed
Simulation error: null
Compute units consumed: 27,814
Transaction fee: 5,000 lamports
Fee plus new-account rent: 5,430,440 lamports
Authority balance: 6.71839352 SOL -> 6.71296308 SOL
USDC moved: 0
SOL transferred: 0
Existing private Deposits mutated: false
Independent Solana CLI confirmation: Finalized
```

The version-2 settlement fixture is now ready for delegation. Because both users and their owner-only Deposit permissions were already onboarded, the next transaction should delegate only this new Payment and its permission. It must not redelegate or expose either aggregate Deposit.

## Version-2 settlement delegation simulation

The dedicated delegation client validated the finalized version-2 shell and permission, the Config and timing policy, both already-delegated user Deposits and permissions, all required MagicBlock programs, the configured Private ER validator, the fee payer, and the absence of all six proposed delegation accounts. It then simulated only Payment-permission and Payment delegation with a no-op signer.

```text
Finalized pre-state slot: 495662432
Simulation slot: 495662470
Payment: 83JoRQii6JKQV5hziNgrrpoYmrzTom8h25gSVWEGpjNK
Payment permission: 3phccDv3mz1jPfHqPcF5qW83hB46M2tcAazqNDtWmvnU
Instructions: delegate Payment permission, delegate Payment
Writable financial accounts: Payment only
Sender Deposit included in instructions: false
Recipient Deposit included in instructions: false
Sender signature required: yes
Recipient signature required: no
Transaction size: 701 bytes
Simulation error: null
Compute units consumed: 102,243
Estimated fee: 5,000 lamports
Delegation-account rent: 4,612,640 lamports
Estimated fee plus rent: 4,617,640 lamports
USDC moved: 0
User-to-user SOL transfer: 0
Payment and permission owner after simulation: MagicBlock Delegation Program
Payment, permission, sender Deposit, and recipient Deposit data unchanged: true
Signed: false
Broadcast: false
```

This is the corrected version-2 permission topology in a real Devnet simulation: automation receives access to the individual Payment but no instruction grants access to either user's aggregate Deposit. A separate sender approval is required before the same guarded flow may sign and broadcast the delegation.

## Version-2 settlement delegation broadcast

After explicit approval, the guarded client repeated the unsigned checks, loaded only the approved sender signer, and passed a signature-verified simulation before submitting the same wire transaction. The transaction finalized successfully. Its first post-submit verifier incorrectly expected the temporary delegation buffers to remain queryable, so it raised an error after finalization; no retry or second transaction was sent. A corrected read-only verifier models the actual lifecycle: temporary buffers close, while delegation records and metadata persist.

```text
Unsigned finalized pre-state slot: 495665396
Signature-verified simulation slot: 495665436
Finalized transaction: GdCSsjhYbv4sQ4h176vMU9T9U6752m4g8kcp5n3vSBgrJcUtKV2355gqM7M9HDEmk8DozT5sbpXJxW5sqVkfcEB
Independent finalized verification slot: 495666350
Sender and fee payer: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Payment: 83JoRQii6JKQV5hziNgrrpoYmrzTom8h25gSVWEGpjNK
Payment permission: 3phccDv3mz1jPfHqPcF5qW83hB46M2tcAazqNDtWmvnU
Payment owner: MagicBlock Delegation Program
Payment permission owner: MagicBlock Delegation Program
Payment version/amount/initialized: 2 / 0 / false
Persistent delegation records and metadata present: true
Temporary delegation buffers closed: true
Sender Deposit owner: MagicBlock Delegation Program
Recipient Deposit owner: MagicBlock Delegation Program
Signature verification: passed
Simulation error: null
Compute units consumed: 102,243
Transaction fee: 5,000 lamports
Delegation-account rent: 4,612,640 lamports
Fee plus rent: 4,617,640 lamports
Authority balance: 6.71296308 SOL -> 6.70834544 SOL
USDC moved: 0
Payment and permission financial data changed: false
Independent Solana CLI confirmation: Finalized
```

This completes the corrected delegation topology on Devnet. The next checkpoint requires sender authentication to the Private ER and a signed, non-broadcast simulation of `open_payment`. That simulation should debit 1 test USDC from the sender's private available balance into the individual Payment escrow without touching the recipient Deposit or transferring SPL tokens.

## Version-2 authenticated private-open simulation

After explicit approval, the version-aware client first validated the public Config, vault collateral, delegated Payment and permission, and both delegated user Deposits and permissions. Unauthenticated Private ER reads returned `null`. The first network attempt timed out at the Private ER edge before producing simulation evidence and changed no state. Once endpoint reachability recovered, the client authenticated the exact sender through the Query Filtering Service, kept the bearer token only in memory, and performed a signature-verified simulation without broadcast.

```text
Public finalized pre-state slot: 495669332
Authenticated Private ER pre-state slot: 300615443
Signed simulation slot: 300615462
Private ER: https://devnet-tee.magicblock.app
Authenticated identity: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Payment: 83JoRQii6JKQV5hziNgrrpoYmrzTom8h25gSVWEGpjNK
Recipient: HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Instruction: open_payment
Payment version: 2
Private amount: 1.000000 test USDC
Escrow model: individual Payment liability
Transaction size: 391 bytes
Prepared, unbroadcast signature: 8NoDwmRfRuPoEJ1u5kgmQhgFjDitSNiYFZfnZtqppx7rnuovxZ4fTQtL2nrQZMHHQrAbxrnaQgPYsfLyTsRJ9cQ
Signature verification: passed
Simulation error: null
Compute units consumed: 12,836
Private sender available: 3.000000 -> 2.000000 test USDC
Private sender locked: 0 -> 0 test USDC
Private sender payment nonce: 2 -> 3
Payment amount/initialized: 0/false -> 1.000000/true
Settlement delay: 60 seconds
Expiry delay: 300 seconds
Recipient Deposit included: false
SPL token movement: none
Protected amount or memo hash in program logs: false
Unauthenticated protected reads: all null
Private state persisted after simulation: false
Public state changed after simulation: false
Bearer token printed or persisted: false
Hardware attestation independently verified: false
Signed: true
Broadcast: false
```

This is the first live proof of the corrected accounting transition. Unlike version 1, opening does not place the liability in the sender's aggregate `locked` field. The value leaves `available` and exists only in the individual shared Payment, so the future Crank can decide its outcome without receiving access to either user's aggregate Deposit.

The standalone open must not be broadcast as the judged path. The earlier version-1 test proved that starting a five-minute claim window and then waiting for a separate schedule approval can leave the payment expired before automation is registered. The next checkpoint will therefore combine `open_payment` and the corrected Payment-only `schedule_payment` in one signed simulation and, after separate approval, one atomic broadcast. Either both actions succeed or neither does.

## Version-2 atomic private-open and Crank-schedule simulation

After explicit approval, the client revalidated the public and protected state, authenticated the sender, and checked that the MagicBlock Crank program is executable inside the Private ER. The first implementation incorrectly looked for that program on base Devnet and stopped before authentication; the corrected check runs in the execution environment where the scheduler CPI exists.

The final signed transaction placed `open_payment` immediately before `schedule_payment`. Its schedule instruction has four outer accounts—MagicBlock program, payer, Payment, and Protected Pay program—and includes neither aggregate Deposit. The Protected Pay program constructs a signer-free `advance_payment` target containing the Payment alone.

```text
Public finalized pre-state slot: 495673073
Authenticated Private ER pre-state slot: 300628007
Signed simulation slot: 300628053
Private ER: https://devnet-tee.magicblock.app
Authenticated sender: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Recipient: HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Payment: 83JoRQii6JKQV5hziNgrrpoYmrzTom8h25gSVWEGpjNK
Instructions: open_payment, schedule_payment
Private amount: 1.000000 test USDC
Payment version: 2
Escrow model: individual Payment liability
Task ID: 1788964779354
Execution interval / iterations: 60,000 ms / 5
Scheduled target: signer-free advance_payment
Scheduled target accounts: Payment only
Sender Deposit included in schedule: false
Recipient Deposit included in schedule: false
Transaction size: 494 bytes
Prepared, unbroadcast signature: 2irzDsk1isoJL5z9LFosdpVcPfXnq4jSWTPBNTGLiWCXoSMps9s9f3Pk11NZkyz3aKvusjdLneb74gpaU8DKekLC
Signature verification: passed
Simulation error: null
Compute units consumed: 25,270
Private sender available: 3.000000 -> 2.000000 test USDC
Private sender locked: 0 -> 0 test USDC
Private sender payment nonce: 2 -> 3
Payment amount/initialized/task: 1.000000 / true / 1788964779354
SPL token movement: none
Protected amount or memo hash in logs: false
Unauthenticated protected reads: all null
Private state persisted after simulation: false
Public state changed after simulation: false
Bearer token printed or persisted: false
Hardware attestation independently verified: false
Signed: true
Broadcast: false
```

This closes the version-1 timing gap: a broadcast can no longer start the five-minute window without also registering its automation. A separate approval is still required for a fresh authentication, signature, and atomic broadcast; the simulation signature is intentionally unbroadcast and will expire.

## Version-2 atomic broadcast and live Crank cadence finding

After explicit approval, the guarded sender client repeated the public/private ownership checks, unauthenticated-read denial, TEE authentication, and signature-verified simulation. It then submitted the same atomic `open_payment` plus `schedule_payment` transaction to the Private ER. Both instructions finalized together.

```text
Public finalized pre-state slot: 495677697
Authenticated Private ER pre-state slot: 300643207
Signed simulation slot: 300643220
Finalized Private ER slot: 300643256
Atomic transaction: 296f9Y8Cir938Gk8spqmyMtm2ai6vXKFtuWVs5wANHaU5LYsUV6gCdycyLLuxampLaLKecJAGbMBWT9dUjtyvKba
Task ID: 1788965539251
Created at: 1788965541
Settle after: 1788965601
Expires at: 1788965841
Execution interval / iterations: 60,000 ms / 5
Payment status after open: Created
Private Payment escrow: 1.000000 test USDC
Private sender available: 2.000000 test USDC
Private sender locked: 0
Private sender payment nonce: 3
Scheduled target: signer-free advance_payment
Scheduled target accounts: Payment only
SPL token movement: none
Unauthenticated protected reads: all null
```

The Payment-only topology worked, but the live task disproved the assumed timing model. The program history contained the user transaction plus five distinct successful autonomous executions:

```text
offset   block time    slot        Crank signature
+0s      1788965541   300643256   2sbwgu4fRU7GCVTkR88F3N8zLe5wVqZ2WyMGo9vmnHnx8bvEF9QbWVVz3wefmCFUmGMVtW1xUsuLqxLaRCYug6yp
+60s     1788965601   300644456   2ukUtZy9QBjcKNPeMoMhT6cGfggr8zdbotAyf3VxbXX449rF7TybJn1qBFE81JUwv2sfMFr3ek51W44mjTw3i3qS
+120s    1788965661   300645656   YAFk4EK1cJEJj2kziVBLph7VLmRiYJWo6eLt5Xkh8za9KijTbRJBio5c2ggT3CW18Z9mLKDgySNxfzhtSqq61j1
+180s    1788965721   300646856   5FV9ZjLkkGX8jNsKtFYU1cG9Nbv6LzEQpJswwM3Zk2ZW4hukwnEVM5NTiPdhJ2HC6pA8gf3gi2JE2dj8bRkx6fWB
+240s    1788965781   300648056   3Tt45mCGKzfsym7SPqDjNJYBH9qJCPQHRvfvjZMfo2jvqibWJ4sE5w1UpFgcUxr3msiEHkrbVW7YMMzUQarKyuZx
```

All five entries finalized with `err: null`. There was no sixth Protected Pay execution at the `+300s` expiry boundary or during the following minute. Every configured call was therefore an expected no-op against an unacknowledged `Created` payment, and the task ended before it could mark the Payment `Expired`.

The recipient then authenticated successfully, but the guarded acknowledgement client observed the payment after its immutable expiry deadline. It stopped before constructing or signing the acknowledgement transaction:

```text
Recipient: HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Payment status observed: Created
First observed lateness: 31 seconds after expiry
Follow-up observed lateness: 152 seconds after expiry
Recipient could read shared Payment: true
Recipient could read own Deposit: true
Recipient could read sender Deposit: false
Recipient Deposit changed: false
Acknowledgement signed: false
Acknowledgement broadcast: false
```

The failure is a schedule-cadence defect, not a custody or privacy failure: the 1 test USDC remains in the private per-Payment escrow, neither party's aggregate Deposit was exposed, and no late recipient action was authorized. The correction is six 60-second iterations (immediate, then `+60` through `+300`) or an absolute-deadline task. The current escrow requires an explicitly approved manual `advance_payment` before the sender-only expired claim can recover it.

## Version-2.1 six-iteration local correction

The local program and guarded atomic-open client now require exactly six executions at 60-second intervals. The Payment account layout, instruction schema, IDL, and stored `version = 2` remain unchanged, so the patch is compatible with existing version-2 state. “Version 2.1” is a release label for the cadence correction, not a new account-data version.

A regression test reproduces the empirically observed immediate-first-run schedule. It invokes `advance` at offsets `0, 60, 120, 180, 240, 300`, asserts that the Payment remains `Created` through the first five calls, and asserts that the sixth call changes it to `Expired` exactly at the immutable deadline.

```text
cargo fmt --all -- --check
PASS

cargo test -p protected-pay --lib --locked
PASS: 23 passed, 0 failed

NO_DNA=1 npm run idl
PASS

npm run client:generate
PASS: generated output unchanged

npm run typecheck
PASS

cargo clippy -p protected-pay --lib --tests --locked -- -D warnings
PASS

NO_DNA=1 RUSTUP_TOOLCHAIN=1.89.0-sbpf-solana-v1.53 \
  cargo-build-sbf --skip-tools-install --optimize-size \
  --features no-log-ix-name,no-idl \
  --manifest-path programs/protected-pay/Cargo.toml -- --locked
PASS

Optimized binary: target/deploy/protected_pay.so
Binary size: 633,568 bytes
SHA-256: e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1
Transactions signed: none
Transactions broadcast: none
```

The next deployment sequence is a separately approved full-bytecode Buffer upload, followed by a signature-verified non-broadcast upgrade simulation and then a separately approved broadcast. The current escrow is not modified by the local correction.

## Version-2.1 exact-upgrade prerequisite preflight

The approved action was an exact signed upgrade simulation only. Solana's upgradeable loader requires that instruction to consume an already initialized, fully uploaded on-chain Buffer. The previous version-2 buffer was consumed and closed during its successful upgrade, and a fresh read-only Devnet query found no buffers owned by the upgrade authority.

```text
Cluster: Solana Devnet
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Upgrade authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Current authority balance: 6.70834544 SOL
Authority-owned buffers: none
ProgramData capacity: 635,136 bytes
Version-2.1 binary length: 633,568 bytes
Unused ProgramData capacity: 1,568 bytes
ProgramData extension required: no
Required new Buffer allocation: 633,605 bytes including loader metadata
Required refundable Buffer rent: 3.21936364 SOL
Local version-2.1 SHA-256: e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1
Current deployed 635,136-byte SHA-256: 7a3391683d118bf58d2b6d9c95f68782facd06a0e0ff00fe011a0fa150fd7e0b
Local binary padded to 635,136 bytes SHA-256: e259019a7411cd56469a36dd46eb658a274985a255569e579a8b3ebe7c1369d4
Current deployment already matches version 2.1: false
Transactions constructed: none
Transactions signed: none
Transactions broadcast: none
```

The exact simulation cannot be performed honestly by chaining non-persistent simulations: the 633,568-byte artifact cannot fit in one Solana transaction, and one simulation's Buffer writes are not visible to the next. Creating and uploading the required buffer changes Devnet state and temporarily locks rent, so it requires separate authorization before the signed simulation can resume.

## Version-2.1 Devnet buffer upload

After separate explicit approval, a fresh upgradeable-loader Buffer was created on Solana Devnet and filled with the reviewed version-2.1 artifact. The configured provider first failed at the transport layer without creating usable state. The official public Devnet uploader then created and initialized the buffer and uploaded 89 of 704 logical chunks before stalling; it was intentionally stopped without damaging or abandoning the buffer.

A guarded resumable uploader validated the buffer owner, discriminator, authority, allocation, rent, and local artifact hash before writing. It scanned existing bytes, skipped the 89 matching chunks, and sent the remaining 615 chunks through MagicBlock Router. Every submitted write used node preflight and was confirmed before its batch advanced. Two transactions encountered an expired blockhash during preflight and were safely rebuilt and retried; neither failed attempt executed a write.

```text
Cluster: Solana Devnet
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Buffer: 8qK2AAvUN6hmwFdMq6B3uDrqPZmk2b4RtucanEHpW48Q
Buffer authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Buffer allocation: 633,605 bytes
Bytecode length: 633,568 bytes
Buffer rent: 3.21936364 SOL
Local bytecode SHA-256: e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1
Finalized buffer SHA-256: e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1
Initial public-uploader chunks preserved: 89
Resumed write transactions confirmed: 615
Independent finalized verification: 704 / 704 chunks already matching
Writes required by independent verification: 0
Finalized verification slot: 495724304
Program deploy slot before upload: 495652516
Program deploy slot after upload: 495652516
Program upgrade executed: false
Authority balance before: 6.70834544 SOL
Authority balance after: 3.4847668 SOL
Rent plus transaction costs: 3.22357864 SOL
Transaction costs excluding refundable rent: 0.004215 SOL
Temporary one-time buffer signer retained: no
```

The second finalized scan reconstructed the complete buffer and matched every byte without sending a transaction. The one-time buffer signer file was then deleted; the persistent buffer remains controlled by the intended upgrade authority. No upgrade instruction was signed or broadcast, and the live ProgramData deploy slot did not change. The next checkpoint is an exact signature-verified, non-broadcast upgrade simulation against this buffer.

## Version-2.1 exact signed upgrade simulation

After explicit approval, the guarded upgrade client fetched the finalized Buffer and complete live ProgramData again, then validated the Devnet genesis, loader owners and discriminators, Program-to-ProgramData link, both stored authorities, allocation bounds, system-owned fee payer, current deployment slot, exact bytecode hash, and full Buffer contents before loading the approved authority signer.

The client built the loader-v3 `Upgrade` instruction with ProgramData, Program, Buffer, authority spill destination, Rent sysvar, Clock sysvar, and the upgrade-authority signer. It signed a fresh transaction and submitted it only to `simulateTransaction` with signature verification enabled. The independent broadcast-approval flag was absent, so the command could not enter its send path.

```text
Cluster: Solana Devnet
Release: version-2.1
Instruction: UpgradeableLoaderInstruction::Upgrade
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Buffer: 8qK2AAvUN6hmwFdMq6B3uDrqPZmk2b4RtucanEHpW48Q
Authority, spill destination, and fee payer: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Binary length: 633,568 bytes
Binary and finalized-buffer SHA-256: e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1
ProgramData capacity: 635,136 bytes
Live deploy slot before simulation: 495652516
Simulated deploy slot: 495728598
Simulated ProgramData matches reviewed binary: true
Simulated trailing allocation zeroed: true
Simulated buffer drained: true
Simulated buffer-rent refund: 3.21936364 SOL
Simulated ProgramData rent top-up: 0 SOL
Estimated fee: 0.000005 SOL
Authority balance before: 3.4847668 SOL
Authority balance after simulated refund and fee: 6.70412544 SOL
Simulation error: none
Compute units consumed: 2,370
Signature verified by simulation: true
Transaction broadcast: false
Live deploy slot after simulation: 495652516
Live buffer still present and byte-identical: true
Live authority balance unchanged: true
Prepared signature found on Devnet: false
```

The simulation proves the exact version-2.1 loader transition, reviewed bytecode replacement, unused-capacity cleanup, buffer closure, and rent accounting. Simulation persisted none of those changes. A separate explicit approval is still required to sign and broadcast a fresh transaction with a fresh blockhash; the prepared simulation signature is intentionally unbroadcast and will expire.

## Version-2.1 Devnet program upgrade

After separate explicit broadcast approval, the guarded client repeated every finalized loader, authority, capacity, and bytecode check. It signed a fresh upgrade transaction, successfully simulated those exact wire bytes with signature verification enabled, and submitted the same bytes to Solana Devnet. The transaction finalized, installed the reviewed version-2.1 bytecode, preserved the upgrade authority, closed the Buffer, and refunded its rent.

```text
Cluster: Solana Devnet
Release: version-2.1
Finalized signature: 3DEwp2XzMGeuKvZPqVh1iUiJARq2Rd2SiZKFTo7teS4pzfvCRYgyHRZXZVM9ar4fEqGHWh7ps4h8EnbuaGxPocNn
Finalized transaction slot: 495731340
Instruction: UpgradeableLoaderInstruction::Upgrade
Program: w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Preserved upgrade authority: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Closed buffer: 8qK2AAvUN6hmwFdMq6B3uDrqPZmk2b4RtucanEHpW48Q
Deploy slot before: 495652516
Deploy slot after: 495731340
ProgramData capacity: 635,136 bytes
Deployed bytecode length: 633,568 bytes
Deployed bytecode SHA-256: e7998fcd2c85f5accead0ba7e6317dfb6bfebed210ea1d18a0b622047d4f78f1
Trailing allocation zeroed: true
Buffer closed: true
Buffer rent refunded: 3.21936364 SOL
ProgramData rent top-up: 0 SOL
Transaction fee: 0.000005 SOL
Authority balance before: 3.4847668 SOL
Authority balance after: 6.70412544 SOL
Exact signed simulation before broadcast: passed
Simulation compute units: 2,370
```

An independent CLI confirmation returned `finalized`. A separate program read returned loader-v3 ownership, the expected ProgramData address, preserved authority, deployment slot `495731340`, and the unchanged 635,136-byte allocation. An independent balance read returned exactly `6.70412544 SOL`, while a direct Buffer lookup returned `AccountNotFound`. No token accounts or private Payment state were involved in this loader transaction.

## Version-2.1 stalled-payment recovery preflight

The payment schedule that exposed the immediate-first-iteration behavior left one version-2 Payment in private `Created` state with 1 test USDC in its individual escrow. After deploying the compatible version-2.1 code, a guarded recovery client was added to combine permissionless `advance_payment` and sender-authorized `claim_payment` in one atomic Private ER transaction. This removes the intermediate failure window: either the Payment becomes `Expired` and the sender receives the internal credit, or neither mutation persists.

The first approved continuation was intentionally unsigned. It validated the public delegated shells, exact identities, owners, discriminators, and allocations for the Payment, both Deposits, and all three permissions. It also validated the SPL Token vault's mint, authority, and exact collateral, then confirmed that an unauthenticated Private ER client could read none of the three protected financial accounts.

```text
Public finalized preflight slot: 495738390
Payment: 83JoRQii6JKQV5hziNgrrpoYmrzTom8h25gSVWEGpjNK
Sender Deposit: 5gUmsQ4sxHvWrKTvbt8Vn4mDzVNH3xAaC11Tarj7uehB
Recipient Deposit: DJU7iPmejpGXAxAs3apWA7ZmWob33cnc3ebAZ7YQ5nxK
Delegated owners and allocations valid: true
Public Payment shell exposes private open state: false
Unauthenticated protected reads: all null
Vault collateral: 3.000000 test USDC
Proposed instructions: advance_payment, claim_payment
Proposed execution: atomic
Expected internal recovery: 1.000000 test USDC
Recipient signature required: false
Recipient Deposit required: false
SPL token movement: none; private accounting only
TEE authentication signed: false
Transaction signed: false
Transaction broadcast: false
```

The preflight deliberately cannot claim that the current private state is unchanged: that fact is hidden from unauthenticated readers by the permission boundary. The next separately approved checkpoint must authenticate the exact sender, validate the live Payment remains expired-but-`Created` with 1 test USDC escrowed, and run a signature-verified simulation proving `Created -> Expired -> claimed/redacted` plus sender available balance `2 -> 3` test USDC. Broadcast remains a further separate approval.

## Version-2.1 stalled-payment atomic recovery simulation

After explicit approval, the sender authenticated to MagicBlock's Query Filtering Service with a fresh wallet challenge. The guarded client retained the returned token only in memory, validated the exact authenticated identity, and fetched only the Payment and sender Deposit the sender is permitted to read. The recipient Deposit remained inaccessible to the sender.

The protected state matched the recorded failed-schedule outcome exactly: the Payment remained version 2 and `Created`, its task ID was unchanged, its immutable expiry was more than 10,000 seconds in the past, 1 test USDC remained in individual escrow, and the sender had 2 test USDC available with nothing in the legacy aggregate `locked` field.

The client signed one transaction containing `advance_payment` followed by `claim_payment` and submitted it only to `simulateTransaction` with signature verification enabled. The simulated advance changed `Created -> Expired`; the immediately following sender claim credited the exact escrow amount, zeroed the sensitive terminal terms, and stored the expected commitment. Because both instructions share one transaction, either both state changes persist or neither does.

```text
Private ER: https://devnet-tee.magicblock.app
Authenticated identity: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Payment: 83JoRQii6JKQV5hziNgrrpoYmrzTom8h25gSVWEGpjNK
Task ID: 1788965539251
Observed at: 1788976544
Expires at: 1788965841
Expired by: 10,703 seconds
Private status before: Created
Private Payment escrow before: 1.000000 test USDC
Instructions: advance_payment, claim_payment
Atomic transaction: true
Recipient signature required: false
Recipient Deposit included: false
Serialized transaction size: 298 bytes
Prepared, unbroadcast signature: 5YiL6jjE87DQZxZ89E2RczDjKxH9FgiuUsf1L91hrTbgieie7nPQZV1KHpcmnRdrQwsfnSwzikubj4NLwBTHSvDm
Signed simulation slot: 300863282
Signature verification: passed
Simulation error: none
Compute units consumed: 16,043
Payment status after simulation: Expired
Payment redacted after claim: true
Terminal commitment matches: true
Sender available: 2.000000 -> 3.000000 test USDC
Sender locked: 0 -> 0
SPL token movement: none; private accounting only
Protected amount or memo hash in logs: false
Private state persisted after simulation: false
Public state changed after simulation: false
Vault balance changed after simulation: false
Unauthenticated protected reads: all null
Bearer token printed or persisted: false
Hardware attestation independently verified: false
Transaction broadcast: false
```

The simulation proves the exact existing escrow can be recovered without recipient cooperation and without an intermediate partial state. A separate explicit approval is required to authenticate again, sign a fresh transaction, simulate those fresh wire bytes, and broadcast them to the Private ER.
