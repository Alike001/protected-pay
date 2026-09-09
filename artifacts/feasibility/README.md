# Feasibility Evidence

This directory records reproducible evidence for Protected Pay's technical go/no-go gates. A gate passes only when its artifact contains the exact commands, cluster, program and account addresses, transaction signatures, pre/post state, and negative-test results.

- `g0-baseline.md`: local toolchain and upstream starter baseline
- `g1-vault-round-trip.md`: real Circle Devnet test-USDC deposit/private mutation/withdrawal
- `g2-crank-private-state.md`: MagicBlock Crank mutation of permissioned delegated accounts
- `g3-privacy-audit.md`: observable metadata and committed-state audit

No empty template or mocked transaction is evidence that a gate passed.
