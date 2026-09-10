# Phase 5 Devnet balance-return signed simulation

Date: 2026-09-10

## Scope

This checkpoint authenticated the configured sender to the MagicBlock Devnet TEE,
signed a `commit_and_undelegate_deposit` transaction, and simulated it with
`sigVerify: true` and `replaceRecentBlockhash: false`.

It did not broadcast the transaction. The harness rejects `--send` and contains
no `sendTransaction` call.

## Validated pre-state

- Sender / fee payer: `6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn`
- Deposit: `5gUmsQ4sxHvWrKTvbt8Vn4mDzVNH3xAaC11Tarj7uehB`
- Mint: Circle Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Private owner: Protected Pay program
- Private balance: `2,000,000` raw units (2 USDC) available, `0` locked
- Public owner: MagicBlock Delegation Program
- Public delegated snapshot: `3,000,000` raw units (3 USDC) available, `0` locked
- Deposit size, discriminator, user, mint, and version were validated before decoding.

The different public and private amounts are expected while delegated and
demonstrate that the base layer has a stale snapshot. A real return would commit
the current aggregate 2 USDC balance publicly.

## Signed simulation result

- Prepared signature: `26nnKbKTnSH9Mk6SaL38t6J4f7nFULKoP2yTpkD3cbLG6tygFrd9dq6rAzjSR3pxf3o6XtBCyoKpPxoTRFRvpimV`
- Private ER simulation slot: `301375646`
- Result: `err: null`
- Compute consumed: `38,837` units
- Returned owner: MagicBlock Delegation Program
- Returned balance: `2,000,000` raw units available, `0` locked
- USDC movement: none
- Broadcast: false

The simulation logs validated the Protected Pay parent program, the exact
Deposit scheduled for undelegation, the Magic program invocation/success, and
Protected Pay program success. The TEE bearer token was held only in process and
was neither printed nor persisted.

## Remaining limitation

Simulation proves transaction construction, the authorized signature, signature
verification, accounting preservation, and the Private ER execution path. It
does not prove asynchronous base-layer settlement; that requires a separately
approved broadcast followed by finalized public verification.
