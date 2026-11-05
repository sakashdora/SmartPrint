# 16 · Risk Assessment and Rollback Plan

Likelihood (L) / Impact (I): 1 low – 5 high. Score = L×I. Items tagged **[V]** come from the audit; others are design risks.

## 1. Risk register

| # | Risk | L | I | Score | Mitigation | Owner phase |
|---|---|---|---|---|---|---|
| R1 | Change breaks the live Business Mode (shared code, shared DB) **[V shared surfaces in 01 §11]** | 3 | 5 | 15 | Additive schema only, frozen v1 contract, regression suite on PG, flags, staging, canary | all |
| R2 | A push to `main` deploys to production unreviewed (`autoDeploy: true`) **[V]** | 4 | 5 | 20 | Staging + promotion; branch protection; deploy on tag | P0 |
| R3 | Schema change silently not applied in production (swallowed DDL) **[V]** | 3 | 4 | 12 | Versioned migrations, owner-role deploy step, startup verification | P1 |
| R4 | Developer machine writes to the production database (`npm start` uses `.env` DB) **[V]** | 3 | 5 | 15 | Separate dev/staging DB, startup guard | P0 |
| R5 | Anonymous quota exhaustion makes a shop unusable for 24 h (S1) **[V]** | 3 | 3 | 9 | Quote-document lifecycle, per-IP quote cap | P1 |
| R6 | Printer pause state lost on restart → backlog prints **[V]** | 4 | 3 | 12 | Persist pause | P1 |
| R7 | Duplicate printing under multi-agent claim | 2 | 4 | 8 | `SKIP LOCKED`, partial unique live-attempt index, fence epochs, journal protocol, chaos tests | P3 |
| R8 | Colour job routed to mono printer | 2 | 3 | 6 | triple enforcement (submit, claim, agent), unknown ≠ capable | P3 |
| R9 | Cross-institution data exposure | 2 | 5 | 10 | org_id + composite FKs + RLS + forged-id test per route | P2/P4 |
| R10 | Wallet double-credit/double-spend | 2 | 5 | 10 | idempotency keys, atomic conditional update, insert-only ledger, reconciliation | P5 |
| R11 | Regulatory exposure for stored value / student data (RBI PPI, GST, DPDP) **[A]** | 3 | 4 | 12 | Obtain advice before launch; design supports refunds, retention, deletion, consent records | P5 |
| R12 | Offline mode complexity produces financial or reconciliation errors | 3 | 4 | 12 | Ship staff-only first; bounded reservations; sync idempotency; reconcile cases | P7 |
| R13 | Agent installer/updater breaks shop PCs | 3 | 4 | 12 | Staged channels, signature verification, auto-rollback, legacy protocol fallback | P3 |
| R14 | E-mail deliverability/provider lock-in blocks onboarding | 3 | 3 | 9 | Provider abstraction, SPF/DKIM, admin-assisted fallback (manual activation link in console) | P2 |
| R15 | Neon/Render free-plan limits (storage for BYTEA documents, compute, cold start, 512 MB RAM) **[A]** | 4 | 3 | 12 | Move Education documents to object storage, paid plans, remove idle polling | P3/P4 |
| R16 | Single developer/team knowledge concentration | 3 | 3 | 9 | These documents, runbooks, tests as specification | all |
| R17 | Exposed historical secret in public repo **[V memory note]** | 2 | 4 | 8 | Confirm rotation, history scan, CI secret scan | P0 |
| R18 | Scope growth (reports, SSO, ERP) delays core | 4 | 2 | 8 | Phase gates, MVP definition per phase | all |
| R19 | Single shop PC is a single point of failure (power, Windows update, USB) **[V one PC]** | 4 | 3 | 12 | Health alerts, second agent for network printers, UPS advice, documented recovery | P3 |
| R20 | Key custody failure (lose `FILE_ENCRYPTION_KEY`/KEK) makes documents/MFA unrecoverable | 2 | 5 | 10 | Escrowed backup of keys separate from DB backups, documented procedure, drill | P0/P4 |

## 2. Rollback strategy by layer

| Layer | Strategy |
|---|---|
| **Application code** | Immutable image/tag per release; redeploy previous tag (target < 10 min); no schema coupling because migrations are additive |
| **Database** | **Expand → backfill → contract.** Each release only *adds* (tables, nullable columns, indexes). Rollback = deploy old code; additive objects are ignored. Contract steps (NOT NULL, drops) happen ≥ 1 release later and have a pre-created restore point (Neon branch/PITR) |
| **Data backfills** | Idempotent, batched, resumable; record counts before/after; reversible by deleting rows where `legacy_*` link exists |
| **Feature flags** | Per org; kill-switch endpoint for platform owner; defaults off |
| **API** | v1 frozen; v2 versioned; agents negotiate protocol; N and N-1 supported |
| **Agents** | Staged channels; automatic rollback if the new version does not heartbeat within 2 min; legacy protocol retained; local journals compatible across versions (versioned format) |
| **Payments/ledger** | Never edit: compensating entries; webhook handler idempotent so redelivery after rollback is safe; per-org flag disables top-ups |
| **Storage** | New object store used only by Education; Business untouched; deleting a flagged org's objects is a runbook step |
| **Config** | Env var changes recorded; previous values retained in the secret manager version history |

## 3. Phase rollback summary

| Phase | Trigger | Action | Data effect |
|---|---|---|---|
| P0 | CI/process issue | revert workflow/render config | none |
| P1 | regression in a fix | revert that PR or disable via env flag (`ENFORCE_MFA`, sweepers) | additive columns remain |
| P2 | org/membership bug | flag off v2 routes/UI; v1 unaffected; stop dual-write | extra org rows ignored |
| P3 | agent v3 issue | pin shops to legacy connector; server routes off | new tables idle |
| P4 | Education defect | org flag off; suspend affected org | tenant data preserved |
| P5 | ledger discrepancy | disable top-ups/holds; run reconciliation; compensating entries | no history edits |
| P6 | scheduler issue | pool setting → `fifo_priority` | none |
| P7 | offline issue | disable offline policy; expire reservations | reconcile cases handled manually |

## 4. Operational runbooks to write (deliverables of the phases)

Production deploy and promotion · migration rehearsal on snapshot · restore from backup · rotate credentials/keys (DB, KEK, webhook, agent) · agent rollback · stuck queue triage · uncertain-job resolution · wallet reconciliation break · support-access grant · organization closure and data export · incident communication template.

## 5. Go/no-go gates before enabling Education for a real institution

1. Phases 0–4 acceptance met; Phase 5 for student billing.
2. Legal/finance confirmation on wallet, GST, privacy notice, data-processing agreement ([A] — outside engineering).
3. Pilot institution with one printer and a human fallback process for 2–4 weeks.
4. Restore drill and key-custody drill completed.
5. Pen-test highs closed; monitoring/alerts live.
