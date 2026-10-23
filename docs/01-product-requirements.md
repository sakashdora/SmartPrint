# SmartPrint product requirements

Version 1.1 · 23 October 2026

## Product and confirmed scope

Customers scan a shop QR, upload from mobile/desktop, inspect a real print preview, pay in INR and collect the print. Owners register shops, configure rates and UPI accounts, connect Windows printers and manage payments/jobs. Admins approve/suspend shops and inspect audit metadata.

Confirmed choices: Neon database, Vercel website/API, always-on Windows 10/11 shop processor, responsive mobile access, each shop's personal/business UPI ID and cash. No Razorpay subscription or gateway keys are required for this flow. UPI verification is manual by the shop. Native Android/iOS printing, automated bank verification and payouts are outside this release.

## Actors and permissions

| Actor | Allowed |
|---|---|
| Guest customer | View active shop; upload, transform and preview; accept quote; create order; see own receipt using private token |
| Owner | Manage own shop rates, QR, UPI and devices; verify collections; resolve print outcomes; view/export own ledger; record returned refunds |
| Admin | Approve/suspend shops and inspect content-free audit; no customer-file viewer |
| Device | Prepare assigned files and print paid compatible jobs for one shop; no payment or admin privileges |

One shop per owner account is supported. Email/password login persists in Neon; MFA is required for production workspaces. Guests do not need accounts. Receipt tokens remain in their browser session.

## Customer flow

1. Scan the shop's QR and verify its name/location. Only approved active shops accept uploads.
2. Select PDF/JPG/PNG, or DOCX/PPTX/XLSX when a shop processor is available. Up to 20 MiB combined, 100 pages. Unsupported/encrypted/malformed documents give an actionable error.
3. Set A4, colour/B&W, one/both sides, 1–100 copies, page range, one/two pages per side or two card images on one side.
4. Images can rotate, crop symmetrically, trim blank borders and improve contrast/sharpness. Card mode requires exactly two images and single-sided output.
5. Review the prepared PDF, every page, source count, printed sides, sheets and exact server price. Changed options invalidate the previous quote. Quotes expire after 15 minutes.
6. Choose cash or UPI. Cash waits for owner collection. UPI pays the shop directly; a shared reference stays pending until the owner checks bank credit.
7. Follow status with automatic five-second refresh: waiting for payment, ready, printing, checking output, complete; failures and review are explicit.
8. Physical-success confirmation deletes the live PDF and retains receipt/financial metadata. Expired files cannot be downloaded.

## Owner and admin flows

Owner: register → sign in/MFA → configure rates/UPI/printer → admin approval → share QR. Queue actions follow allowed states. Connection failure never triggers automatic duplicate printing. An uncertain job requires checking paper and stopping the Windows queue before failure/refund resolution.

Admin: secure sign-in/MFA → review shop name/location/owner → approve or suspend → inspect audit. Suspension rejects new public work and connector claims. Existing collected orders require owner resolution.

Collections are immutable. Refund recording is separate and confirms money already returned. Totals cover all records; ledger pages and CSV support historical transactions. No tax/commission or settlement claim is inferred.

## Pricing

Integer paise. Default examples: B&W ₹2/side, colour ₹10/side, editable by each owner. Chargeable sides = ceil(selected pages / pages per side) × copies. Sheets = ceil(sides per copy / duplex factor) × copies. Duplex saves paper; it does not automatically reduce the per-side rate. Card front/back uses one side per copy.

Example: five pages, two-up, duplex, two copies = six charged sides, four sheets. Existing quotes/orders retain their original rate.

## Acceptance criteria

| ID | Acceptance |
|---|---|
| C01 | QR targets an approved shop; inactive shops reject new uploads/orders |
| C02 | Type, byte/page/pixel limits and malformed input are checked |
| C03 | Preview contains the real generated output, including grayscale and two-up/card layout |
| C04 | Odd-page duplex/copy pricing matches the documented formula |
| C05 | Price/page-count tampering and quote replay do not create underpriced/duplicate orders |
| C06 | Unpaid cash/UPI jobs cannot be claimed or manually started |
| C07 | Customer UPI reports cannot mark payments paid; owner confirmation creates one ledger row |
| C08 | Duplicate claims/submissions cannot automatically reprint an order |
| C09 | Shop/device A cannot read or mutate shop B data |
| C10 | Physical success atomically deletes the live file; receipt remains |
| C11 | Expiry denies access immediately; cleanup freshness and outage behavior are observable |
| C12 | Mobile/desktop have labelled controls and readable real preview |
| C13 | Offline/jam/timeout stays unresolved until owner checks output |
| C14 | Initial admin and ongoing account/session data persist in Neon |
| C15 | Gross/refund/net totals include the entire ledger; export is tenant-scoped |

## Non-functional goals and release boundaries

Targets to measure: p95 ordinary reads under 500 ms, a 10-page PDF preview within 5 seconds excluding upload, 99.5% monthly availability, metadata recovery within 4 hours and WCAG 2.2 AA. These are targets, not certified measurements.

No arbitrary executable/archive printing, OCR, perspective correction, unattended physical-success detection, offline-Internet operation, automatic UPI verification, automated refunds or native mobile printer drivers. Office conversion and Windows behavior require the live pilot. Public launch requires the operational checklist, actual processor/printer tests and operator-approved policies.
