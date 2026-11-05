import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from './helpers/edu.js';
import { AgentCore } from '../agent/core.js';
import { simulatedDriver, trackCompletion } from '../agent/drivers.js';
import { sweepAttempts } from '../server/queue.js';

const flaky = (when, real = fetch) => (url, init) => when(String(url), init) ? Promise.reject(new TypeError('fetch failed')) : real(url, init);
const crash = () => { throw new Error('process killed'); }; // thrown from a hook = the agent died at that point

async function enrolled(t, ctx, admin, { driver = simulatedDriver(), fetchImpl, hooks, dir, instanceId } = {}) {
  dir ??= mkdtempSync(join(tmpdir(), 'agent-'));
  const opened = [];
  t.after(() => { opened.forEach(c => c.close()); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }); // Windows cannot delete an open database
  const make = extra => { const c = new AgentCore({ dir, driver, url: ctx.base, vaultMode: 'file', fetchImpl, hooks, instanceId, ...extra }); opened.push(c); return c; };
  const core = make();
  if (!core.settings.agentId) {
    const created = await ctx.call('/api/v2/edu/agents', { method: 'POST', cookie: admin.cookie, body: { name: 'Test PC' } });
    await core.enroll(created.body.enrolmentCode);
  }
  await core.cycle(); // reports printers
  return { core, driver, dir, restart: extra => { opened.forEach(c => c.close()); return make({ hooks: {}, ...extra }); } };
}
const jobStatus = (ctx, id) => ctx.db.query('SELECT status FROM print_jobs WHERE id=$1', [id]).then(r => r[0].status);

test('end to end: the agent claims, downloads, checks, prints and reports; nothing is left behind', async t => {
  const ctx = await boot(t), admin = await ctx.org('e2e');
  const { core, driver, dir } = await enrolled(t, ctx, admin);
  const jobId = await ctx.job(admin.orgId);
  assert.deepEqual(await core.cycle(), { jobs: 1 });
  assert.equal(driver.printed.length, 1);
  assert.equal(await jobStatus(ctx, jobId), 'completed');
  assert.equal(core.liveJournal().length, 0);
  assert.deepEqual(readdirSync(join(dir, 'cache')), [], 'no document remains on the PC');
  assert.equal(await ctx.number('SELECT COUNT(*) AS n FROM stored_objects WHERE deleted_at IS NULL'), 0);
  assert.deepEqual(await core.cycle(), { jobs: 0 });
});

test('printers report only what the driver verified; a colour job goes to the colour printer', async t => {
  const ctx = await boot(t), admin = await ctx.org('caps');
  const driver = simulatedDriver({ printers: [{ name: 'Mono', color: false, duplex: false }, { name: 'Unknown printer' }, { name: 'Colour', color: true, duplex: true }] });
  const { core } = await enrolled(t, ctx, admin, { driver });
  const caps = Object.fromEntries((await ctx.db.query('SELECT display_name, cap_color, cap_duplex FROM printers')).map(p => [p.display_name, [p.cap_color, p.cap_duplex]]));
  assert.deepEqual(caps, { Mono: [0, 0], 'Unknown printer': [null, null], Colour: [1, 1] });
  const jobId = await ctx.job(admin.orgId, { color: 'color' });
  await core.cycle();
  assert.deepEqual(driver.printed.map(p => p.printerName), ['Colour']);
  assert.equal(await jobStatus(ctx, jobId), 'completed');
});

test('a crash before the server accepted "submitted": after restart the job is printed exactly once', async t => {
  const ctx = await boot(t), admin = await ctx.org('crash1');
  const driver = simulatedDriver();
  const down = flaky(url => url.includes('/events'));
  const first = await enrolled(t, ctx, admin, { driver, fetchImpl: down });
  const jobId = await ctx.job(admin.orgId);
  await first.core.cycle(); // downloaded, journal says about_to_submit, the server could not be told
  assert.equal(driver.printed.length, 0, 'nothing is printed before the server has accepted');
  assert.deepEqual(first.core.liveJournal().map(e => e.state), ['about_to_submit']);
  const second = first.restart({ fetchImpl: fetch });
  await second.cycle();
  assert.equal(driver.printed.length, 1);
  assert.equal(await jobStatus(ctx, jobId), 'completed');
  second.close();
});

