import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, pdf } from './helpers/edu.js';
import { AgentCore } from '../agent/core.js';
import { startPortal } from '../agent/portal.js';
import { simulatedDriver } from '../agent/drivers.js';

async function setup(t, name, { driver, policy = {} } = {}) {
  const ctx = await boot(t);
  const admin = await ctx.org(name), student = await ctx.member(admin.orgId, 'student'), staff = await ctx.member(admin.orgId, 'staff');
  const info = (await ctx.call('/api/v2/edu/institution', { cookie: admin.cookie })).body;
  await ctx.call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: admin.cookie, body: { version: info.version, policies: { offlineStudentPrinting: true, offlineStaffPrinting: true, studentRateBwMinor: 300, studentRateColourMinor: 900, maxPagesPerJob: 10, offlineStaffDailyPages: 8, ...policy } } });
  const dir = mkdtempSync(join(tmpdir(), 'agent-'));
  driver ??= simulatedDriver({ printers: [{ name: 'Mono', color: false, duplex: false, status: 'Ready' }, { name: 'Colour', color: true, duplex: true, status: 'Ready' }] });
  const core = new AgentCore({ dir, driver, url: ctx.base, vaultMode: 'file' });
  const server = await startPortal(core, { port: 0, host: '127.0.0.1', perMinute: 1000 });
  t.after(async () => { await new Promise(r => server.close(r)); core.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const created = await ctx.call('/api/v2/edu/agents', { method: 'POST', cookie: admin.cookie, body: { name: 'Library PC' } });
  await core.enroll(created.body.enrolmentCode);
  await core.cycle();
  const portal = `http://127.0.0.1:${server.address().port}`;
  const idOf = async who => (await ctx.db.query('SELECT college_id FROM edu_profiles WHERE user_id=$1', [who.userId]))[0].college_id;
  const goOffline = () => { core.lastContact = 0; };
  const print = async ({ id, pin, pages = 1, options = {}, body, type = 'application/pdf' }) => {
    const response = await fetch(`${portal}/print`, { method: 'POST', headers: { 'Content-Type': type, 'X-College-Id': encodeURIComponent(id), 'X-Pin': encodeURIComponent(pin), 'X-Options': JSON.stringify(options) }, body: body ?? await pdf(pages) });
    return { status: response.status, body: await response.json() };
  };
  const reserve = async (amountMinor, pin = '4321') => {
    await ctx.call(`/api/v2/edu/wallets/${student.userId}/credit`, { method: 'POST', cookie: admin.cookie, body: { amountMinor: 10000, note: 'cash', idempotencyKey: `k-${Math.random()}` } });
    const r = await ctx.call('/api/v2/edu/wallet/reservations', { method: 'POST', cookie: student.cookie, body: { agentId: core.settings.agentId, amountMinor, pin } });
    await core.fetchGrants();
    return r;
  };
  return { ...ctx, admin, student, staff, core, driver, portal, idOf, goOffline, print, reserve, dir };
}

test('the portal serves a page and refuses work while the internet works', async t => {
  const s = await setup(t, 'online');
  await s.reserve(2000);
  const page = await fetch(s.portal);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /internet is working/);
  assert.ok(page.headers.get('content-security-policy').includes("default-src 'none'"));
  const blocked = await s.print({ id: await s.idOf(s.student), pin: '4321' });
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'portal.online'], 'the normal queue and wallet are never bypassed');
  assert.equal(s.driver.printed.length, 0);
  s.goOffline();
  assert.match(await (await fetch(s.portal)).text(), /The internet is down/);
});

test('a student prints during an outage; the cost comes from the reservation and is applied once on reconnection', async t => {
  const s = await setup(t, 'student');
  await s.reserve(2000);
  s.goOffline();
  const id = await s.idOf(s.student);
  const ok = await s.print({ id, pin: '4321', pages: 2, options: { copies: 2 } });
  assert.deepEqual([ok.status, ok.body.pages, ok.body.chargedMinor, ok.body.remainingMinor], [200, 4, 1200, 800]);
  assert.equal(s.driver.printed.length, 1);
  assert.equal((await s.print({ id, pin: '4321', pages: 2 })).body.chargedMinor, 600);
  const refused = await s.print({ id, pin: '4321', pages: 3 }); // 900 asked, 200 left
  assert.deepEqual([refused.status, refused.body.code], [402, 'offline.insufficient'], 'never more than was reserved');
  assert.equal(s.driver.printed.length, 2, 'a refused job prints nothing');
  const result = await s.core.syncOffline();
  assert.deepEqual([result.accepted, result.problems], [2, []]);
  assert.equal(await s.number("SELECT spent_minor AS n FROM offline_reservations"), 1800);
  assert.deepEqual((await s.call('/api/v2/edu/wallets/verify', { cookie: s.admin.cookie })).body.problems, []);
  assert.deepEqual(readdirSync(join(s.dir, 'cache')).filter(f => f.startsWith('portal-')), [], 'no document is kept');
});

