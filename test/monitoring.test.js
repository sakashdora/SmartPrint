import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers/edu.js';
import { runMonitoring } from '../server/monitoring.js';

const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const mails = (ctx, to) => ctx.db.query("SELECT subject, body FROM email_outbox WHERE kind='alert' AND to_email=$1", [to]);
const open = async (ctx, admin) => (await ctx.call('/api/v2/edu/alerts', { cookie: admin.cookie })).body.filter(a => !a.resolved);
const dueAgain = ctx => ctx.db.query("DELETE FROM worker_status WHERE id='ledger-verify'");

test('a healthy institution raises nothing', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('calm');
  await ctx.agent(admin);
  await runMonitoring(ctx.db);
  assert.deepEqual(await open(ctx, admin), []);
  assert.equal((await mails(ctx, admin.email)).length, 0);
});

test('a silent agent opens one alert, mails the administrator once, and clears itself on return', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('silent'), other = await ctx.org('elsewhere');
  const agent = await ctx.agent(admin, undefined, 'Library PC');
  await ctx.db.query('UPDATE agents SET last_seen=$1 WHERE id=$2', [ago(120), agent.id]);
  await runMonitoring(ctx.db);
  const alerts = await open(ctx, admin);
  assert.deepEqual(alerts.map(a => a.kind), ['agent_silent']);
  assert.match(alerts[0].message, /Library PC/);
  assert.equal((await mails(ctx, admin.email)).length, 1);
  await runMonitoring(ctx.db); await runMonitoring(ctx.db);
  assert.equal((await mails(ctx, admin.email)).length, 1, 'no repeat mail while it stays true');
  assert.equal((await open(ctx, admin)).length, 1, 'still one alert row');
  assert.deepEqual(await open(ctx, other), [], "another institution sees nothing of it");
  // The PC comes back.
  await ctx.db.query('UPDATE agents SET last_seen=$1 WHERE id=$2', [new Date().toISOString(), agent.id]);
  await runMonitoring(ctx.db);
  assert.deepEqual(await open(ctx, admin), []);
  assert.equal((await ctx.call('/api/v2/edu/alerts', { cookie: admin.cookie })).body[0].resolved, true, 'kept as history');
  // It goes quiet again: a new mail.
  await ctx.db.query('UPDATE agents SET last_seen=$1 WHERE id=$2', [ago(90), agent.id]);
  await runMonitoring(ctx.db);
  assert.equal((await open(ctx, admin)).length, 1);
  assert.equal((await mails(ctx, admin.email)).length, 2);
});

test('work waiting while every printer in its group is unavailable raises an alert', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('waiting');
  const agent = await ctx.agent(admin);
  const jobId = await ctx.job(admin.orgId);
  await ctx.db.query('UPDATE print_jobs SET enqueued_at=$1 WHERE id=$2', [ago(20), jobId]);
  await runMonitoring(ctx.db);
  assert.deepEqual(await open(ctx, admin), [], 'a printer is online, so waiting is just the queue');
  await ctx.db.query("UPDATE printers SET device_status='Offline' WHERE agent_id=$1", [agent.id]);
  await runMonitoring(ctx.db);
  assert.deepEqual((await open(ctx, admin)).map(a => a.kind), ['printer_offline_with_work']);
  // A job that has only just been queued does not alarm anybody.
  await ctx.db.query("UPDATE printers SET device_status='Idle' WHERE agent_id=$1", [agent.id]);
  await ctx.db.query('UPDATE printers SET paused=1 WHERE agent_id=$1', [agent.id]);
  await runMonitoring(ctx.db);
  assert.equal((await open(ctx, admin)).length, 1, 'paused counts as unavailable too');
  await ctx.db.query('UPDATE printers SET paused=0 WHERE agent_id=$1', [agent.id]);
  await runMonitoring(ctx.db);
  assert.deepEqual(await open(ctx, admin), []);
});