test('a crash after the server accepted "submitted": the restarted agent never prints it again; the job becomes uncertain', async t => {
  const ctx = await boot(t), admin = await ctx.org('crash2');
  const driver = simulatedDriver();
  const first = await enrolled(t, ctx, admin, { driver, hooks: { afterSubmitAck: crash } });
  const jobId = await ctx.job(admin.orgId);
  await assert.rejects(() => first.core.cycle(), /process killed/);
  assert.deepEqual(first.core.liveJournal().map(e => e.state), ['submitted']);
  const second = first.restart();
  await second.cycle();
  assert.equal(driver.printed.length, 0, 'no second print, ever');
  assert.equal(await jobStatus(ctx, jobId), 'uncertain', 'a person decides');
  assert.equal(second.liveJournal().length, 0);
  second.close();
});

test('downloaded documents are encrypted on disk, and an interrupted download resumes', async t => {
  const ctx = await boot(t), admin = await ctx.org('cache');
  const driver = simulatedDriver();
  const first = await enrolled(t, ctx, admin, { driver, hooks: { afterDownload: crash } });
  const jobId = await ctx.job(admin.orgId);
  await assert.rejects(() => first.core.cycle(), /process killed/);
  const cached = readdirSync(join(first.dir, 'cache'));
  assert.equal(cached.length, 1);
  assert.notEqual(readFileSync(join(first.dir, 'cache', cached[0])).subarray(0, 5).toString(), '%PDF-', 'the cached file is not readable as a document');
  assert.deepEqual(first.core.liveJournal().map(e => e.state), ['downloaded']);
  const second = first.restart();
  await second.cycle();
  assert.equal(driver.printed.length, 1);
  assert.equal(await jobStatus(ctx, jobId), 'completed');
  assert.deepEqual(readdirSync(join(first.dir, 'cache')), []);
  second.close();
});

test('a job taken away from a slow agent is not printed by it: two agents, one print', async t => {
  const ctx = await boot(t), admin = await ctx.org('fence');
  const slowDriver = simulatedDriver({ printers: [{ name: 'Mono', color: false, duplex: false }] }), fastDriver = simulatedDriver({ printers: [{ name: 'Mono 2', color: false, duplex: false }] });
  const slow = await enrolled(t, ctx, admin, { driver: slowDriver, fetchImpl: flaky(url => url.includes('/events')) });
  const fast = await enrolled(t, ctx, admin, { driver: fastDriver });
  const jobId = await ctx.job(admin.orgId);
  await slow.core.cycle(); // claims, downloads, cannot reach the server to submit
  assert.equal(await jobStatus(ctx, jobId), 'claimed');
  await ctx.db.query("UPDATE print_attempts SET lease_expires='2020-01-01T00:00:00.000Z'");
  await sweepAttempts(ctx.db); // the lease ran out: the job goes back to the queue
  await fast.core.cycle();
  assert.equal(await jobStatus(ctx, jobId), 'completed');
  const back = slow.restart({ fetchImpl: fetch });
  await back.cycle(); // the slow agent wakes up and asks again
  assert.equal(slowDriver.printed.length, 0, 'the old attempt is fenced');
  assert.equal(fastDriver.printed.length, 1);
  assert.equal(back.liveJournal().length, 0);
  assert.equal(await ctx.number('SELECT COUNT(*) AS n FROM print_attempts WHERE state=$1', ['completed']), 1);
  back.close();
});

