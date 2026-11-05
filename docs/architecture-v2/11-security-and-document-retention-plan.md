# 11 · Security and Document Retention Plan

Status column: **Have** = verified in code today **[V]** · **Gap** = missing/weak · **New** = required by Education Mode.

## 1. Control review

| Control | Status | Detail / proposal |
|---|---|---|
| Password hashing | **Have** | Argon2id (64 MiB, t=3, p=4); legacy scrypt upgraded on login; dummy-hash on unknown e-mail. Keep. Add breached-password check (k-anonymity API or offline list) for student passwords **[R]**. |
| Session management | Have / Gap | Hashed session ids in DB, HttpOnly/Lax/Secure, revoked on password/MFA change. Gap: fixed 8 h, no idle timeout, no session list, no org context. → [05](05-registration-and-authentication-flow.md). |
| MFA | Have / Gap | TOTP with replay guard, recovery codes, passkeys. Gap: owners not forced in prod; staff/students optional. → require for platform and institution admins; optional with nudge for staff. |
| Role-based authorization | Have / New | Exact role match per route today. → permission matrix + route-declared permissions + generated test ([06](06-role-permission-matrix.md)). |
| Tenant isolation | Have (shop) / New | Shop predicate pattern is correct and tested. → org_id everywhere, composite FKs, RLS ([07](07-database-er-diagram.md)). Frontend filters are never relied on. |
| Agent communication | Gap | Static bearer, plain-text on disk, no rotation. → per-agent rotating credential, DPAPI storage, signed updates, fenced events ([09](09-print-queue-and-agent-architecture.md)). TLS only; reject plain HTTP. |
| Local bridge (`127.0.0.1:17631`) | Gap | Trusts any `localhost` origin, accepts `replace:true`. → require a per-install pairing code shown in the agent tray, remove blanket localhost trust, `replace` only with the code (fixes S6). |
| File validation | Have / Gap | Magic-byte check (PDF/PNG/JPG), 20 MiB, 100 pages, pixel limits; LibreOffice conversion + ClamAV in isolated processor. Gap: processor is optional; PDF parsing (`pdf-lib`) runs in the web process. → run all Education parsing in the isolated worker with CPU/memory/time limits; reject PDFs with JavaScript/embedded files/XFA, encrypted PDFs; content-type sniff on the **stored** object. |
| Private document storage | Have (DB) / New | BYTEA AES-256-GCM, one global key. → Education: private bucket (no public ACL, no direct listing), signed short-lived URLs only for the **agent**, envelope encryption with per-org data keys (below). |
| Encrypted local Agent cache | New | Documents downloaded as ciphertext; local AES-GCM per attempt, key wrapped by DPAPI; files deleted after confirmed submit + short grace; startup sweep (today's 10-minute stale cleanup is kept). Spooler copies (Windows `%SystemRoot%\System32\spool`) are outside agent control – document and recommend disabling "keep printed documents". |
| Document retention | Have / Gap / New | Live PDFs deleted on completion/cancel/refund/expiry (verified). Gaps: `orders.options` keeps file names forever; quotes/notifications/history/audit never purged; unused quote documents kept 24 h (S1). → configurable per org below. |
| Secure deletion | Gap | DB `DELETE` leaves backups and WAL. → **crypto-shredding**: per-org data key (and optional per-batch key); when retention expires or an org is closed, destroying/rotating the key makes ciphertext unrecoverable, including in backups. Object deletion + lifecycle rule as belt and braces. |
| Payment webhook verification | Have / New | HMAC-SHA256 with `timingSafeEqual`, event-id dedupe (Business). Gap: secret falls back to API secret (S8). → dedicated webhook secret required; per-org secrets for Education; reject events for unknown org keys; amount/currency/order match; raw-body signature check retained. |
| Immutable financial records | Have (Business: logical) / New | Business: never updated by code, but not DB-enforced. → Education ledger insert-only enforced by `REVOKE` + trigger; nightly zero-sum and balance checks. |
| Audit logging | Have / Gap | Global `audit`, written for mutations; order_history failures swallowed. → `audit_log_v2` org-scoped, same-transaction, append-only, optional hash chain; reads by institution admin for own org; platform reads metadata only. Make order-history writes fatal (the savepoint swallow is no longer needed). |
| Rate limiting | Have / Gap | DB-backed per-IP/per-account windows. Gaps: a DB write per request, per-IP only on mutations, shared NAT campus (known BUG-05). → per-identity first, IP second; separate buckets (login, upload, job, wallet, agent); in-memory token bucket with periodic flush to PostgreSQL. |
| Backups & recovery | **Unknown [U]** | Neon retention/PITR not verified. → written RPO/RTO targets (proposal: RPO ≤ 15 min, RTO ≤ 2 h), quarterly restore drill into staging, encryption keys backed up separately (a backup without the key is useless, and vice versa). |
| Error monitoring | Gap | stdout logs only. → error tracker (Sentry-type), structured logs to a central sink, uptime probe on `/readyz`, alerting on 5xx rate, queue age, agent silence, webhook failures, ledger anomalies. |
| Printer/agent health | Partial | Heartbeat + `/readyz` cleanup freshness. → [09](09-print-queue-and-agent-architecture.md) §5. |
| Secrets | Gap | Env vars on Render; key rotation untooled; repo public with a previously exposed password in history (memory note). → secret scanning (gitleaks) in CI, history review, rotate anything ever exposed **[U: confirm done]**, separate KEK in a KMS (cloud KMS or Vault) for per-org DEKs. |
| Dependencies | Have | `npm audit --omit=dev` in CI. Add Dependabot/Renovate, SBOM, pinned Docker digests, SumatraPDF download pinned **by SHA-256** (today it is downloaded over HTTPS from a URL without checksum verification, `sumatra-helper.js:40-54`). |
| Web hardening | Have / Gap | CSP, HSTS, nosniff, frame deny, Origin check. Gap: CSP drift between server and `vercel.json`; `style-src 'unsafe-inline'`. → single CSP source, nonce for inline styles over time, `Permissions-Policy`, `Cross-Origin-Opener-Policy`. |

## 2. Encryption design (Education)

```
KEK (cloud KMS, never leaves KMS)  ──wraps──▶  per-org DEK (stored wrapped in organizations.dek_wrapped, version n)
DEK ──derives (HKDF)──▶ per-object key  ──AES-256-GCM──▶ object body in bucket
Agent download: server unwraps per-object key and returns it **wrapped for that agent** (agent X25519 key) — object ciphertext never decrypted server-side for agents.
```
- Business keeps `FILE_ENCRYPTION_KEY` unchanged; **no re-encryption of Business data** in any phase.
- Key rotation: new DEK version for new objects; old versions retained until their objects expire; destroy old version after the last object is gone (this is the secure-delete mechanism).
- MFA secrets remain under the global key for Business; Education MFA secrets use the org DEK.

## 3. Platform Super Admin access to institution documents

Default: **no technical or UI path** from platform roles to decrypt Education documents (platform application role has no KMS decrypt permission for org DEKs).

Break-glass support access:
1. `platform_support` files a request (`support_access_grants`: org, scope = a job id or time window, reason, ticket reference).
2. The **institution admin approves** in their console (or, for emergencies, two platform_owners approve with reason; the institution is notified immediately).
3. Grant is time-limited (default 1 h, max 4 h), single scope, auto-expires, revocable.
4. A separate KMS grant is created for the window only.
5. Every document open writes `audit_log_v2` (actor, scope, object id, reason) visible to the institution; a daily digest is e-mailed to the institution admin.
6. No bulk export through the grant.

## 4. Retention configuration

| Data | Default | Configurable range | Mechanism |
|---|---|---|---|
| Education document after `completed` | delete after 1 h | 0 – 30 days | `stored_objects.expires_at`; sweeper deletes object, marks `deleted_at`, writes audit |
| Document of `failed/uncertain` job | 24 h (until resolved) | up to 7 days | extended automatically while unresolved |
| Document of `cancelled` job | delete immediately | fixed | |
| Un-submitted upload | 30 min | 15 min – 2 h | quota-friendly (fixes S1 pattern) |
| Job metadata (file name, pages, cost) | 2 years | 90 days – 7 years | file name optionally redacted after N days |
| Ledger | **7 years, never deleted** (financial) | fixed by policy | archival partitioning only |
| Audit log | 2 years | 1 – 7 years | partition drop |
| Sessions, rate limits, idempotency, notifications | 8 h / minutes / 24 h / 90 days | fixed | scheduled sweep (today none of these except sessions/rate limits are purged) |
| Business: quotes, notifications, history | **proposal:** quotes purged 7 days after expiry; notifications 90 days; `order_history` and `audit` retained | – | additive sweeper, no schema change |
| Agent local cache | delete after submit + 10 min; sweep on start | fixed | |

Organization closure: documents purged immediately, DEK destroyed, ledger and audit exported to the institution then retained per statutory minimum.

## 5. Threat model summary (STRIDE-oriented, Education additions)

| Threat | Mitigation |
|---|---|
| Student guesses another student's job id | ids unguessable (uuid) **and** every query scoped by `org_id` + `submitter_id`; 404 not 403 |
| Staff impersonation by roll-number guessing | per-identifier throttle with delays, password strength, MFA option, anomaly alert |
| Stolen agent PC | credential revoke, DPAPI-bound secrets, bounded offline reservations |
| Malicious PDF | isolated worker, limits, feature rejection, timeouts; agent prints only a **server-normalised** PDF (existing `prepare()` flattens to A4 pages) |
| Replay of payment webhook | `gateway_events` unique key; amount/order match |
| Wallet double spend | atomic conditional update + unique idempotency key |
| Cross-institution read | org predicates + composite FKs + RLS + tests that forge ids |
| Insider (platform) browsing documents | no decrypt capability; grants audited and visible |
| Mass registration spam | e-mail verification, rate limit, human approval |
| Abuse of bulk import | dry-run, size caps, audit, permission `users.import` |
| Log leakage | existing log sanitiser extended; never log file names, tokens or document bytes |
