# G3 — Permission And Commitment Privacy Audit

Status: **NARROW PASS; unrelated-wallet denial and the corrected Payment's complete pre-commit through public post-commit field boundary are proven, while independent hardware attestation remains a separate check**

The product's claim is deliberately narrow: only state transitions performed after delegation inside an authenticated Private ER may be described as private. Funding, withdrawal, wallet-to-Deposit linkage, permission membership and capabilities, account addresses, the pre-delegation balance snapshot, transaction timing, and committed terminal data are observable or may become observable and must be disclosed.

## Observed public bootstrap state

At finalized Devnet slot `495240265`, an ordinary unauthenticated Solana RPC read exposed all of the following:

- authority wallet `6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn`;
- permissioned Deposit `5gUmsQ4sxHvWrKTvbt8Vn4mDzVNH3xAaC11Tarj7uehB`;
- Circle Devnet USDC mint;
- Deposit `available = 1,000,000`, `locked = 0`, nonce, and pause state;
- vault collateral of `1,000,000` raw USDC units;
- Protected Pay program membership in the Permission account;
- user membership and all five enabled capability flags: authority, transaction logs, transaction balances, transaction messages, and account signatures.

The Permission account was decoded as 567 allocated bytes with 105 meaningful serialized bytes and zero nonzero padding bytes. It contains two public members:

```text
Protected Pay program: flags 0
Authority wallet:      flags 31
```

Therefore the bootstrap hides nothing, does not provide sender anonymity, and publicly links the wallet, Deposit, token mint, and funded balance. The defensible claim is:

> Protected Pay restricts access to subsequent payment-state transitions while those delegated accounts execute inside MagicBlock's authenticated Private ER. It does not hide onchain funding, wallet membership, initial balances, delegation timing, or eventual committed state.

Reproducible read-only audit:

```sh
NO_DNA=1 npm run gate3:audit:bootstrap
```

MagicBlock's current Private ER documentation describes Permission Program authorization and the deposit/delegate/private-transfer/undelegate lifecycle. The deployed program is pinned to `ephemeral-rollups-sdk` revision `0fc46041` (crate version `0.16.0`), whose Permission layout and capability flags match the observed bytes.

The audit must inspect, from an unrelated wallet and public RPC:

- configuration, vault, and token accounts;
- Deposit and Payment accounts before delegation, during delegation, and after commitment;
- permission group and membership metadata;
- transaction instructions, logs, account lists, and timing;
- whether the committed byte layout reveals balances, participants, amount, memo, or status;
- authorized versus unauthorized Private ER reads.

This is only the first G3 measurement. G3 remains open until unauthorized and authorized Private ER RPC reads are tested and the exact post-commit bytes are audited. If those tests reveal more than the claim allows, the design or the claim must change before submission. A frontend blur effect is not privacy evidence.

## Observed state after delegation

The real delegation finalized in slot `495242777`. Public Solana RPC still exposes the last base-layer Deposit snapshot (`available = 1,000,000`, `locked = 0`), both delegation records, the validator identity, original account owners, delegation slot, rent payer, and the PDA seeds used for both protected accounts. In particular, the Deposit metadata publicly identifies seed categories corresponding to the authority wallet and USDC mint.

An unauthenticated request to `https://devnet-tee.magicblock.app` returned the full delegated Permission account, including membership and capability flags, but returned `null` for the protected Deposit account. This is encouraging access-control evidence, but one request is not sufficient to pass G3: it must be repeated against the live mutated state from an unrelated authenticated wallet and compared with an authorized read.

The endpoint's authentication mechanism is a free challenge-response flow, not a paid API key. The challenge explicitly identifies the Query Filtering Service, timestamp, and wallet public key. Obtaining the bearer token requires an off-chain wallet message signature; it does not submit an onchain transaction or move funds. Tokens must never be committed to this repository or printed in evidence logs.

The authorized comparison was run with the Deposit owner's wallet. At Private ER slot `299219252`, the authenticated request returned the full Deposit state (`available = 1,000,000`, `locked = 0`) while the prior unauthenticated request returned `null`. An authenticated simulation of `lock_balance(250_000)` returned the expected private post-state (`available = 750,000`, `locked = 250,000`) and successful program logs; the same simulation was redacted when unauthenticated.

This proves the owner-versus-unauthenticated distinction for the current delegated Deposit. It does not yet prove denial to an unrelated but authenticated wallet, and it does not prove independent TEE hardware attestation. Both remain open G3 checks.

## Observed finalized private mutation

