# G0 — Toolchain And Upstream Baseline

Status: **passed**
Observed: 2026-09-08

## Local versions

- Node.js: `24.14.1`
- npm: `11.13.0`
- Yarn: `1.22.22`
- Rust/Cargo: `1.96.0`
- Solana CLI: `4.0.1`
- cargo-build-sbf: `4.0.0`
- installed Anchor CLI: `1.0.2`
- selected Anchor CLI: `1.0.2`

## Pinned reference

MagicBlock `starter-kits/private-payments-demo` was inspected at commit:

```text
8e6774276c77426b97852319dd40297dd650496d
```

Its dependency declarations are Anchor `0.31.1` and `ephemeral-rollups-sdk` `0.2.11`. Because those plain version requirements are not exact pins, a fresh resolution on 2026-09-08 selected SDK `0.2.12`; that version pulled Anchor `1.2.0` alongside Anchor `0.31.1` and Solana Program `4.1.0`, then failed inside the SDK on removed `solana_program` APIs. Protected Pay therefore pins Anchor and the SDK exactly and commits `Cargo.lock`. Verification commands must use `--locked`.

## Reproduction and result

The isolated upstream demo was given its missing local `session-keys` path and run with the installed Anchor CLI. The CLI warned about the `0.31.1` / `1.0.2` mismatch and stopped before program compilation with:

```text
Error: package section not provided
```

`avm use 0.31.1` could not install the requested CLI non-interactively. Direct `avm install 0.31.1` and isolated `cargo install anchor-cli --version 0.31.1 --locked` attempts were blocked by repeated registry/network timeouts.

## Current-stack decision

The unchanged older private-payments baseline is not reported as working. More importantly, its SDK line has no Crank module, so making it compile would not prove the mandatory automation path.

MagicBlock's current official `crank-counter` example instead uses Anchor `1.0.2` and SDK revision `0fc4604157de51df28693e02e5a1a6a4a08c8a03` with the `crank` feature. Protected Pay now pins that same revision and enables `anchor`, `crank`, and `access-control`. This stack exposes the current `MagicIntentBundleBuilder`, Hydra Crank CPI, and permission interfaces in one SDK.

Verified locally with the committed lockfile:

```text
cargo check -p protected-pay --lib --locked   PASS
cargo test -p protected-pay --lib --locked    PASS (7 tests)
cargo clippy -p protected-pay --lib --tests --locked -- -D warnings   PASS
```

The Solana SBF build also passes with platform-tools `v1.53`:

```text
NO_DNA=1 cargo build-sbf --skip-tools-install \
  --manifest-path programs/protected-pay/Cargo.toml \
  --sbf-out-dir target/deploy -- --locked

PASS: target/deploy/protected_pay.so (458,472 bytes)
SHA-256: ef73f2379919aad693798c52917a96fd4ad39c84f776ee6d4dd0c1c37f7c42be
```

Generated development program ID: `w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk`.

G0 passes. The host-side Anchor IDL build also passes and is recorded in the G1 artifact.

An earlier full `anchor build` attempt was stopped because Anchor 1.0.2 requested a redundant Solana platform-tools `v1.52` download after the program had already built with `v1.53`. The IDL was subsequently generated successfully with `anchor idl build`, which does not repeat the SBF build.

## Devnet deployment evidence

The exact verified SBF artifact was deployed to public Solana Devnet on 2026-09-08.

```text
Program ID:          w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk
ProgramData address: BXX67CiW14MVLku97gfUm4muQKwUc7uDsSrbC9qsYRAj
Upgrade authority:   6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Finalized slot:      495198793
Data length:         458,472 bytes
ProgramData rent:    2.3299166 Devnet SOL
Deployment signature: 4F5ANzeQk5AGmdLYzCYgdszmaCPDDCZdUJBbfrLVNLh41GBCBrXv2vSP1UkPeBS12usDYVB87g97XfPuBFvtUxKv
Local SHA-256:       ef73f2379919aad693798c52917a96fd4ad39c84f776ee6d4dd0c1c37f7c42be
Devnet SHA-256:      ef73f2379919aad693798c52917a96fd4ad39c84f776ee6d4dd0c1c37f7c42be
```

`solana confirm --commitment finalized --verbose` reported `Status: Ok` and the log `Deployed program w1uf...YDGk`. A subsequent `solana program dump` produced a byte-for-byte hash match with `target/deploy/protected_pay.so`.

The first upload attempt exhausted RPC retries after funding a temporary upgradeable-loader buffer. That exact buffer was inspected, closed by its recorded authority, and its `2.3299166` Devnet SOL was returned before the successful retry. No temporary recovery phrase is retained in this repository.
