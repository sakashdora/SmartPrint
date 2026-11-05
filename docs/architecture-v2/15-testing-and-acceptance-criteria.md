# 15 · Testing and Acceptance Criteria

## 1. Baseline **[T]**

97 tests (96 pass, 1 skipped = PostgreSQL integration) run in ~69 s on SQLite. They are the seed of the **Business regression suite**. Weakness: concurrency tests run on SQLite's serialised connection (`db.js` serial queue), so they prove logic, not PostgreSQL locking.

## 2. Test pyramid

| Level | Scope | Tools | Runs |
|---|---|---|---|
| Unit | pricing, option validation, scheduler math (WFQ), ledger math, permission matrix, state transitions, capability matching | `node --test` | every commit |
| Integration (service + PostgreSQL) | repositories, `withTenant`/RLS, claim SQL (`SKIP LOCKED`), wallet atomic spend, migrations | `node --test` + PostgreSQL service container | every PR |
| API | every v1/v2 route: auth required, permission, validation, error codes; **contract snapshot** of v1; OpenAPI conformance for v2 | `node --test` + `fetch` | every PR |
| Database | constraints (CHECKs, composite FKs, partial unique indexes), triggers (insert-only), migration up on empty + baseline dump, backfill idempotency | SQL tests | every PR |
| Security | forged-id/cross-org matrix, role escalation, CSRF/Origin, webhook signature, rate limits, upload fuzz (malformed PDFs), secret scan, dependency audit | custom + `npm audit` + gitleaks (+ ZAP baseline on staging) | PR + nightly |
| Load | login storm, simultaneous uploads, queue with many agents, wallet contention | k6 on staging | nightly/weekly |
| Business regression | tagged subset below | `node --test` | **every PR, blocking** |
| Education workflow | scenarios §4 | API-level end to end + a few Playwright flows | every PR touching `education/` |
| Real printer | physical output and driver capability | manual script with checklist, run on the shop PC **only with explicit consent and a test-page plan** | per agent release |
| Windows Agent | service install/upgrade/rollback, DPAPI, journal replay, local queue, updater | Windows CI runner (exists: `windows-latest`) + VM matrix | per agent release |
| Offline/recovery | WAN cut, DB restart, agent kill, clock skew | fault-injection scripts | per phase 3/7 + monthly |

## 3. Business Mode regression suite (must stay green, blocking)

Golden journeys, each asserted on **SQLite and PostgreSQL**:
1. Shop registration → admin approval → prices → QR → customer upload → quote → order (cash) → owner confirms cash → print claim → submitted → confirm output → document deleted → receipt shows completed.
2. Same with direct UPI (12-digit reference, duplicate reference rejected).
3. Same with Razorpay: signed webhook, duplicate webhook, verify+webhook race, amount mismatch.
4. Failure paths: connector failure before submit (retry allowed), after submit (needs review, retry refused), cancel while claimed vs submitted, expiry → `payment_review`, refund recording.
5. Tenant isolation: owner A against shop B's order/doc/device ids → 404.
6. Printer capability routing: colour job never claimed by mono device; jobs wait; unroutable alert once.
7. Auth: login, MFA TOTP, recovery code, passkey, password change revokes sessions, admin MFA mandatory.
8. Backlog hold, stale test-page cancellation, pause persistence (after Phase 1).
9. Idempotency keys on order/cash/UPI/refund.
10. v1 API contract snapshot (route list, auth type, response key sets).
Every phase's PR checklist includes "ran business-regression on PG: ✔".

## 4. Education and platform scenarios

