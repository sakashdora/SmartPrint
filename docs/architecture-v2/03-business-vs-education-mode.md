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

---

# Education role workflows **[R]**

Each workflow lists the happy path and the rules that matter. Screens are lazy-loaded under `public/edu/`.

## Institution Admin
1. **Activation:** receives invitation e-mail → sets password → enrols MFA (required) → lands on a checklist that shows only *"Install an agent"* and *"Add a printer"* as required; everything else is optional.
2. **Profile and structure:** edit institution profile; optionally add campuses and departments (can be done any time).
3. **People:** add one user, or bulk import CSV (dry-run → row-level errors → confirm); imported accounts are `invited`, activation link e-mailed or printed as a slip for students without e-mail; verification = activation link plus optional institution-ID match against the import.
4. **Printers and agents:** create enrolment code → install agent on the Windows PC → printers appear with driver-verified capabilities → confirm display names, department/pool access; later reassign, pause, deactivate.
5. **Policies and pricing:** set student prices, allowed file types, colour rules, queue weights, release-at-printer, offline policy and reservation limits, retention; every change versioned and audited.
6. **Wallet:** view student balances and ledger, issue refunds, make audited manual adjustments (two-person rule above a limit), configure refund-to-wallet vs original method.
7. **Oversight:** reports (usage by department/printer/user, wallet reconciliation, failed/uncertain jobs), audit log, retention status, access-grant approvals from the platform.

## Department Admin / HOD (optional)
1. Appointed by the Institution Admin; absent in single-printer colleges.
2. Manages users of own department(s) (add/deactivate/reset password), views department usage and printer access, requests or edits delegated settings (e.g. department pool access, soft quota) if the Institution Admin enabled delegation.
3. Cannot see other departments' users, wallets or documents.

## Staff / Faculty
1. Signs in (e-mail or staff ID) → uploads official document → sets copies, colour, duplex, range → preview → submit.
2. System authorises automatically (role = staff, within policy caps); no payment step; the job enters the queue with class `staff`.
3. Tracks status, sees own history and monthly usage; optional release code at the printer.
4. Offline: allowed only if policy enables it; usage is recorded and synced later.

## Student
1. Signs in with College ID/roll number and password (institution deep link) → forced password change on first login.
2. Wallet: views balance; tops up online (UPI/card through the institution's gateway); transaction history and receipts.
3. Prints: upload → preview → page range/copies/colour → price shown → balance check → **hold** → queued (class `student`) → printed → hold **captured**; failure or cancel → hold released.
4. Not enough balance: shortfall top-up flow (top-up then continue) instead of a dead end.
5. History: print history with status and charged pages; refund requests go to the Institution Admin.
6. Offline: may reserve credit for a chosen agent in advance; offline prints draw only from that reservation.

## Print Operator
1. Signs in → queue view for assigned pools (waiting, printing, awaiting confirmation, uncertain, failed) with printer status and agent health.
2. Normal jobs need no action (agent reports pages printed).
3. **Uncertain job:** inspect output → *Confirm printed* or *Not printed / partial (enter pages)* → system captures or releases accordingly. Never *Retry* on uncertain.
4. **Failed job:** *Retry* (new attempt, possibly another compatible printer) or *Cancel*; the system blocks retry while a live attempt exists.
5. Can pause/resume a printer, reprioritise within caps, and see—but not open—student documents unless policy allows preview for release.
