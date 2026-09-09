# G2 — Crank Mutates Private Delegated State

Status: **PASSED on Devnet; autonomous terminal state committed and undelegated successfully**

Pass condition: the official MagicBlock Crank invokes an idempotent program instruction while the Payment and required Deposit accounts are permissioned and delegated. The browser and a local cron process must be offline during the terminal transition.

Evidence must include the task identifier, schedule, target instruction/account set, ER transaction signature or receipt, decoded before/after state, retry result, and proof that no client-selected financial term was accepted by the scheduled instruction.

## Devnet execution log

- Program upgrade finalized at slot 495473470, signature 5Hjq4wUk5yK8p4Jo78hGaSgrTAxyUCrmj57mjaF5bCAfnQm47Cr8A2qiERqWkL75YbYJS7qi6G86dWpbLPnERVsH.
- Independent onchain dump: 482,376 bytes, SHA-256 2bf5049c5a5b9d0d4af485a35069a9d314d050ac4fce4fecd6343da42c6be313, an exact local match.
- Gate 2 bootstrap finalized with signature tNVXQeN4mazy1V9AwrxGYsQ1NyKdGB4Vtw9G73PQVkq6xVJoCYr6gyo8LX6uKx3hK1ZHQnNXxyQc51jddqNvaNC.
- Finalized bootstrap state: CrankProbe AGwR6YfS8859XuWf1eg4d4dCcx7Jhu9kJDQ36t9pTEj5 was Pending, linked to the expected Deposit, with task ID 0 and transition count 0.
- Gate 2 delegation finalized with signature 5Vn55rtjtPkUG46RtBqEXauuGKUTprJa4PpsqpAXgjPGoQuS79m45HBGY6xa7cK6UEy2ecg8LPj6AEeJLaimPy89.
- Finalized owner verification at slot 495478410 proved both state accounts and both Permission accounts are owned by MagicBlock Delegation Program; all records and metadata exist and transient buffers are absent.
- Gate 2 TEE authentication succeeded for authority `6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn`; the bearer token remained process-only and was neither printed nor stored.
- Authenticated Private ER read at slot 299999664 returned the 98-byte Deposit and 99-byte CrankProbe under Protected Pay, plus both 567-byte Permission accounts under MagicBlock Permission Program.
- Pre-schedule private state was Deposit available 0, locked 0, payment nonce 0; CrankProbe Pending, task ID 0, transition count 0, deadline 1788931901.
- Schedule simulation passed at Private ER slot 299999699: 344-byte transaction, 13,900 compute units, no error. MagicBlock accepted task ID 1788931901 with a 1,000 ms interval and 3 iterations.
- Simulated post-state changed only CrankProbe task ID from 0 to 1788931901. Status remained Pending, transition count and Deposit payment nonce remained 0, and no USDC moved. The transaction was not signed or submitted.
- Scheduler registration finalized on the Private ER at slot 300005906 with signature `4YCD7bUdsM6QEyCWjCti191ATmaqH5EvwC53DzdHj5Rzo3GMNga2zstsJazRLpmrM1W8WQ77Mdjxu7u2HQkAe2gK`.
- MagicBlock executed all three scheduled iterations without the user signer:
  - slot 300005907, signature `22J8Qnjg6vCKaakAxc9NoKb3PMJ1kCY34EBy6VZRyeo1EnRiePqtAp7GsESCKFxJED22GJ69sAGdX4dapH2z1GnB`
  - slot 300005927, signature `4ePZyLa8DuPrU9Mv6no99NsW8zK2u2c5g5V5jGLgJ2sVKKSzgwt9v1eyjRAEpXB4ajWTWuXNDbpUUqagmwRBv5AD`
  - slot 300005947, signature `2gLZLPwk617gXnBwJPcKruvw6HVR5SNxLLX29W7aC9S9ydeQcxrr3EkkcBseGnkkmxXQsCFXyEfgoafcNAike7wR`
