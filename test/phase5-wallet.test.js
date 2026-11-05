import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, pdf } from './helpers/edu.js';

async function setup(t, name, { policy = { studentPrinting: 'wallet', studentRateBwMinor: 300, studentRateColourMinor: 900 } } = {}) {
  const ctx = await boot(t);
  const admin = await ctx.org(name), student = await ctx.member(admin.orgId, 'student');
  const printer = await ctx.agent(admin);
  const current = (await ctx.call('/api/v2/edu/institution', { cookie: admin.cookie })).body;
  assert.equal((await ctx.call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: admin.cookie, body: { version: current.version, policies: policy } })).status, 200);
  const pool = (await ctx.call('/api/v2/edu/pools', { cookie: admin.cookie })).body[0];
  await ctx.call(`/api/v2/edu/pools/${pool.id}/scheduler`, { method: 'PUT', cookie: admin.cookie, body: { userCap: 1000 } });
  let n = 0;
  const credit = (amountMinor, who = student, key = `credit-${++n}-${Math.random()}`) => ctx.call(`/api/v2/edu/wallets/${who.userId}/credit`, { method: 'POST', cookie: admin.cookie, body: { amountMinor, note: 'cash at the counter', idempotencyKey: key } });
  const wallet = async who => (await ctx.call('/api/v2/edu/wallet', { cookie: who.cookie })).body;
  const upload = async (who, pages = 1) => (await ctx.call('/api/v2/edu/documents', { method: 'POST', cookie: who.cookie, raw: await pdf(pages) })).body.documentId;
  const submit = async (who, pages = 1, options = {}) => ctx.call('/api/v2/edu/jobs', { method: 'POST', cookie: who.cookie, body: { documentId: await upload(who, pages), fileName: 'a.pdf', options } });
  const verify = async () => (await ctx.call('/api/v2/edu/wallets/verify', { cookie: admin.cookie })).body;
  const revenue = async () => ctx.number("SELECT COALESCE(SUM(b.available_minor),0) AS n FROM wallet_accounts a JOIN wallet_balances b ON b.account_id=a.id WHERE a.org_id=$1 AND a.kind='revenue'", [admin.orgId]);
  return { ...ctx, admin, student, printer, credit, wallet, upload, submit, verify, revenue };
}

test('manual credit: reason, bounds, idempotency key, roles and isolation', async t => {
  const s = await setup(t, 'credit');
  assert.equal((await s.credit(100000)).status, 201);
  assert.equal((await s.wallet(s.student)).available, 100000);
  const key = 'same-key-12345';
  assert.equal((await s.credit(5000, s.student, key)).status, 201);
  const replay = await s.credit(5000, s.student, key);
  assert.deepEqual([replay.status, replay.body.replay, replay.body.available], [200, true, 105000], 'a repeated request posts once');
  const call = (body, headers = {}) => s.call(`/api/v2/edu/wallets/${s.student.userId}/credit`, { method: 'POST', cookie: s.admin.cookie, headers, body });
  assert.equal((await call({ amountMinor: 100, note: 'x' })).status, 400, 'no idempotency key');
  assert.equal((await call({ amountMinor: 100, idempotencyKey: 'abcdefgh' })).status, 400, 'no reason');
  for (const amountMinor of [0, -5, 1.5, 'abc', 99999999999]) assert.equal((await call({ amountMinor, note: 'x', idempotencyKey: 'abcdefgh' })).status, 400, String(amountMinor));
  assert.equal((await s.call(`/api/v2/edu/wallets/${s.student.userId}/credit`, { method: 'POST', cookie: s.student.cookie, body: { amountMinor: 100, note: 'x', idempotencyKey: 'abcdefgh' } })).status, 403, 'students cannot credit themselves');
  const operator = await s.member(s.admin.orgId, 'print_operator');
  assert.equal((await s.call('/api/v2/edu/wallets', { cookie: operator.cookie })).status, 403);
  const other = await s.org('othercollege');
  assert.equal((await s.call(`/api/v2/edu/wallets/${s.student.userId}/credit`, { method: 'POST', cookie: other.cookie, body: { amountMinor: 100, note: 'x', idempotencyKey: 'abcdefgh' } })).status, 404);
  assert.equal((await s.call(`/api/v2/edu/wallets/${s.student.userId}/ledger`, { cookie: other.cookie })).status, 404);
  assert.equal((await s.call(`/api/v2/edu/wallets/${s.admin.userId}/credit`, { method: 'POST', cookie: s.admin.cookie, body: { amountMinor: 100, note: 'x', idempotencyKey: 'abcdefgh' } })).status, 404, 'only students have wallets');
  assert.equal((await s.call(`/api/v2/edu/wallets/${s.student.userId}/debit`, { method: 'POST', cookie: s.admin.cookie, body: { amountMinor: 999999999, note: 'x', idempotencyKey: 'debit-too-much' } })).status, 400);
  assert.equal((await s.call(`/api/v2/edu/wallets/${s.student.userId}/debit`, { method: 'POST', cookie: s.admin.cookie, body: { amountMinor: 5000000, note: 'fine', idempotencyKey: 'debit-over-balance' } })).status, 402, 'a debit cannot take a balance below zero');
  assert.deepEqual((await s.verify()).problems, []);
});

