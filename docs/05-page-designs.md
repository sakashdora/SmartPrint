# Page designs and interaction specification

Updated 23 October 2026. The approved `design-v2` mockups are now implemented as responsive application screens. Illustrative mockup metrics were replaced by the data already available through the application APIs.

## Visual system

White panels on a pale grey background, restrained blue primary actions, dark text, thin dividers, 8px corners and system typography. `public/premium.css` is the active stylesheet; `public/ui.js` supplies one local outline icon set. Controls have visible focus, loading/disabled states and nearby errors. Desktop workspaces use a sidebar; mobile uses a labelled expandable navigation menu with Escape support. Order and shop tables become labelled summaries on phones. Other detailed ledgers scroll inside their table container.

## Customer

Shop name/location first. Three steps: Upload → Print options → Payment. The active step reflects the selected file and prepared preview. Desktop puts the large preview on the left and settings/checkout on the right; mobile puts the preview above the controls. A labelled file picker displays selected names and limits. Colour, sides and layout use accessible radio segments. Copies have keyboard-accessible increment/decrement buttons and a number input. Page range, exact INR total and payment method remain visible in the flow. Crop/rotate/enhance is an image-only disclosure; replacing an image with a PDF resets incompatible image adjustments.

Show original image/PDF immediately, then require Update print preview to display the generated output. PDF canvas has previous/next controls and page count. Display Ready to print only when output loads. Settings changes invalidate checkout. The bottom summary shows pages, charged sides, paper sheets, exact INR amount and payment choice.

## Tracking and payment

Private order number, amount, options, payment and print status, automatic refresh and a manual Refresh button. UPI shows the shop payee/ID, QR, open-app link and reference field. Say explicitly that printing waits for the shop to verify receiving money. Cash shows the amount to pay at the counter. Completed/expired states explain file deletion and receipt retention.

## Owner

Navigation: Overview, Print queue, Transactions, Prices & QR, UPI payments, Printers, Account.

Overview shows all-time net collections, active/review jobs, awaiting/completed counts and online printer counts calculated from device heartbeats. The queue supports All, Ready, Needs attention and Completed filters over the latest 200 orders. Overview shows at most eight matching rows and links to the full queue. The payment panel links to orders needing attention; the printer panel shows actual device status or setup guidance. Automatic refresh preserves active form input, open mobile navigation and pending actions. Actions retain their order IDs after filtering: collect cash or verify UPI, manual fallback, confirm physical output, stop failed/uncertain job, cancel, record refund. No optimistic “printed” state.

Transactions shows total collection/refund/net amounts, paginated historical rows and CSV export. Prices explain per-side billing and preserve old order totals. QR is downloadable and uses the public origin. UPI settings show that payments go directly to the chosen account. Printer setup shows capability checkboxes, online/offline state, one-time device token and revocation.

## Admin and identity

Admin navigation: Overview, Shops, Audit log, Account. Overview shows registered/active/pending counts, applications awaiting review and recent audit activity. The shop directory filters All, Pending, Active and Suspended. Show shop name, location, owner email and status; approve/suspend/reactivate actions operate on metadata. Suspensions have a confirmation prompt. No customer document preview. Platform revenue and service-health examples from the mockup are not displayed without supporting API data.

Registration has shop name/location, email and password. Sign-in has email/password and optional existing authenticator code. Production first sign-in opens authenticator enrollment before workspace access. Account settings changes password and signs out all sessions. Demo shortcuts appear only for local SQLite.

## Verification artifacts

The `screenshots/premium/` directory contains actual redesigned customer, owner and admin screenshots at desktop and mobile widths. The isolated local demo uses `.data/design-preview.sqlite`; synthetic applications and test print orders are not Neon production records. Browser checks covered PDF preparation and page navigation, image enhancement controls, quote invalidation after changing copies, checkout/receipt, cash collection, queue filters, mobile menu, shop status filters, and the pricing, printer and UPI pages. At 390px, the customer, queue and admin pages had no document-level horizontal overflow. `npm run build` and all eight existing tests passed. Real printers and deployed Vercel flows were not exercised by this visual redesign.

Earlier screenshots below describe the preceding design:

- `screenshots/print-preview-desktop.jpg`: actual two-page document prepared as grayscale two-up A4.
- `screenshots/print-preview-mobile.jpg`: 390px mobile layout with the same prepared output.
- Original/prepared page navigation and customer settings were exercised in the browser.
- `screenshots/owner-dashboard.jpg` and `screenshots/admin-dashboard.jpg` show the verified local workspace designs. Transaction pagination and account controls were also inspected, with no browser warnings/errors observed.
- Accessibility conformance and multiple real phone/browser models still require a launch audit.
