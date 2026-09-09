# Spec: Protected Pay On MagicBlock

Status: implementation-ready product specification with explicit feasibility gates. It defines what must exist and how completion will be verified; it is not the task-by-task implementation checklist.

## Objective

Build a working Solana application that lets a funded user create a private pending USDC payment, lets the intended recipient acknowledge it, lets the sender cancel it before final settlement, and automatically settles or expires it through MagicBlock execution.

The implementation must make MagicBlock essential:

- meaningful payment transitions execute against delegated accounts on an Ephemeral Rollup;
- pending state is protected by Private ER permissions;
- a MagicBlock Crank invokes deadline transitions;
- actual token collateral is held and withdrawn through Solana program logic.

## Background And Current Reality

MagicBlock's official private-payments starter already demonstrates the closest infrastructure baseline:

1. a user deposits SPL tokens into a program-controlled vault;
2. a per-user deposit account records internal balance;
3. permissions are created for that account;
4. the account is delegated to a Private Ephemeral Rollup;
5. internal balances transfer privately on the rollup;
6. an account is committed and undelegated before withdrawal.

The starter does not provide a protected-payment object, pending state, acknowledgement, cancellation, expiry, recovery window, scheduled recovery, or human-recovery workflow. Protected Pay adds that product state machine.

Current MagicBlock documentation also establishes several constraints:

- Private ER permission membership controls access to delegated state, but application write authorization must still be enforced by the Anchor program.
- Both source and destination internal deposit accounts must exist for the private-transfer pattern.
- Crank handlers must be idempotent and validate current state when invoked.
- Session tokens identify a temporary signer, authority, target program, and expiry; they do not natively enforce payment recipients, amounts, counts, or purposes.
- Depositing real tokens and changing private internal balances are different phases: token movement occurs against the base-layer vault, while private payment transitions change delegated accounting state.

The inspected starter calls its token-vault integration a demonstration/WIP pattern. The first build must therefore prove collateral accounting and withdrawal before the product UI is considered trustworthy.

## Users

### Sender

Owns test USDC, funds a protected balance, creates payments, inspects private pending state, and cancels an unsettled payment.

### Recipient

Owns the exact wallet bound to a payment, privately inspects the offered payment, acknowledges it, and withdraws settled USDC.

### Time-transition caller

MagicBlock Crank or any permitted caller invokes a deterministic `advance_payment` instruction. It chooses no recipient or amount and cannot override payment terms.

### Recovery operator

For the MVP, this is the sender exercising cancel-one or client-batched cancel-all actions. A distinct recovery wallet and session-key revocation are extensions unless the core is completed early.

### Judge

Uses the product normally, then inspects a proof view, repository, tests, program address, and explorer links.

## Goals

1. Protect a real program-accounted USDC payment before settlement.
2. Make `Created → Acknowledged → Settled` and recovery transitions deterministic and race-safe.
3. Keep pending amount, memo, and status unavailable through an unauthenticated Private ER read.
4. Require the correct sender and recipient signatures for human actions.
5. Let scheduled execution settle or expire a payment while neither user is online.
6. Conserve every deposited token unit across available, locked, settled, and withdrawn balances.
7. Preserve an honest boundary: terminal settlement cannot be undone by the sender.
8. Present a simple payment product rather than an infrastructure control panel.

## Non-goals

- Mainnet or production custody.
- Arbitrary reversal after settlement.
- Fiat or bank payout.
- Resolva integration or implied partnership.
- SOL, USDT, Token-2022, swaps, price feeds, or exchange rates.
- Paid AI, AI adjudication, or model-generated transaction instructions.
- Merchant-delivery disputes, evidence review, arbitration, or reputation.
- Anonymous payments or compliance evasion.
- Guaranteed hiding of all base-layer metadata.
- A separate mobile application.

## System Boundary

```text
Sender / Recipient wallet
          │
          ▼
Protected Pay web application
     │                 │
     │ base RPC        │ authenticated Private ER RPC
     ▼                 ▼
Solana base layer      MagicBlock Private ER
- SPL token vault      - delegated Deposit accounts
- account creation     - delegated Payment account
- permission records   - acknowledge/cancel/advance
- delegation records   - private live status
- withdrawal           - scheduled Crank execution
          │                 │
          └──── commit / undelegate ────┘
```

No required application backend stores payment truth. The program and delegated state are authoritative. The browser may cache display data but must reconcile it against chain state after reconnect or refresh.

