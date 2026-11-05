# 08 · API Architecture and Endpoint Map

## 1. Versioning and compatibility policy **[R]**

| Rule | Detail |
|---|---|
| Existing `/api/*` = **v1, frozen** | 88 handlers listed in §2. Allowed changes: additive response fields, bug fixes, new optional request fields. No removals, renames or status-code changes. A contract test snapshot (`test/business-regression/api-contract.test.js`) records every v1 route, auth requirement and response shape key set. |
| New capabilities = `/api/v2/*` | Education, platform, agent v2, shared services. Error envelope `{error:{code,message,request_id}}`. |
| Agents | `X-Agent-Protocol: 1|2` header; server advertises `min_protocol`, `latest_agent_version`; protocol 1 = legacy `/api/device/*` forever (until all shops migrate). |
| Deprecation | `Deprecation`/`Sunset` headers + audit log of v1 callers; removal needs ≥ 6 months and zero callers in logs. |
| Idempotency | v2 POSTs creating money/jobs require `Idempotency-Key`; stored atomically (§5). |
| Pagination | v2 lists use keyset pagination (`?after=`, `limit ≤ 200`); v1 unchanged. |
| Auth modes | Browser session cookie (+ Origin check) · Agent bearer credential (no cookie, no Origin check, per-agent rate limit) · Gateway webhook (signature) · Cron secret. |
| OpenAPI | v2 described by an OpenAPI 3.1 file checked in CI (route ↔ spec drift fails the build). |

## 2. Existing v1 map (**[V]**, for the regression contract)

| Group | Endpoints | Auth |
|---|---|---|
| Public customer | `GET /api/health` · `GET /api/shops`, `/api/shops/:slug` · `POST /api/uploads`, `PUT /api/uploads/:id/chunks/:part` · `POST /api/quotes`, `/api/quotes/:id/reprice`, `GET /api/quotes/:id/preview` · `POST /api/orders`, `GET /api/orders/:id` · `POST /api/orders/:id/payment`, `/payment/verify` · `GET/POST /api/orders/:id/upi` · `GET /api/preparations/:id` | none / receipt or quote bearer token |
| Auth | `POST /api/auth/login, logout, register, password` · `GET /api/me` · `/api/auth/mfa/{status,setup,confirm,verify,disable,recovery-codes/regenerate}` · `/api/auth/webauthn/{register-options,register-verify,auth-options,auth-verify}` · `DELETE /api/auth/webauthn/passkeys/:id` | session / none |
| Owner | `/api/owner/shop, orders, summary, transactions, qr, payments (GET/PUT), prices (PUT), refunds, devices (+pause, heartbeat, test-print, DELETE), printers/{scan,scanned-report,autoconnect}, print-job, notifications(+stream,read,mark-all-read)` · `POST /api/owner/orders/:id/{cash,upi-confirm,start,complete,cancel,retry,resolve-failed,priority,refund}` · `GET /api/owner/orders/:id/document` · `GET /api/local/printers` | session role `owner` |
| Admin | `GET /api/admin/{shops,orders,payments,devices,audit,stats}` · `POST /api/admin/shops/:id/status` | session role `admin` |
| Device | `POST /api/device/{heartbeat,claim,printers/scanned}` · `POST /api/device/jobs/:id/events` · `GET /api/device/jobs/:id/document` · `POST /api/device/preparations/{claim,:id/result,:id/complete,:id/fail}` · `GET …/files/:file/:part` · `PUT …/result/:part` | device bearer (+ lease token) |
| Payments/ops | `POST /api/payments/webhook` (HMAC) · `GET /maintenance` (cron secret) · `GET /readyz` | signature / secret / none |

## 3. New v2 map **[R]**

### 3.1 Platform (Super Admin)
| Method & path | Permission | Notes |
|---|---|---|
| `POST /api/v2/registrations` | public (rate limited, verified e-mail) | business or education |
| `GET /api/v2/registrations/:id/status` | token from e-mail | applicant view |
| `POST /api/v2/registrations/:id/verify-email` | token | |
| `GET /api/v2/platform/registrations?status=` | `registrations.review` | keyset |
| `POST /api/v2/platform/registrations/:id/{approve,reject,request-info}` | `registrations.review` | reason required for reject/info |
| `GET /api/v2/platform/organizations`, `GET …/:id` | `organizations.read_metadata` | no documents/wallet |
| `POST /api/v2/platform/organizations/:id/{activate,suspend}` | `organizations.activate/suspend` | dual-writes `shops.status` for business |
| `PUT /api/v2/platform/organizations/:id/features` | `features.toggle` | |
| `POST /api/v2/platform/support-access` | `support_access.request` | needs institution approval |
| `GET /api/v2/platform/audit` | `platform.audit.read` | |

### 3.2 Identity and sessions
| Path | Notes |
|---|---|
| `POST /api/v2/auth/login` | identifier = email or `{institution_code, id}`; returns memberships / redirect |
| `POST /api/v2/auth/session/org` | choose active organization |
| `POST /api/v2/auth/invitations/:token/accept` | set password from invitation |
| `POST /api/v2/auth/password/{forgot,reset}` | e-mail link |
| `GET /api/v2/me`, `GET/DELETE /api/v2/me/sessions[/:id]` | |
| v1 `/api/auth/mfa/*`, `/webauthn/*` | reused as-is for all roles |