test('a job left "uncertain" for half an hour is flagged', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('uncertain');
  const agent = await ctx.agent(admin);
  await ctx.job(admin.orgId);
  const [claimed] = await agent.claim();
  await agent.report(claimed, { event: 'submitted' });
  await ctx.db.query("UPDATE print_attempts SET state='uncertain', created=$1 WHERE id=$2", [ago(5), claimed.attemptId]);
  await ctx.db.query("UPDATE print_jobs SET status='uncertain' WHERE id=$1", [claimed.jobId]);
  await runMonitoring(ctx.db);
  assert.deepEqual(await open(ctx, admin), [], 'five minutes is still within the operators\' reaction time');
  await ctx.db.query('UPDATE print_attempts SET created=$1 WHERE id=$2', [ago(45), claimed.attemptId]);
  await runMonitoring(ctx.db);
  assert.deepEqual((await open(ctx, admin)).map(a => a.kind), ['stuck_uncertain']);
});

test('the nightly ledger check raises an alert on a mismatch and clears it when the books agree again', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('books');
  const student = await ctx.member(admin.orgId, 'student');
  assert.equal((await ctx.call(`/api/v2/edu/wallets/${student.userId}/credit`, { method: 'POST', cookie: admin.cookie, body: { amountMinor: 5000, note: 'seed', idempotencyKey: 'seed-credit-0001' } })).status, 201);
  await dueAgain(ctx);
  await runMonitoring(ctx.db);
  assert.deepEqual(await open(ctx, admin), [], 'consistent books');
  const [account] = await ctx.db.query("SELECT account_id FROM wallet_balances b JOIN wallet_accounts a ON a.id=b.account_id WHERE a.kind='student' AND a.org_id=$1", [admin.orgId]);
  await ctx.db.query('UPDATE wallet_balances SET available_minor=available_minor+7 WHERE account_id=$1', [account.account_id]);
  // Not due yet: the check does not run again within the interval, so nothing changes.
  await runMonitoring(ctx.db);
  assert.deepEqual(await open(ctx, admin), []);
  await dueAgain(ctx);
  await runMonitoring(ctx.db);
  assert.deepEqual((await open(ctx, admin)).map(a => a.kind), ['ledger_mismatch']);
  await runMonitoring(ctx.db);
  assert.equal((await open(ctx, admin)).length, 1, 'the problem stays open between nightly runs');
  await ctx.db.query('UPDATE wallet_balances SET available_minor=available_minor-7 WHERE account_id=$1', [account.account_id]);
  await dueAgain(ctx);
  await runMonitoring(ctx.db);
  assert.deepEqual(await open(ctx, admin), []);
});

test('alerts are for administrators; metrics need a token and contain no personal data', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('visible');
  const student = await ctx.member(admin.orgId, 'student');
  assert.equal((await ctx.call('/api/v2/edu/alerts', { cookie: student.cookie })).status, 403);
  assert.equal((await ctx.call('/api/v2/edu/alerts')).status, 401);
  delete process.env.METRICS_TOKEN;
  assert.equal((await ctx.call('/metrics')).status, 404, 'disabled unless a token is configured');
  process.env.METRICS_TOKEN = 'a-metrics-token-for-tests';
  t.after(() => { delete process.env.METRICS_TOKEN; });
  assert.equal((await ctx.call('/metrics', { bearer: 'wrong-token-value-for-tests!' })).status, 404);
  const response = await fetch(`${ctx.base}/metrics`, { headers: { Authorization: 'Bearer a-metrics-token-for-tests' } });
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const name of ['smartprint_jobs', 'smartprint_agents', 'smartprint_open_alerts', 'smartprint_ledger_last_check_timestamp_seconds', 'smartprint_maintenance_last_success_timestamp_seconds']) assert.ok(text.includes(`# TYPE ${name} `), name);
  assert.ok(!text.includes(admin.email) && !text.includes('visible'), 'no emails or institution names');
});
