# SmartPrint — Root Cause Analysis & Prioritized Bug Report

This document details the evidence-supported root causes, reproduction steps, customer impact, affected components, and engineering fixes for the eight primary issues observed across local development and the Render production deployment.

---

## Bug Report Index

| ID | Issue Description | Severity | Layer | Root Cause Summary |
| :--- | :--- | :--- | :--- | :--- |
| **BUG-01** | Uploads & Previews Slow to Become Usable | High | Backend / CPU | Heavy rasterization of every vector PDF page via `@napi-rs/canvas` + `sharp` in `grayscalePdf()`. |
| **BUG-02** | Slow Preview Load on Mobile QR Scan | Medium | Frontend / Client | Client re-uploading and recalculating quotes on minor UI touches; sequential base64 chunk processing. |
| **BUG-03** | Production (Render) Divergence from Local | High | DevOps / Environment | Linux container environment differences, Render 15-minute free tier cold-starts, origin header enforcement. |
| **BUG-04** | Restricted Printer/Queue Data Exposed to Customers | Critical | Security / API | Open `/api/local/printers` unauthenticated route with wildcard CORS; customer order API exposing queue count. |
| **BUG-05** | Token Quota & 429 Rate Limit Errors | High | Middleware / Network | Shared WiFi NAT IPs hitting aggressive 120/min mutation and 30/15min upload rate limits during chunked uploads. |
| **BUG-06** | Printer Connectivity & Print Status Unreliable | High | Windows Agent / Agent | Autoconnect spawning local processes on Render Linux; missing reconnection backoff; ambiguous lease timeouts. |
| **BUG-07** | Double Taps / Repeated Requests Duplicate Operations | Critical | Backend / Data | Lack of server-side idempotency keys and atomic state validation on order creation and payment confirmation. |
| **BUG-08** | Inconsistent State Across Customer/Owner/Admin | Medium | Architecture / Polling | Disjointed state transitions scattered in route handlers without centralized state machine validation. |

---

## Detailed Root Cause Diagnoses

### BUG-01 & BUG-02: Document Uploads & Previews Slower than Expected
- **Symptoms:** Uploading a 5-20 page PDF takes 15–40 seconds before a quote or preview appears.
- **Evidence:** Code inspection of `server/printing.js` (lines 8–30):
  ```javascript
  async function grayscalePdf(bytes) {
    for (let n = 1; n <= pdf.numPages; n++) {
      const source = await pdf.getPage(n), viewport = source.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await source.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const jpg = await sharp(Buffer.from(pixels.data.buffer), ...).greyscale().jpeg().toBuffer();
      ...
    }
  }
  ```
- **Root Cause:** When the user selected Black & White (the default), `prepare()` synchronously rasterized every single vector page into a 20-million pixel raw RGBA bitmap on the server CPU, compressed it to JPEG with `sharp`, and embedded it back into a PDF. On Render's 512 MB shared CPU, this saturated CPU and memory, causing 20+ second delays and OOM crashes.
- **Solution:** 
  1. Eliminate full server-side rasterization for vector PDFs. Modern Windows printer drivers and SumatraPDF natively enforce hardware monochrome via `-print-settings monochrome`.
  2. In the browser viewer, display grayscale preview instantaneously via CSS `filter: grayscale(100%)`.
  3. Restrict `sharp` greyscale processing to image inputs (PNG/JPG ID cards) where processing takes < 10ms.

---

### BUG-03: Production Deployment (Render) Differs from Local Development
- **Symptoms:** Features work on Windows localhost but fail on Render (`smartprint-ieks.onrender.com`).
- **Root Cause:**
  1. **OS Mismatch:** The Windows print scanner (`scanWindowsPrinters()`) executed Windows registry queries (`reg.exe`). In Render's Linux Docker environment, `reg.exe` does not exist, causing empty printer lists.
  2. **Render Spin-Down:** On Render's free tier, inactive services sleep after 15 minutes. The initial customer QR scan or API call takes 30–50 seconds for container startup.
  3. **Strict Origin Checking:** `server/index.js` checks `req.headers.origin === config.origin`. If `PUBLIC_BASE_URL` in Render environment variables is configured with `http://` instead of `https://` or omits custom domains, valid POST requests are rejected with `403 Request origin is not allowed`.
- **Solution:**
  1. Clearly isolate the Windows Print Agent to execute exclusively on the shop's local Windows computer.
  2. Enhance `server/config.js` to automatically normalize `RENDER_EXTERNAL_URL` and `RENDER_EXTERNAL_HOSTNAME` to secure HTTPS.
  3. Provide structured readiness probe (`/readyz`) and health check (`/api/health`).