Private ER transaction `FkZ9epRuaywdb9cxRFeztDxPPRgu5YGcAn37QJEfadaMntR1drXfBHosYkm2CWYoUYJbVSbYdUUADnSEnXxz3ke` finalized at Private ER slot `299226720`. The authenticated owner read showed `available = 750,000, locked = 250,000`, while the public Solana Deposit remained at its pre-delegation `1,000,000/0` snapshot.

An unauthenticated observer can discover the transaction signature, finalized status, slot, and block time. The same observer's `getTransaction` response is redacted to empty account keys, instructions, balances, token balances, inner instructions, and logs, and its Deposit `getAccountInfo` response remains `null`. Therefore timing and transaction existence are public, but the tested instruction and resulting private balance are not returned through the unauthenticated RPC path.

The inverse recovery transaction `4vDs3HvnjsfwuhZDBgeyu9NCGJgzfAeA2UbbacsdmkLusfBjDTELWBEKp87Ms2yE5ZADwS4uyQv3ooVGzP39AxKM` finalized at Private ER slot `299240778`. Its authorized post-state returned to `available = 1,000,000, locked = 0`; public Solana still exposed only the unchanged pre-delegation snapshot and 1-USDC vault collateral.

The unauthenticated observations were repeated after this second real mutation. They again exposed only the signature, finalized status, slot, and block time. The transaction response contained no account keys, instructions, logs, balances, token balances, or inner instructions, and the Deposit account response remained `null`. This repeat supports the narrow privacy claim for both directions of the lock/unlock lifecycle. It does not establish sender anonymity, hide timing, prove denial to an unrelated authenticated wallet, attest the TEE hardware, or say anything yet about the eventual committed state.

## Observed state after commitment

Private ER transaction `5ipJxaeQsjUw3PqmkKqDkMwMTqt5t3ibEi2voZvd2JHmXrPAcSG7qFwEu17Zi7gNsGcB1chmLdoXYtDoXrhcMR1N` finalized at ER slot `299261573`. Its unauthenticated transaction response exposes the signature, status, slot, and block time but redacts account keys, instructions, logs, balances, and token balances, consistent with the earlier private mutation observations.

The resulting public Solana commitment `oey3c5SvyzKy1spXNESNMk2mpT64Yy5vMa3AaRCBCHV2h58oWw2iLJJHMR7m7LKiQwA7uXWJwWZNZ4k4cdgkkPV` finalized at Devnet slot `495260956`. Unlike the ER response, this public transaction reveals the Private ER validator, authority wallet, Deposit, Delegation Program, Protected Pay program, delegation-related accounts, instruction data, logs, balances, timing, and the `ProcessUndelegation` operation.

After commitment, the complete 98-byte Deposit is publicly readable and decodes to:

```text
User:                  6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Token mint:            4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
Available:             1,000,000 raw units
Locked:                0 raw units
Next payment nonce:    0
Automation paused:     false
Version:               1
```

The Deposit Delegation Record and Metadata are closed, while the Permission and its delegation metadata remain public and delegated. The unauthenticated Private ER Deposit read returns `null` after undelegation.

This confirms the project's deliberately narrow claim: intermediate delegated transitions were access-controlled, but the committed terminal Deposit is public in full. The current Deposit layout contains no memo, recipient, payment identifier, or payment status, so commitment does not reveal those fields in this feasibility model; it does reveal the owner, mint, and complete terminal balance/accounting state. A future Payment account must either remain delegated or redact sensitive terminal fields before it is committed.

## Gate 2 scheduled-state audit

The audit was repeated while the real Gate 2 Crank terminal state remained delegated. At public Devnet slot `495491601`, all four protected accounts were owned by the Delegation Program. Both public 567-byte Permission snapshots exposed the same two members:

```text
Protected Pay program: flags 0
Authority wallet:      flags 31 (authority, logs, balances, messages, signatures)
```

All four delegation records and metadata accounts were publicly discoverable. The base layer still exposed the stale pre-delegation state: CrankProbe `Pending`, task ID `0`, transition count `0`; Deposit payment nonce `0`. It did not expose the Private ER terminal values: CrankProbe `Advanced`, task ID `1788931901`, transition count `1`; Deposit payment nonce `1`.

At unauthenticated Private ER slot `300026279`, both Permission accounts remained readable but both protected state accounts returned `null`. The known scheduler transaction exposed its signature, slot, block time, and success, but returned zero account keys, zero instructions, and zero logs.

An unrelated local wallet `HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr` then completed the same short-lived TEE challenge-response authentication. At Private ER slot `300026694`, it could still read the public Permission accounts but could not read either protected state account. This proves that possession of a valid authentication token alone does not grant access; membership in the Permission account is enforced.

No bearer token, challenge, authentication signature, or private key was printed or stored in the evidence.

## Gate 2 commit/undelegate simulation and execution