| # | Scenario | Key assertions |
|---|---|---|
| E1 | One institution, **one printer, no departments** | Setup ≤ 5 admin actions; staff and student print through the default pool; no department UI visible; reports work with `department_id NULL` |
| E2 | **Several departments share one printer** | Dept-level reporting; usage split correct; HOD sees only own department |
| E3 | **Departments with separate printers** | `pool_access` honoured; student of dept X cannot route to dept Y's pool; shared Library pool open to all |
| E4 | **Multiple agents, multiple printers** | Jobs routed only to printers of reporting agents; USB printer never offered to another agent; network printer eligible on two agents, one prints |
| E5 | **Simultaneous student uploads** (300 in 10 min) | No 5xx; p95 submit < 2 s excluding transfer; memory under limit; quota per org respected; no cross-org blocking (noisy neighbour test) |
| E6 | **Agent disconnects during printing** | `uncertain`; no reprint; operator resolution flows; after reconnect the late `completed` with valid fence is accepted, stale fence rejected |
| E7 | **Internet outage and reconnection** | Staff offline jobs per policy; students only with reservation; sync idempotent; ledger equals local spend log |
| E8 | **Duplicate payment notification** | Same event twice, retried event, confirm+webhook race ⇒ exactly one credit |
| E9 | **Concurrent wallet spending** | 100 parallel spends on balance for 10 ⇒ exactly the affordable number succeed; balance never < 0; ledger zero-sum |
| E10 | **Partial printing** | Pages reported 3 of 10 ⇒ capture 3 pages, release rest; operator reprint of remainder |
| E11 | **Printer incompatibility** | Colour job with only mono printers ⇒ rejected at submit with clear message; with colour printer offline ⇒ waits with alert; never printed mono |
| E12 | **Cross-institution access attempts** | For every v2 route: replace ids with another org's ⇒ 404; direct SQL as app role without `app.org_id` ⇒ zero rows (RLS) |
| E13 | **Document retention expiry** | Object deleted, DB marked, audit row, ciphertext undecryptable after DEK destroy (test environment), agent cache swept |
| E14 | Registration → approval → activation | states, reject reason, invitation single-use/expiry, no login before activation |
| E15 | Bulk import | dry-run, duplicates, malformed rows, 5 000 rows < 60 s, forced password set |
| E16 | Weighted fair queue | simulation tolerance ±5 %, no starvation, per-user cap |
| E17 | Support-access grant | no access without grant; access logged; expires; institution notified |

## 5. Acceptance criteria per module (measurable)

| Module | Criteria |
|---|---|
| Registration & approval | 100 % of state transitions covered by tests; approval creates org+admin invite in one transaction (fault injection mid-way leaves nothing partial); median review action < 3 clicks |
| Authentication | 0 successful cross-tenant sessions in forged-claim tests; login p95 < 400 ms (Argon2 cost excluded: ≤ 250 ms hash); lockout/delay verified; session revoke effective ≤ 5 s |
| Tenant isolation | Cross-org matrix 100 % pass for every route; RLS test with `BYPASSRLS` absent; composite FKs reject mismatched parents |
| Institution configuration | Topologies A–F reproducible by fixtures; adding/removing department/printer/agent requires no migration; reassign audited |
| Print queue | 0 duplicate claims in 10 000 concurrent claims (PG); WFQ shares within ±5 %; oldest-job wait ≤ `max_wait_target` in simulation; claim p95 < 200 ms with 10 000 queued jobs |
| Agent | Crash at each of 6 journal points ⇒ never prints twice; idle requests ≤ 4/min; upgrade + automatic rollback tested; credential rotation without job loss; revoked agent halts ≤ 1 heartbeat |
| Colour routing | In the full capability matrix (colour/mono × duplex/simplex × unknown), mismatching claims = 0 |
| Wallet/ledger | Zero-sum at all times; no negative balance; every cached balance equals ledger sum (nightly); duplicate events create 0 extra entries; refund ≤ credit |
| Payments | Webhook with bad signature rejected 100 %; orphan payments always surfaced; reconciliation detects injected 1-paisa mismatch |
| Offline | Money spent offline ≤ reserved limit in 100 % of runs; replayed sync no effect; reservation expiry releases remainder exactly once |
| Documents & retention | Deletion within `retention + 5 min`; platform role cannot read objects (negative test); upload quota recovers after TTL |
| Security headers/web | OWASP ZAP baseline: 0 high; CSP single source; no secrets in logs (grep test) |
| Observability | Alerts fire in staging chaos tests (agent silence, queue age, webhook failures) within 2 min |
| Performance | k6: 1 000 concurrent sessions, error rate < 0.5 %, p95 API < 500 ms (non-upload) on target plan **[A]** |

## 6. Phase 8 exit numbers (initial targets, adjustable after measurement)

| Test | Target |
|---|---|
| Login storm 1 000 users / 60 s | p95 < 1 s, 0 5xx |
| 300 simultaneous 5 MB uploads | all succeed < 90 s, RSS < 70 % of limit |
| 10 agents × 50 printers-worth of claims | no double claim; DB pool wait p95 < 50 ms |
| Wallet contention 500 spends / 10 accounts | invariant checks pass |
| Restore drill | RPO ≤ 15 min, RTO ≤ 2 h demonstrated |

## 7. Real-printer and Windows-agent test protocol

1. Written test plan listing printers, jobs and expected output; **user approves before any paper is used**.
2. Use the diagnostic page generator for output checks (already exists) before real documents.
3. Matrix: colour/mono, simplex/duplex, 1 and N copies, page ranges, 2-up, card layout, large (100 pages), cancel mid-job, unplug USB mid-job, power-cycle printer, change USB port (HP "Copy 1" case), spooler with other jobs ahead.
4. For each: expected pages, observed pages, server state, ledger/usage effect, Windows queue left empty.
5. Never run these tests against the live shop connector; use a second profile/PC or a stopped-live window agreed with the owner.
