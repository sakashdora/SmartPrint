# Smart Print · Architecture Analysis and Implementation Plan (v2)

Analysis and plan produced for `main` @ `1a1e59b`. After the plan was approved, **Phase 0–1 only** was implemented and deployed (commits `11960a1`, `5b19277`; see the status note in [14](14-phased-implementation-roadmap.md)). Phases 2–8 and all Education Mode work are **not started** and wait for explicit approval.

## Documents

| # | Document |
|---|---|
| 01 | [Existing Project Technical Audit](01-existing-project-technical-audit.md) |
| 02 | [Architecture Blueprint](02-architecture-blueprint.md) |
| 03 | [Business Mode vs Education Mode](03-business-vs-education-mode.md) |
| 04 | [Flexible Institution Configuration](04-flexible-institution-configuration.md) |
| 05 | [Unified Registration and Authentication Flow](05-registration-and-authentication-flow.md) |
| 06 | [Role and Permission Matrix](06-role-permission-matrix.md) |
| 07 | [Database ER Diagram and Migration Strategy](07-database-er-diagram.md) |
| 08 | [API Architecture and Endpoint Map](08-api-architecture-endpoint-map.md) |
| 09 | [Print Queue and Windows Agent Architecture](09-print-queue-and-agent-architecture.md) |
| 10 | [Wallet, Payment and Offline Architecture](10-wallet-payment-offline-architecture.md) |
| 11 | [Security and Document Retention Plan](11-security-and-document-retention-plan.md) |
| 12 | [Scalability and Extensibility Strategy](12-scalability-and-extensibility-strategy.md) |
| 13 | [Existing Functionality Improvement Report](13-existing-functionality-improvement-report.md) |
| 14 | [Phased Implementation Roadmap](14-phased-implementation-roadmap.md) |
| 15 | [Testing and Acceptance Criteria](15-testing-and-acceptance-criteria.md) |
| 16 | [Risk Assessment and Rollback Plan](16-risk-assessment-and-rollback-plan.md) |
| 17 | [Final Recommended Architecture and open decisions](17-final-recommended-architecture.md) |

## Evidence labels
**[V]** verified in source · **[T]** verified by running the existing tests (97 tests: 96 pass, 1 skipped, SQLite, isolated) · **[A]** assumption · **[U]** not verifiable here (production, Neon, Render, printers, Razorpay) · **[R]** recommendation.

## Limits of the evidence
The analysis itself did not touch a live printer, the production API, Neon or Render, and no production data was inspected, so counts of existing shops and orders are unknown (`scripts/census.sql` is provided for that). No load test was run. Only Phase 1 changes touched production (the Neon migration and a Render deploy).
