# Operations and recovery

## Routine checks

Check printer online state, pending UPI/cash, uncertain print jobs, refund obligations, all-time collection/refund/net totals and recent audit entries. A receipt or screenshot alone is not bank verification. Export the ledger and reconcile it against the shop's actual bank/cash records.

Monitor `/readyz` and API failure rates, processor/ClamAV health, signature freshness, storage, expired payloads and Windows disk/print queue. Review dependency updates and OS support regularly. Do not log tokens, passwords, filenames or document content.

## Print failure

1. Check the physical paper and Windows printer queue. Stop any outstanding job if it cannot be fulfilled.
2. If fully printed, use Confirm output. This atomically deletes the live file.
3. If not fulfilled, use Print failed / stopped after ensuring the queue is stopped. Then cancel or return money and record the refund reference.
4. A replacement print uses a fresh customer-approved upload/order. Do not remove submission journals to force a retry of an uncertain job.

The connector removes its downloaded PDF after submission and stale PDFs on startup. Submission journals contain order identifiers/hashes, not document content. Configure Windows/printer spool retention separately. Stop all connector processes before investigating local cache cleanup.

## Account recovery

Normal password changes use Account settings and revoke all sessions. If an owner/admin loses their password or authenticator, an authorized platform operator must verify their identity independently. The operator can then run locally with the private database environment:

```powershell
$env:RECOVERY_REASON = 'Verified account holder through the operator recovery process'
npm run account:recover -- account@example.com
Remove-Item Env:RECOVERY_REASON
```

This replaces that account's password, revokes its sessions and authenticator, audits recovery and writes new credentials to a private `.data/recovery-*.txt` file. It does not change account role. Deliver credentials through an approved private channel; the user must enroll MFA again and change the password. Remove the delivery file when no longer needed. Never run recovery from a public API or unattended scheduler.

## Database and encryption

Runtime uses `DATABASE_URL`; migrations use `MIGRATION_DATABASE_URL`. Apply additive migrations on a test branch first. Keep database-owner credentials out of Vercel. Revoking the owner password does not replace the separate runtime password. Rotate a compromised runtime/device token and update its consumers deliberately.

Back up the encryption key in a protected secret store. A database backup without the matching key cannot decrypt documents or authenticator secrets. Do not simply replace the key in production. A planned key rotation requires decrypt/re-encrypt migration and a rollback plan; that automated migration is not included.

Choose Neon backup retention based on the operator's actual requirements. Test restores on a separate branch. Reconcile deleted/cancelled/refunded orders against restored payloads and run cleanup before allowing access. Do not restore over newer payments blindly. Record recovery time and acceptable data-loss objectives from a real drill.

## Outages and alerts

Expired files are denied at read/claim time. Physical expiry deletion waits for successful cleanup; connector heartbeats, local timers, function initialization and daily cron provide triggers. A complete outage can delay erasure. Investigate stale cleanup, database connectivity and worker availability rather than displaying a false success.

Scanner/converter outage rejects preparation. Connector outage leaves jobs unprinted. Bank verification delay leaves payment pending. Lost Internet is not supported as a full offline mode. Communicate an accurate status and refund where appropriate.

## Incident handling

Revoke the affected device or suspend the shop, stop new intake if file access or cleanup cannot be trusted, preserve content-free audit metadata, identify affected orders/tenants, rotate compromised secrets, restore trusted software and repeat denied-access and physical-print checks before reopening. Operator-approved privacy/refund/contact policies govern communication and record retention.

## Release handoff

Build and tests validate application behavior. A user-managed Vercel deployment and real scanner/printer pilot are still required. Keep a dated record of who verified each item in document 06. Do not claim paper output or backup erasure based solely on an API success response.
