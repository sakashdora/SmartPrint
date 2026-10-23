# Verification and implementation status

23 October 2026

## Observed evidence

- `npm run build`: syntax checks and static asset build passed.
- `npm test`: eight test groups passed, including real rendered card/grayscale pixels, cross-instance production session/MFA checks and uncertain-print/refund lifecycle.
- Real Neon schema migration and transaction integration passed; every integration fixture was rolled back.
- A separate generated runtime role was created and checked for SmartPrint table access without schema-creation privilege.
- Requested admin account was created in Neon. A second database connection verified its role and strong salted scrypt hash without printing the password.
- Browser showed original PDF, generated grayscale two-up PDF, correct ₹2 price for one printed side and functioning page controls. Desktop 1440px and mobile 390px captures saved; mobile had no horizontal page overflow.
- Final `npm audit --omit=dev`: zero reported vulnerabilities.
- Windows connector PowerShell scripts passed parser checks; this does not establish hardware execution.
- Existing local shop registration was preserved in Neon with its owner hash and prices, pending real admin approval. Demo accounts and synthetic orders were not imported.
- Live local API smoke check passed against Neon: real admin login, persisted session, shop directory and logout. A transient DNS lookup failure was observed on the first attempt; connection acquisition now retries bounded transient failures without replaying SQL.

## Delivered implementation

Customer/shop/admin screens, database-backed authentication/MFA/rate limits, registration/approval, encrypted chunk uploads, shop-PC preparation protocol, actual PDF previews, direct UPI/cash gates, persistent ledger/refunds/totals, printer leasing/revocation, local submission journal/cleanup, physical-output confirmation/deletion, Vercel packaging, Docker processor and Windows setup/startup scripts.

Docs include PRD, architecture/data, security/privacy, API, page designs, release tests, deployment and recovery. The optional old gateway adapter is disabled; direct UPI is the chosen payment method.

## External validation still required

| Area | Remaining evidence |
|---|---|
| Vercel | User-managed deployment, live origin/cookies/routes/cron/static worker checks |
| Shop processor | Docker not available in this environment; build/start, signatures and LibreOffice conversion not exercised live |
| Physical printer | Actual model unavailable; driver capability, paper output, jam/restart and spool-retention checks required |
| Banking | No real UPI payment or refund executed; owner verification procedure must be piloted |
| Operations | Backup retention/restore drill, alert destination, capacity and accessibility audit |

This is a deployment handoff with verified application/database behavior, not a claim that an untested shop or deployment is already running in production.
