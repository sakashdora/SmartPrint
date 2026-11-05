# 13 · Existing Functionality Improvement Report

Improvements to the **current** product, independent of Education Mode. Priority: **P0** fix first (risk to live Business Mode), **P1** next, **P2** worthwhile. Root causes are from code reading **[V]**; effects on real hardware/Render are **[U]** until measured. Every item says how Business regression is guarded.

## 1. Reliability and correctness

| # | P | Problem | Root cause | Proposed change | Regression guard |
|---|---|---|---|---|---|
| 1 | P0 | Printer pause and backlog hold vanish on restart/deploy | `deviceMetadata` Map (`devices.js:172`), no column | `devices.paused boolean`, `paused_note`; keep Map only as a cache; read/write DB in pause route, `holdBacklog`, claim | extend `print-backlog-and-spooler.test.js`: pause → recreate app on same DB → claim returns null |
| 2 | P0 | Anonymous quota exhaustion (S1) | unordered quotes keep `documents` for 24 h and count toward the 200 MiB quota | on quote expiry, delete its document unless an order or another live quote (reprice reuses documents) references it (cleanup joins `quotes.used=0 AND expires<now AND no order`); count only live-order documents + current-quote uploads against quota; per-IP quote cap | new test: 10 unordered quotes then expire → quota recovered; existing quote/order tests unchanged |
| 3 | P0 | Schema changes may silently not apply in production | runtime-role `migrate()` swallows permission errors; unversioned | `schema_migrations` + owner-role deploy step + startup version check ([07](07-database-er-diagram.md) §8) | CI applies migrations to empty and to a baseline-dump database |
| 4 | P0 | No staging; local `npm start` talks to production DB | README + `.env` convention | separate Neon branch for dev/staging; refuse to start non-production against a database whose name matches production unless `ALLOW_PROD_DB=1`; update README | startup guard unit test |
| 5 | P1 | Audit holes: `order_history` insert failures swallowed in 8 places | savepoint + `console.warn` written for legacy schemas | make inserts mandatory in the same transaction (schema is guaranteed after #3); remove savepoints | existing lifecycle tests assert history rows; add count assertions |
| 6 | P1 | Partial prints invisible | connector reads `PagesPrinted` but never reports it | add optional `pages_printed` to `/api/device/jobs/:id/events` (additive) and show on owner screen | backwards-compatible: old connectors omit it |
| 7 | P1 | `claimed` lease expiry forces manual review although nothing was sent | conservative sweep marks all expired leases `uncertain` | for state `claimed` (journal-before-submit proves no spool) re-queue automatically; keep `submitted`/`awaiting_confirmation` → `needs_review` | targeted unit tests on `sweepLeases`; Business owners see fewer manual reviews |
| 8 | P1 | Dead state machine, documentation claims otherwise | `transitionOrder` unused | either wire `PERMITTED_TRANSITIONS` as an assertion layer (`assertTransition(from,to)` called next to each conditional UPDATE) or delete and fix docs; recommend assertion layer | tests iterate the matrix and fail on any SQL that moves an order to an unpermitted state |
| 9 | P1 | Direct-quote orders can wait forever for a missing colour/duplex printer | capability checked only in `queuePreparation` and claim, not at `POST /api/orders` | at order creation, if a device is online but none is capable → return actionable 409 for colour/duplex choice; if no device online keep current behaviour | `printer-connector-resolution.test.js` additions |
| 10 | P1 | Owner remote print ignores capability | `/api/owner/print-job` picks latest heartbeat device regardless of options | filter devices with `printerSupports` | new test |
| 11 | P2 | Customers can change an order's payment method to `online` | `/payment` and `/payment/verify` rewrite `orders.method` | only allow when `method` was `online` or flip only after provider order creation succeeds; never from `cash` once the owner confirmed | existing payment tests + one new |
| 12 | P2 | Idempotency helper not atomic | read-then-write | adopt reserve-first pattern ([08](08-api-architecture-endpoint-map.md) §5) for new routes; for v1 keep behaviour (guarded by `quotes.used` and `payment='pending'`) | concurrency tests on PostgreSQL |
| 13 | P2 | Gateway refunds/partial refunds unsupported | `refunds.order_id` PK; refund route rejects `online` | additive `refund_events` table keyed by provider refund id; keep existing `refunds` view for owner UI | ledger totals tests |

## 2. Upload, preview, crop, pricing, speed

| # | P | Observation | Cause | Change |
|---|---|---|---|---|
| 14 | P1 | Upload overhead | base64 inside JSON (+33 %), 1 MiB chunks, only 3 parallel workers, each chunk = session-less but rate-limited DB insert + AES | add `PUT /api/uploads/:id/chunks/:part` accepting `application/octet-stream` (additive; client prefers it), 4 MiB chunks, resumable by listing received parts; expected benefit **[A]** ~25–35 % less bytes/CPU, to be measured |
| 15 | P1 | Memory spikes during quote | `resolveUploads` → Buffer.concat → base64 string → decode again | stream chunks into `prepare()` as Buffers; avoid base64 round-trip in the web process (processor client keeps JSON only when remote) |
| 16 | P1 | CPU-bound PDF work on web thread | `pdf-lib` in-process | run `prepare()` in a `worker_threads` pool (size 2) with timeout; the existing `ConcurrencyQueue` caps concurrency |
| 17 | P2 | Pricing: `price()` ignores duplex discount and paper size; no minimum order; no per-shop rule beyond bw/colour | by design | keep as is for live shops; Education pricing rules are separate ([04](04-flexible-institution-configuration.md)); optionally add shop-level minimum later behind `shops.version` bump |
| 18 | P2 | Queue-position query O(queue) | JSON priority parse per order | compute from an indexed `priority` column once added (Business-hardening phase); until then cache per shop for 2 s |
| 19 | P2 | Crop/preview | `crop.js` 1 426 lines, tests exist (`crop.test.js`, `customer-editor-tools.test.js`) | no functional defects found in tests; verify on real low-end phones **[U]**; add Playwright smoke on Android/iOS emulation |

## 3. Mobile responsiveness and usability

- **[T]** `mobile-responsive-customer-panel.test.js` passes (structure-level). **[U]** no real-device pass.
- Admin dashboard: pagination, server-side search, shop detail view, rejection reason, real Reports (orders/revenue per day per shop, failure rate, agent uptime) instead of three counters; Settings page with real platform settings.
- Owner dashboard: surface `uncertain` jobs prominently with a single decision UI, printer health card (paper/toner when the driver reports it), CSV export for orders (only transactions exported today).
- Customer: show shop open/printer-offline status **before** upload (cheap `GET /api/shops/:slug` field `printers_online`), clear messages for each 4xx (several already good).
- Error messages: v1 returns `{error:"…"}` strings; add stable `code` (additive) so the UI can localise.

## 4. Authentication and redirects

- Owners: enforce MFA in production by default (S3) with a grace period banner; recovery codes already exist.
- Add e-mail verification + self-service password reset (needs e-mail service) – required anyway for Education, benefits Business.
- Redirect logic is duplicated 6× in `app.js` (`admin/track/owner`); centralise in one `landingFor(user)` helper (reduces risk when Education roles are added).
- Per-identifier throttle with delay instead of 15-minute lockout (S7).

## 5. Agent stability (connector)

| Issue | Evidence | Fix |
|---|---|---|
| Plain-text token | `connector/index.js:342` | DPAPI protection (`ProtectedData` via PowerShell/`node-dpapi`) |
| Needs Node installed; no auto-update | `start-connector.bat`, no updater | signed single executable + auto-update (agent v3) |
| Single instance by TCP port | bridge `EADDRINUSE` exit | named mutex + service wrapper; keep port as UI link only |
| Polling load | §[12](12-scalability-and-extensibility-strategy.md) | idle backoff now, long-poll in v2 protocol |
| SumatraPDF download without checksum | `sumatra-helper.js:40-54` | pin SHA-256, ship alongside installer |
| Printer fallback guessing | `pickPrinter` falls back to default/any physical printer | log + report `printer_substituted` to server and show to owner (a job silently printing on a different printer is surprising; Business tests cover current picking) |

## 6. Payment reconciliation

| Gap | Improvement |
|---|---|
| UPI is manual: owner types the 12-digit reference | keep; add optional bank-statement CSV import to match references, and a daily "unmatched UPI references" list |
| Razorpay: webhook only handles `payment.captured`; unknown/mismatched payments return 409 and are lost to the platform | record every event in `payment_events` with status; alert on orphans; handle `payment.failed`, `refund.processed`, `order.paid` |
| Verify endpoint and webhook use different `payment_events` keys (`payment_id` vs `event_id`) | safe today because `collect()` is guarded by `payment='pending'`; unify key to payment id for clarity |
| No daily totals vs ledger check | nightly job: `SUM(transactions)` vs `payment_events` captured amounts per shop |

## 7. Job cancellation, retry, duplicate-print prevention

Verified strong: `cancelRefusal`, order-row-first locking, lease deletion only in `claimed`, retry only after reported failure, journal-before-submit, spooler watcher. Improvements: attempt history table (today `opts.attempt` increments inside JSON), a `print_attempt_log` additive table for Business too so owners can see "attempt 2 of job – attempt 1 printed 0 pages"; surface Windows queue clean-up result to the owner.

## 8. Technical-debt reduction (low risk, mechanical)

1. Remove dead code (`state-machine` or wire it), unused import, duplicate session/MFA logic.
2. Move routes out of `server/index.js` into modules unchanged, one group per PR, test after each.
3. Add ESLint with `no-unsanitised`-style rule for template literals feeding `innerHTML` (forces `escape()` usage) and an import-boundary rule.
4. CI: PostgreSQL service container, run the full suite on both SQLite and PostgreSQL until SQLite is retired, add secret scan and the API contract snapshot.
5. Fix doc drift (scrypt vs Argon2id, state machine claim, test counts).

## 9. Sequence

P0 items 1–4 are Phase 0/1 in [14](14-phased-implementation-roadmap.md); they are prerequisites for adding any Education table.
