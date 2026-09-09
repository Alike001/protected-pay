# G1 — Real Test-USDC Vault Round-Trip

Status: **G1 core pass condition met: real test-USDC round-trip, delegated private mutation, commit/undelegation, and replay rejection verified; expanded Devnet negative-case matrix pending**

## Deployment prerequisite

The program is live on public Solana Devnet at `w1ufT3tzJmo6AwLPUV67qXHGTCzUypT7B8RdHATYDGk`. Deployment finalized in slot `495198793` with signature `4F5ANzeQk5AGmdLYzCYgdszmaCPDDCZdUJBbfrLVNLh41GBCBrXv2vSP1UkPeBS12usDYVB87g97XfPuBFvtUxKv`. The downloaded on-chain bytecode and local SBF artifact both hash to `ef73f2379919aad693798c52917a96fd4ad39c84f776ee6d4dd0c1c37f7c42be`.

Deployment alone did not pass G1. The funded bootstrap described below created the Config, vault, Deposit, and Permission accounts and deposited 1 real test USDC. The complete delegated lock/unlock, commit/undelegation, and withdrawal sequence has now finalized. MagicBlock Crank remains the separate G2 risk.

The Anchor 1.0.2 host-side IDL build also passes. It generated an IDL containing the deployed program address and all 12 expected instructions.

```text
IDL JSON SHA-256: 8da759b6232c589f8c67b0e7f0ddb67b2e78ee43b62e629d58ec530b7a3a27b4
TypeScript SHA-256: f249d11d045a6550e014fe858ecdec49dafb6ba955f1bc9c4594bc7749c4157e
```

## Circle Devnet USDC prerequisite

The authority wallet's standard associated token account for Circle Devnet USDC was created and finalized, then funded with 20 test USDC from Circle's public faucet. The mint, Token Program owner, wallet owner, account lengths, initialization state, six decimals, and raw balance were independently validated before simulation.

```text
Wallet:              6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
USDC mint:           4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
Token program:       TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
Wallet USDC ATA:     5a1yoHwrpcLiTEo4MdDcqZ82C7AemH4p1A3jBh6bvDQU
ATA creation slot:   495201732
ATA creation tx:     4cz12vXPbvuNe1DzTgHLiYRWiQircBzyo8MWBiHhyE3BfX4JCYPKUoHRLCrwRowbC9cyCagrJ4hoMP8aAZYRVvSr
Faucet balance:      20 USDC (20,000,000 raw units)
Post-bootstrap:      19 USDC (19,000,000 raw units)
```

Deterministic Protected Pay addresses for this wallet/mint:

```text
Config PDA:          n7i13zNfTRnBzvB9q7CrkNP3CKZE6rZTFBrcb4cevYs
Vault PDA:           2ZdYUadAD4DLg9wYCFdWFwo1ogviVHuyeVoCtzub6hJF
Vault USDC ATA:      AuGcALKgp6TH1XH4GXpd9AV1m1wkWrZqRtJhbLTnXhNU
Deposit PDA:         5gUmsQ4sxHvWrKTvbt8Vn4mDzVNH3xAaC11Tarj7uehB
Permission PDA:      Hpd7CAgviskE8J2KuQq6DyGVjbuaTMN3zYbcYfgQHaJy
```

## Unsigned Devnet simulations

The read-only harness uses a Codama-generated, Kit-native client derived from the Anchor IDL. It holds no private key and exposes no send path. `npm run typecheck` passes and `npm audit` reports zero known vulnerabilities.

The atomic bootstrap + deposit + withdrawal simulation passed at Devnet slot `495216216`:

```text
RPC error:              null
Serialized size:        732 bytes
Compute units consumed: 96,417
Estimated fee:          5,000 lamports
Wallet USDC before:     20,000,000
Wallet USDC after:      20,000,000
Vault USDC after:       0
Vault liability after:  0
Deposit available:      0
Deposit locked:         0
```

Every Protected Pay instruction, SPL Token CPI, Associated Token CPI, and MagicBlock Permission Program CPI returned success. The decoded simulated Config binds the Circle mint, classic Token Program, authority, `300`-second safety window, `86,400`-second claim window, and validator `MTEW...3xzo` exactly as planned.

The exact funded-bootstrap transaction proposed for submission was separately simulated at Devnet slot `495216549`:

