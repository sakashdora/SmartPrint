# SmartPrint — Automated Testing Strategy & Verification Plan

## 1. Testing Philosophy & Acceptance Criteria

Testing in SmartPrint adheres to the **Real Integrations, Zero Mocking of Core Logic** principle:
- **No Mock Databases:** All database tests execute against real PostgreSQL (Neon) or in-memory SQLite with full schema constraints and transactional rollbacks.
- **No Mock Payments:** Online payments test real HMAC-SHA256 signature verification and timing-safe equality; Direct UPI tests real 12-digit reference deduplication.
- **No False Hardware Claims:** Tests never falsely claim physical printing without verifiable evidence from the spooler or print agent.
- **Strict Concurrency Verification:** Multi-user simultaneous orders, concurrent approvals, and duplicate-click simulations must pass cleanly without orphaned locks or duplicate jobs.

---

## 2. Test Suite Architecture

SmartPrint utilizes Node.js's native test runner (`node --test`), structured across six specialized test suites:

```
test/
├── smartprint.test.js           # Core pricing, PDF normalization, cash lifecycle, webhooks
├── production.test.js           # Production session security, chunked uploads, UPI verification, leases
├── workflow.test.js             # End-to-end multi-user workflow, printer connection & queueing
├── reliability.test.js          # MFA RFC 6238 vectors, artwork greyscale, tenant isolation, sweeps
├── customer-preview.test.js     # Client preview readiness, quote repricing, upload caching
└── crop.test.js                 # Image cropping, coordinate bounding, and aspect ratio safety
```

---

## 3. Test Categories & Scope

### A. Unit Tests
- `validateOptions()`: Enforces layout rules, copy limits (1–100), paper size (A4), and duplex compatibility.
- `price()`: Tests two-up imposition pricing, duplex sheet calculations, and odd-page ceiling calculations.
- `totpStep()`: Validates RFC 6238 HMAC-SHA1 vectors and verifies that reused tokens in the same time step are rejected.
- State Machine transitions: Validates permitted and forbidden transitions across all roles.

### B. Integration Tests
- **Chunked Upload Pipeline:** Validates 1 MB chunk encryption, out-of-order chunk assembly, and upload expiration sweeps.
- **Quote Repricing:** Verifies that changing copies or duplex modes updates pricing without re-uploading the original file.
- **Tenant Isolation:** Confirms that Owner A cannot query or modify Owner B's orders, prices, devices, or transaction ledgers.
- **Direct UPI Reconciliation:** Asserts that duplicate 12-digit bank reference numbers across orders at the same shop fail with `409 Conflict`.

### C. End-to-End Concurrency & Race Condition Tests
- **Simultaneous Approvals:** Simulates mobile and laptop owners approving the same order concurrently; exactly one transaction is recorded.
- **Double-Tap Protection:** Simulates rapid double-clicking of "Place Order" with identical quote tokens; returns the existing order safely.
- **Multi-Device Claiming:** Simulates multiple background connector instances attempting to claim the same queued print job; exactly one lease is granted.
- **Lease Sweeper Recovery:** Simulates agent crash mid-print; verifies that `sweepLeases()` detects the expired lease and transitions the order to `needs_review` without orphaned states.

### D. Physical Hardware Testing Safety Rules
- Automated test runs MUST NOT send uncontrolled physical print jobs to production hardware.
- The test suite uses synthetic diagnostic test pages (`generateTestPage()`) and virtual / PDF spoolers during automated CI runs.
- Physical print tests are executed only in controlled shop environments with explicit operator confirmation.

---

## 4. Execution Commands & Reporting

```bash
# Run entire test suite
npm test

# Run syntax check across all source files
npm run check

# Verify production build static asset packaging
npm run build

# Check environment variable configuration status
npm run env:check
```
