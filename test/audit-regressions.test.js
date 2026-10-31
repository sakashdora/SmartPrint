import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { saveIdempotentResult, getIdempotentResult } from '../server/idempotency.js';
import { cleanPrinterList, sweepLeases } from '../server/devices.js';

async function start(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token, lease } = {}) => {
    const started = performance.now();
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(lease ? { 'X-Lease-Token': lease } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
      ms: performance.now() - started
    };
  };
  const login = await request('/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } });
  return { db, request, owner: login.cookie };
}

async function pdfData() {
  const doc = await PDFDocument.create();
  doc.addPage();
  return Buffer.from(await doc.save()).toString('base64');
}

async function paidCashOrder(request, owner, options = {}) {
  const quote = await request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: await pdfData(), name: 'a.pdf' }], options } });
  assert.equal(quote.status, 201);
  const order = await request('/api/orders', { method: 'POST', token: quote.body.token, body: { quoteId: quote.body.id, method: 'cash' } });
  assert.equal(order.status, 201);
  assert.equal((await request(`/api/owner/orders/${order.body.id}/cash`, { method: 'POST', cookie: owner })).status, 200);
  return order.body;
}

test('idempotency results saved outside a transaction do not break concurrent transactions', async () => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();
  const save = saveIdempotentResult(db, 'key-1', 'actor', 'op', 'resource', 200, { ok: true });
  const transaction = db.transaction(async tx => tx.query('SELECT 1 AS one'));
  await assert.doesNotReject(Promise.all([save, transaction]));
  assert.deepEqual((await getIdempotentResult(db, 'key-1', 'actor', 'op')).body, { ok: true });
  await db.close();

  // PostgreSQL rejects SAVEPOINT outside a transaction block, and each pool query may use another client.
  const statements = [];
  const topLevel = { query: async sql => { statements.push(sql); return []; }, transaction: async () => {} };
  await saveIdempotentResult(topLevel, 'key-2', 'actor', 'op', 'resource', 200, { ok: true });
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^INSERT INTO idempotency_keys/);
});

test('retry only re-queues failed prints, never printing or already-printed jobs', async t => {
  const { db, request, owner } = await start(t);
  const device = await request('/api/owner/devices', { method: 'POST', cookie: owner, body: { name: 'Regression Printer', color: true, duplex: true } });
  await paidCashOrder(request, owner);
  const claim = await request('/api/device/claim', { method: 'POST', token: device.body.token });
  assert.ok(claim.body?.id);
  for (const event of ['submitted', 'awaiting_confirmation']) {
    assert.equal((await request(`/api/device/jobs/${claim.body.id}/events`, { method: 'POST', token: device.body.token, lease: claim.body.token, body: { event } })).status, 200);
  }
  const printedRetry = await request(`/api/owner/orders/${claim.body.id}/retry`, { method: 'POST', cookie: owner });
  assert.equal(printedRetry.status, 409);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [claim.body.id]))[0].status, 'awaiting_confirmation');

  // A lease that timed out leaves the physical outcome unknown, so it needs owner review, not a retry.
  await db.query("UPDATE print_leases SET expires='2000-01-01T00:00:00.000Z' WHERE order_id=$1", [claim.body.id]);
  await sweepLeases(db);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [claim.body.id]))[0].status, 'needs_review');
  assert.equal((await request(`/api/owner/orders/${claim.body.id}/retry`, { method: 'POST', cookie: owner })).status, 409);

  assert.equal((await request(`/api/owner/devices/${device.body.id}`, { method: 'DELETE', cookie: owner })).status, 200);
  const manual = await paidCashOrder(request, owner);
  assert.equal((await request(`/api/owner/orders/${manual.id}/start`, { method: 'POST', cookie: owner })).status, 200);
  assert.equal((await request(`/api/owner/orders/${manual.id}/retry`, { method: 'POST', cookie: owner })).status, 409);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [manual.id]))[0].status, 'printing');

  assert.equal((await request(`/api/owner/orders/${manual.id}/resolve-failed`, { method: 'POST', cookie: owner, body: { confirmed: true } })).status, 200);
  assert.equal((await request(`/api/owner/orders/${manual.id}/retry`, { method: 'POST', cookie: owner })).status, 200);
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [manual.id]))[0].status, 'queued');
});