## Token Model

- The MVP supports one configured SPL Token mint representing test USDC.
- Amounts use raw `u64` token units; display conversion uses the mint decimals.
- Every deposit, payment, recipient balance, and withdrawal must use the same configured mint.
- The Token Program ID must be validated; arbitrary token-program CPIs are prohibited.
- The vault authority is a program-derived address and cannot be replaced by a client-supplied authority.
- The interface must label the cluster and test token clearly.

Supporting another mint requires a later explicit allowlist entry, separate vault, and complete duplicate test coverage. It is not enabled by accepting an arbitrary mint argument.

## Program Accounts

### `Config`

One program configuration PDA.

Required fields:

- `authority: Pubkey`
- `allowed_mint: Pubkey`
- `token_program: Pubkey`
- `private_validator: Pubkey`
- `safety_window_seconds: i64`
- `claim_window_seconds: i64`
- `version: u8`
- bumps required by the chosen PDA layout

Constraints:

- Hackathon values are 60 seconds safety and 300 seconds claim expiry.
- The Devnet configuration pins MagicBlock's documented TEE validator so permission and application accounts cannot be delegated to different validators.
- Configuration cannot be changed in a way that alters an already-created payment.
- Payment records copy their fixed deadlines at creation.

### `Vault`

A PDA that controls the associated token account holding all deposited test USDC.

Seeds:

```text
["vault", allowed_mint]
```

The token account's mint must equal `Config.allowed_mint`, and its authority must equal the vault PDA.

The Vault also records `total_liability: u64`. It increases only when collateral is deposited and decreases only when collateral is withdrawn. Internal payment transitions move liability between Deposit accounts without changing this aggregate. The vault token balance must always be greater than or equal to this value; unsolicited token transfers may make the token balance larger.

### `Deposit`

One internal balance account per user and mint.

Seeds:

```text
["deposit", user, allowed_mint]
```

Required fields:

- `user: Pubkey`
- `token_mint: Pubkey`
- `available: u64`
- `locked: u64`
- `next_payment_nonce: u64`
- `automation_paused: bool`
- `version: u8`

The account is created and funded on the base layer, permissioned to its owner, and delegated for private payment operations. It must be committed and undelegated before a base-layer withdrawal.

### `Payment`

One unique account for each protected payment.

Recommended seeds:

```text
["payment", random_payment_id]
```

`random_payment_id` is a client-generated 32-byte identifier. It must never be reused. Recipient and amount are deliberately excluded from PDA seeds.

Required private fields:

- `payment_id: [u8; 32]`
- `sender: Pubkey`
- `recipient: Pubkey`
- `token_mint: Pubkey`
- `amount: u64`
- `created_at: i64`
- `settle_after: i64`
- `expires_at: i64`
- `status: PaymentStatus`
- `memo: fixed-size optional bytes` or `memo_hash: [u8; 32]`
- `version: u8`
- `bump: u8`

The payment shell must exist and be delegated before sensitive fields are written inside the Private ER. Pending payment accounts must not be committed to the public base layer with unsanitized sensitive fields.

### `PaymentStatus`

```text
Created
Acknowledged
Settled
Cancelled
Expired
```

Terminal states are `Settled`, `Cancelled`, and `Expired`. No instruction may transition out of a terminal state.

## State Machine

```text
Created
  ├── recipient acknowledges ───────────────► Acknowledged
  ├── sender cancels ───────────────────────► Cancelled
  └── claim deadline passes without ack ───► Expired

Acknowledged
  ├── sender cancels before actual settle ─► Cancelled
  └── safety window has ended ─────────────► Settled
```

Important rules:

- Acknowledgement never changes payment terms.
- The sender may cancel until the state actually becomes `Settled`, even if a scheduled task is late.
- A recipient cannot acknowledge at or after `expires_at`.
- If acknowledgement occurs after `settle_after` but before `expires_at`, the acknowledge transaction may immediately perform the settlement transition.
- At most one terminal transition succeeds.

## Instruction Requirements

### Base-layer instructions

#### `initialize_config`

- Initializes the single configured test-USDC mint and timing policy.
- Validates the authority and token program.
- Cannot reinitialize existing configuration.

#### `initialize_deposit`

- Creates a zero-balance Deposit for any named user.
- Repeated initialization must not overwrite an existing balance or authority.
- This allows a sender to prepare a destination Deposit without requiring the recipient to fund it.

