# Test and release plan

Updated 23 October 2026. Repository completion and live rollout are separate acceptance steps.

## Automated checks

`npm run build` checks JavaScript syntax and generates browser PDF.js assets.
`npm test` uses isolated SQLite fixtures and local HTTP servers. It covers pricing, PDF/image rendering, grayscale pixels, card visibility, chunked preparation, tenant boundaries, quote replay, cash/UPI gates, print leases, ambiguity/refund handling, MFA replay, production Origin/cookies, session persistence across app instances, password revocation, deletion and retained receipts.
`npm run test:neon` checks real PostgreSQL schema qualification, byte storage, conditional transitions, rate UPSERTs, cascade deletion and rollback.
`npm audit --omit=dev` checks reported dependency vulnerabilities.

Browser checks cover desktop/mobile prepared previews and owner/admin navigation. These checks do not constitute physical printer, production deployment, performance or full accessibility certification.

## Deployment and pilot checklist

- [ ] User deploys to Vercel with the exact production origin and restricted runtime secrets.
- [ ] Rotate the previously exposed owner password and update the local migration URL.
- [ ] Sign in as the created admin, enroll MFA and change the initial password.
- [ ] Register and approve a real shop; confirm QR opens that shop on a phone.
- [ ] Start Docker processor and updated ClamAV; test clean input, rejected malware test fixture, malformed PDF and Office conversion.
- [ ] Pair the actual Windows 10/11 printer; confirm colour, duplex, copies, two-up/card orientation and A4 margins using synthetic documents.
- [ ] Test paper-out/jam, network interruption, PC restart and connector crash after submission. Verify no automatic duplicate print.
- [ ] Verify one small cash and one real UPI payment with the shop, then reconcile the bank credit and ledger. No real payment was made during development.
- [ ] Confirm physical output, then verify document absence while the receipt remains.
- [ ] Exercise failed/cancelled order and a manual returned-money refund.
- [ ] Observe cleanup heartbeat and alert on stale /readyz; test total-worker outage and resumption.
- [ ] Decide backup retention, protect encryption keys, perform restore/deletion-reconciliation drill.
- [ ] Review privacy/refund/contact policies, commercial hosting eligibility, operator access and shop-PC maintenance.
- [ ] Measure load/latency and audit keyboard/screen-reader/mobile behavior.

## Failure expectations

No scanner → preparation fails closed. Offline device → new preparation rejected. No bank verification → UPI remains unpaid. Unpaid job → no print claim. Unknown physical result → review, not automatic retry. Expired file → no download; owner handles payment correction. Database/configuration failure → service unavailable, never fake success.

## Rollback

Revert the deployed code to the last verified version without replacing data or keys. Additive schema changes remain. Revoke a compromised device rather than sharing its token. Do not restore an old database over current payment records without reconciliation. Restore on a separate Neon branch and purge any resurrected deleted payloads before enabling customer access.
