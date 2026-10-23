# Page designs and interaction specification

Updated 23 October 2026. Initial designs preceded implementation; this revision reflects the requested simpler interface.

## Visual system

White panels on a pale grey background, blue primary actions, dark text, clear labels and system typography. No marketing carousel or invented metrics. Controls have visible focus, primary actions have loading/disabled states, and errors are placed near the action. Desktop workspaces use a sidebar; mobile uses stacked content and horizontal navigation.

## Customer

Shop name/location first. Three steps: Choose file → Check preview → Pay & collect. A labelled file picker shows selected names and limits. Desktop has a compact settings panel beside a large preview; mobile stacks them. Colour/sides use plain radio choices; copies/layout/range are labelled. Crop/rotate/enhance is a secondary disclosure.

Show original image/PDF immediately, then require Update print preview to display the generated output. PDF canvas has previous/next controls and page count. Display Ready to print only when output loads. Settings changes invalidate checkout. The bottom summary shows pages, charged sides, paper sheets, exact INR amount and payment choice.

## Tracking and payment

Private order number, amount, options, payment and print status, automatic refresh and a manual Refresh button. UPI shows the shop payee/ID, QR, open-app link and reference field. Say explicitly that printing waits for the shop to verify receiving money. Cash shows the amount to pay at the counter. Completed/expired states explain file deletion and receipt retention.

## Owner

Navigation: Overview, Print queue, Transactions, Prices & QR, UPI payments, Printers, Account.

Overview shows all-time net collections, awaiting payment, active/review jobs and completed count. Queue shows recent orders, options, payment and next allowed action. Automatic refresh preserves active form input. Actions: collect cash or verify UPI, manual fallback, confirm physical output, stop failed/uncertain job, cancel, record refund. No optimistic “printed” state.

Transactions shows total collection/refund/net amounts, paginated historical rows and CSV export. Prices explain per-side billing and preserve old order totals. QR is downloadable and uses the public origin. UPI settings show that payments go directly to the chosen account. Printer setup shows capability checkboxes, online/offline state, one-time device token and revocation.

## Admin and identity

Admin navigation: Shop approvals, Audit history, Account. Show shop name, location, owner email and status; approve/suspend actions operate on metadata. No customer document preview.

Registration has shop name/location, email and password. Sign-in has email/password and optional existing authenticator code. Production first sign-in opens authenticator enrollment before workspace access. Account settings changes password and signs out all sessions. Demo shortcuts appear only for local SQLite.

## Verification artifacts

- `screenshots/print-preview-desktop.jpg`: actual two-page document prepared as grayscale two-up A4.
- `screenshots/print-preview-mobile.jpg`: 390px mobile layout with the same prepared output.
- Original/prepared page navigation and customer settings were exercised in the browser.
- `screenshots/owner-dashboard.jpg` and `screenshots/admin-dashboard.jpg` show the verified local workspace designs. Transaction pagination and account controls were also inspected, with no browser warnings/errors observed.
- Accessibility conformance and multiple real phone/browser models still require a launch audit.