#### `deposit_usdc(amount)`

- Requires the depositing user to sign.
- Requires `amount > 0`.
- Transfers exactly `amount` from the user's token account to the program vault.
- Increases only that user's `available` balance after token transfer succeeds.
- Is unavailable while the Deposit is delegated unless the chosen MagicBlock token path safely supports it.

#### `withdraw_usdc(amount)`

- Requires the Deposit owner to sign.
- Requires an undelegated, committed Deposit account.
- Allows withdrawal only from `available`, never `locked`.
- Transfers exactly `amount` from the vault to the owner's validated token account.
- Decreases internal liability atomically with the token transfer.

#### `prepare_private_payment(payment_id, recipient)`

- Creates an empty Payment shell without public amount or memo.
- Ensures sender and recipient Deposit accounts exist.
- Creates the required permission records.
- Delegates the Payment and required Deposit accounts to the same Private ER validator.
- May use a supported post-delegation action or transaction bundle to minimize approvals, but the safety invariant takes priority over the one-approval target.

### Private ER instructions

#### `open_payment(payment_id, amount, memo)`

- Requires the sender or an explicitly allowed sender session.
- Requires `amount > 0` and configured mint.
- Requires sender and recipient to differ.
- Requires `sender.available >= amount` using checked arithmetic.
- Initializes the private Payment fields and copied deadlines.
- Moves `amount` from sender `available` to sender `locked`.
- Schedules the payment's time-transition task or records the data needed for the associated Crank call.
- Rejects reuse of an initialized Payment shell or payment ID.

#### `acknowledge_payment()`

- Requires a signer equal to `Payment.recipient`.
- Requires `status == Created` and `now < expires_at`.
- Changes status to `Acknowledged` without altering parties, amount, or deadlines.
- If `now >= settle_after`, may settle atomically under the same invariants as `advance_payment`.
- A duplicate call after acknowledgement is either a documented no-op or a clear already-acknowledged error; it must never move value twice.

#### `cancel_payment()`

- Requires a signer equal to `Payment.sender`.
- Requires status `Created` or `Acknowledged`.
- Moves `amount` from sender `locked` back to sender `available` exactly once.
- Sets status to `Cancelled`.
- Does not require a scheduled task to be removed for safety; later task calls must no-op against the terminal state.

#### `advance_payment()`

- Does not accept a recipient, amount, or deadline argument.
- Reads every payment term from the stored Payment account.
- If `Acknowledged` and `now >= settle_after`, settles.
- If `Created` and `now >= expires_at`, expires and refunds.
- Otherwise returns success without moving value, allowing safe repeated Crank execution.
- A settled transition subtracts sender `locked` and adds recipient `available` exactly once.
- An expired transition subtracts sender `locked` and returns it to sender `available` exactly once.

#### `set_automation_paused(paused)`

- Optional until session-based automatic payment creation exists.
- Requires the Deposit owner.
- Blocks new session-created payments, not owner recovery.
- Must not indefinitely change already-agreed recipient settlement terms.
- Must not be exposed in the UI if it has no implemented automation to control.

#### `redact_terminal_payment()`

- May run only on a terminal payment.
- Replaces private recipient, amount, and memo fields with zeroed values after creating a commitment hash sufficient for integrity proof.
- Is required before committing or undelegating a Payment account to public Solana.
- Cannot alter Deposit balances or terminal status.

## Scheduled Execution

The preferred hackathon schedule is one idempotent task per payment that invokes `advance_payment` every 60 seconds for five iterations:

- iteration 1 can settle an acknowledged payment after the safety window;
- iterations 2–4 safely retry or no-op;
- iteration 5 expires an unacknowledged payment at the claim deadline;
- all iterations after a terminal state return without moving funds.

If the current Crank interface supports reliable one-shot tasks at absolute deadlines, two one-shot calls may replace the recurring schedule. Either implementation must satisfy the same state-based acceptance criteria.

The Crank never supplies or changes financial terms. The target instruction must remain correct if execution is early, late, duplicated, or invoked manually.

## Access And Authorization Model

### Deposit privacy

- A Deposit permission group contains its owner.
- The owner authenticates to the Private ER endpoint by signing the supported challenge.
- Other users may credit a recipient through program logic but cannot debit the recipient's balance.

### Payment privacy

The baseline Payment permission group contains sender and recipient so both can inspect pending state. This is the simplest verifiable MVP.

