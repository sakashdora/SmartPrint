# API contract v1

JSON errors: `{"error":"message"}`. Money is integer paise; timestamps UTC ISO-8601. 400 invalid input, 401 unauthenticated, 403 forbidden, 404 absent/inaccessible, 409 conflicting state, 413 oversized, 429 throttled, 503 integration unavailable. No stack traces or secret values.

Owner/admin requests use the session cookie. Production mutations require the configured Origin. Guest resources use `Authorization: Bearer <token>`; device routes use a paired bearer token and print downloads/events also use `X-Lease-Token`. Tokens never go in URLs.

## Customer and authentication

| Method / path | Contract |
|---|---|
| GET /api/health | Mode and feature availability; no secrets |
| GET /api/shops/:slug | Active shop and public prices/UPI availability |
| POST /api/auth/register | email, password, name, location → pending owner/shop |
| POST /api/auth/login | email, password, optional authenticator code → cookie and MFA requirement |
| POST /api/auth/logout | Revoke current session |
| GET /api/me | Current identity or null |
| POST /api/auth/mfa/setup | Signed-in user → one-time enrollment secret/QR |
| POST /api/auth/mfa/confirm | Fresh six-digit code → enable MFA, revoke old sessions |
| POST /api/auth/password | current, password → change password and revoke all sessions |
| POST /api/uploads | slug, name, size → upload id, token and chunkSize |
| PUT /api/uploads/:id/chunks/:part | Upload token, base64 data; exact chunk size, idempotent part |
| POST /api/quotes | slug, files [{uploadId,token}], options → 202 preparation handle in production |
| GET /api/preparations/:id | Preparation token → pending/failed or complete quote |
| GET /api/quotes/:id/preview | Quote token → PDF with no-store; Range chunks up to 1 MiB |
| POST /api/orders | Quote token, quoteId, method cash/upi → private receipt id/token |
| GET /api/orders/:id | Receipt token → payment/print/deletion state |
| GET /api/orders/:id/upi | Receipt token → shop payee, amount-bound UPI URI/QR |
| POST /api/orders/:id/upi | Receipt token, 12-digit reference → report only, never paid |

Options: `{color:"bw"|"color",duplex:boolean,layout:"single"|"two"|"card",copies:1..100,range:string,crop:0..20,rotate:0|90|180|270,smartCrop:boolean,enhance:boolean}`.

## Owner

| Method / path | Contract |
|---|---|
| GET /api/owner/shop | Own shop |
| GET /api/owner/orders | Latest 200 own orders |
| GET /api/owner/summary | All-time collection/refund/net, transaction and order counts |
| GET /api/owner/transactions?limit=100&offset=0 | Ledger page, max 200, includes refund fields |
| GET /api/owner/refunds | Own recorded refunds |
| PUT /api/owner/prices | bw/color integer paise, increment price version |
| GET /api/owner/qr | QR for exact configured origin and shop slug |
| GET/PUT /api/owner/payments | upi_id, payee; future orders use new payee |
| GET/POST /api/owner/devices | List or create name/color/duplex capability; token shown once |
| DELETE /api/owner/devices/:id | Revoke own device |
| POST /api/owner/orders/:id/cash | Collect pending cash order |
| POST /api/owner/orders/:id/upi-confirm | confirmed=true + bank-verified reference → collection |
| POST /api/owner/orders/:id/start | Paid queued → printing for manual fallback |
| GET /api/owner/orders/:id/document | Paid manual-print state only; range PDF download |
| POST /api/owner/orders/:id/complete | confirmed=true after physical success → complete + delete live PDF |
| POST /api/owner/orders/:id/resolve-failed | confirmed=true after paper/Windows-queue check → failed |
| POST /api/owner/orders/:id/cancel | Non-running permitted state → cancel + delete |
| POST /api/owner/orders/:id/refund | Stopped/expired paid order, confirmed=true, returned-money reference → refund ledger + delete |

## Device, administration and operations

Device endpoints: POST `/api/device/heartbeat`, POST `/api/device/preparations/claim`, GET `/api/device/preparations/:id/files/:file/:part`, POST `/api/device/preparations/:id/result` (byte size), PUT `/api/device/preparations/:id/result/:part` (base64 chunk), POST `/api/device/preparations/:id/complete` (source pages), POST `/api/device/preparations/:id/fail` (bounded error). Claims/downloads are assigned-device and shop scoped.

Print endpoints: POST `/api/device/claim` → paid compatible job and lease; GET `/api/device/jobs/:id/document`; POST `/api/device/jobs/:id/events` with submitted/awaiting_confirmation/failed. Failed/expired ambiguous submissions require review; completed jobs cannot be resurrected.

Admin: GET `/api/admin/shops`, POST `/api/admin/shops/:id/status` with active/suspended, GET `/api/admin/audit` (latest 100). No admin document-download endpoint.

GET `/maintenance` requires `Authorization: Bearer CRON_SECRET`. GET `/readyz` returns 503 when cleanup freshness exceeds three minutes. Device heartbeat also runs due cleanup.

The optional legacy gateway endpoints remain disabled without explicit provider configuration. They are not used by the direct-UPI deployment.