- Each autonomous transaction was paid and signed by validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`; the user authority was absent from their required signer sets.
- Authenticated verification at Private ER slot 300012639 showed CrankProbe task ID 1788931901, status Advanced, transition count 1, and Deposit payment nonce 1. Because three executions succeeded but the counters increased exactly once, the two retries were idempotent no-ops.
- Public verification at finalized Devnet slot 495488174 still showed the pre-delegation snapshot: CrankProbe Pending with task ID 0 and transition count 0; Deposit payment nonce 0. The private terminal values were therefore not exposed on the base layer before commit.
- Honest privacy boundary: authority and protected-account addresses, delegation/validator metadata, and pre-delegation account contents remain public. Only post-delegation state changes were hidden in this proof.
- No amount, recipient, destination, or financial action was accepted by the scheduled target, and no USDC moved.
- The completed private terminal state was committed and undelegated through Private ER transaction `4JQmsfHUW8JxaTQ7gVVkwQLbQk9vyk9CVuvjvKamnn7XQ4ma6DqChvJwi9E2boCVjecQdT2HUPN8uRRvyuq3FsCy` at slot 300036129. The ER emitted scheduled-commit receipt `Cp31gU4z8Y6hEn6jZYNXYBsUbrEjyN93VBYVgqLCk47KTFtAFDswx54t7QBJKtGLNycxB4S1ycwMiLtDNUq2hhC`.
- Public Solana processed the two-account undelegation in transaction `5RVFFa6a1npPbR5zfsQK5zNB97yg8QtezuyDkKT3PfYq98RsJt6SisdX5dMcDCsdynMnCySRKhmexhnZbXQVutKF`, finalized at slot 495494615.
- Final public state preserves the Crank result exactly: task ID 1788931901, status Advanced, transition count 1, and Deposit payment nonce 1. Both balances remain 0 and no USDC moved.
- Both state delegation Record and Metadata pairs are closed. The two Permission accounts were not part of the state commitment and remain delegated.

## Prepared implementation

The program now contains a deliberately small payment-shaped automation proof:

- `CrankProbe` links one owner to the existing `Deposit`, records a deadline and task ID, and starts `Pending`.
- `schedule_crank_probe` stores a fixed `advance_crank_probe` instruction with MagicBlock Crank. The stored instruction contains only the linked `CrankProbe` and `Deposit` addresses. It accepts no amount, recipient, destination, or user-selected financial action.
- `advance_crank_probe` is signer-free, deadline-gated, relationship-checked, and idempotent. Its one terminal transition changes the probe to `Advanced` and increments `Deposit.next_payment_nonce` exactly once; later retries are no-ops.
- Both mutable accounts and both MagicBlock Permission accounts are intended to be delegated to the configured Private ER before scheduling.
- The read-only public Config account was intentionally removed from the ER scheduling path. The scheduler carries only the delegated private state required by the target.

The current official `magicblock-engine-examples/crank-counter` example at commit `e137826af4969d538ef10d8f672a8d77deb6e194` uses the legacy `ScheduleCrankCpi` wrapper. The pinned SDK marks that wrapper deprecated in favor of Hydra `CreateCrankCpi`. For this feasibility run, Protected Pay constructs the exact same `MagicBlockInstruction::ScheduleTask` wire instruction directly from `magicblock-magic-program-api` instead of enabling the SDK's broad `crank` feature. This avoids linking unused Hydra client code while preserving the official example's scheduling protocol; Hydra migration remains product follow-up work.

## Local verification

- `cargo check --locked`: passed
- `cargo test -p protected-pay --lib --locked`: 10 passed, 0 failed
- `npm run idl`: passed
- `npm run client:generate`: passed
- `npm run typecheck`: passed
- SBF build with the installed Solana `v1.53` compiler: passed
- Built binary: 482,376 bytes
- Built binary SHA-256: `2bf5049c5a5b9d0d4af485a35069a9d314d050ac4fce4fecd6343da42c6be313`
- Release features: `no-log-ix-name,no-idl`; the IDL remains generated off-chain

The local `cargo-build-sbf 4.0.0` automatic Rustup-name path panics because the installed Solana Rust compiler reports an unknown commit hash. The successful reproducible workaround is:

```bash
NO_DNA=1 RUSTUP_TOOLCHAIN=1.89.0-sbpf-solana-v1.53 \
  cargo-build-sbf --skip-tools-install --optimize-size \
  --features no-log-ix-name,no-idl \
  --manifest-path programs/protected-pay/Cargo.toml
```

## Devnet upgrade preflight

- Program: `w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk`
- Upgrade authority and fee payer: `6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn`
- Current onchain binary: 458,472 bytes, SHA-256 `ef73f2379919aad693798c52917a96fd4ad39c84f776ee6d4dd0c1c37f7c42be`
- Required automatic extension: 23,904 bytes
- Approximate permanent additional program rent: 0.12143232 SOL
- Approximate temporary upload-buffer rent: 2.45130828 SOL, refundable after a successful deployment
- Current authority balance at preflight: 2.64660708 SOL
- Estimated peak requirement before fees: 2.5727406 SOL, leaving approximately 0.07386648 SOL for fees
- Asset movement: no USDC or vault liability movement; only Devnet SOL deployment rent and fees

The approved 2 SOL, 1 SOL, and 0.1 SOL CLI faucet requests were all rate-limited; no faucet funds arrived. The upgrade, bootstrap, and delegation stages above are finalized; scheduler registration has not yet been submitted.
