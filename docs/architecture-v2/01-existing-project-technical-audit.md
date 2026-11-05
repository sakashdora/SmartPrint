# 01 · Existing Project Technical Audit

Scope: the repository at commit `1a1e59b` (main, 2026-11-04). Read-only analysis. Nothing was modified, migrated, deployed or pushed.

**Evidence labels used in every document in this folder**

| Tag | Meaning |
|---|---|
| **[V]** | Verified by reading the source and following the execution path |
| **[T]** | Verified by running the existing automated test suite locally |
| **[A]** | Assumption – could not be verified from the repository |
| **[U]** | Unverifiable in this analysis (live printers, Render, Neon, Razorpay, real UPI) |
| **[R]** | Recommendation / design proposal |

## 0. What was and was not tested

- **[T]** `npm test` was run once, with `DATABASE_URL` and `MIGRATION_DATABASE_URL` unset, so every test used an in-memory SQLite database. Result: **97 tests, 96 pass, 0 fail, 1 skipped** (68 s). The skipped test is `test/postgres-integration.test.js`, which needs `SMARTPRINT_TEST_DATABASE_URL`.
- **[U]** Not tested: live Render deployment, Neon/PostgreSQL behaviour, physical printers, real Razorpay/UPI, ClamAV/LibreOffice processor, load or concurrency on PostgreSQL, browsers on real phones.
- **[V]** The production connector on this PC, the production database and the printers were not touched.
- The existing documents in `docs/` were treated as claims, not evidence; several are contradicted by the code (see §9).

## 1. System inventory

| Layer | What exists | Source |
|---|---|---|
| Runtime | Node 24, Express 5, ESM, single process | `package.json`, `server/index.js` |
| Database | PostgreSQL (Neon, schema `smartprint`) in production; SQLite (`node:sqlite`) for dev/tests; one `schema.js` string, SQL rewritten by a regex to add the schema prefix | `server/db.js`, `server/schema.js` |
| Frontend | Vanilla ES modules, hash router, `innerHTML` templates, ~9 000 lines CSS; no build step beyond copying pdf.js | `public/*` |
| Document processing | `pdf-lib` + `sharp` in the web process; optional isolated processor (LibreOffice + ClamAV) on the shop PC | `server/printing.js`, `processor/` |
| Printing | "Connector": Node script on a Windows PC, one printer per connector, SumatraPDF, local bridge on `127.0.0.1:17631` | `connector/` |
| Auth | Argon2id passwords, DB-backed hashed sessions (8 h cookie), TOTP, recovery codes, WebAuthn passkeys | `server/auth.js`, `server/security.js` |
| Payments | Cash (owner confirms), direct UPI (owner confirms by 12-digit reference), Razorpay online (webhook + client verify), manual refunds | `server/payments.js`, `server/index.js` |
| Hosting | Render web service (free plan), `autoDeploy: true`; Vercel and Railway configs also present | `render.yaml`, `vercel.json`, `railway.json` |
| CI | GitHub Actions: build, test, `npm audit` on ubuntu + windows; **no PostgreSQL service** | `.github/workflows/ci.yml` |

### 1.1 Roles and actors that actually exist [V]

| Actor | Real implementation |
|---|---|
| Platform admin | `users.role='admin'`, created only by `scripts/provision-admin.js`; MFA mandatory in production |
| Shop owner | `users.role='owner'`, exactly one shop per owner (`one_active_shop_per_owner` unique index) |
| Customer | **Anonymous.** A bearer "receipt token" per order. The `customer` role exists in the CHECK constraint and in front-end redirects, but **no code path creates a customer user** – it is dead. |
| Device (printer connector) | Bearer token hashed in `devices.token`; one device row = one printer = one credential |

> Consequence for the requested design: there is **no Business-Mode flag, no organization concept, no customer/student account, no wallet, no staff sub-accounts and no multi-printer agent** today. "Business Mode" is simply the entire current product. Education Mode is therefore a *new tenant type*, not a toggle.

### 1.2 Pages (hash routes in `public/app.js`) [V]

`#print` (customer upload/preview/crop/pay), `#track` (receipt tracking), `#login`, `#register` (shop registration), `#security` (MFA/passkey enrolment), `#account`; owner: `#owner #queue #transactions #payments #printers #settings`; admin: `#admin #shops #audit #reports #settings-admin`. `#reports` and `#settings-admin` are near-empty placeholders (three counters; one static paragraph).

### 1.3 API surface [V]