test('a wallet job: priced, held when submitted, charged when printed, ledger stays balanced', async t => {
  const s = await setup(t, 'flow');
  await s.credit(1000);
  const quote = (await s.call('/api/v2/edu/jobs/quote', { method: 'POST', cookie: s.student.cookie, body: { documentId: await s.upload(s.student, 2), options: {} } })).body;
  assert.deepEqual([quote.costMinor, quote.charged, quote.balanceMinor, quote.shortfallMinor], [600, true, 1000, 0]);
  const job = await s.submit(s.student, 2);
  assert.equal(job.status, 201);
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held], [400, 600], 'held, not yet charged');
  const claim = (await s.printer.claim('Mono'))[0];
  await s.printer.report(claim, { event: 'submitted' });
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held], [400, 600], 'still held while printing');
  await s.printer.report(claim, { event: 'completed', pages: 2 });
  const after = await s.wallet(s.student);
  assert.deepEqual([after.available, after.held, await s.revenue()], [400, 0, 600], 'charged once, revenue recorded');
  assert.deepEqual(after.ledger.map(e => e.kind).sort(), ['capture', 'credit', 'hold']);
  await s.printer.report(claim, { event: 'completed', pages: 2 }); // a repeated report cannot charge twice
  assert.equal(await s.revenue(), 600);
  assert.deepEqual((await s.verify()).problems, []);
});

test('not enough balance: no job, no hold, a clear message and the shortfall in the quote', async t => {
  const s = await setup(t, 'poor');
  await s.credit(100);
  const quote = (await s.call('/api/v2/edu/jobs/quote', { method: 'POST', cookie: s.student.cookie, body: { documentId: await s.upload(s.student), options: {} } })).body;
  assert.deepEqual([quote.costMinor, quote.shortfallMinor], [300, 200]);
  const refused = await s.submit(s.student);
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, 'wallet.insufficient_funds');
  assert.match(refused.body.error, /costs ₹3\.00 and you have ₹1\.00/);
  assert.equal(await s.number('SELECT COUNT(*) AS n FROM print_jobs'), 0);
  assert.equal(await s.number('SELECT COUNT(*) AS n FROM wallet_holds'), 0);
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held], [100, 0]);
});

test('cancelling releases the hold; a partial print is charged pro rata', async t => {
  const s = await setup(t, 'cancel');
  await s.credit(5000);
  // 1. Cancel while waiting: everything comes back.
  const waiting = await s.submit(s.student, 2);
  assert.equal((await s.wallet(s.student)).available, 4400);
  assert.equal((await s.call(`/api/v2/edu/my-jobs/${waiting.body.jobId}/cancel`, { method: 'POST', cookie: s.student.cookie })).status, 200);
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held, await s.revenue()], [5000, 0, 0]);
  // 2. A 4-page job (₹12.00) of which 1 page came out, then the operator cancels: 1 page charged, 3 returned.
  const partial = await s.submit(s.student, 4);
  const claim = (await s.printer.claim('Mono'))[0];
  await s.printer.report(claim, { event: 'submitted' });
  await s.printer.report(claim, { event: 'failed', error: 'paper jam', pages: 1 });
  assert.equal((await s.call(`/api/v2/edu/jobs/${partial.body.jobId}/resolve-uncertain`, { method: 'POST', cookie: s.admin.cookie, body: { printed: false, pages: 1 } })).status, 200);
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held], [3800, 1200], 'the hold stays while the job can still be retried');
  assert.equal((await s.call(`/api/v2/edu/jobs/${partial.body.jobId}/cancel`, { method: 'POST', cookie: s.admin.cookie })).status, 200);
  const end = await s.wallet(s.student);
  assert.deepEqual([end.available, end.held, await s.revenue()], [4700, 0, 300]);
  assert.deepEqual((await s.verify()).problems, []);
});

