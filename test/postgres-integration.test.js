import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import pg from 'pg';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { saveIdempotentResult, getIdempotentResult } from '../server/idempotency.js';

// Runs only against a dedicated, disposable PostgreSQL database, e.g.
//   SMARTPRINT_TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/smartprint_test npm test
// The database name must contain "test", and it must not be the app or migration database.
// The test drops and recreates the "smartprint" schema in that database.
const url = process.env.SMARTPRINT_TEST_DATABASE_URL;
function refusal() {
  if (!url) return 'SMARTPRINT_TEST_DATABASE_URL is not set (no disposable PostgreSQL database available).';
  if ([process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL].includes(url)) return 'Refusing: the test URL is the application or migration database.';
  let name;
  try { name = decodeURIComponent(new URL(url).pathname.slice(1)); } catch { return 'Refusing: SMARTPRINT_TEST_DATABASE_URL is not a valid URL.'; }
  if (!/test/i.test(name)) return 'Refusing: the database name must contain "test".';
  return null;
}
const skip = refusal();

test('PostgreSQL: schema, concurrency, cancellation, routing and idempotency', { skip: skip || false }, async t => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS smartprint CASCADE');
  await admin.end();

  const db = await openDatabase({ url });
  assert.equal(db.kind, 'Neon/PostgreSQL', 'must not silently fall back to SQLite');
  const service = await createApp({ database: db });
  await db.migrate(); // a second run must be a no-op
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token, lease } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(lease ? { 'X-Lease-Token': lease } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = (await request('/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } })).cookie;
  assert.ok(owner);
  const pdf = async () => { const doc = await PDFDocument.create(); doc.addPage(); return Buffer.from(await doc.save()).toString('base64'); };
  const quote = async options => (await request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: await pdf(), name: 'a.pdf' }], options } })).body;
  const paid = async (options = {}) => {
    const q = await quote(options);
    const created = await request('/api/orders', { method: 'POST', token: q.token, body: { quoteId: q.id, method: 'cash' } });
    assert.equal((await request(`/api/owner/orders/${created.body.id}/cash`, { method: 'POST', cookie: owner })).status, 200);
    return created.body.id;
  };
  const status = async id => (await db.query('SELECT status FROM orders WHERE id=$1', [id]))[0].status;

  // Concurrent submits of one quote create exactly one order.
  const q = await quote({});
  const submits = await Promise.all(Array.from({ length: 5 }, () => request('/api/orders', { method: 'POST', token: q.token, body: { quoteId: q.id, method: 'cash' } })));
  assert.equal(submits.filter(r => r.status === 201).length, 1);

  // Idempotency results saved outside a transaction persist on PostgreSQL.
  await saveIdempotentResult(db, 'pg-key', 'actor', 'op', 'resource', 200, { ok: true });
  assert.deepEqual((await getIdempotentResult(db, 'pg-key', 'actor', 'op')).body, { ok: true });

  // Concurrent claims by four colour printers on two colour jobs: no job is handed out twice.
  const printers = [];
  for (const name of ['PG1', 'PG2', 'PG3', 'PG4']) printers.push((await request('/api/owner/devices', { method: 'POST', cookie: owner, body: { name, color: true } })).body);
  const mono = (await request('/api/owner/devices', { method: 'POST', cookie: owner, body: { name: 'PG mono' } })).body;
  const colourJobs = [await paid({ color: 'color' }), await paid({ color: 'color' })];
  assert.equal((await request('/api/device/claim', { method: 'POST', token: mono.token })).body, null, 'mono printer never takes a colour job');
  const claims = await Promise.all(printers.map(p => request('/api/device/claim', { method: 'POST', token: p.token })));
  assert.deepEqual(claims.map(c => c.body?.id).filter(Boolean).sort(), [...colourJobs].sort());
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM print_leases'))[0].n), 2);

  // Cancel racing the connector's "submitted" event: exactly one wins, under row locks.
  for (let round = 0; round < 5; round++) {
    const id = await paid();
    const device = printers.find((_, i) => !claims[i].body);
    const job = (await request('/api/device/claim', { method: 'POST', token: device.token })).body;
    assert.equal(job.id, id);
    const [submit, cancel] = await Promise.all([
      request(`/api/device/jobs/${id}/events`, { method: 'POST', token: device.token, lease: job.token, body: { event: 'submitted' } }),
      request(`/api/owner/orders/${id}/cancel`, { method: 'POST', cookie: owner, body: { confirmed: true } })
    ]);
    assert.equal([submit.status, cancel.status].filter(s => s === 200).length, 1);
    assert.equal(await status(id), cancel.status === 200 ? 'cancelled' : 'printing');
    await db.query("UPDATE orders SET status='completed' WHERE id=$1 AND status='printing'", [id]);
    await db.query('DELETE FROM print_leases WHERE order_id=$1', [id]);
  }

  // Concurrent cancels of one order: one cancellation recorded.
  const id = await paid();
  const cancels = await Promise.all(Array.from({ length: 5 }, () => request(`/api/owner/orders/${id}/cancel`, { method: 'POST', cookie: owner, body: { confirmed: true } })));
  assert.ok(cancels.every(c => c.status === 200));
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM order_history WHERE order_id=$1 AND to_status='cancelled'", [id]))[0].n), 1);

  // A failed statement rolls the whole transaction back.
  await assert.rejects(db.transaction(async tx => { await tx.query("UPDATE shops SET name='rolled back' WHERE id='shop-demo'"); await tx.query('SELECT * FROM no_such_table'); }));
  assert.equal((await db.query("SELECT name FROM shops WHERE id='shop-demo'"))[0].name, 'Campus Print Studio');
});
