# Load test

`scripts/load-test.mjs` starts the real application inside the test process against a **throwaway** database
(in-memory SQLite by default; PostgreSQL only when `SMARTPRINT_TEST_DATABASE_URL` names a database containing
"test", the same guard the automated tests use). It never reads `DATABASE_URL`, so it cannot touch production.

```bash
node scripts/load-test.mjs                                  # 200 students, 3 jobs each, 10 printers on 5 agents
node scripts/load-test.mjs --students 300 --jobs 3 --printers 12 --agents 6 --concurrency 40 --wallet
```

Students submit a one-page PDF (upload + job creation, two HTTP calls) with `--concurrency` requests in flight while
the printers claim, submit and complete jobs in loops, like an afternoon in a computer lab. The fair queue
(`wfq_aging`) is enabled. With `--wallet` every student prints against a prepaid wallet (hold, capture) and the
ledger is verified at the end. The exit code is non-zero if an invariant is violated.

## Result (this development PC)

Ryzen 5 5600H, 15 GB RAM, Node 24, in-memory SQLite, **server, 300 simulated students and 12 simulated printers
all sharing the same CPU**. 300 students × 3 jobs = 900 jobs, 40 concurrent requests.

| | free printing | wallet printing |
|---|---|---|
| jobs submitted / printed | 900 / 900 | 900 / 900 |
| jobs printed twice | 0 | 0 |
| attempts left live | 0 | 0 |
| ledger balanced | – | yes |
| submit (upload + create) p50 / p95 / p99 | 412 / 468 / 619 ms | 429 / 494 / 639 ms |
| claim p50 / p95 | 32 / 312 ms | 32 / 321 ms |
| submit throughput | 94 jobs/s | 91 jobs/s |
| printed throughput (queue drain) | 63 jobs/s | 60 jobs/s |
| time to submit all / to print all | 9.5 s / 14.2 s | 9.9 s / 14.9 s |

## How to read this

* **Correctness under load is the result that matters.** Every job was printed exactly once, no printer ever had two
  live attempts, and the wallet ledger balanced to the paisa. A real college prints a few jobs per minute per
  printer; the test pushed roughly 3,500 jobs per minute through the queue.
* **The latencies are an upper bound for one process on one CPU**, because the load generator, 12 agents and the
  server compete for the same cores, and submit includes PDF parsing, page counting and per-institution encryption.
  Claim p95 is dominated by the 12 printer loops polling at once.
* **They are not PostgreSQL numbers.** SQLite in memory has no network hop and no row-level locking; production
  uses PostgreSQL (Neon), where each query adds a network round trip and claims use `FOR UPDATE SKIP LOCKED`. The
  same invariants are exercised against PostgreSQL by the CI job (`phase6-queue`, `phase3-agents`, wallet and
  offline suites), but a latency/throughput run against a PostgreSQL test database has not been done. To do it,
  create a disposable database whose name contains `test` and run
  `SMARTPRINT_TEST_DATABASE_URL=<url> node scripts/load-test.mjs --wallet`. Do not point it at the production
  Neon database; the guard refuses.
* Student sessions are created directly in the database because sign-in is rate limited per address by design,
  and opening balances are posted through the ledger because manual credits are rate limited too.