test('a failed print keeps the hold for a retry; the retry is charged once; an uncertain job resolved as printed is charged in full', async t => {
  const s = await setup(t, 'retry');
  await s.credit(3000);
  const job = await s.submit(s.student, 1);
  const first = (await s.printer.claim('Mono'))[0];
  await s.printer.report(first, { event: 'failed', error: 'offline' }); // nothing reached the printer
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held], [2700, 300]);
  assert.equal((await s.call(`/api/v2/edu/jobs/${job.body.jobId}/retry`, { method: 'POST', cookie: s.admin.cookie })).status, 200);
  assert.ok(await s.printer.printNext('Mono'));
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held, await s.revenue()], [2700, 0, 300]);
  const uncertain = await s.submit(s.student, 1);
  const claim = (await s.printer.claim('Mono'))[0];
  await s.printer.report(claim, { event: 'submitted' });
  await s.db.query("UPDATE print_attempts SET lease_expires='2020-01-01T00:00:00.000Z' WHERE id=$1", [claim.attemptId]);
  await (await import('../server/queue.js')).sweepAttempts(s.db);
  assert.equal((await s.call(`/api/v2/edu/jobs/${uncertain.body.jobId}/resolve-uncertain`, { method: 'POST', cookie: s.admin.cookie, body: { printed: true } })).status, 200);
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held, await s.revenue()], [2400, 0, 600]);
  assert.deepEqual((await s.verify()).problems, []);
});

test('twenty simultaneous jobs against a balance for ten: exactly ten are accepted, nothing is overspent', async t => {
  const s = await setup(t, 'race');
  await s.credit(3000); // ten one-page jobs at ₹3.00
  const documents = []; for (let i = 0; i < 20; i++) documents.push(await s.upload(s.student, 1));
  const results = await Promise.all(documents.map(documentId => s.call('/api/v2/edu/jobs', { method: 'POST', cookie: s.student.cookie, body: { documentId, fileName: 'a.pdf', options: {} } })));
  const accepted = results.filter(r => r.status === 201).length, refused = results.filter(r => r.status === 402).length;
  assert.deepEqual([accepted, refused], [10, 10], `statuses: ${results.map(r => r.status).join(',')}`);
  const w = await s.wallet(s.student);
  assert.deepEqual([w.available, w.held], [0, 3000]);
  assert.equal(await s.number('SELECT COUNT(*) AS n FROM print_jobs'), 10);
  assert.equal(await s.number('SELECT COUNT(*) AS n FROM wallet_holds'), 10);
  assert.deepEqual((await s.verify()).problems, []);
});

test('the ledger is append-only and balances cannot go negative, even for someone with database access', async t => {
  const s = await setup(t, 'immutable');
  await s.credit(1000);
  await assert.rejects(() => s.db.query('UPDATE ledger_entries SET available_delta=available_delta+1'), /immutable/);
  await assert.rejects(() => s.db.query('DELETE FROM ledger_entries'), /immutable/);
  const [{ id }] = await s.db.query("SELECT a.id FROM wallet_accounts a WHERE a.kind='student' AND a.org_id=$1", [s.admin.orgId]);
  await assert.rejects(() => s.db.query('UPDATE wallet_balances SET available_minor=-1 WHERE account_id=$1', [id]), /check|constraint/i);
  // A tampered cache is caught by the check.
  await s.db.query('UPDATE wallet_balances SET available_minor=available_minor+50 WHERE account_id=$1', [id]);
  const report = await s.verify();
  assert.equal(report.ok, false);
  assert.match(report.problems.join(' '), /cached balance differs/);
});

test('free pilot mode does not touch the wallet, and a student sees only their own wallet', async t => {
  const s = await setup(t, 'free', { policy: { studentPrinting: 'free', studentRateBwMinor: 300 } });
  const quote = (await s.call('/api/v2/edu/jobs/quote', { method: 'POST', cookie: s.student.cookie, body: { documentId: await s.upload(s.student), options: {} } })).body;
  assert.deepEqual([quote.charged, quote.costMinor], [false, 300]);
  assert.equal((await s.submit(s.student)).status, 201);
  assert.equal(await s.number('SELECT COUNT(*) AS n FROM wallet_holds'), 0);
  const other = await s.member(s.admin.orgId, 'student');
  await s.credit(700, other);
  assert.equal((await s.wallet(s.student)).available, 0);
  assert.equal((await s.wallet(other)).available, 700);
  assert.equal((await s.call(`/api/v2/edu/wallets/${other.userId}/ledger`, { cookie: s.student.cookie })).status, 403);
});
