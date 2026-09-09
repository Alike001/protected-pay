# Phase 4 Local State-Machine Verification

Date: 2026-09-09

## Result

**LOCAL PASS / LIVE PENDING**

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

## Not yet proven

This artifact is not Devnet transaction evidence. Before Phase 5:

1. simulate the program upgrade and calculate exact Devnet rent/fees;
2. update the existing Config timing policy from the feasibility values to 60/300 seconds;
3. create and delegate a real Payment shell and recipient Deposit/permissions;
4. execute open, acknowledge, cancel, settle, and expiry through the authenticated Private ER;
5. prove a real five-run Crank task advances a Payment with both users offline;
6. re-run the unauthorized-read and public metadata audit for the Payment layout;
7. redact, commit/undelegate, and verify final public state before withdrawal.

No program upgrade or transaction was signed or sent during this local phase.

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
