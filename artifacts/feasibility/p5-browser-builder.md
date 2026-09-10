# Phase 5 Browser Transaction-Builder Verification

Date: 2026-09-10

Command: `NO_DNA=1 npm run p5:verify:browser-payment-builder`

Result: all assertions passed.

| Browser path | Instructions | Serialized bytes |
|---|---:|---:|
| Funded sender public preparation | 5 | 797 |
| First-recipient public preparation | 6 | 943 |
| Recipient one-time onboarding | 4 | 846 |
| Sender first balance setup and funding | 6 | 955 |
| Private open plus Crank schedule | 3 | 494 |
| Private balance return / undelegation | 2 | 320 |
| Public top-up plus re-delegation | 3 | 737 |
| Public withdrawal plus re-delegation | 3 | 737 |

The schedule is fixed at 60,000 milliseconds for six iterations. This verifier uses generated instruction builders and the deployed program configuration, but deliberately does not request a wallet signature and does not broadcast a transaction (`signed: false`, `broadcast: false`). Live signing remains an explicit user action in the browser. The balance-management builders are measured separately because the private return must finalize before the public custody mutation and re-delegation can execute safely.