88 route handlers in `server/` (33 GET, 49 POST, 4 PUT, 2 DELETE). Groups: public shop/quote/order (`/api/shops`, `/api/uploads`, `/api/quotes`, `/api/orders`), auth (`/api/auth/*` and `/api/me`, ~16), owner (`/api/owner/*`, ~38), admin (`/api/admin/*`, 6 read + 1 write), device (`/api/device/*`, 11), notifications/SSE, payments webhook, ops (`/api/health`, `/readyz`, `/maintenance`). Full map in [08](08-api-architecture-endpoint-map.md).

### 1.4 Database (24 tables) [V]

`users, sessions, mfa, passkeys, rate_limits, shops, shop_payments, upi_receipts, uploads, upload_chunks, preparations, documents, quotes, orders, order_history, transactions, refunds, payment_events, idempotency_keys, devices, print_leases, notifications, audit, worker_status`.
Tenancy is **shop_id on most tables**; there is no organization table. `order_history`, `upi_receipts`, `print_leases`, `audit`, `idempotency_keys` carry no `shop_id`.

## 2. Execution-flow findings (how the main journeys really work)

### 2.1 Customer → paid → queued
1. `POST /api/uploads` + `PUT …/chunks/:n` store AES-256-GCM chunks in `upload_chunks` (base64 inside JSON, 1 MiB chunks, ≤20 MiB). [V]
2. `POST /api/quotes` either queues a **preparation** for the shop PC (when an online device exists and the file is not a simple PDF/PNG/JPG) or processes on the web process; stores the prepared PDF encrypted in `documents` (BYTEA, 24 h expiry) and a 15-minute quote. [V `server/index.js:225-254`]
3. `POST /api/orders` atomically burns the quote (`UPDATE quotes SET used=1 … AND used=0`) and inserts the order; optional `Idempotency-Key`. [V]
4. Payment: cash/UPI → owner confirms → `collect()` flips `payment='pending'→'paid'` and inserts a `transactions` row in one transaction; online → Razorpay order, then either webhook or client verify call, both converging on `collect()`. [V]

### 2.2 Queue → print
`POST /api/device/claim` (connector polls about once per second) runs a transaction: heartbeat update, refuse if the device already holds an active lease, select up to 200 queued paid orders, sort by `options.priority` then `created` in JavaScript, skip jobs the printer cannot serve (colour/duplex), then `UPDATE orders SET status='printing' WHERE status='queued'` and insert a `print_leases` row. The conditional UPDATE is what makes the claim atomic. [V `server/devices.js:610-645`]

Lease states: `claimed → submitted → awaiting_confirmation`, plus `failed`/`uncertain`. The connector writes a local journal file **before** telling the server `submitted`, then prints. Expired leases are swept to `uncertain → needs_review`; a retry is only possible after a device-reported failure or an owner "print failed" decision. Final `completed` requires the **owner to confirm the paper**, which deletes the live document. [V]

### 2.3 Connector
- Settings (URL, device token, printer name) are stored **in plain JSON** in `%LOCALAPPDATA%\SmartPrintConnector\settings.json`. [V `connector/index.js:342`]
- Backoff on claim errors (1 s → 10 s), 10 s heartbeat, 1.5 s preparation poll, 60 s printer scan. [V]
- Printer name is re-resolved per job (copy-N, USB port change); virtual printers are excluded; a spooler watcher removes jobs the printer never took. [V `connector/sumatra-helper.js`]
- The spooler reports `PagesPrinted`, but **the connector never sends pages-printed to the server** – partial printing is invisible to the platform. [V `sumatra-helper.js:315`, `connector/index.js:441`]
- Without the cloud the connector cannot print at all; there is no local queue or offline mode, only the submission journal. [V]

## 3. Working functionality (all **[T]** – tests pass on SQLite; **[U]** on production/hardware)

