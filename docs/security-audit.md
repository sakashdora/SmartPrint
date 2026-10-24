# SmartPrint — Security Audit, Threat Model & Privacy Controls

## 1. Security Overview & Threat Model

SmartPrint handles sensitive customer documents, proprietary shop pricing, financial transactions (Cash, UPI, Gateway), and hardware printing interfaces. This document outlines the threat vectors, vulnerabilities identified, mitigation implementations, and verification evidence.

---

## 2. Threat Vector Assessment & Mitigations

### A. Broken Object-Level Authorization (BOLA / IDOR)
- **Threat:** Customer A attempts to access Customer B's order, preview, or print file by guessing order IDs.
- **Mitigation:**
  - Order routes require cryptographic receipt tokens generated via `crypto.randomBytes(32).toString('hex')`.
  - The token is hashed with SHA-256 (`digest(token)`) before database lookup.
  - Public order endpoints never return database primary keys for documents or provider orders (`publicOrder()` sanitization).
  - Test verification: `assert.equal((await request('/api/orders/' + orderId, { token: 'bad' })).status, 404)`.

### B. Multi-Tenant Shop Isolation
- **Threat:** Shop Owner A attempts to view, approve, cancel, or download documents belonging to Shop Owner B.
- **Mitigation:**
  - All owner queries strictly enforce ownership filtering:
    `SELECT * FROM shops WHERE owner_id = $1`
    `SELECT * FROM orders WHERE id = $1 AND shop_id = $2`
  - Unique index `one_active_shop_per_owner` guarantees a single shop per owner.
  - Test verification: An authenticated owner attempting to access another shop's order receives `404 Order not found` or `403 Forbidden`.

### C. Unauthenticated Local Hardware Exposure (Resolved)
- **Vulnerability:** `GET /api/local/printers` previously lacked authentication, exposed Windows registry and spooler details, and allowed wildcard CORS (`Access-Control-Allow-Origin: *`).
- **Remediation:**
  - Route now requires authenticated shop owner role (`requireRole('owner')`) or an authorized device token.
  - Wildcard CORS and unauthenticated access are completely removed.

### D. Rate Limiting & Denial of Service Protection
- **Vulnerability:** Shared NAT gateways (e.g., college campus WiFi) triggered 429 errors during chunked uploads due to aggressive IP-based limits.
- **Remediation:**
  - Chunked uploads (`PUT /api/uploads/:id/chunks/:part`) are validated using signed upload tokens and scoped to a shop storage quota rather than IP mutation limits.
  - Auth routes enforce `limitRate(db, 'auth', req.ip, 40, 900)` to prevent brute-force attacks on passwords and MFA tokens.

### E. Cryptography & Data at Rest
- **Password Storage:** Uses `scrypt` with RFC-compliant parameters ($N=32768, r=8, p=3$) and 16-byte random salts.
- **Document Payloads:** Encrypted with AES-256-GCM using a 256-bit key (`FILE_ENCRYPTION_KEY`). Initialization vectors (12 bytes) and authentication tags (16 bytes) are unique per chunk.
- **Zero-Retention Life Cycle:** Encrypted documents and chunks are immediately deleted upon confirmed printing or order cancellation. Expired temporary uploads are deleted every 60 seconds by background maintenance workers.

### F. Multi-Factor Authentication (MFA)
- Time-based One-Time Password (TOTP) compliant with RFC 6238 using HMAC-SHA1 and 30-second steps.
- Replay prevention: Tracks `mfa.last_step` and strictly rejects reused codes within the validity window.
- Test verification: Confirmed using standard RFC 6238 test vectors.

### G. Online Payment Security
- Razorpay webhook signature verification via HMAC-SHA256 (`timingSafeEqual`).
- Duplicate webhook prevention: `payment_events` table ensures each event ID is processed exactly once (`ON CONFLICT(id) DO NOTHING`).
- Verified payment amount, order association, and currency (`INR`) server-side before marking payment complete.
- Direct UPI verification: Requires owner to input the 12-digit bank reference, strictly enforces uniqueness (`unique_upi_collection` index) to prevent UPI receipt replay attacks across orders.

---

## 3. Security Checklist Summary

| Security Control | Implementation Status | Verification Method |
| :--- | :--- | :--- |
| **Strict CSP Headers** | Implemented (`script-src 'self'`, `object-src 'none'`) | HTTP Header Inspection |
| **HSTS in Production** | Implemented (`Strict-Transport-Security: max-age=31536000`) | Production Header Check |
| **Origin Checking** | Enforced for mutations in production | Automated Origin Tests |
| **Zero Customer Login** | Tokenized receipts for privacy | Customer Flow Integration Test |
| **Audit Logging** | Every mutation logged to `audit` table | `test/production.test.js` |
| **No Credential Logging** | Sanitized log output; zero tokens in console | Automated Syntax & Log Check |