Current permission metadata is managed by an L1 permission program. Until tested otherwise, the product must assume that group membership may reveal some participant metadata publicly. Therefore the hackathon claim is limited to private amount, memo, live balance, and pending status—not guaranteed hiding of every relationship or timing signal.

An optional stronger design uses an unlinkable claim-access public key in the permission group and stores the real recipient only in private state. That design is allowed only if it does not weaken recipient signature checks or introduce an unsafe reusable secret.

### Write authorization

Private read membership does not grant financial authority. The program enforces:

| Action | Authorized actor |
|---|---|
| Deposit | Token owner |
| Open payment | Sender owner or bounded sender session |
| Acknowledge | Exact stored recipient |
| Cancel | Exact stored sender |
| Advance | Permissionless deterministic caller / Crank |
| Withdraw | Exact Deposit owner |
| Change configuration | Config authority only |

No client-provided account may substitute a different token program, mint, vault, Deposit owner, sender, or recipient.

## Accounting Invariants

These invariants are mandatory:

1. `available + locked` for each sender changes only through a defined deposit, payment, recovery, settlement, or withdrawal transition.
2. Opening a payment performs `available -= amount` and `locked += amount` atomically.
3. Cancellation or expiry performs `locked -= amount` and `available += amount` for the sender atomically.
4. Settlement performs `sender.locked -= amount` and `recipient.available += amount` atomically.
5. No terminal instruction can run twice.
6. No instruction can change a stored payment's amount, sender, recipient, mint, or deadlines after opening.
7. Vault token balance must cover the sum of all internal liabilities after every successful base-layer deposit or withdrawal.
8. Arithmetic uses checked operations and rejects underflow/overflow.
9. A Deposit PDA includes its user and mint; a Payment PDA uses a unique random payment ID.
10. Initialization cannot overwrite existing state.

## Session-Key Boundary

Session keys are not required for the first protected person-to-person payment. If included:

- the session token must target only the Protected Pay program and expire within the event build window;
- program policy must additionally cap amount per payment, cumulative spend, allowed recipient(s), payment count, and policy expiry;
- a session may open a compliant payment but may not change policy, cancel owner recovery, withdraw, alter the vault, or choose arbitrary program instructions;
- the owner can revoke the session without losing the ability to cancel pending payments or withdraw available funds.

No model API is required. A deterministic rules engine is the only allowed initial automation authority.

## Client Requirements

The client should start from the pinned MagicBlock private-payments example because it already contains:

- Next.js and React UI;
- Solana wallet adapter integration;
- Anchor client wiring;
- authenticated Private ER RPC connection;
- permission creation, delegation, private balance transfer, commitment, and withdrawal flows.

For the hackathon, compatibility with MagicBlock's working stack is more important than upgrading libraries. Legacy `@solana/web3.js` and Anchor types must remain isolated in program/MagicBlock adapters rather than spread through presentation components.

Required product surfaces:

- landing/connect state;
- protected balance and funding state;
- send form and review;
- pending-payment detail with authoritative countdown/status;
- recipient acknowledgement view;
- activity list;
- individual and client-batched bulk recovery;
- proof/debug view available to judges but not used as the primary journey.

Browser countdowns are display aids only. Every mutation and status reconciliation reads authoritative state from the appropriate RPC.

## Privacy Requirements

- Unauthenticated PER reads must not return payment amount, memo, live status, or private internal balance.
- A wrong recipient wallet must not receive an authenticated view merely because it possesses the public URL.
- Raw private notes must never be written to a public memo or unsanitized base-layer account.
- Pending Payment accounts remain delegated unless sensitive fields have been redacted before commitment.
- Funding, vault deposits, withdrawals, permission records, and commitment timing may remain observable and must be disclosed in product copy.
- Logs and errors must not print private memo contents or complete sensitive account state.

## Failure Behavior

- A rejected wallet signature changes no program state.
- A partially confirmed client workflow reconciles existing PDAs before retrying and never guesses whether a payment exists.
- If permission creation or delegation fails, no private payment may be reported as open.
- If scheduling fails after a payment opens, the UI must expose a recoverable warning; sender cancellation and manual permissionless `advance_payment` remain available.
- If the Crank executes late, stored state and chain time decide the result.
- If Private ER authentication expires, the client re-authenticates without recreating the payment.
- If a withdrawal requires undelegation, the UI shows the commitment phase and waits for base-layer confirmation.

## Requirements

### Functional