test('results are kept when the internet is down and delivered, in order, afterwards', async t => {
  const ctx = await boot(t), admin = await ctx.org('offline');
  const driver = simulatedDriver();
  const { core } = await enrolled(t, ctx, admin, { driver });
  // A fetch that fails only when the agent reports the outcome of the print.
  const reportDown = flaky((url, init) => url.includes('/events') && String(init?.body).includes('completed'));
  core.fetch = reportDown;
  const jobId = await ctx.job(admin.orgId);
  await core.cycle();
  assert.equal(driver.printed.length, 1);
  assert.equal(await jobStatus(ctx, jobId), 'submitted', 'the server has not heard the result yet');
  assert.equal(core.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1, 'the result waits in the outbox');
  core.fetch = fetch;
  await core.cycle();
  assert.equal(await jobStatus(ctx, jobId), 'completed');
  assert.equal(core.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});

test('a revoked agent stops at once and keeps its journal; a second installation is refused', async t => {
  const ctx = await boot(t), admin = await ctx.org('revoke');
  const { core } = await enrolled(t, ctx, admin);
  const agentId = core.settings.agentId;
  // Same credential, second machine (different instance id): refused.
  const cloneDir = mkdtempSync(join(tmpdir(), 'agent-'));
  const clone = new AgentCore({ dir: cloneDir, driver: simulatedDriver(), url: ctx.base, vaultMode: 'file' });
  t.after(() => { clone.close(); rmSync(cloneDir, { recursive: true, force: true, maxRetries: 5 }); });
  clone.settings.agentId = agentId; clone.credential = core.credential;
  assert.deepEqual(await clone.cycle(), { halted: 'conflict' });
  await ctx.call(`/api/v2/edu/agents/${agentId}/revoke`, { method: 'POST', cookie: admin.cookie });
  assert.deepEqual(await core.cycle(), { halted: 'unauthorized' });
  assert.deepEqual(await core.cycle(), { halted: 'unauthorized' });
});

test('a document that does not match its checksum is refused and the job stays retryable', async t => {
  const ctx = await boot(t), admin = await ctx.org('checksum');
  const driver = simulatedDriver();
  const tamper = async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).includes('/document')) return response;
    const headers = new Headers(response.headers); headers.set('x-content-sha256', '0'.repeat(64));
    return new Response(await response.arrayBuffer(), { status: response.status, headers });
  };
  const { core } = await enrolled(t, ctx, admin, { driver, fetchImpl: tamper });
  const jobId = await ctx.job(admin.orgId);
  await core.cycle(); await core.cycle();
  assert.equal(driver.printed.length, 0);
  assert.equal(await jobStatus(ctx, jobId), 'failed', 'failed cleanly: nothing reached the printer, so a retry is safe');
});

test('the credential is never stored in plain text and rotates when due', async t => {
  const ctx = await boot(t), admin = await ctx.org('rotate');
  const { core, dir } = await enrolled(t, ctx, admin);
  const old = core.credential;
  assert.ok(!readFileSync(join(dir, 'settings.json'), 'utf8').includes(old), 'settings.json holds only a sealed credential');
  assert.equal(await core.rotateIfDue(Date.now()), false, 'not due yet');
  assert.equal(await core.rotateIfDue(Date.now() + 31 * 86400000), true);
  assert.notEqual(core.credential, old);
  assert.deepEqual(await core.cycle(), { jobs: 0 }, 'the new credential works');
  const fresh = new AgentCore({ dir, driver: simulatedDriver(), url: ctx.base, vaultMode: 'file' });
  assert.equal(fresh.credential, core.credential, 'it survives a restart');
  fresh.close();
});

test('following a job through the Windows queue: completion, partial output and stalls are told apart', async () => {
  const run = (frames, opts = {}) => { let i = 0; return trackCompletion({ list: async () => frames[Math.min(i++, frames.length - 1)], fileName: 'x.pdf', intervalMs: 0, sleepImpl: async () => {}, ...opts }); };
  const job = (pages, status = 'Printing') => [{ DocumentName: 'C:\\agent\\x.pdf', PagesPrinted: pages, JobStatus: status }];
  assert.deepEqual(await run([job(0), job(2), job(5), []]), { outcome: 'completed', pages: 5 }, 'it left the queue after 5 pages');
  assert.deepEqual(await run([[]]), { outcome: 'completed', pages: undefined });
  const stalled = await run([job(3), job(3, 'Error, Printing')], { errorLimitMs: -1 });
  assert.deepEqual([stalled.outcome, stalled.pages, stalled.nothingPrinted], ['failed', 3, false], 'partial output is reported, never guessed');
  const timeout = await run([job(1)], { timeoutMs: 5 });
  assert.deepEqual([timeout.outcome, timeout.pages], ['failed', 1]);
});