### 3.3 Institution administration (`/api/v2/edu`)
| Path | Permission |
|---|---|
| `GET/PUT /institution`, `GET/PUT /institution/policies` | `institution.profile.edit`, `policies.edit` |
| `GET/POST /campuses`, `PATCH /campuses/:id` | `campuses.manage` |
| `GET/POST /departments`, `PATCH /departments/:id` | `departments.manage` |
| `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/{deactivate,reset-password,assign-role}` | `users.*` |
| `POST /users/import` (dry-run flag) → `GET /imports/:id` (row errors) | `users.import` |
| `GET/POST /agents`, `POST /agents/:id/{rotate-credential,revoke}`, `GET /agents/:id/health` | `agents.*` |
| `GET/POST /printers`, `PATCH /printers/:id`, `POST /printers/:id/{pause,resume,reassign,deactivate}` | `printers.*` |
| `GET/POST /pools`, `PUT /pools/:id/members`, `PUT /pools/:id/access` | `pools.manage` |
| `GET/PUT /pricing-rules` | `pricing.edit` |
| `GET /reports/{usage,wallet,printers,departments}` · `GET /audit` · `GET/PUT /retention` | `reports.*`, `audit.read`, `retention.edit` |

### 3.4 Printing and wallet (staff/student/operator)
| Path | Permission |
|---|---|
| `POST /api/v2/edu/uploads` (+`PUT` binary part) · `POST /api/v2/edu/jobs/quote` · `POST /api/v2/edu/jobs` (**Idempotency-Key**) | `jobs.submit` |
| `GET /jobs?mine=1`, `GET /jobs/:id`, `POST /jobs/:id/cancel` | `jobs.view_own`, `jobs.cancel_own` |
| `POST /jobs/:id/release` (release code at printer) | `jobs.submit` |
| `GET /queue?pool=`, `POST /jobs/:id/{retry,cancel,resolve-uncertain,reprioritize}` | operator/admin permissions |
| `GET /wallet`, `GET /wallet/ledger` | `wallet.view_own` |
| `POST /wallet/topups` (**Idempotency-Key**) → gateway order · `POST /wallet/topups/:id/confirm` (client-verify, converges with webhook) | `wallet.topup` |
| `POST /wallet/reservations` (offline), `DELETE /wallet/reservations/:id` | `wallet.reserve_offline` |
| `POST /wallet/adjustments`, `POST /refunds` | `wallet.adjust`, `refunds.issue` |
| `POST /api/v2/payments/webhook/:provider/:org_key` | signature (per-org secret) |

### 3.5 Agent protocol v2 (`/api/agent/v2`, bearer = agent credential)
| Path | Purpose |
|---|---|
| `POST /enroll` | one-time enrolment code → agent id + first credential |
| `POST /credentials/rotate` | agent obtains next credential (overlap window) |
| `GET /config` (ETag) | effective policies, pool membership, min version, update manifest |
| `POST /heartbeat` | agent version, uptime, printer statuses, queue depth, local clock, disk |
| `POST /printers/report` | discovered printers + driver-verified capabilities |
| `GET /jobs/stream` (long-poll/SSE, ≤30 s) | wakes on new eligible work; replaces 1 s polling |
| `POST /jobs/claim` | claim up to *n* jobs for named printers; returns attempt id, fence epoch, lease token |
| `GET /attempts/:id/document` (Range) | encrypted blob + key wrapped for agent |
| `POST /attempts/:id/events` | `submitted`, `progress {pages_printed}`, `completed`, `failed`, `uncertain` – each with fence epoch |
| `POST /sync` | offline batch: completed attempts, reservation spends (`agent_id`,`seq`) |
| `POST /logs` (bounded) | diagnostics upload on request |

## 4. Cross-cutting API behaviour

| Aspect | Rule |
|---|---|
| Authorization | Declared per route (`route({permission:…})`); a startup check fails if any v2 route lacks it |
| Rate limits | Per identity **and** IP; separate buckets: login, upload, job-submit, wallet, agent; counters in PostgreSQL (existing pattern) with batch-writes to avoid a DB write per request **[R]** |
| Request size | JSON ≤ 256 KiB for v2; documents only via binary upload (raw `application/octet-stream`, no base64) |
| Caching | `Cache-Control: no-store` on all API; ETag only on `/agent/v2/config` |
| Observability | `X-Request-Id` in/out, structured log with org_id, route, status, latency; slow-query log |
| Errors | Stable `code` strings (`wallet.insufficient_funds`, `job.no_compatible_printer`, `agent.fenced`) |

## 5. Idempotency redesign (v2)

Today's helper (`server/idempotency.js`) reads, executes, then writes – two concurrent requests with the same key can both run. v2:

1. `INSERT INTO idempotency_records(org_id, actor_id, op, key, request_hash, state='in_progress') ON CONFLICT DO NOTHING`.
2. Winner executes inside its transaction and stores `response_status/body`, `state='done'` **in the same transaction**.
3. Loser: same `request_hash` ⇒ wait/return stored response; different hash ⇒ `422 idempotency_key_reuse`.
4. TTL 24 h (money) – swept by the scheduled job.