- F1: A user can deposit configured test USDC and observe an internal available balance.
- F2: A funded user can create one private pending payment to another wallet.
- F3: Only the stored recipient can acknowledge before expiry.
- F4: Only the stored sender can cancel before settlement.
- F5: A stored payment cannot be redirected or resized.
- F6: An acknowledged payment settles after the safety window.
- F7: An unacknowledged payment expires after the claim deadline.
- F8: Settlement, cancellation, and expiry move exactly one amount exactly once.
- F9: A recipient can withdraw settled available balance after commitment/undelegation.
- F10: Users can revisit current and terminal payment states.
- F11: The UI never presents pending money as spendable or final.
- F12: All three product proof scenarios work without editing program state manually.

### MagicBlock

- M1: At least `open_payment`, `acknowledge_payment`, `cancel_payment`, and `advance_payment` execute on delegated state through the ER endpoint.
- M2: Payment and Deposit accounts use the documented delegation lifecycle.
- M3: Pending state uses a Private ER permission configuration.
- M4: An unauthorized read test demonstrates privacy enforcement.
- M5: At least one terminal transition is invoked by MagicBlock Crank while both users are offline.
- M6: Committed or undelegated state has an explorer-verifiable base-layer result.

### Security

- S1: Every typed account has owner, PDA seed, signer, mint, and relationship constraints appropriate to its role.
- S2: Token CPIs use the validated SPL Token program and PDA signer seeds.
- S3: Initialization cannot overwrite a funded Deposit or initialized Payment.
- S4: Same-account substitution and sender-equals-recipient are rejected.
- S5: Arithmetic is checked.
- S6: Terminal transitions are irreversible and idempotent.
- S7: A scheduled caller cannot choose financial terms.
- S8: Locked balance cannot be withdrawn.
- S9: The client simulates base-layer transactions before requesting signatures where supported.
- S10: Development and submission use localnet/devnet or the official hackathon ER, never mainnet customer funds.

## Acceptance Criteria

### Correct payment

Given funded sender and initialized recipient Deposits, when the sender opens a payment and the intended recipient acknowledges it, then a Crank call after 60 seconds changes it to `Settled`, subtracts the sender's locked amount, and credits the recipient exactly once.

### Mistaken payment

Given a `Created` or `Acknowledged` payment, when the sender cancels it before settlement, then the full amount returns to sender available balance and every later Crank call leaves it `Cancelled`.

### Abandoned payment

Given an unacknowledged payment, when the 300-second claim deadline passes, then Crank changes it to `Expired`, returns the exact amount to the sender, and rejects later acknowledgement.

### Authorization

- A third wallet cannot acknowledge, cancel, withdraw, or change payment terms.
- The recipient cannot cancel.
- The sender cannot acknowledge on the recipient's behalf.
- Crank can invoke only deterministic time transitions.

### Privacy

- Authenticated sender and recipient can read allowed pending details.
- An unauthenticated or unrelated wallet cannot read those details through the Private ER endpoint.
- Public explorer inspection is documented honestly and reveals no raw private memo.

### Accounting

Across deposit, open, cancel, acknowledge, settle, expire, commit, and withdrawal tests, total internal liability plus withdrawn value equals deposited value, subject only to token amounts and not transaction fees.

### Product

- A new viewer can explain the product as "Undo for USDC payments before finality" after 30 seconds.
- Infrastructure terminology is absent from the primary send and recovery screens.
- Every visible action invokes a real program transition; no settlement or refund button is mocked.
- The submission includes repository, program address, explorer proof, private-read proof, and Crank proof.

## Constraints

- Remaining event time is assumed to be only a few days and one primary builder unless corrected.
- The first build uses test tokens and non-mainnet environments.
- The MagicBlock starter's pinned, working versions are the compatibility baseline during the feasibility spike.
- The older private-payments starter uses Anchor 0.31.1 and `ephemeral-rollups-sdk` 0.2.x, but that SDK line has no Crank module. MagicBlock's current official `crank-counter` example uses Anchor 1.0.2 and the SDK git revision `0fc4604157de51df28693e02e5a1a6a4a08c8a03` with the `anchor` and `crank` features. Protected Pay uses this current Crank-capable baseline and also enables `access-control`; the exact revision and lockfile are mandatory until the SDK release containing that API is published.
- Private permission metadata exists on Solana L1; privacy claims must be measured, not inferred.
- A recipient Deposit and permissions must exist before private settlement.
- Program correctness cannot depend on a browser remaining online.
- No paid API or external fiat/payment-provider integration may block the core flow.