| Area | Evidence |
|---|---|
| Cash, UPI and Razorpay payment collection with duplicate-event protection (`payment_events`, `WHERE payment='pending'`) | `test/smartprint.test.js`, `production.test.js`, `concurrency-idempotency.test.js` |
| Quote replay protection, order idempotency | `order-submission-resilience.test.js` |
| Owner-side tenant isolation (other shop's order → 404) | `smartprint.test.js`, `printer-shop-isolation.test.js`, `security-architecture.test.js` |
| Lease lifecycle, uncertain-output handling, safe cancellation, safe retry | `print-pipeline-resilience.test.js`, `cancellation-routing.test.js`, `print-backlog-and-spooler.test.js` |
| Capability-aware routing (colour/duplex jobs never claimed by an incapable printer) | `printer-connector-resolution.test.js`, claim logic [V] |
| Argon2id, TOTP replay protection, recovery codes, WebAuthn challenge single-use | `two-factor-recovery.test.js`, `webauthn-security.test.js`, `authentication-audit-repair.test.js` |
| Encrypted chunked uploads, preparation protocol, PDF normalisation (2-up, card, crop) | `customer-upload-lifecycle.test.js`, `preparation.test.js`, `crop.test.js` |
| Document deletion on confirmed output / cancel / refund / expiry | `smartprint.test.js`, `reliability.test.js` |

## 4. Partially working

| # | Finding | Evidence |
|---|---|---|
| P1 | **Printer pause and the backlog hold are stored only in a process-memory `Map`.** A restart/deploy (Render restarts on every push) un-pauses printers, which can release exactly the backlog `holdBacklog()` was written to stop. | `server/devices.js:172`, `devices` table has no pause column [V] |
| P2 | Several other control-plane states are memory-only: pending connector keys, scanned-printer lists, WebAuthn challenges, "already alerted" set, QR cache, SSE client registry. Safe on one instance, wrong on two, lost on restart. | `devices.js:44,176`, `auth.js:12`, `notifications.js:4` [V] |
| P3 | Multiple printers per shop: the schema allows many `devices`, but a PC runs **one** connector (bridge port) and a connector prints to **one** printer. Several printers need several PCs or several user profiles. | `connector/index.js:274-279` [V] |
| P4 | Online (Razorpay) payments are wired but only valid in `single_merchant` mode – money would settle to the **platform's** merchant account, with no per-shop settlement or payout ledger. README states direct UPI is the intended method. | `server/config.js:62-78` [V] |
| P5 | Gateway refunds cannot be recorded: the refund route rejects `online` orders and `refunds.order_id` is the primary key (one, full refund per order). Net totals therefore ignore gateway refunds. | `payments.js:130`, `schema.js:19` [V] |
| P6 | Shop registration → admin approval exists, but there is no rejection state, reason, notification or e-mail; there is **no e-mail capability at all** in the code base (no mailer dependency). | `server/index.js:175-185`, `index.js:598` [V] |
| P7 | Documented central state machine is **dead code**: `transitionOrder` is imported in `server/index.js` and never called; real transitions are ad-hoc conditional UPDATEs (which are correct, but unreviewed as a set). | `index.js:18`, `state-machine.js` [V] |
| P8 | Admin console: read-only lists, no pagination, client-side search, placeholder reports/settings. | `public/app.js:715-718` [V] |
| P9 | Retention: live documents are deleted correctly, but `orders.options` (including the customer's file name) is kept forever, and `quotes`, `notifications`, `order_history`, `audit`, `idempotency_keys`, `payment_events` are **never purged**. | grep of `DELETE FROM` in `server/` [V] |

## 4b. Broken functionality

No feature was found **broken in a way the 97 tests or the code paths show** **[T][V]**. Items that behave incorrectly under specific conditions are listed as defects in §5 (S1, S11) and as partial functionality in §4 (P1, P5). Features that cannot work as implemented:

| Item | Why it cannot work | Evidence |
|---|---|---|
| Customer sign-in / `#track` for a `customer` user | No code creates a `customer` user; the role and redirects are dead | `INSERT INTO users` occurs only for owner, admin and demo seeds [V] |
| Several printers behind one connector | Connector holds a single printer name and one bridge port per PC | `connector/index.js` [V] |
| Recording a gateway refund | Refund route rejects `online`; `refunds` allows one row per order | `payments.js:130`, `schema.js:19` [V] |
| Printing with no cloud connection | Claim, document download and every state change require the server | `connector/index.js` [V] |

## 4c. Missing functionality (relative to the stated goals)

| Area | Missing today **[V]** |
|---|---|
| Tenancy | Organizations, memberships, org-level roles, multi-user shops, multi-shop owners |
| Registration | Organization types, representative details, rejection with reason, request-info, e-mail verification, notification |
| Identity | Student/staff accounts, College ID login, bulk import, self-service password reset, session list/idle timeout |
| Education | Institutions, campuses, departments, pools, policies, usage reports, operator console |
| Money | Wallet, ledger, holds, top-ups, per-organization gateway, partial refunds, reconciliation jobs |
| Printing | Multi-printer agent, per-agent credentials and rotation, attempt history, pages-printed reporting, release-at-printer, weighted fair queue, persistent local queue, offline mode, agent auto-update, agent health alerts |
| Security | Per-tenant encryption keys, support-access grants, tamper-evident audit, central monitoring and alerting, secret scanning (added in Phase 1 CI), documented backup/restore drill |
| Operations | Staging environment, PostgreSQL in CI (added in Phase 1), deploy promotion gate, error tracker |
| Admin console | Pagination, server-side search, real reports and platform settings |

## 5. Defects and risks (security, correctness)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | **High** | **Anonymous storage-quota exhaustion.** `/api/quotes` writes an encrypted `documents` row with a 24 h expiry for every quote even if never ordered (the quote itself lives 15 min). The per-shop quota (200 MiB of uploads + documents) counts these rows, so an unauthenticated caller who knows a shop slug (printed on the QR) can fill it with ~10 quotes and make every customer of that shop receive HTTP 429 for up to 24 h. Not exploited; derived from code. | `index.js:248-250`, `uploads.js:14-16`, no quote→document cleanup [V] |
| S2 | Medium | One global `FILE_ENCRYPTION_KEY` protects all tenants' documents, MFA secrets; no key id, no rotation tooling (docs admit this). | `security.js:35-46` [V] |
| S3 | Medium | Owner MFA is **optional** in production (`ENFORCE_MFA` unset in `render.yaml`); only admins are forced. | `index.js:95`, `render.yaml` [V]; actual Render env [U] |
| S4 | Medium | No e-mail verification, no self-service password reset (operator CLI only), no login alerts. Unacceptable for thousands of students. | §P6 [V] |
| S5 | Medium | Connector device token stored in plain text on the shop PC; no expiry; one static bearer. | `connector/index.js:342` [V] |
| S6 | Low-Med | Connector bridge trusts any `http://localhost:*` origin and accepts `replace:true` re-link; a malicious local web app could redirect the connector (and therefore customer documents) to another server. | `local-bridge.js:14-17,79` [V] |
| S7 | Low | Per-e-mail login limiter (10/15 min) lets anyone lock a known owner out of sign-in for 15 min. | `auth.js:102` [V] |
| S8 | Low | Webhook secret falls back to the API key secret. | `index.js:137` [V] |
| S9 | Low | CSP differs between `server/index.js` (allows Razorpay) and `vercel.json` (does not); `style-src 'unsafe-inline'`. | [V] |
| S10 | Low | `/api/health` leaks mode/commit; commit falls back to a hard-coded `0bf8e4f`. | `index.js:165` [V] |
| S11 | Info | Customers can flip an order's method to `online` (`/payment`, `/payment/verify`) regardless of the original choice, which also makes a cash order un-confirmable by the owner. Harmless to money, confusing operationally. | `index.js:355-358,380-383` [V] |
| S12 | Ops | Repository is public; project memory records a password exposed in commit `885501f` (rotation was advised). | memory note; **[U]** whether rotated |
| S13 | Ops | README tells developers to run `npm start` against the **production Neon database** (`.env`), and there is no staging environment. | `README.md`, memory note [V] |

## 6. Database design limitations [V]

1. **No migration system.** `migrate()` re-runs `CREATE IF NOT EXISTS`, then a hard-coded list of `ALTER … ADD COLUMN IF NOT EXISTS`, on **every web-process start** with the *runtime* role. Permission errors are swallowed, so a schema change can silently not apply in production. `users_role_check` is dropped and re-created on every boot (`db.js:87-94`). `npm start` runs `migrate.js` first, which uses `MIGRATION_DATABASE_URL || DATABASE_URL`; whether Render has the owner URL is **[U]**.
2. **Regex SQL rewriting.** Table names are listed in a constant (`db.js:5`); any new table not added there is silently created/queried in the wrong schema. Education mode would add ~30 tables.
3. **Dual dialect** forces lowest-common-denominator SQL: no `FOR UPDATE SKIP LOCKED`, `timestamptz`, `jsonb`, partial-index reliance, RLS, triggers or `numeric`. CI never runs PostgreSQL, so lock behaviour is untested (`SMARTPRINT_TEST_DATABASE_URL` test is skipped by default).
4. All timestamps are ISO **TEXT**; job options (including priority, attempt counter, file name) are JSON in **TEXT** (`options LIKE '%SmartPrint_Diagnostic_Test.pdf%'` is used as a query, `devices.js:196`).
5. No CHECK constraints on `orders.status/payment/method`, `print_leases.state`, `transactions.method`; no FK from `orders.document_id`/`quotes.document_id` to `documents`.
6. One shop per owner is a hard unique index – chains and shop staff accounts are impossible.
7. Missing indexes for admin/reporting: `audit(created)`, `orders(created)`, `transactions(created)`, `print_leases(expires,state)`, `quotes(expires)`.
8. `transactions.order_id UNIQUE` and `refunds.order_id PRIMARY KEY` hard-wire "one payment, at most one full refund per order".
9. `order_history` inserts are wrapped in savepoints whose failure is swallowed (`console.warn`) in 8 places – the audit trail can silently have holes.
10. Documents (≤40 MiB) are stored as BYTEA in the primary database. [V] On Neon's storage/egress limits this is the first thing that will hurt (**[A]** plan limits).

## 7. Performance and scalability [V unless noted]

| Bottleneck | Detail |
|---|---|
| Idle polling | Each connector issues about 1 claim/s + 1 preparation claim/1.5 s + 1 heartbeat/10 s = **~1.8 req/s, 24/7**, each doing 2–4 SQL statements (device lookup, heartbeat UPDATE, claim transaction). 100 shops ≈ 180 req/s ≈ 500+ statements/s against a pool of **5** connections (`db.js:12`). It also prevents Neon scale-to-zero and Render sleep. |
| Per-request overhead | Every authenticated request runs a session JOIN plus a shop lookup; every mutation also upserts `rate_limits` (a DB write per request). |
| Memory amplification | `resolveUploads` concatenates all chunks and base64-encodes them (≈ 1.33×), `prepare()` decodes again and builds PDFs in RAM; up to 8 concurrent (`ConcurrencyQueue(8)`) on a 512 MB Render free instance **[A plan]**. |
| Event loop | `pdf-lib` page copying/embedding is CPU-bound JavaScript on the web thread; one 100-page job can stall heartbeats and requests for every shop on that process. |
| Queue position | `GET /api/orders/:id` loads and `JSON.parse`s every queued order of the shop on each 5-second customer poll (O(queue) per poll). |
| Cleanup | Runs inside the web process every 60 s and on boot; loops per expired document; no leader election (two instances would duplicate work). |
| Polling UI | Owner dashboard polls orders/summary/devices every 5 s; there is an SSE stream but only for notifications. |

## 8. Technical debt

- `public/app.js` (1 083 lines), `customer.js` (1 535), `workspaces.js` (1 149), `dashboards.js` (991) render by string templates and rely on a hand-written `escape()` at each interpolation; no linter/test enforces it (the `cleanPrinterList` comment documents one near-miss).
- Duplicated session/MFA-enforcement logic in `index.js` and `auth.js`.
- Error handling convention (`throw fail(...)` inside Express 5 async handlers) is good; business logic is embedded in route handlers (`index.js` 690 lines) with no service layer.
- Docs drift (see §9). `scratch/`, `.data/` fixtures on the dev PC; four presentation files untracked at repo root.

## 9. Documentation versus code (examples)

| Document claim | Reality |
|---|---|
| `docs/security-audit.md`: passwords use scrypt | Code uses **Argon2id**; scrypt only for legacy hashes `[V security.js:9-34]` |
| `docs/architecture-audit.md`: "centralized state machine… addressed" | `transitionOrder` unused `[V]` |
| `docs/security-audit.md`: "Zero-retention… deleted immediately" | True for live PDFs; order metadata and file names persist (§P9) |
| `docs/testing-strategy.md`: "against real PostgreSQL (Neon) or in-memory SQLite" | CI and default `npm test` are SQLite only |
| README: "eight automated test groups" | 97 tests today |

## 10. Opportunities (feeds [13](13-existing-functionality-improvement-report.md))

Persisted printer state; agent long-poll instead of 1 s polling; quote-document lifecycle; migration framework + PostgreSQL-only CI; pages-printed reporting; owner MFA enforcement; e-mail service (verification, reset, approvals); pagination and server-side search for admin; request-scoped metrics; per-tenant keys; refund/partial-refund ledger redesign.

## 11. Dependencies between current modules (for Business Mode protection)

| Module | Used by | Proposed Education reuse |
|---|---|---|
| `security.js` (Argon2id, AES-GCM, TOTP, rate limit) | all auth, uploads, devices | **Reuse** unchanged |
| `auth.js` sessions/MFA/passkeys | owner/admin | **Extend** (org context in session) |
| `print-options.js` / `printing.js` (`validateOptions`, `prepare`, `price`) | quotes, devices, processor | **Reuse** `prepare/validateOptions`; Education pricing is new |
| `printer-capabilities.js` | connector, devices | **Reuse** |
| `idempotency.js` | order, cash, UPI, refund routes | **Replace** for new modules (not atomic, see [10](10-wallet-payment-offline-architecture.md)) |
| `devices.js` / `print_leases` / `/api/device/*` | Business printing | **Do not change**; new agent protocol alongside |
| `orders`, `transactions`, `refunds`, `shop_payments`, `upi_receipts` | Business money | **Do not reuse** for Education |
| `notifications.js` (SSE) | owner dashboard | Reuse pattern, not tables |
| `audit` table | everything | Superseded by org-scoped audit for new modules |
