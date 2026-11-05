# Staging environment and restore drill

Both need accounts only you hold (Neon, Render), so this is a step-by-step runbook rather than something the code can do. Nothing below touches production data.

## 1. Staging environment (about 30 minutes, once)

Goal: every change is tried against a copy of production's schema, with test data and test keys, before production sees it.

1. **Database.** In the Neon console open the production project → *Branches* → *Create branch* from *main*, name it `staging`, **without** data if you prefer test-only data (schema-only is enough: the app creates and verifies its own tables).
   Create a restricted role for the app exactly as you did for production, and keep the owner connection string for `npm run migrate`.
2. **Web service.** In Render create a second *Web Service* from the same repository, plan Free, **Auto-Deploy: Off**, branch `main`. Environment:
   `NODE_ENV=production`, `DATABASE_URL` = the **staging** branch's app connection string, `FILE_ENCRYPTION_KEY` = a **new** random 64-hex value (never reuse production's), `CRON_SECRET` = new, `PUBLIC_BASE_URL` = its own URL, `ALLOW_PENDING_MIGRATIONS` unset.
   Leave `RAZORPAY_*` unset, or use **test** keys only. Do not set `S3_*` to a production bucket.
3. **Migrations.** From this PC: `MIGRATION_DATABASE_URL` pointing at the staging branch → `npm run migrate`.
4. **Admin and test data.** `npm run admin:create` against staging, register a test college through the normal pages, approve it, enrol a test agent (or use the simulated driver).
5. **Promotion rule.** Merge to `main` → deploy **staging manually** → run the checklist below → only then deploy production. To stop `main` deploying production automatically, set `autoDeploy: false` for the production service in `render.yaml` (and press *Deploy* by hand after staging passes). This is deliberately **not** changed in the repository for you, because it changes how you release.

Staging checklist (10 minutes): register + approve a college; invite and sign in; add a student; set student printing to *wallet*; credit ₹100; submit a job; (agent or simulator) print it; confirm the wallet balance and `wallets/verify` say balanced; open the Business shop owner page and place one cash order end to end.

## 2. Restore drill (do it once now, then every quarter)

Goal: prove you can get the data back, and how long it takes.

1. Note the time. In Neon → *Branches* → *Create branch* → **from a past point in time** (for example 1 hour ago) named `restore-drill`.
2. Point a throwaway local run at it: `DATABASE_URL=<restore-drill app string>` and `npm start` on a spare port (never against production), with the **production** `FILE_ENCRYPTION_KEY` (documents and MFA secrets cannot be decrypted without it; this also proves your key backup works).
3. Check: you can sign in as a shop owner; an old order's receipt page loads; `GET /api/v2/edu/wallets/verify` reports no problems for a college; `SELECT COUNT(*)` of `orders`, `transactions` and `ledger_entries` match what production showed at that time.
4. Write down: minutes from "create branch" to "signed in", the restore point used, anything that failed.
5. Delete the `restore-drill` branch.

Targets proposed in `docs/architecture-v2/11`: recovery point ≤ 15 minutes, recovery time ≤ 2 hours. Neon's history window depends on your plan: check that it covers the period you want to be able to go back.

## 3. Keys that must be backed up outside the database

`FILE_ENCRYPTION_KEY` (documents, MFA secrets, per-institution keys are wrapped by it), the Neon owner login, the Render environment, and the agent **update-signing private key** once it exists. A database backup without `FILE_ENCRYPTION_KEY` is unreadable. Store them in a password manager or vault, not in the repository.

## 4. Secrets exposed in the past

The repository is public and a password was once committed (see `scratch/rotate-exposed-account-password.mjs`, which you already have). Confirm it was rotated, and rotate anything else that ever appeared in chat or logs.
