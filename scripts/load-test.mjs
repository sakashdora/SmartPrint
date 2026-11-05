// Load test for the education queue. It starts the real application in this process against a THROWAWAY database
// (in-memory SQLite by default; PostgreSQL only when SMARTPRINT_TEST_DATABASE_URL names a database containing "test",
// exactly like the automated tests) and never touches production data.
//
//   node scripts/load-test.mjs                       # 200 students, 3 jobs each, 10 printers on 5 agents
//   node scripts/load-test.mjs --students 400 --jobs 4 --printers 20 --agents 8 --concurrency 40 --wallet
//
// It reports submit latency, claim latency, throughput and the invariants that must hold under load: every job is
// printed exactly once, no printer ever has two live attempts, and (with --wallet) the ledger still balances.
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { token, digest } from '../server/security.js';
import { boot, pdf } from '../test/helpers/edu.js';
import { verifyLedger, creditStudent } from '../server/wallet.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : (typeof fallback === 'boolean' ? true : Number(process.argv[i + 1])); };
const cfg = { students: arg('students', 200), jobs: arg('jobs', 3), printers: arg('printers', 10), agents: arg('agents', 5), concurrency: arg('concurrency', 25), wallet: arg('wallet', false) };
const cleanups = [];
const t = { after: fn => cleanups.push(fn) };
const pct = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0;
const stats = xs => ({ n: xs.length, p50: +pct(xs, 0.5).toFixed(1), p95: +pct(xs, 0.95).toFixed(1), p99: +pct(xs, 0.99).toFixed(1), max: +Math.max(0, ...xs).toFixed(1) });
async function pool(items, size, worker) { let next = 0; await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) { const i = next++; await worker(items[i], i); } })); }

