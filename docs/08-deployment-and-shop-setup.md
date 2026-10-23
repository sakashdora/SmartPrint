# Vercel deployment and Windows shop setup

## 1. Existing local setup

The supplied Neon database has been migrated. Your requested administrator is saved in `smartprint.users`; its password is a salted scrypt hash. Open the local `.data/admin-access.txt` to retrieve the generated initial login. Never upload or commit that file.

`.env` contains generated secrets and a restricted runtime `DATABASE_URL`. `MIGRATION_DATABASE_URL` is the owner connection for migrations only. Rotate the previously shared owner password in Neon and update this local migration URL before launch. The runtime login is separate.

## 2. Import into Vercel

1. Import this project into your own Vercel account, or deploy the directory using your authenticated Vercel CLI.
2. Choose **Other** framework, repository root as root directory, **Node.js 24.x**, build command `npm run build`, output directory `public`. The checked-in `vercel.json` routes API traffic to `api/index.js`.
3. Configure the following production environment variables using your private local `.env` values. Set the final public origin to your actual domain or project `.vercel.app` origin.

| Vercel variable | Value |
|---|---|
| NODE_ENV | production |
| DATABASE_URL | Restricted runtime URL from .env, with sslmode=verify-full |
| FILE_ENCRYPTION_KEY | Existing 64-character hex key; preserve it across deployments |
| CRON_SECRET | Existing random secret, at least 32 characters |
| PUBLIC_BASE_URL | Exact HTTPS origin, for example https://your-project.vercel.app |

Do **not** deploy `MIGRATION_DATABASE_URL`, `ADMIN_PASSWORD`, `.data/admin-access.txt`, or `PROCESSOR_SECRET`. The app reads account hashes from Neon, so admin credentials do not belong in Vercel environment variables. Production automatically uses the shop-PC processing path; no public processor URL is needed.

4. Deploy. Open `/api/health`, then sign in at `/#login`. Verify production mode, enroll your authenticator, then change the initial password under Account.
5. Use separate Neon branches and encryption keys for independent preview/test deployments. Do not point public preview deployments at production customer data. Each deployment needs its matching `PUBLIC_BASE_URL` for Origin checks.

`.vercelignore` excludes local secrets, test data, docs and shop-PC files. The static build copies PDF.js assets; the API bundle excludes native document-processing libraries. The migration is explicit and must run before deploying a schema change:

```powershell
npm ci
npm run migrate
npm run build
npm test
```

## 3. Register the shop

Register shop name, location, owner email and a strong password. Complete production MFA on sign-in. The admin approves the shop in Shop approvals. The owner sets B&W/colour rates and their own UPI ID/account holder name. UPI payments go to that account; the platform does not hold or distribute funds.

Create a printer in Printers and check only capabilities supported by its actual Windows driver. Copy the one-time device token privately. The shop QR is generated from `PUBLIC_BASE_URL`; scan it on a phone and verify the destination/shop name.

## 4. Prepare the always-on Windows PC

Install current vendor-supported Node.js 24.x, Docker Desktop with Linux containers/WSL2, and SumatraPDF. Install the printer's vendor driver and verify an ordinary Windows test page. Windows 10 hosts need a supported security-maintenance arrangement; confirm Docker's current OS requirements. Allocate enough memory for the processor and ClamAV (the configured container limits total roughly 3.5 GiB, plus Windows/Docker overhead).

Copy the repository to the shop PC **without** the database `.env`, `.data`, credentials or Git history containing secrets. The shop PC needs a processor secret and device token, not a Neon login. Install dependencies with `npm ci`.

Create a local `.env.processor` from `.env.processor.example`. Put a new random secret of at least 32 characters in `PROCESSOR_SECRET`, then run from the repository root:

```powershell
docker compose --env-file .env.processor -f compose.processor.yml up -d --build
docker compose --env-file .env.processor -f compose.processor.yml ps
```

Allow ClamAV to download signatures on first start. It has an update network; the processor has only its isolated processing network and a localhost binding. Never expose port 4000 or the ClamAV service publicly. Test conversion/scanning before opening intake.

Then pair and start the connector:

```powershell
powershell -NoProfile -File .\connector\setup.ps1
powershell -NoProfile -File .\connector\start.ps1
```

Setup asks for your HTTPS app URL, exact Windows printer name, full path to SumatraPDF.exe, one-time device token and matching processor secret. Secrets are stored using Windows user-bound DPAPI encryption. Run the connector as the same Windows user. Do not pass tokens on the command line.

For startup after that user signs in:

```powershell
powershell -NoProfile -File .\connector\install-startup.ps1
```

The scheduled task does not bypass Windows sign-in or start Docker. Enable Docker's normal startup setting and keep the PC awake. A mutex prevents duplicate connectors for the same Windows user. If Windows script policy blocks the signed/local script, have the PC operator approve it through the organization's normal policy; do not weaken machine security globally.

## 5. Test the complete path

Use synthetic PDF/image/Office documents. Scan the QR on a phone, generate the preview, check every page and place a cash order. The owner collects cash; the connector claims/prints the paid job. Confirm physical output only after checking the paper. Verify the receipt says complete and the live PDF is absent.

Then test UPI: verify the recipient in the payment app, pay the exact amount, share its reference, and have the owner independently check the actual credit before confirming. No gateway key is required; confirmation is manual. Refunds are returned by the shop and then recorded in SmartPrint.

Test two-up, card front/back, grayscale, colour, multiple copies and duplex against the actual printer. Test disconnect/jam/restart before unattended use. If submission is uncertain, inspect the Windows queue and paper; never automatically resend. Follow the launch checklist in document 06.

## Monitoring and limits

The connector heartbeats every 30 seconds and performs due cleanup. Vercel has a daily cron fallback to `/maintenance`, authenticated with `CRON_SECRET`; active devices are the primary frequent cleanup trigger. `/readyz` returns 503 if cleanup is older than three minutes. At deployment with no connected PC, this can go stale until a heartbeat or cron resumes. Configure an external uptime alert and investigate overdue payloads.

Hosting/database plans and printer drivers determine practical capacity and cost; a no-gateway UPI flow does not make all hosting free. Review current [Vercel limits](https://vercel.com/docs/functions/limitations), [cron configuration](https://vercel.com/docs/cron-jobs), [Docker Windows requirements](https://docs.docker.com/desktop/setup/install/windows-install/) and [SumatraPDF print options](https://www.sumatrapdfreader.org/docs/Command-line-arguments).