test('reprice keeps quoted options that the request does not change', async t => {
  const { request } = await start(t);
  const quote = await request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: await pdfData(), name: 'a.pdf' }], options: { copies: 3 } } });
  const repriced = await request(`/api/quotes/${quote.body.id}/reprice`, { method: 'POST', token: quote.body.token, body: { duplex: true } });
  assert.equal(repriced.status, 201);
  assert.equal(repriced.body.options.copies, 3);
  assert.equal(repriced.body.options.duplex, true);
  const again = await request(`/api/quotes/${repriced.body.id}/reprice`, { method: 'POST', token: repriced.body.token, body: { copies: 2, duplex: false } });
  assert.equal(again.body.options.copies, 2);
  assert.equal(again.body.options.duplex, false);
});

test('scanned printer reports are bounded and reduced to primitive fields', async t => {
  const cleaned = cleanPrinterList([null, { name: '' }, { name: ' HP ', nested: { x: 1 }, port: 'USB001', color: true, note: 'x'.repeat(500) }]);
  assert.deepEqual(cleaned, [{ name: 'HP', port: 'USB001', color: true, note: 'x'.repeat(200) }]);
  assert.equal(cleanPrinterList(Array.from({ length: 80 }, (_, i) => ({ name: `p${i}` }))).length, 50);
  const [flags] = cleanPrinterList([{ name: 'Lab', isWifi: '" autofocus onfocus="alert(1)', isWired: true, isDefault: 1 }]);
  assert.deepEqual([flags.isWifi, flags.isWired, flags.isDefault], [false, true, false], 'attribute-rendered flags are coerced to booleans');

  const { request, owner } = await start(t);
  for (let batch = 0; batch < 4; batch++) {
    const printers = Array.from({ length: 40 }, (_, i) => ({ name: `batch${batch}-p${i}` }));
    assert.equal((await request('/api/owner/printers/scanned-report', { method: 'POST', cookie: owner, body: { printers } })).status, 200);
  }
  const scan = await request('/api/owner/printers/scan', { cookie: owner });
  const reported = scan.body.filter(p => p.name.startsWith('batch'));
  assert.equal(reported.length, 50);
  assert.ok(reported.some(p => p.name === 'batch3-p0'), 'the newest report is kept');
});

test('a local `npm start` never migrates the operator-only MIGRATION_DATABASE_URL', async () => {
  const { execFile } = await import('node:child_process');
  const { mkdtemp, rm, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cwd = await mkdtemp(join(tmpdir(), 'smartprint-migrate-'));
  const script = fileURLToPath(new URL('../server/migrate.js', import.meta.url));
  const env = { ...process.env, npm_lifecycle_event: 'start', NODE_ENV: 'development', MIGRATION_DATABASE_URL: 'postgresql://owner:placeholder@db.remote.invalid/neondb', DATABASE_URL: '' };
  for (const name of ['RENDER', 'RAILWAY_ENVIRONMENT', 'KOYEB_PUBLIC_DOMAIN', 'VERCEL']) delete env[name];
  try {
    const stdout = await new Promise((resolve, reject) => execFile(process.execPath, [script], { cwd, env, timeout: 20000 }, (error, out) => error ? reject(error) : resolve(out)));
    assert.match(stdout, /Skipping MIGRATION_DATABASE_URL/);
    assert.deepEqual(await readdir(cwd), [], 'no database was opened, not even the local SQLite fallback');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('login spends comparable time on unknown and known emails', async t => {
  const { request } = await start(t);
  const median = async email => {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const result = await request('/api/auth/login', { method: 'POST', body: { email, password: 'Definitely-Wrong-Password!' } });
      assert.equal(result.status, 401);
      times.push(result.ms);
    }
    return times.sort((a, b) => a - b)[1];
  };
  await median('warm-up@nowhere.test');
  const known = await median('admin@smartprint.local');
  const unknown = await median('nobody@nowhere.test');
  assert.ok(unknown > known * 0.3, `unknown-email login took ${unknown.toFixed(1)}ms vs ${known.toFixed(1)}ms for a known email`);
});
