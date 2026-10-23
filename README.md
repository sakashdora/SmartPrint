# SmartPrint

QR printing for independent shops, with customer previews, owner/admin workspaces, INR cash payments and direct-to-shop UPI.

## Current setup

- Neon is connected and migrated under the `smartprint` schema. The app uses a separate restricted runtime login. The owner login remains local as `MIGRATION_DATABASE_URL`.
- Your admin account is created in Neon. Initial credentials are in the ignored local file `.data/admin-access.txt`. The database stores a salted scrypt hash, never the plaintext password.
- Orders, quotes, encrypted files, payments, prices, sessions and audit records persist in Neon. Tracking and owner queue/transactions check for changes every five seconds.
- Deployment is prepared for Vercel. You will deploy it yourself. An always-on Windows 10/11 shop PC runs document processing and the printer connector.

**Verified:** build, eight automated test groups, real Neon transaction checks, restricted runtime privileges, persisted admin hash and desktop/mobile PDF preview.
**Still requires live validation:** Vercel deployment, Docker/ClamAV/LibreOffice startup and physical output on your printer.

## Run locally

Requires Node.js 24.x:

```powershell
npm ci
npm start
```

Open http://localhost:3000. This loads `.env` and uses Neon. Register a shop, approve it using your admin account, then configure prices, UPI and a printer. With `CONNECTOR_PROCESSING=true`, previews require the shop connector.

For an isolated UI demonstration, stop the real server and run `npm run demo` from a shell without inherited production variables. Demo accounts: `owner@smartprint.local` / `admin@smartprint.local`, password `SmartPrintDemo!2026`. These accounts exist only in local SQLite. Demo processing is unscanned and must stay local.

## Deploy and connect a shop

Follow [Vercel and Windows setup](docs/08-deployment-and-shop-setup.md). Upload only the listed runtime variables to Vercel. Never upload `.env`, `.data`, migration credentials, admin credentials or the processor secret.

First production sign-in requires authenticator enrollment. Change the initial password in Account settings, save it privately, then remove the local delivery file.

## Included

- Registration, admin approval/suspension, per-shop prices, QR download, UPI settings, printer pairing/revocation.
- PDF/JPG/PNG and shop-PC conversion of DOCX/PPTX/XLSX. 20 MiB input, 100 pages, A4 output, 100 copies, 40 MiB output limit.
- Actual original/prepared previews, page navigation, ranges, colour/grayscale, duplex, two-up and card front/back.
- Image rotation, symmetric crop, blank-border trimming and contrast/sharpness enhancement.
- Manually verified UPI/cash, immutable collections, all-time gross/refund/net totals, paginated ledger and CSV export.
- Paid print leases, duplicate-submission protection, uncertain-output review, manual printing, cancellation and manual refund recording.
- Atomic live-PDF deletion after confirmed physical output; expiry cleanup while receipts remain.
- Persistent hashed sessions, MFA, distributed rate limits, tenant/role checks, Origin checks, encrypted files, audit events and operator recovery.

A customer's UPI reference never marks payment paid. The shop must verify its own bank credit. Refund recording does not transfer money. Windows spool submission does not prove physical output; the owner confirms it. Mobile uses the responsive website and Windows bridge, not a native silent-print app. Auto-crop is not perspective correction.

## Verify and maintain

```powershell
npm run build
npm test
npm run test:neon
npm audit --omit=dev
```

Tests use isolated local databases and no printer. The Neon check rolls back every fixture. `npm run migrate` explicitly uses the migration login; `npm run env:check` prints configuration presence only.

Keep `FILE_ENCRYPTION_KEY` unchanged across deployments: files and MFA depend on it. Rotate the original Neon owner password exposed in chat before public launch. Live SQL deletion does not erase retained backups or printer spool caches.

[Full PRD and document pack](docs/README.md) · [Launch checklist](docs/06-test-and-release-plan.md) · [Operations](docs/09-operations-and-recovery.md)