```text
RPC error:              null
Serialized size:        705 bytes
Compute units consumed: 79,133
Estimated fee:          5,000 lamports
Account rent:           8,498,840 lamports
Wallet USDC after:      19,000,000
Vault USDC after:       1,000,000
Vault liability after:  1,000,000
Deposit available:      1,000,000
Deposit locked:         0
```

These simulations preceded the real transaction. The funded-bootstrap half of the sequence has since been sent and independently verified below. They do not by themselves prove the remaining Private ER round-trip.

## Finalized funded bootstrap

The approved transaction finalized successfully on public Solana Devnet.

```text
Signature:              2mZkeCbRnCFpmaFvRrgevoUP8NSaocsxcnXpfJ7QdNLw8vSDq3FwGFaAemmJ4sF9TCX4nYPaKWfsTTRBEcEYg2xC
Finalized slot:         495222423
Block time:             2026-09-08T18:54:27+01:00
Status:                 Ok
Transaction fee:        5,000 lamports (0.000005 SOL)
Created-account rent:   8,498,840 lamports (0.00849884 SOL)
Fee-payer SOL before:   2.6577374 SOL
Fee-payer SOL after:    2.64923356 SOL
```

All six instructions and their CPIs succeeded:

1. Set compute-unit limit.
2. Initialize Config.
3. Initialize vault and its associated USDC token account.
4. Initialize the user's Deposit ledger.
5. Create the Deposit Permission through MagicBlock's Permission Program.
6. Transfer exactly 1 USDC into the vault and credit the Deposit ledger.

Rent by created account:

```text
Config:          1,432,560 lamports
Vault:             899,160 lamports
Vault USDC ATA:   1,488,440 lamports
Deposit:          1,148,080 lamports
Permission:       3,530,600 lamports
Total:            8,498,840 lamports
```

The read-only verifier fetched every account at finalized slot `495223982`, checked the account owners, exact data lengths, and Anchor discriminators, decoded the application state, and checked both SPL Token accounts:

```text
Config owner:             Protected Pay program
Allowed mint:             Circle Devnet USDC
Token program:            classic SPL Token Program
Safety window:            300 seconds
Claim window:             86,400 seconds
Private validator:        MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo

Wallet USDC:              19,000,000 raw units
Vault USDC:                1,000,000 raw units
Vault total liability:     1,000,000 raw units
Deposit available:         1,000,000 raw units
Deposit locked:                    0 raw units
Deposit next nonce:                0
Automation paused:             false

Permission owner:         ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1
Permission data length:   567 bytes
All verifier assertions:  passed
```

Reproducible read-only verification:

```sh
NO_DNA=1 npm run gate1:verify:bootstrap
```

At this checkpoint, the funded bootstrap proved that real Circle Devnet USDC could enter the program-controlled vault while the application ledger and vault liability remained exactly collateralized. The later sections complete the remaining round-trip.

## Unsigned delegation simulation

The next proposed transaction was constructed from the finalized funded state and simulated without a private key at Devnet slot `495238565`:

```text
RPC error:                     null
Serialized size:               733 bytes
Compute units consumed:        99,803
Estimated transaction fee:     5,000 lamports
New persistent-account rent:   4,795,520 lamports
Estimated total SOL cost:      4,800,520 lamports (0.00480052 SOL)

USDC moved:                    0
Vault USDC before/after:       1,000,000 / 1,000,000 raw units
Deposit available before/after:1,000,000 / 1,000,000 raw units
Deposit locked before/after:   0 / 0 raw units
```

The atomic transaction contains `delegate_deposit_permission` followed by `delegate_deposit`, both pinned to Private ER validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`. Simulation assigned both the Permission and Deposit accounts to MagicBlock's Delegation Program (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`) and created their delegation record and metadata PDAs. Temporary buffer PDAs ended with zero lamports and no data.

The approved transaction was subsequently signed, submitted, finalized, and independently verified.

## Finalized Private ER delegation

```text
Signature:               49267e1KvPxubbny2Gf2qRd4JjP6WS2W9kZBYgpy1RM2EeYHuftBtJiAcfzuqfaLrWhVefkHEufBgvJn2kPWGeMh
Finalized slot:          495242777
Block time:              2026-09-08T19:50:47+01:00
Status:                  Ok
Compute units consumed:  99,803
Transaction fee:         5,000 lamports
Persistent-account rent: 4,795,520 lamports
Total SOL spent:         4,800,520 lamports (0.00480052 SOL)
USDC moved:              0
```

Independent finalized-state verification at slot `495243624` proved:

