# Security and privacy

Updated 23 October 2026. Controls below are implemented; operational validation remains explicit.

| Risk | Control |
|---|---|
| Cross-shop access | Server-derived owner/device scope, role gates, denied-case tests; no admin customer-file route |
| Password guessing | Salted scrypt N=32768/r=8/p=3, persistent account/IP limits, generic failed login |
| Session theft | Mandatory production MFA, TOTP replay rejection, encrypted MFA secret, hashed eight-hour HttpOnly/Secure/SameSite sessions |
| CSRF / XSS | Exact mutation Origin, escaped HTML, same-origin CSP, PDF.js eval disabled |
| SQL injection / excess privileges | Parameterized SQL, smartprint schema, separate runtime/migration logins, TLS verify-full |
| Payment forgery | Customer UPI references never release printing; owner checks bank credit; unique collection per order |
| Duplicate printing | Conditional transitions, lease tokens, durable submission journal, operator review after uncertainty |
| Malicious documents | Allowlisted types, byte/page/pixel limits, fail-closed ClamAV scan, isolated read-only non-root processor, Office macros disabled |
| Resource exhaustion | Bounded upload/chunk/output sizes, per-shop reservations, bounded preparation queue, process deadlines and container limits |
| File leakage | AES-256-GCM payloads, authenticated no-store downloads, temporary cleanup, content-free audit |
| Compromised connector | Shop-only revocable credential, no payment/admin authority, DPAPI-protected Windows settings |

## Credentials

Admin identity and password hash persist in Neon. Generated initial credentials are in ignored `.data/admin-access.txt`. Enroll MFA, change the password, save it privately and remove that delivery file. Password changes revoke all sessions. No public reset endpoint exists: verified operator recovery issues a password, revokes sessions/MFA and audits the action.

Vercel receives only runtime database URL, encryption key, cron secret and public origin. Migration credentials stay local; processor secrets stay on the shop PC. Keep the encryption key stable because files and MFA secrets depend on it. Back it up securely; key rotation requires re-encryption.

Rotate the database-owner password exposed in chat before launch. The app now uses a separate generated restricted runtime credential. Never expose credentials in browser code, logs, screenshots or support tickets.

## Retention and limits

Successful physical-print confirmation atomically deletes the live PDF. Cancellation/refund removes remaining live print data. Original uploads disappear after preparation; abandoned uploads expire in 30 minutes, preparations/quotes in 15 minutes, prepared PDFs in 24 hours. Access expires immediately; actual cleanup can wait for a worker after an outage. Monitor cleanup freshness and overdue payloads.

Neon backups retain encrypted historical copies according to configured retention. Shared-key encryption is not per-document cryptographic erasure. Browser previews/downloads and Windows/printer spools are separate retention surfaces; the connector clears its own cached PDFs, while the shop controls spool/printer settings. Permanent receipts contain amounts, options and references, not document content or filenames.

## Customer notice

Your chosen shop uses your file to prepare and print this order. The live print file is removed after successful printing is confirmed, or when temporary retention expires and cleanup runs. Transaction details remain for receipts and reconciliation. Encrypted historical data may remain in backups for the configured backup-retention period. Upload only files you are permitted to print. Ask the shop about payment corrections, refunds and printer handling.

## Before public launch

Validate Docker isolation, scanner rejection and physical printer behavior; rotate exposed owner credentials; enroll MFA; protect backups; test account recovery; set exact HTTPS origin; monitor cleanup; choose backup retention and perform a restore drill. Publish operator-approved privacy/refund/contact policies appropriate to the business. This is an engineering specification, not legal certification.

Keep Node, PDF.js, Sharp, LibreOffice, ClamAV signatures, SumatraPDF and Windows patched. A dependency audit is not a penetration test.

Incident response: suspend affected shops/devices, revoke credentials/sessions, stop intake if access or cleanup fails, preserve content-free audit evidence, investigate verified impact, restore trusted artifacts and re-test access before reopening.
