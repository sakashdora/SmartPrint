# 03 · Business Mode vs Education Mode

Business column = **[V]** current behaviour. Education column = **[R]** proposal.

| Dimension | Business Mode (existing) | Education Mode (new) |
|---|---|---|
| Tenant root | A `shops` row (one per owner) → will be wrapped by an `organizations` row of `type='business'` (1:1 backfill) | `organizations` row of `type='education'` + `institutions` settings |
| Who prints | Anonymous walk-in customers via shop QR | Authenticated staff and students; print operators |
| Customer identity | None – bearer receipt token per order | Account per person: College ID/roll number (student), staff ID/e-mail (staff) |
| Roles | `owner`, `admin` | Platform Super Admin, Institution Admin, Department Admin/HOD (optional), Staff, Student, Print Operator |
| Org structure | Flat | Optional campuses and departments; fully optional ([04](04-flexible-institution-configuration.md)) |
| Registration | `#register` → shop `pending` → admin sets `active`/`suspended` | Same entry page, `organization_type=education`, richer details, explicit **reject / need-info**, e-mail invitation for the initial admin ([05](05-registration-and-authentication-flow.md)) |
| Pricing | Per-shop B&W and colour rate per side (`shops.bw/color`) | Per-institution rules, overridable by department/printer; separate student and staff audience; staff = ₹0 charged but usage recorded |
| Payment | Cash, direct UPI (owner verifies), Razorpay (disabled path) **per order** | Staff: none. Students: prepaid wallet funded by online payment; pay-per-job is modelled as top-up + immediate debit so every rupee goes through the ledger |
| Money store | `transactions`, `refunds`, `shop_payments`, `upi_receipts` | Immutable `ledger_entries`, `wallet_holds`, `payments`, `refunds_v2`; **separate tables, no shared rows** |
| Job record | `orders` + `print_leases` | `print_jobs` + `print_attempts` |
| Queue discipline | FIFO within priority integer (`priority` in JSON options) | Per-pool scheduler: Weighted Fair Queueing with Aging (configurable); legacy FIFO available |
| Printer model | `devices` = printer = credential; one connector per PC | `agents` (Windows installs) 1—N `printers`, pools, department access |
| Completion | Owner confirms paper output (human-in-loop) | Operator confirm optional; agent reports pages printed; auto-complete policy configurable; uncertain outcomes always need an operator |
| Release | Prints automatically when claimed | Optional **release at printer** (code/QR) per policy [R] |
| Offline | None (cloud required) | Staff per policy; students only against pre-reserved credits ([10](10-wallet-payment-offline-architecture.md)) |
| Documents | BYTEA in primary DB, 24 h expiry, deleted on confirmed output | Private object storage, per-org keys, configurable retention (default delete after print + short grace) |
| Reporting | Owner totals, CSV ledger | Institution/department/printer/user usage, wallet reconciliation, audit export |
| Notifications | Owner SSE + in-app | Plus e-mail (verification, reset, receipts, low balance) |
| Audit | Global `audit` table, admin-only | Org-scoped append-only `audit_log_v2`; institution admins read their own org |
| Platform super-admin access | Sees all shops, orders, payments | Sees organization metadata only; **no document or wallet-detail access without a time-limited grant** |

## Rules that keep the two worlds apart

1. A user can hold memberships in more than one organization, but each session acts in **one active organization**; permissions are evaluated against that organization only.
2. No query joins Business money tables with Education money tables. Platform-level reports read pre-aggregated, per-type summary views.
3. An organization's `type` is immutable after approval (changing it requires a new organization).
4. Feature flags: `features.education` is off for every existing shop; turning on Education for a **new** organization cannot alter any shop's behaviour.
5. Education jobs are never written to `orders`; Business orders are never written to `print_jobs`.

## What each Business user sees after the change

Nothing. Same login page, same `#owner` workspace, same QR, same prices. The only visible additions are on the common sign-in/registration entry (an organization-type selector) and in the Super Admin console (Education registrations tab).

## Shared components, one line each

| Shared | Why safe |
|---|---|
| Password hashing, MFA, passkeys, sessions | Pure primitives; extended with org context via an optional column, not changed semantics |
| `prepare()` / `validateOptions()` | Pure functions covered by existing tests |
| Capability probe + printer discovery code in the agent | Same binary; protocol selected by the agent's registration record |
| Rate limiter, logger, request id | Infrastructure only |
