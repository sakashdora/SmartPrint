# 06 · Role and Permission Matrix

Permissions are **named capabilities** held in code (`server/core/permissions.js`) and mapped to roles; handlers check permissions, never role names. A role's permission set is versioned and covered by a generated-matrix test (every route must declare exactly one permission or `public`).

Legend: **●** allowed · **○** allowed on own scope only · **—** denied · **G** only with an approved, time-limited, audited access grant.

## 1. Role inventory

| Role | Org type | Scope | Status today |
|---|---|---|---|
| `platform_owner` (= today's `admin`) | – | platform | exists |
| `platform_reviewer`, `platform_support`, `platform_security` | – | platform | new (optional split) |
| `owner` | business | own shop | exists |
| `institution_admin` | education | whole institution | new |
| `department_admin` (HOD) | education | own department(s), optional | new |
| `staff` | education | self | new |
| `student` | education | self | new |
| `print_operator` | education | pools/printers assigned | new |
| `agent` (machine) | both | one agent | exists as `device` |

## 2. Platform and tenancy

| Permission | platform_owner | platform_reviewer | platform_support | platform_security | owner | inst_admin | dept_admin | staff | student | operator |
|---|---|---|---|---|---|---|---|---|---|---|
| `registrations.review` | ● | ● | — | — | — | — | — | — | — | — |
| `organizations.activate/suspend` | ● | ● | — | — | — | — | — | — | — | — |
| `organizations.read_metadata` | ● | ● | ● | ● | ○ | ○ | — | — | — | — |
| `platform.audit.read` | ● | — | — | ● | — | — | — | — | — | — |
| `platform.sessions.revoke` | ● | — | — | ● | — | — | — | — | — | — |
| `support_access.request` | ● | — | ● | — | — | — | — | — | — | — |
| `support_access.approve` | — | — | — | — | — | ● | — | — | — | — |
| `features.toggle` | ● | — | — | — | — | — | — | — | — | — |

## 3. Institution administration (education)

| Permission | inst_admin | dept_admin | staff | student | operator |
|---|---|---|---|---|---|
| `institution.profile.edit` | ● | — | — | — | — |
| `campuses.manage` / `departments.manage` | ● | ○ (own dept metadata) | — | — | — |
| `users.read` | ● | ○ dept | — | — | ○ (name/ID for support) |
| `users.create/edit/deactivate` | ● | ○ dept | — | — | — |
| `users.import` (bulk) | ● | ○ dept | — | — | — |
| `users.reset_password` | ● | ○ dept students | — | — | — |
| `roles.assign` (to others) | ● (not above own level) | — | — | — | — |
| `policies.edit` | ● | ○ (delegated items only) | — | — | — |
| `pricing.edit` | ● | ○ if delegated | — | — | — |
| `retention.edit` | ● | — | — | — | — |
| `audit.read` (own org) | ● | ○ dept actions | — | — | — |
| `reports.view_org` | ● | — | — | — | — |
| `reports.view_dept` | ● | ● | — | — | — |
| `reports.export` | ● | ○ | — | — | — |

## 4. Printers and agents

| Permission | inst_admin | dept_admin | operator | agent (machine) |
|---|---|---|---|---|
| `agents.register/rotate/revoke` | ● | — | — | — |
| `agents.view_health` | ● | ○ dept | ● | — |
| `printers.add/edit/deactivate/reassign` | ● | — | — | — |
| `printers.pause/resume` | ● | ○ dept pool | ● | — |
| `pools.manage`, `pool_access.manage` | ● | — | — | — |
| `agent.claim_job`, `agent.report_event`, `agent.fetch_document` | — | — | — | ○ own agent/lease only |
| `agent.sync_offline` | — | — | — | ○ own agent |

## 5. Printing, wallet and queue

| Permission | inst_admin | dept_admin | staff | student | operator |
|---|---|---|---|---|---|
| `jobs.submit` | ● | ● | ● | ● | ● |
| `jobs.view_own` | ● | ● | ● | ● | ● |
| `jobs.view_queue` (all in pool) | ● | ○ dept | — | — | ● |
| `jobs.cancel_own` (before submission) | ● | ● | ● | ● | ● |
| `jobs.cancel_any` | ● | ○ dept | — | — | ● |
| `jobs.retry` (failed, not uncertain) | ● | — | — | — | ● |
| `jobs.resolve_uncertain` | ● | — | — | — | ● |
| `jobs.reprioritize` | ● | — | — | — | ○ (within caps) |
| `documents.open_own` | ● | ● | ● | ● | — |
| `documents.open_any` | **G** | — | — | — | — (preview only for jobs they must release, if policy allows) |
| `print.unlimited_official` | — | — | ● | — | — |
| `wallet.view_own`, `wallet.topup` | — | — | — | ● | — |
| `wallet.reserve_offline` | — | — | — | ● | — |
| `wallet.view_any` | ● | ○ dept | — | — | — |
| `wallet.adjust` (manual credit/debit, two-person rule above limit) | ● | — | — | — | — |
| `refunds.issue` | ● | — | — | — | — |

## 6. Business Mode (unchanged semantics, listed for completeness)

| Permission | owner | platform_owner |
|---|---|---|
| Manage prices, QR, UPI settings, printers, queue, cash/UPI confirmation, refunds, cancel/retry | ● own shop | — |
| View/approve shops, global orders/payments/devices/audit | — | ● (as today) |
| Shop staff sub-accounts | — (not available today; proposed `shop_staff` role in a later phase as a Business improvement) | – |

## 7. Enforcement points

| Layer | Mechanism |
|---|---|
| Route | `requirePermission('x')` middleware resolves membership once per request; routes without a declared permission fail the matrix test |
| Scope | Services receive a `scope` object `{org_id, department_ids?, user_id}`; repositories add predicates from it; "own" permissions compare `user_id` |
| Database | `org_id` predicates + RLS ([07](07-database-er-diagram.md)); composite FKs make cross-org references impossible |
| Agent | Credential identifies one agent; every call checks `agent.org_id` equals the job/printer `org_id` and the lease token |
| UI | Menu built from `permissions[]` returned at sign-in; **UI hiding is cosmetic, never the control** |
| Grants | `G` permissions require a row in `support_access_grants` (reason, approver, scope, expiry ≤ 4 h); every use writes an audit row visible to the institution |

## 8. Extensibility

Adding a role = add it to the code matrix + migration of the `memberships.role` CHECK (or a `roles` lookup table in a later phase for institution-defined custom roles). A scoped role (e.g. `campus_admin`) reuses `department_admin` logic with `scope_type='campus'` on the membership – no new tables.