The proposed `commit_and_undelegate_crank_probe` transaction passed authenticated simulation at Private ER slot `300026979`:

- serialized transaction size: 353 bytes;
- compute units consumed: 46,504;
- required signer and fee payer: the protected owner;
- committed accounts: CrankProbe and Deposit only;
- Permission accounts committed: no;
- SPL Token instructions: none;
- USDC movement: zero;
- transaction signed or submitted: no.

The simulation preserved the terminal values exactly and predicted that submission would publish the complete CrankProbe and Deposit byte layouts, including owner/deposit linkage, deadline, task ID, terminal status, transition count, owner wallet, USDC mint, balances, nonce, and pause flag. It also predicted disclosure of the public commit transaction's account list, instruction data, logs, timing, and validator relationship.

The transaction was subsequently approved and submitted. Private ER transaction `4JQmsfHUW8JxaTQ7gVVkwQLbQk9vyk9CVuvjvKamnn7XQ4ma6DqChvJwi9E2boCVjecQdT2HUPN8uRRvyuq3FsCy` finalized at ER slot `300036129` and emitted scheduled-commit receipt `Cp31gU4z8Y6hEn6jZYNXYBsUbrEjyN93VBYVgqLCk47KTFtAFDswx54t7QBJKtGLNycxB4S1ycwMiLtDNUq2hhC`.

Public Solana transaction `5RVFFa6a1npPbR5zfsQK5zNB97yg8QtezuyDkKT3PfYq98RsJt6SisdX5dMcDCsdynMnCySRKhmexhnZbXQVutKF` processed both undelegations and finalized at slot `495494615`. It publicly exposes the authority, validator, Protected Pay program, Deposit, CrankProbe, delegation records/metadata, instruction execution, logs, and timing. Afterward:

```text
CrankProbe owner:           Protected Pay program
Task ID:                    1788931901
Status:                     Advanced
Transition count:           1
Deposit owner:              Protected Pay program
Next payment nonce:         1
Available / locked:         0 / 0
State delegation records:   closed
State delegation metadata:  closed
Permission accounts:        still delegated
USDC moved:                 0
```

This real commitment matches the predicted disclosure exactly. The intermediate scheduled-commit receipt is not itself a public Solana transaction signature; the independently observable public transition is the `ProcessUndelegation` transaction above.

## Gate decision

The feasibility result is **NARROW**, not an absolute-privacy result:

- real USDC custody and withdrawal work;
- a real MagicBlock Crank can mutate protected delegated state without the user online;
- unauthenticated and unrelated authenticated readers are denied the protected state;
- permission membership, delegation metadata, addresses, timing, pre-delegation state, and eventual committed terminal state are public.

Protected Pay may proceed only with language such as **“private while pending inside the authenticated Private ER”**. It must not claim anonymous payments, hidden wallet relationships, hidden funding, hidden timing, or permanent confidentiality after commitment. The feasibility result required a fresh field-by-field audit of the production-shaped Payment before submission; that corrected-layout audit and redacted public commitment are recorded below. Raw memos must never be committed.

## Corrected version-2.1 Payment audit

The future-layout requirement above is now satisfied for the live version-2.1 expiry fixture. A read-only audit at finalized Devnet slot `495834477` decoded the 245-byte public Payment shell, 567-byte Payment Permission, both delegation records and metadata accounts, the two delegated Deposit shells, and the 3 test-USDC vault. It also repeated unauthenticated Private ER reads and constructed the exact terminal closeout transaction without loading a keypair.

The public pre-delegation Payment shell reveals:

```text
Payment:        AvZwmKkHPvrTHk3qyYCeuTAg2jSSrYM9tLEm4gKUD759
Payment ID:     759c4e3fbf3ad9a11c1797e1db3f7e27d0cc4110956e07e0d10aaf1dd005b4a0
Sender:         6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Recipient:      HfoFUr4dJWHFR4cPBPoyJpABZzNuQ5DoPMdgGsvKkRMr
Mint:           Circle Devnet test USDC
Amount/times:   zero
Status:         Created
Initialized:    false
Redacted:       false
Version:        2
```

