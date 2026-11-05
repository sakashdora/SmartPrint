# 12 · Scalability and Future Extensibility Strategy

## 1. Target scale (assumptions to confirm — **[A]**)

| Profile | Users | Printers / agents | Peak load | Architecture needed |
|---|---|---|---|---|
| Small college | 300–2 000 | 1 / 1 | 20 jobs in 10 min | one instance, one DB |
| Mid college | 2 000–10 000 | 5–15 / 3–5 | 100 jobs / 10 min (exam rush) | one instance + worker, pooled DB |
| University | 10 000–50 000 | 40+ / 10+ | 500 jobs / 10 min, 1 000 concurrent sessions | 2–3 instances, worker, object storage, read replica for reports |
| Today's Business fleet | tens of shops | 1 each | low | current code adequate |

Nothing here needs microservices; the bottlenecks are listed below with the fix that removes each.

## 2. Bottlenecks → fixes (ordered by impact)

| # | Bottleneck (verified [01](01-existing-project-technical-audit.md) §7) | Fix | Business impact |
|---|---|---|---|
| 1 | 1.8 req/s idle polling per connector; pool of 5 | Agent v2 **long-poll/SSE** (≤30 s) + adaptive backoff; Business connector gets backoff 1 s → 5 s when idle (small change, optional) | none functionally |
| 2 | DB write per request (rate limit) and session+shop lookups | token-bucket in memory with periodic flush; cache `user+membership` for 30 s keyed by session hash with explicit invalidation on role/status change | none |
| 3 | In-process, base64-through-memory document handling; event-loop blocking `pdf-lib` | Education: binary uploads straight to object storage, preparation in a **worker** (separate process/container, bounded concurrency, memory ceiling); Business unchanged until Phase 1 optional binary chunk endpoint | none |
| 4 | Documents as BYTEA in primary DB | Education on object storage; Business keeps BYTEA with the S1 fix (documents for unordered quotes expire with the quote) | S1 fix is a bug fix |
| 5 | Single process holds control state | move to PostgreSQL: pause flags, pending keys, WebAuthn challenges, alert dedupe; SSE fan-out via `LISTEN/NOTIFY` so any instance can notify | removes data loss on deploy |
| 6 | Cleanup/maintenance in web process, no leader | `jobs/` module: `pg_advisory_lock`-guarded scheduler; optional worker | none |
| 7 | JSON-in-TEXT queue fields, O(queue) position calculation | Education queue uses indexed columns; Business position query can use a computed column later | none |
| 8 | Admin/report queries unindexed, unpaginated | indexes (§[07](07-database-er-diagram.md) §6), keyset pagination, read replica/materialised views for reports | additive indexes only |
| 9 | Pool size 5 | per-instance pool 10–20, PgBouncer (transaction mode) — requires `SET LOCAL` discipline and no session state, both already planned | none |

### Capacity guardrails
Per-org limits (`max_printers`, `max_users`, `max_upload_mb`, `max_jobs_per_hour`) stored in settings and enforced at the API; Super Admin can raise them. Prevents one org from starving another (noisy neighbour).

## 3. Modularity and boundaries

- Layered modules (`platform`, `core`, `printing`, `business`, `education`) with import-lint ([02](02-architecture-blueprint.md)).
- Each module exposes a small `index.js` API; cross-module calls go through it (and are the future extraction seams: `wallet` and `printing/queue` are the first candidates if scale demands a separate service).
- Domain events (`job.completed`, `wallet.credited`, `printer.offline`) emitted in-process via a transactional outbox table so that notifications, reports, and future ERP webhooks subscribe without coupling.

## 4. API evolution

- v1 frozen with contract snapshot test; v2 additive within a major; breaking changes ⇒ v3.
- Agents negotiate protocol; server supports N and N-1 for ≥ 6 months.
- Webhooks out (ERP/LMS): signed, versioned payloads from the outbox, retried with backoff, per-org endpoints.

## 5. Safe change management

| Practice | Rule |
|---|---|
| Migrations | versioned, owner-role, expand → backfill → contract, rehearsed on production snapshot ([07](07-database-er-diagram.md) §8) |
| Feature flags | per organization; dark launch → pilot org → all |
| Rollout | Render preview/staging + canary agents (`channel=canary`) before `stable` |
| Rollback | code: redeploy previous image; DB: additive migrations stay; flags off; agents: auto-rollback on failed heartbeat ([16](16-risk-assessment-and-rollback-plan.md)) |
| Autodeploy | `autoDeploy: true` on `main` pushes straight to production **[V render.yaml]** → move to deploy-on-tag or a promotion step after staging passes **[R]** |

## 6. Extensibility

| Future need | How the design absorbs it |
|---|---|
| ERP / college management integration | `user_identifiers` + `external_ref` columns, bulk import API, outbound webhooks, later SCIM; no schema change |
| SSO (Google/Microsoft/Shibboleth) | `auth_providers(org_id, type, config)` + OIDC callback creating sessions through the same `session()` path; password login remains for fallback |
| New roles (e.g. Library Admin, Campus Admin) | add to code matrix + scoped membership (`scope_type`, `scope_id`); no new tables |
| Per-department quotas / cost centres | `quota_rules(scope, period, pages|amount)` consulted at submit; reports already carry `department_id` |
| Additional payment providers | `payment_intents.provider` + adapter interface; webhook route per provider |
| New printer types (network/IPP, macOS agent) | `printers.connection_class`, agent protocol is OS-agnostic; capability probe is per-agent implementation |
| Multi-region/data residency | org-level `region`; object storage bucket per region; DB per region only if mandated |
| White-label per institution | `institution_settings.branding` + `/i/<slug>` entry points |
| Business Mode enhancements (shop staff, multi-shop owners) | `memberships` already supports N users per org; replace the `one_active_shop_per_owner` constraint by org-level ownership in a later, flagged migration |

## 7. Observability and load management

| Area | Plan |
|---|---|
| Logs | JSON, request id, org_id, route, latency; shipped centrally; sampling for 2xx |
| Metrics | HTTP latency histograms, DB pool wait, queue depth & oldest age per pool, claim latency, agent heartbeat age, wallet hold/capture counts, webhook failures, ledger-check result |
| Tracing | request-id propagation to agent calls (cheap), full tracing optional |
| Alerts | oldest queued job age > policy, agent silent, printer offline with work, DB pool saturation, 5xx > 1 %, reconciliation failure |
| Load tests | k6 scenarios: login storm, 300 simultaneous uploads, 500 queued jobs with 10 agents, concurrent wallet spends ([15](15-testing-and-acceptance-criteria.md)) |
| Back-pressure | per-org job caps, 429 with `Retry-After`, worker queue length limit, upload concurrency limit |
| Cost | idle polling removal reduces Neon compute-hours and allows scale-to-zero overnight for Business **[A]** |

## 8. Why not microservices (summary of reasoning)

1. Transactions span wallet + queue (hold and enqueue must be atomic). Splitting forces sagas and compensations for the most safety-critical path.
2. The team and traffic are small; operational cost of N services (deploys, observability, auth between services) exceeds benefit.
3. Module boundaries + outbox + feature flags give the same *change isolation* inside one deployable.
4. The seams (wallet, document preparation worker) are already designed so extraction remains possible when measured load justifies it.
