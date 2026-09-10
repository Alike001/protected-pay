# Phase 5 Balance Dialog Fidelity Ledger

Date: 2026-09-10

Accepted reference: `context/design/protected-pay-dashboard-concept.png` at 1536 × 1024.

Rendered checks used the built-in Playwright browser against the Vite development server. The balance dialog was captured at 1536 × 1024 and 390 × 844, after its 180 ms entrance animation settled. Both the accepted reference and latest desktop render were inspected with `view_image`.

| Check | Reference evidence | Render evidence | Result |
|---|---|---|---|
| Product story | Undo for USDC and protected balance dominate the sender screen | Existing headline, balance, composer, active payment, and activity remain visible beneath the dialog | Match |
| Palette | True white canvas, navy text, violet controls, pale-violet information surfaces | Dialog uses the same tokens without introducing glass, tint, or decorative effects | Match |
| Typography | Compact operational labels with strong navy headings | Dialog heading, labels, values, steps, and disclosure follow the existing type scale | Match |
| Containers | Thin borders, restrained radii, no nested decorative cards | One focused modal, compact account summary rows, and one disclosure surface | Match |
| Icons | Consistent thin outline icons inside pale-violet tiles | Lucide withdrawal, close, lock, recovery, and verification icons retain the established treatment | Match |
| Transaction clarity | The product must communicate protection and recovery without infrastructure jargon | Amount, network, wallet/fee payer, destination/source, asset, two approvals, and public privacy boundary appear before signing | Required functional extension |
| Mobile behavior | Existing recipient concept establishes narrow, single-column spacing | 354 px dialog fits a 390 px viewport with no horizontal overflow; every control remains visible | Match |

Above-the-fold sender copy is unchanged. The balance-operation copy appears only after an explicit Add funds or Withdraw action. This dialog is an intentional functional extension not pictured in the original dashboard concept; it uses the accepted component system and introduces no new product claim.