The public Payment Permission has three members: the Protected Pay program with flags `0`, the sender with all five capability flags (`31`), and the recipient with all five flags (`31`). Its 138 meaningful bytes are followed only by zero padding. Both public delegation records identify validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`; metadata exposes PDA seeds, rent payer, delegation slot `495794202`, and the account topology. The base layer therefore already reveals the sender-recipient relationship. Protected Pay must not claim anonymous counterparties.

The unauthenticated Private ER returned `null` for the Payment and both Deposit accounts while leaving the public Permission readable. Its unauthenticated view of the known sender recovery transaction exposed only the signature, slot, block time, and successful status; it returned zero account keys, instructions, logs, pre-balances, and post-balances. This verifies that amount, memo hash, live state and deadlines, task ID, and user balances remain protected through this RPC boundary while delegated.

The prepared `commit_and_undelegate_payment` transaction is 320 bytes and requires only the sender as fee payer/signer. It contains no SPL Token instruction, moves no USDC, and commits only the already-redacted Payment. It does not include either aggregate Deposit or the Payment Permission. Based on the independently verified private terminal bytes, commitment is expected to publish sender, payment ID, mint, `Expired` status, initialization/redaction/version fields, and the terminal commitment. Recipient, amount, memo hash, timestamps, task ID, and both aggregate balances should remain absent.

Reproducible no-sign audit:

```sh
NO_DNA=1 npm run p4:v21:preflight:closeout
```

No keypair was loaded, no authentication message or transaction was signed, and no transaction was broadcast.

### Authenticated terminal-closeout simulation

After explicit approval, the sender authenticated to the Private ER and signed the terminal closeout for signature-verified simulation only. The 320-byte transaction succeeded at Private ER slot `301175477`, consumed 39,402 compute units, produced the expected scheduled-commit receipt, and returned the Payment under the transitional Delegation Program owner. Its 245 data bytes were identical to the verified redacted terminal state: `Expired`, zero escrow and sensitive fields, and the exact terminal commitment.

Neither Deposit nor the Payment Permission was included. Logs contained neither the original `1,000,000` raw-unit amount nor the memo hash. Fresh authenticated, public, vault, and unauthenticated reads proved that simulation persisted no state and weakened no access boundary.

```text
Sender / fee payer: 6EtwPqDdXXGrWQF8DBTzeeoj7uqCyLZ87YR3cZRfiDYn
Prepared, unbroadcast signature: 3wRQggytgA2ooYtoUXTybBrn2LC6pm4Qqh7RQAGUPNF8QPbabC9DZEn68v7pejGi3MyvGCh7fGrVYA37yx7gUsNF
Simulation slot: 301175477
Transaction size: 320 bytes
Compute units: 39,402
Simulation error: none
Committed account: Payment only
Payment bytes changed: false
Terminal commitment matches: true
Aggregate Deposits included: false
SPL Token instructions / USDC movement: none / zero
Original amount or memo hash in logs: false
Public or private state persisted: false
Unauthenticated protected reads: all null
Transaction broadcast: false
```

The public-after-commit result was then proven by the separately approved broadcast and independent verifier below.

### Finalized redacted public commitment

The sender reauthenticated, repeated the exact signature-verified simulation with a fresh blockhash, and broadcast the same 320-byte transaction. Private ER transaction `Zh9jropwxoVtKV6kVhqcZcVbsHGXPfZm8ZHjsH29oAp4RRJBMRT7LUZZwaPZM9KDwEGgMMCd16DBHRtpFMbtMMQ` finalized at slot `301184653` and produced scheduled-commit receipt `2F5hmMPY7SozPXq74VChtiYRDSVqGbYhW7D4XWCAUDu6SfTkc2e5uWkzxbZDv32mpZT3ZQ6UK4vnwvDzNVNHe7bG`.

Public Solana `ProcessUndelegation` transaction `2ncJVLoHZ14hwmCcPpD9Qp5GEQyyY2NeYz1EvcnWVCWATeBfN3JNMFm8e7W9J89ccZ4qWRssyQbpB7vBgJFMjXiv` finalized at Devnet slot `495841058`. A separate no-sign verifier later repeated the public and unauthenticated reads at finalized Devnet slot `495842094`.

The 245-byte Payment is now owned by Protected Pay and publicly contains the expected redacted terminal form:

```text
Payment ID:              public
Sender and USDC mint:    public
Status:                  Expired
Initialized / redacted:  true / true
Version:                 2
Terminal commitment:     exact independently reproduced hash
Recipient:               zeroed
Amount / escrow:         zero
Memo hash:               zeroed
Created/settle/expiry:   zeroed
Crank task ID:           zero
```

The Payment delegation record and metadata are closed. Its Permission remains delegated and continues to reveal both wallet members. The sender and recipient Deposits remain delegated, so their aggregate balances were not published. Vault collateral remains exactly 3 test USDC. The public transaction logs contain neither the original amount nor memo hash, and unauthenticated Private ER reads of Payment and both Deposits remain `null`.

Reproducible no-sign verification:

```sh
NO_DNA=1 npm run p4:v21:verify:closeout
```

This completes technical risk 3 with the deliberately narrow result: payment terms and balances are private during delegated execution and sensitive terminal fields are redacted before public commitment, but counterparties, permission membership, account topology, funding, and timing metadata are not anonymous.