test('wrong PINs, unknown IDs and bad files are refused and charge nothing; five wrong PINs lock the ID', async t => {
  const s = await setup(t, 'refuse');
  await s.reserve(2000);
  s.goOffline();
  const id = await s.idOf(s.student);
  assert.equal((await s.print({ id, pin: '0000' })).body.code, 'offline.wrong_pin');
  assert.equal((await s.print({ id: 'NOBODY', pin: '4321' })).body.code, 'offline.no_reservation');
  assert.equal((await s.print({ id, pin: '4321', body: Buffer.from('not a document') })).body.code, 'portal.file');
  assert.equal((await s.print({ id, pin: '4321', pages: 11 })).body.code, 'portal.pages', 'the institution page limit applies');
  assert.equal((await s.print({ id, pin: '4321', options: { copies: 99 } })).body.code, 'portal.copies');
  assert.equal((await s.print({ id, pin: '4321', options: { copies: 0 } })).body.code, 'portal.options');
  for (let i = 0; i < 4; i++) await s.print({ id, pin: '9999' }); // with the earlier wrong PIN that makes five
  assert.equal((await s.print({ id, pin: '4321' })).body.code, 'offline.locked');
  assert.equal(s.driver.printed.length, 0);
  assert.equal(s.core.db.prepare('SELECT COUNT(*) AS n FROM spend_log').get().n, 0, 'nothing was charged');
  await s.core.fetchGrants(); // reaching the server clears the lock...
  s.goOffline(); // ...and the outage resumes
  assert.equal((await s.print({ id, pin: '4321' })).status, 200, 'the lock was cleared by being online');
});

test('colour goes only to a printer that can do colour; a failed print is not charged; a partial print is charged pro rata', async t => {
  let behaviour = 'ok';
  const driver = simulatedDriver({ printers: [{ name: 'Mono', color: false, duplex: false, status: 'Ready' }, { name: 'Colour', color: true, duplex: true, status: 'Ready' }, { name: 'Dead', color: true, duplex: true, status: 'Offline' }],
    onPrint: (job) => behaviour === 'ok' ? { outcome: 'completed', pages: job.jobPages } : behaviour === 'nothing' ? { outcome: 'failed', error: 'printer off', nothingPrinted: true } : { outcome: 'failed', error: 'jam', pages: 1, nothingPrinted: false } });
  const s = await setup(t, 'caps', { driver });
  await s.reserve(5000);
  s.goOffline();
  const id = await s.idOf(s.student);
  assert.equal((await s.print({ id, pin: '4321', options: { color: 'color' } })).status, 200);
  assert.deepEqual(driver.printed.map(p => p.printerName), ['Colour'], 'colour job on the colour printer; the Offline one is never chosen');
  await s.print({ id, pin: '4321', options: { color: 'bw' } });
  assert.equal(driver.printed.at(-1).printerName, 'Mono');
  behaviour = 'nothing';
  const failed = await s.print({ id, pin: '4321', pages: 2 });
  assert.deepEqual([failed.status, failed.body.code], [502, 'portal.print_failed']);
  assert.match(failed.body.error, /not charged/);
  behaviour = 'partial';
  const partial = await s.print({ id, pin: '4321', pages: 3 }); // 3 pages = 900, 1 page came out
  assert.equal(partial.body.code, 'portal.partial');
  const spends = s.core.db.prepare('SELECT amount_minor FROM spend_log ORDER BY seq').all().map(r => r.amount_minor);
  assert.deepEqual(spends, [900, 300, 300], 'colour 900, bw 300, partial 1 of 3 pages = 300; the failed job charged nothing');
});

test('staff print without charge up to a daily limit and are recorded once for the usage report', async t => {
  const s = await setup(t, 'staffportal');
  const id = await s.idOf(s.staff);
  assert.equal((await s.call('/api/v2/edu/me/offline-pin', { method: 'PUT', cookie: s.staff.cookie, body: { pin: '12' } })).status, 400);
  assert.equal((await s.call('/api/v2/edu/me/offline-pin', { method: 'PUT', cookie: s.student.cookie, body: { pin: '1234' } })).status, 403, 'students have no staff PIN');
  assert.equal((await s.call('/api/v2/edu/me/offline-pin', { method: 'PUT', cookie: s.staff.cookie, body: { pin: '5555' } })).status, 200);
  await s.core.fetchGrants();
  s.goOffline();
  assert.equal((await s.print({ id, pin: '0000' })).body.code, 'offline.wrong_pin');
  const first = await s.print({ id, pin: '5555', pages: 3, options: { copies: 2 } });
  assert.deepEqual([first.status, first.body.pages, first.body.chargedMinor], [200, 6, 0]);
  const over = await s.print({ id, pin: '5555', pages: 3 }); // 6 + 3 > the daily limit of 8
  assert.deepEqual([over.status, over.body.code], [429, 'portal.daily_limit']);
  assert.equal((await s.print({ id, pin: '5555', pages: 2 })).status, 200);
  const sync = await s.core.syncOffline();
  assert.deepEqual([sync.accepted, sync.problems], [2, []]);
  const report = (await s.call('/api/v2/edu/reports/usage', { cookie: s.admin.cookie })).body;
  assert.deepEqual([report.total.jobs, report.total.pagesPrinted], [2, 8]);
  assert.equal((await s.core.syncOffline()), null, 'nothing is sent twice');
});

test('the page never echoes what was typed, and oversized uploads are refused', async t => {
  const s = await setup(t, 'safety');
  s.goOffline();
  const evil = '<script>alert(1)</script>';
  const reply = await s.print({ id: evil, pin: '1234' });
  assert.ok(!JSON.stringify(reply.body).includes('<script>'), 'error messages do not reflect input');
  assert.equal((await fetch(`${s.portal}/nope`)).status, 404);
  const big = await fetch(`${s.portal}/print`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-College-Id': 'x', 'X-Pin': '1' }, body: Buffer.alloc(21 * 1024 * 1024, 1) }).catch(() => ({ status: 413 }));
  assert.ok([413, undefined].includes(big.status) || big.status === 413);
});
