# Protected Pay UI Specification

Source concepts:

- `protected-pay-dashboard-concept.png` — 1536 × 1024 desktop sender dashboard.
- `protected-pay-recipient-mobile-concept.png` — 853 × 1844 recipient mobile state.

The concepts are visual references. Verified product behavior and privacy wording override any generated-image copy that conflicts with the program evidence.

## Product hierarchy

The first viewport must answer three questions without infrastructure vocabulary:

1. What is this? **Undo for USDC, before it becomes final.**
2. What can I do? **Send protected payment.**
3. What happens next? The payment waits privately, the recipient acknowledges, and the deadline resolves to settlement or recovery.

Primary sender surfaces:

1. protected balance;
2. send form and review;
3. two-stage approval progress;
4. active Payment safety-window timeline;
5. Undo;
6. activity;
7. withdrawal;
8. secondary technical proof.

Recipient surfaces:

1. wallet match/denial;
2. offered amount and note only after authorized read;
3. countdown and non-final warning;
4. acknowledgement;
5. settled claim;
6. secondary technical proof.

## Honest workflow copy

The generated desktop concept visually merges authentication with public setup. The implementation must use the measured sequence instead:

1. **Prepare protection** — one public Solana transaction creates and delegates Payment plus Permission.
2. **Private session** — one off-chain wallet message only when no valid authentication session exists.
3. **Protect payment** — one Private ER transaction atomically opens escrow and registers automation.

Concise disclosure:

> Two transaction approvals. A one-time session signature may also appear.

Do not claim one click or one approval.

## Design system

### Color

- canvas: true white `#ffffff`;
- subtle surface: `#f7f8fc`;
- ink: `#071735`;
- secondary text: `#63708c`;
- rule/border: `#dce2ee`;
- violet brand/action: `#5b50e6`;
- violet soft: `#efedff`;
- recovery coral: `#f45258`;
- success emerald: `#0fb36d`;
- pending amber: `#dfa317`.

No tinted page background, glassmorphism, neon glow, or decorative gradients. A restrained violet button gradient is allowed only where shown in the concepts.

### Typography

- UI family: `Inter`, `Avenir Next`, `Segoe UI`, sans-serif fallback;
- display: 44/50 desktop, 34/40 mobile, weight 760;
- section heading: 20/28, weight 700;
- balance: 34/40, weight 760;
- body: 15/23;
- control: 14/20, weight 650;
- caption: 13/19.

### Geometry

- desktop sidebar: 244px;
- main maximum width: 1280px;
- spacing scale: 4, 8, 12, 16, 20, 28, 36, 48;
- control height: 44–48px desktop, at least 48px mobile;
- radii: 10px controls, 14px panels;
- borders: 1px cool gray;
- shadows: none by default, subtle `0 12px 32px rgba(7, 23, 53, .06)` only for modal/sheet elevation.

### Signature motif

The protected-time rail is the recurring product shape. It appears as a circular countdown in focused Payment states and a vertical/horizontal timeline in lists. Violet means protected/in progress, coral is reserved for Undo, emerald means completed.

## Component families

- `AppShell`: sidebar/compact mobile header and main content.
- `BrandMark`: code-native shield outline.
- `WalletControl`: connected/disconnected, full address available to inspect.
- `BalancePanel`: available test USDC and withdrawal.
- `PaymentComposer`: validated recipient, amount, private note, review transition.
- `ApprovalSteps`: public preparation, optional session signature, private open.
- `PaymentCountdown`: authoritative deadline plus local display countdown.
- `PaymentTimeline`: created, acknowledged, settled/expired.
- `RecoveryAction`: coral Undo with deliberate confirmation dialog.
- `ActivityList`: open desktop rows and compact mobile rows, grouped by attention/in-progress/completed.
- `RecipientPayment`: matching-wallet acknowledgement and wrong-wallet denial variants.
- `ProofDrawer`: program, clusters, signatures, privacy boundary, and explorer links.
- `Disclosure`: test-only and exact privacy limits.

The browser implementation encrypts note text with AES-GCM and carries the ciphertext and key in the recipient URL fragment, which browsers do not send to the host. The authenticated Payment stores only the note hash and the recipient verifies decrypted text against it. This keeps note text off public and Private ER state, but possession of the complete recipient link is sufficient to decrypt it; copy must not describe the note as wallet-gated.

## Required states

- disconnected landing;
- connected empty/unfunded;
- connected funded/no active Payment;
- composer editing, validation, review, preparing, authenticating, opening, confirmed;
- pending Created and Acknowledged;
- Settled claimable and claimed;
- Cancelled;
- Expired recoverable and recovered;
- wrong recipient denied;
- signature rejected;
- delayed confirmation/reconciliation;
- proof drawer open.

## Responsive behavior

At ≤ 900px, remove the fixed sidebar, use a compact header, stack balance/composer/payment, convert activity table rows to open list rows, and keep the primary action within thumb reach. Recipient payment detail uses the mobile concept directly: countdown, amount, sender shorthand, note, acknowledgement explanation, three-stage rail, proof disclosure, and privacy/test notice.

## Allowed first-viewport copy

- Protected Pay
- Undo for USDC, before it becomes final.
- Protected balance
- test USDC
- Send protected payment
- Recipient wallet
- Amount
- Private note
- Review payment
- Active payment
- Pending
- Waiting for recipient
- Undo payment
- Withdraw
- View technical proof
- Test funds only
- Amount, note, and live status stay private while pending. Wallets and timing are public.

No hero eyebrow, promotional badge, fake metric, or infrastructure label is allowed in the primary journey.