try {
  const ctx = await boot(t);
  const admin = await ctx.org('loadtest');
  const info = (await ctx.call('/api/v2/edu/institution', { cookie: admin.cookie })).body;
  await ctx.call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: admin.cookie, body: { version: info.version, policies: cfg.wallet ? { studentPrinting: 'wallet', studentRateBwMinor: 100 } : { studentPrinting: 'free' } } });

  console.log(`Setting up ${cfg.students} students and ${cfg.printers} printers on ${cfg.agents} agents…`);
  const setupStart = performance.now();
  const perAgent = Math.ceil(cfg.printers / cfg.agents), agents = [];
  for (let a = 0; a < cfg.agents; a++) {
    const printers = Array.from({ length: perAgent }, (_, i) => ({ name: `P${a}-${i}`, color: false, duplex: false }));
    agents.push(await ctx.agent(admin, printers, `PC ${a}`));
  }
  const defaultPool = (await ctx.call('/api/v2/edu/pools', { cookie: admin.cookie })).body.find(p => p.is_default).id;
  const sched = await ctx.call(`/api/v2/edu/pools/${defaultPool}/scheduler`, { method: 'PUT', cookie: admin.cookie, body: { scheduler: 'wfq_aging' } });
  if (sched.status !== 200) throw new Error('could not enable the fair queue');
  const students = [];
  // Students get a session directly (logging in is rate limited per address, and is not what is being measured here).
  const stamp = new Date().toISOString();
  for (let i = 0; i < cfg.students; i++) {
    const userId = randomUUID(), secret = token();
    await ctx.db.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,'unused','customer')", [userId, `load-${i}-${userId.slice(0, 6)}@x.test`]);
    await ctx.db.query('INSERT INTO memberships (id,org_id,user_id,role,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), admin.orgId, userId, 'student', stamp]);
    await ctx.db.query("INSERT INTO edu_profiles (user_id,org_id,kind,college_id,name,status,created) VALUES ($1,$2,'student',$3,'Load Student','active',$4)", [userId, admin.orgId, `L-${i}`, stamp]);
    await ctx.db.query('INSERT INTO sessions (id,user_id,expires,mfa,last_seen,created) VALUES ($1,$2,$3,0,$4,$4)', [digest(secret), userId, new Date(Date.now() + 8 * 3600000).toISOString(), stamp]);
    students.push({ userId, cookie: `sp_session=${secret}` });
  }
  // Opening balances are posted through the ledger directly (the admin credit endpoint is rate limited by design).
  if (cfg.wallet) for (const s of students) await ctx.db.transaction(tx => creditStudent(tx, { orgId: admin.orgId, userId: s.userId, amountMinor: 100000, key: `load-${s.userId}`, kind: 'adjustment', actor: admin.userId, note: 'load test' }));
  console.log(`  set up in ${((performance.now() - setupStart) / 1000).toFixed(1)} s`);

  const noCookie = students.filter(s => !s.cookie).length;
  if (noCookie) console.log(`  ${noCookie} students could not sign in during set-up`);
  const document = await pdf(1);
  const submitMs = [], errors = {}, jobIds = [];
  const work = students.flatMap(s => Array.from({ length: cfg.jobs }, () => s));
  const t0 = performance.now();

  // Printers run while students are still submitting, like a real afternoon.
  let submitting = true, printed = 0;
  const claimMs = [];
  const printers = agents.flatMap(a => Object.keys(a.printers).map(name => ({ a, name })));
  const printerLoop = async ({ a, name }) => {
    let idle = 0;
    while (submitting || idle < 3) {
      const s = performance.now();
      const [claimed] = await a.claim(name);
      claimMs.push(performance.now() - s);
      if (!claimed) { idle++; await new Promise(r => setTimeout(r, 20)); continue; }
      idle = 0;
      await a.report(claimed, { event: 'submitted' });
      await a.report(claimed, { event: 'completed', pages: claimed.pages });
      printed++;
    }
  };
  const printersDone = Promise.all(printers.map(printerLoop));

  await pool(work, cfg.concurrency, async student => {
    const s = performance.now();
    const doc = await ctx.call('/api/v2/edu/documents', { method: 'POST', cookie: student.cookie, raw: document });
    const job = await ctx.call('/api/v2/edu/jobs', { method: 'POST', cookie: student.cookie, body: { documentId: doc.body.documentId, fileName: 'load.pdf', options: {} } });
    submitMs.push(performance.now() - s);
    if (job.status === 201) jobIds.push(job.body.jobId); else { const key = `${job.status} ${job.body?.code ?? ''}`.trim(); errors[key] = (errors[key] ?? 0) + 1; }
  });
  const submitDone = performance.now() - t0;
  submitting = false;
  await printersDone;
  const total = performance.now() - t0;

  const count = async (sql, p) => ctx.number(sql, p);
  const completed = await count("SELECT COUNT(*) AS n FROM print_jobs WHERE status='completed'");
  const notDone = await count("SELECT COUNT(*) AS n FROM print_jobs WHERE status<>'completed'");
  const attempts = await count('SELECT COUNT(*) AS n FROM print_attempts');
  const doublePrinted = await count("SELECT COUNT(*) AS n FROM (SELECT job_id FROM print_attempts WHERE state='completed' GROUP BY job_id HAVING COUNT(*) > 1) x");
  const live = await count("SELECT COUNT(*) AS n FROM print_attempts WHERE state IN ('claimed','submitted','uncertain')");
  const ledger = cfg.wallet ? await verifyLedger(ctx.db, admin.orgId) : null;
  const waits = (await ctx.db.query("SELECT j.enqueued_at, a.created FROM print_jobs j JOIN print_attempts a ON a.job_id=j.id")).map(r => Date.parse(r.created) - Date.parse(r.enqueued_at));

  const result = {
    config: cfg, database: process.env.SMARTPRINT_TEST_DATABASE_URL ? 'PostgreSQL (test database)' : 'SQLite in memory', node: process.version,
    submitted: jobIds.length, rejected: errors, completed, notCompleted: notDone, attempts,
    seconds: { submitting: +(submitDone / 1000).toFixed(1), untilEverythingPrinted: +(total / 1000).toFixed(1) },
    throughput: { submitJobsPerSecond: +(jobIds.length / (submitDone / 1000)).toFixed(1), printedJobsPerSecond: +(completed / (total / 1000)).toFixed(1) },
    submitLatencyMs: stats(submitMs), claimLatencyMs: stats(claimMs), queueWaitMs: stats(waits),
    invariants: { everyJobPrintedExactlyOnce: completed === jobIds.length && doublePrinted === 0 && attempts === completed, jobsPrintedTwice: doublePrinted, attemptsStillLive: live, ledgerBalanced: ledger ? ledger.ok : 'not run (use --wallet)' }
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.invariants.everyJobPrintedExactlyOnce || live || (ledger && !ledger.ok)) { console.error('INVARIANT VIOLATED'); process.exitCode = 1; }
} finally {
  for (const fn of cleanups.reverse()) await fn().catch?.(() => {});
}