- Permission and Deposit are both owned by MagicBlock's Delegation Program.
- Both Delegation Records name validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` and delegation slot `495242777`.
- Their recorded original owners are respectively the Permission Program and Protected Pay program.
- Permission and Deposit metadata contain their exact expected PDA seeds and rent payer.
- The temporary buffer PDAs were closed and did not persist.
- The public base-layer Deposit snapshot remains `available = 1,000,000`, `locked = 0`.
- Vault collateral remains exactly `1,000,000` raw USDC units.

Reproducible read-only verification:

```sh
NO_DNA=1 npm run gate1:verify:delegation
```

## Private lock preparation

An unsigned `lock_balance(250_000)` transaction has been constructed for the authenticated Private ER endpoint. Its intended effect is to change only delegated internal accounting from `available = 1,000,000, locked = 0` to `available = 750,000, locked = 250,000`; it contains no SPL Token instruction and cannot move the 1-USDC vault collateral.

The unauthenticated endpoint correctly returns `null` for the Deposit while returning the Permission account. It also redacts the unsigned simulation result (`0` compute units, no logs, and no returned Deposit state). Consequently, that response is **not** counted as a successful execution simulation. A wallet-signed challenge is required to obtain a free auth token and perform a meaningful authorized preflight before the private lock transaction can be proposed for signing.

The owner approved that off-chain authentication. A strictly validated Query Filtering Service challenge was signed for wallet `6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn`; the returned token remained in process memory, was not printed or stored, and was discarded when the process exited.

The authenticated read at Private ER slot `299219252` returned the Deposit with its original Protected Pay program owner and state `available = 1,000,000, locked = 0`. The authenticated unsigned simulation then passed at slot `299219282`:

```text
Instruction:             LockBalance
Internal amount:         250,000 raw units (0.25 USDC)
RPC error:               null
Compute units consumed:  4,053
Program result:          success
Simulated available:     750,000
Simulated locked:        250,000
SPL Token instructions:  none
USDC movement:           none
```

The official MagicBlock package's hardware-attestation verifier was not used because its current dependency graph introduces an invalid Solana Kit peer combination and low-severity cryptography advisories. Authentication used MagicBlock's documented HTTPS challenge flow, so hardware attestation remains an explicitly unproven layer in this checkpoint.

## Finalized private lock

The approved `lock_balance(250_000)` transaction was signed only after a fresh authenticated preflight returned the exact expected post-state.

```text
Private ER signature:       FkZ9epRuaywdb9cxRFeztDxPPRgu5YGcAn37QJEfadaMntR1drXfBHosYkm2CWYoUYJbVSbYdUUADnSEnXxz3ke
Finalized Private ER slot:  299226720
Status:                     Ok / finalized
Compute units:              4,053
Private available after:    750,000 raw units
Private locked after:       250,000 raw units
Public Deposit snapshot:    available 1,000,000 / locked 0
Public vault collateral:    1,000,000 raw USDC units
SPL Token movement:         none
```

The post-transaction verifier read the mutated Deposit through the authenticated Private ER RPC, independently read public Solana state, and repeated the unauthenticated Private ER query. The authenticated state showed `750,000/250,000`; the unauthenticated Deposit remained `null`; and public vault collateral remained exactly 1 USDC.

## Private unlock simulation

Using a fresh process-only auth token, an authorized read at Private ER slot `299229793` confirmed the real locked state (`available = 750,000`, `locked = 250,000`). An unsigned `unlock_balance(250_000)` simulation passed at slot `299229831`:

```text
RPC error:               null
Compute units consumed:  4,051
Program result:          success
Simulated available:     1,000,000
Simulated locked:        0
SPL Token instructions:  none
USDC movement:           none
```

This is the exact inverse of the finalized lock. The approved unlock transaction was subsequently signed, sent, finalized, and independently checked as described below.

## Finalized private unlock

The approved `unlock_balance(250_000)` transaction was signed only after a fresh authenticated preflight reproduced the exact expected recovery state.

```text
Private ER signature:       4vDs3HvnjsfwuhZDBgeyu9NCGJgzfAeA2UbbacsdmkLusfBjDTELWBEKp87Ms2yE5ZADwS4uyQv3ooVGzP39AxKM
Finalized Private ER slot:  299240778
Block time:                 2026-09-08T20:23:37+01:00
Status:                     Ok / finalized
Compute units:              4,051
Private available after:    1,000,000 raw units
Private locked after:       0 raw units
Public Deposit snapshot:    available 1,000,000 / locked 0
Public vault collateral:    1,000,000 raw USDC units
SPL Token movement:         none
```

An independent unauthenticated status query found the finalized signature and slot, while `getTransaction` returned empty account keys, instructions, logs, balances, and token balances. An unauthenticated Deposit read returned `null`. A separate finalized public-Solana verifier at slot `495254844` confirmed that the Deposit remains delegated, the base snapshot remains `1,000,000/0`, the vault still holds exactly 1 USDC, and no temporary delegation buffers persist.

At that checkpoint, the lock/unlock portion proved the first concrete human-recovery control: an owner can reverse a private reservation without moving collateral. The later commitment and withdrawal sections prove base-layer recovery.

## Commit and undelegate simulation

The next proposed action was constructed with the Codama-generated `commit_and_undelegate_deposit` instruction and simulated through an authenticated Private ER connection. Before building it, the harness validated the authorized private Deposit, the delegated public Deposit snapshot, and the public vault collateral.

```text
Authenticated private read slot:  299253693
Public Devnet read slot:           495258550
Simulation slot:                   299253751
RPC error:                         null
Compute units consumed:            33,595
Private state before:              available 1,000,000 / locked 0
Public snapshot before:            available 1,000,000 / locked 0
Vault collateral before:           1,000,000 raw USDC units
SPL Token instructions:            none
USDC movement:                     none
Transaction signed/sent:           no / no
```

The logs show the Protected Pay instruction invoking `Magic11111111111111111111111111111111111111`, scheduling Deposit `5gUmsQ4sxHvWrKTvbt8Vn4mDzVNH3xAaC11Tarj7uehB` for commit and undelegation, and returning success. The simulated post-account retained `1,000,000/0` accounting and used the Delegation Program owner as its transitional representation.

The simulated commit ID `126419` and simulated `ScheduledCommitSent` signature are deliberately not recorded as real settlement evidence: simulation cannot prove asynchronous base-layer commitment. A separate finalized public read at slot `495258676` confirmed that the real Deposit remained delegated and its commitment metadata was unchanged at that checkpoint. The approved real transaction subsequently finalized as described below.

## Finalized commit and undelegation

The approved transaction passed both unsigned and signed authenticated preflights before submission. The outer Private ER transaction finalized without error, and the separately generated base-layer settlement restored the Deposit to the Protected Pay program.

```text
Private ER signature:         5ipJxaeQsjUw3PqmkKqDkMwMTqt5t3ibEi2voZvd2JHmXrPAcSG7qFwEu17Zi7gNsGcB1chmLdoXYtDoXrhcMR1N
Finalized Private ER slot:    299261573
Base commitment signature:   oey3c5SvyzKy1spXNESNMk2mpT64Yy5vMa3AaRCBCHV2h58oWw2iLJJHMR7m7LKiQwA7uXWJwWZNZ4k4cdgkkPV
Finalized Devnet slot:        495260956
Block time:                   2026-09-08T20:40:57+01:00
Status:                       Ok / finalized on both layers
ER instruction compute:       33,595 units
Base settlement compute:      82,391 units
Base transaction fee:         33,800 lamports, paid by the Private ER validator
User rent refund:             2,179,040 lamports
USDC movement:                none
```

The original bounded sender timed out while waiting for its RPC-derived commitment status and deliberately did not resubmit. Independent public history then identified the only new finalized Deposit transaction after delegation. Its instructions and logs include the same Deposit, Private ER validator, Delegation Program, Protected Pay program, and `ProcessUndelegation`. This public transaction is therefore the real settlement proof, not a preflight-generated signature.

Finalized verification at Devnet slot `495262498` proved:

- Deposit owner restored from the Delegation Program to Protected Pay.
- Deposit Delegation Record and Delegation Metadata both closed.
- Committed state is `available = 1,000,000`, `locked = 0`, nonce `0`, automation unpaused, version `1`.
- Vault collateral remains exactly `1,000,000` raw USDC units.
- Permission remains delegated with its record and metadata intact.
- The unauthenticated Private ER no longer returns the undelegated Deposit.

Reproducible read-only verification:

```sh
NO_DNA=1 npm run gate1:verify:undelegation
```

## Final withdrawal simulation

After finalized undelegation, the exact proposed `withdraw_usdc(1_000_000)` transaction was simulated against public Devnet state. It transfers the original 1 test USDC from the program-controlled vault ATA back to the authority wallet's existing Circle-USDC ATA and reduces both internal Deposit accounting and aggregate vault liability to zero.

```text
Finalized pre-state slot:       495264178
Simulation slot:                495264214
RPC error:                      null
Compute units consumed:         17,435
Estimated fee:                  5,000 lamports
Wallet USDC before/after:       19,000,000 / 20,000,000 raw units
Vault USDC before/after:        1,000,000 / 0 raw units
Vault liability before/after:   1,000,000 / 0 raw units
Deposit available before/after: 1,000,000 / 0 raw units
Deposit locked before/after:    0 / 0 raw units
```

The simulation logs contain one successful Protected Pay `WithdrawUsdc` instruction and one successful classic SPL Token CPI. Nothing was signed or sent during this simulation checkpoint. The approved real withdrawal subsequently finalized as described below.

## Finalized withdrawal and replay rejection

The approved `withdraw_usdc(1_000_000)` transaction passed a fresh unsigned simulation and signed preflight before submission to public Solana Devnet.

```text
Signature:                    3vgEQBC5BNEJyx23QgkbZU8mQTFJ916184t83WRwHCK149CVySEqFuqoDK8rFuKRK4dSsaAbfKkdva3aeqp3Df92
Finalized slot:               495265948
Block time:                   2026-09-08T20:54:46+01:00
Status:                       Ok / finalized
Transaction fee:              5,000 lamports
Compute units consumed:       17,435
Wallet USDC before/after:     19,000,000 / 20,000,000 raw units
Vault USDC before/after:      1,000,000 / 0 raw units
Vault liability after:        0
Deposit available after:      0
Deposit locked after:         0
```

An independent read-only verifier at finalized slot `495266546` re-fetched the transaction, Deposit, Vault, wallet ATA, vault ATA, Permission, and delegation PDAs. Every owner, length, mint, authority, balance, transaction-status, and conservation assertion passed. The wallet's Circle test-USDC balance exactly returned to its original 20-USDC value; only SOL transaction fees were spent by the wallet during the overall lifecycle.

Immediately after finalization, an unsigned attempt to withdraw the same `1,000,000` raw units again failed at instruction index `1` with Protected Pay error `6003`, `InsufficientAvailable`. No second transaction was signed or sent and no account state changed.

Reproducible final-state verification:

```sh
NO_DNA=1 npm run gate1:verify:final-roundtrip
```

This meets G1's core pass condition with real Circle Devnet test USDC: exact deposit, delegated private mutation, reversal, commitment, exact withdrawal, zero residual liability, and replay rejection. The broader wrong-mint, wrong-vault, wrong-owner, underflow, overflow, and locked-withdrawal matrix remains covered locally and should still be repeated against Devnet where practical before submission.

## Local preparation

The clean-room program now implements a single-mint Config with a fixed Private ER validator, vault PDA plus exact vault ATA, per-user Deposit PDA, checked `available`/`locked` accounting, aggregate vault liability, current Permission Program creation and delegation CPIs, owner-authorized Deposit delegation, current intent-bundle commit/undelegation, and base-layer SPL Token `transfer_checked` deposit/withdrawal.

On the current Crank-capable MagicBlock stack, `cargo check --locked` and seven unit tests pass. Tests cover liability conservation, locked-fund withdrawal rejection, zero amounts, insufficient balance, arithmetic overflow, failed-operation state preservation, and aggregate vault-liability changes. This is preparation only; it does not pass G1 without the real Devnet sequence below.

Required proof sequence:

1. Use Circle's Solana Devnet USDC mint (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals).
2. Record sender token account and vault token account balances.
3. Deposit an exact raw amount into the program-controlled vault.
4. Create the Deposit permission, delegate it to the approved Private ER, and confirm its owner changed as expected. **Complete.**
5. Lock and unlock part of the internal balance on the ER; prove vault collateral did not move. **Complete.**
6. Commit and undelegate the Deposit. **Complete.**
7. Withdraw the exact original amount to the same owner. **Complete.**
8. Prove final vault and internal liability are zero and a repeated withdrawal fails. **Complete.**
9. Record wrong-mint, wrong-vault, wrong-owner, locked-withdrawal, underflow, and overflow failures.

This file must be filled with real addresses, signatures, commands, and decoded pre/post account state. Local fixtures and screenshots alone do not pass G1.
