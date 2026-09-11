# Phase 5.1 — Browser Payment Receipt Capture

Status: PASS — implemented, locally verified, and exercised with a live Devnet protected-payment/Undo round trip.

Protected Pay now retains a sanitized receipt after each successful private payment action: protected open, sender Undo, expired sender recovery, recipient acknowledgement, and recipient claim. Records are namespaced by connected wallet, validated on every read, ordered newest-first, and capped at 20 entries.

The receipt schema includes only the action, raw amount, counterparty, occurrence time, Payment account, payment reference, private transaction signature, optional related public transaction signature, role, wallet, and schema version. It cannot serialize the session signer, wallet key, authentication token, encrypted memo envelope, or plaintext note. Activity shows the captured result after reload, and Technical proof exposes the full private signature and Payment address with copy controls.

## Verification

- `npm run p5:verify:payment-receipts` proves schema validation, deterministic upsert, newest-first ordering, the 20-record bound, and omission of injected plaintext/secret fields.
- `npm run p5:verify:frontend-recovery` still passes the existing checkpoint and recovery safety matrix.
- `npm run typecheck` and `npm run build:web` pass.
- Rendered Chromium checks at 1366×900 and 390×844 confirm the receipt appears in Activity and Technical proof, the drawer has no horizontal overflow, and no console or page errors occur.

## Live Devnet evidence

Wallet `4C2GznkXgEp2EhcXkPyBQh9feYvAkCcN2bWDrGjbkwvR` opened a `0.01` test-USDC payment to `Hfo7LD2FQk6o1uTiVMXvcfvuw9NT1J1qdQSZP9aG3qvQ`, then immediately used its bounded session to Undo it. The browser showed the exact protected-balance sequence `1 -> 0.99 -> 1` and retained both **Payment protected** and **Payment undone** rows in Recent activity.

- Session Token creation: `iakYywNMdWrACrEt3dR2Ey5xU1uCienZrnf4jep2SJE6FMNaCaHXMafCjNp4GKu1Fq6sZXdkXT6wXgfwbiKHKHg`, finalized at public Devnet slot `496536507`.
- Public Payment preparation/delegation: `P2Jzum4vNt2Lfqhs6XvySWji5S2wRzVCuJ8vPjyCqqz5DpViBN1TReHumyxb9gRt3qGYHXffwkmcR9hrpr7FfQ3`, finalized at public Devnet slot `496537428`.
- Payment account: `2psoEtLrWyuwgJeAX1s4L9ATwv27Kz1YzvXRBtbn66n5`.
- Session-signed private Undo: `kLoqrck2mbd1z6X1y6LaYWT9GEG2qkevMfqXvmcorVP7jzf75LZmRBXiAhyYd6igbDd4vC52PsRykwjjLjPwrdf`, finalized without error at Private ER slot `303508074`.

The live receipt appeared in Technical proof and its copy control returned the same complete signature and Payment address. An independent unauthenticated Private ER lookup confirmed finalization but returned empty account keys, instructions, logs, and balances. A finalized public read found the 245-byte Payment shell still owned by the Delegation Program. Independent SPL reads returned exactly `4` test USDC in both public vault `AuGcALKgp6TH1XH4GXpd9AV1m1wkWrZqRtJhbLTnXhNU` and wallet ATA `GhVfyTgi5GnNrSUCVY4PPWkLGC52J1cS8vSN3tDd9Eqb`, proving that the private lock/Undo did not move public custody.

The earlier live expired-payment recovery happened before this feature existed, and its helper discarded the returned private signature. That historical signature cannot be reconstructed honestly, but the new live round trip now proves the receipt-capture mechanism end to end.