## Feasibility Gates

The idea remains the chosen product only if these gates pass quickly:

### Gate 1: Real collateral

A test token deposit enters the program vault, the Deposit account is delegated, and the same owner can later commit/undelegate and withdraw the correct amount.

### Gate 2: Protected ER transition

A unique Payment account and both Deposit accounts can participate in an ER instruction that moves `available` to `locked`, followed by a successful cancel or settle transition.

### Gate 3: Private access

Authorized wallets can read the pending record while an unrelated wallet cannot. The exact public metadata visible in permission accounts and after commitment is recorded.

### Gate 4: Scheduled private transition

Crank successfully calls `advance_payment` against the delegated private accounts and produces the expected terminal state without either user online.

### Gate 5: Usable approval count

After initial funding/authentication, creating a protected payment can be packaged into one normal approval or a flow simple enough to explain honestly. If multiple unavoidable approvals remain, the product copy must not claim one-tap sending.

Failure of Gate 1 or Gate 2 blocks the product. Failure of Gate 3 removes the privacy claim and makes the hackathon fit substantially weaker. Failure of Gate 4 removes automatic recovery and requires immediate architecture review. Gate 5 affects experience and pitch but not financial correctness.

## Stories Needed

1. First-time sender funds and enters private mode.
2. Sender creates and shares a protected payment.
3. Correct recipient privately acknowledges.
4. Scheduled settlement completes exactly once.
5. Sender undoes a mistaken payment.
6. Scheduled expiry recovers an abandoned payment.
7. Unauthorized wallet fails to inspect or mutate the payment.
8. Recipient commits/undelegates and withdraws settled value.
9. Returning user reconciles state after refresh or lost connection.
10. Judge opens proof view and verifies MagicBlock integration.

## Open Questions

- Does the hackathon Private ER permit a scheduled Crank to mutate permissioned accounts without an authenticated human RPC session?
- Can permission creation, delegation, and the post-delegation `open_payment` action fit into one wallet approval using the current SDK?
- Which test-USDC mint and faucet are expected by the event environment?
- Exactly which permission-group fields are public on L1, and how much relationship metadata do they reveal?
- Can terminal Payment records remain delegated for the demo, or must they be redacted and committed for resource cleanup?
- Does the current Crank schedule its first invocation after `execution_interval_millis`, and can a completed recurring task be safely ignored without explicit cancellation?
- What authenticated submission portal state and exact deadline does the organizer see for Blitz v8?

## Hackathon Requirement Fit

| Requirement | Fit | Evidence required at submission |
|---|---|---|
| Integrate an Ephemeral Rollup | Pass by design | ER transaction signatures for protected-payment state transitions. |
| Creativity | Strong | A private staged-finality and human-recovery workflow, not a direct-transfer clone. |
| Technical depth | Strong if gates pass | Vault accounting, multiple delegated accounts, PER permissions, scheduled idempotent transitions, race tests. |
| Compelling use of Solana | Strong | Improves a familiar irreversible-payment problem while preserving verifiable final settlement. |
| Private ER prize alignment | Strong | Pending financial state is genuinely permissioned rather than privacy being a label. |
| Understandable in 30 seconds | Pass | "Undo for USDC payments before they become final." |
| Low friction | Conditional | Must prove the post-funding payment approval count in Gate 5. |
| Product, not demo | Pass if full lifecycle ships | Send, acknowledge, undo, automatic settle/expiry, activity, withdrawal, and recovery are user workflows. |

## Source References

- [MagicBlock documentation](https://docs.magicblock.gg/)
- [Ephemeral Rollups Anchor guide](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/anchor)
- [Private ER authorization](https://docs.magicblock.gg/pages/tools/tee/authorization)
- [MagicBlock Crank implementation](https://docs.magicblock.gg/pages/tools/crank/implementation)
- [MagicBlock session-key integration](https://docs.magicblock.gg/pages/tools/session-keys/integrating-sessions-in-your-program)
- [MagicBlock private-payments starter](https://github.com/magicblock-labs/starter-kits/tree/main/private-payments-demo)
- [Protected Pay research](./protected-settlement-prior-art.md)
- [Resolva and product fit](./resolva-and-product-fit.md)
- [Protected Pay MVP scope](./protected-pay-mvp-scope.md)
- [Protected Pay PRD](./protected-pay-prd.md)