---

### BUG-04: Restricted Printer & Queue Data Exposed to Customers
- **Symptoms:** Customers inspecting API requests or network responses could view shop printer hardware details and other queue activity.
- **Root Cause:**
  1. In `server/devices.js`, route `GET /api/local/printers` lacked authentication and had `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Private-Network: true`. Anyone on the internet could query local Windows registry printers, ports, and spooler states.
  2. In `server/index.js`, route `GET /api/orders/:id` queried `SELECT id, options, created FROM orders WHERE shop_id=$1` to compute queue positions, exposing queue depth and internal ordering details.
- **Solution:**
  1. Enforce strict shop-owner authentication on all printer scanning and diagnostic endpoints.
  2. Remove sensitive printer queue metrics from customer-facing tracking responses; customers only receive their own order's status and ETA indicators.

---

### BUG-05: Token Quota & 429 Rate Limit Errors
- **Symptoms:** Customers on shop WiFi or campus networks received "Too many attempts" (HTTP 429) errors during document upload.
- **Root Cause:**
  - `server/index.js` lines 46–48:
    ```javascript
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && ...) await limitRate(db, 'mutations', req.ip, 120);
    if (req.path === '/api/quotes' || req.path === '/api/uploads') await limitRate(db, 'uploads', req.ip, 30, 900);
    ```
  - For a 15 MB file uploaded in 1 MB chunks, each chunk is a `PUT /api/uploads/:id/chunks/:part`. Multiple customers sharing the shop's public NAT IP quickly exhausted the 120 mutations/min window.
- **Solution:**
  - Exclude authorized chunk uploads (`PUT /api/uploads/:id/chunks/:part`) from the generic IP-based mutation rate limiter, since they are already constrained by their cryptographically signed upload token and shop storage quotas.
  - Implement per-token quota accounting rather than punishing all customers sharing a public NAT gateway.

---

### BUG-06: Printer Connectivity & Print-Job Status Unreliable
- **Symptoms:** Shop owners clicking "Connect Printer" on the dashboard saw printer disconnects or lost jobs.
- **Root Cause:**
  - When hosted on Render, calling `/api/owner/printers/autoconnect` attempted to write to `%LOCALAPPDATA%` and launch `connector/index.js` inside the Render Linux container.
  - In `connector/index.js`, unhandled network errors in the polling loop caused tight CPU spinning without exponential backoff.
  - Print spooler submission was not cleanly separated from physical paper output confirmation.
- **Solution:**
  - Clearly document and package the standalone Windows Print Agent launcher (`start-connector.bat`) to run on the physical Windows PC.
  - Add exponential backoff (1s -> 2s -> 5s -> 10s) on network failures in `connector/index.js`.
  - Enforce a strict three-phase print lifecycle: (1) `claimed` (leased to agent), (2) `awaiting_confirmation` (spooler accepted), (3) `completed` (owner confirmed paper output).

---

### BUG-07: Double Taps / Repeated Requests Creating Duplicate Operations
- **Symptoms:** An eager customer tapping "Place Order" twice or an owner tapping "Collect Cash" rapidly caused duplicate order records or unexpected 409 error alerts.
- **Root Cause:**
  - `POST /api/orders` consumed quotes with `UPDATE quotes SET used=1 WHERE id=$1 AND used=0`. The second request immediately threw `409 Quote expired or already used` instead of returning the existing order ID.
  - No server-side idempotency store existed to deduplicate requests with identical idempotency keys.
- **Solution:**
  - Implement a durable `idempotency_keys` table with scoped actor, operation, and response caching.
  - Add client-side disabling of buttons and debouncing on all mutation buttons.

---

### BUG-08: Customer, Owner, and Admin State Inconsistency
- **Symptoms:** An order approved on mobile did not reflect immediately on the owner's laptop or customer's tracking screen without manual refresh.
- **Root Cause:**
  - Polling intervals (`live.js`) relied on naive 5-second timers that paused when dialogs were open or when tabs were backgrounded.
  - Transitions were executed directly with ad-hoc SQL updates across multiple route files, causing edge cases where orders could jump into invalid states.
- **Solution:**
  - Build a centralized Order State Machine (`server/state-machine.js`) that validates every transition and logs history in `order_history`.
  - Provide immediate UI state reconciliation and reactive fallback polling.
