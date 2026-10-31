import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { printerSupports, cancelRefusal, sweepLeases } from '../server/devices.js';

async function start(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token, lease } = {}) => {
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
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  const login = async (email, password) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie').split(';')[0];
  const owner = await login('owner@smartprint.local', 'SmartPrintDemo!2026');
  const pdf = async () => { const doc = await PDFDocument.create(); doc.addPage(); return Buffer.from(await doc.save()).toString('base64'); };
  const order = async (options = {}, { pay = true } = {}) => {
    const quote = await request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: await pdf(), name: 'a.pdf' }], options } });
    assert.equal(quote.status, 201);
    const created = await request('/api/orders', { method: 'POST', token: quote.body.token, body: { quoteId: quote.body.id, method: 'cash' } });
    assert.equal(created.status, 201);
    if (pay) assert.equal((await request(`/api/owner/orders/${created.body.id}/cash`, { method: 'POST', cookie: owner })).status, 200);
    return created.body.id;
  };
  const printer = async (name, { color = false, duplex = false } = {}) => {
    const paired = await request('/api/owner/devices', { method: 'POST', cookie: owner, body: { name, color, duplex } });
    assert.equal(paired.status, 201);
    return { id: paired.body.id, token: paired.body.token };
  };
  const claim = device => request('/api/device/claim', { method: 'POST', token: device.token });
  const event = (device, job, name, extra = {}) => request(`/api/device/jobs/${job.id}/events`, { method: 'POST', token: device.token, lease: job.token, body: { event: name, ...extra } });
  const status = async id => (await db.query('SELECT status FROM orders WHERE id=$1', [id]))[0]?.status;
  const cancel = (id, cookie = owner) => request(`/api/owner/orders/${id}/cancel`, { method: 'POST', cookie, body: { confirmed: true } });
  return { db, request, login, owner, order, printer, claim, event, status, cancel };
}

// ---------- Cancellation contract ----------

test('cancellation succeeds for every state where nothing can be printing', async t => {
  const { db, order, status, cancel } = await start(t);
  const unpaid = await order({}, { pay: false });
  const queued = await order();
  const failed = await order();
  await db.query("UPDATE orders SET status='failed' WHERE id=$1", [failed]);
  const review = await order({}, { pay: false });
  await db.query("UPDATE orders SET status='payment_review', payment='paid' WHERE id=$1", [review]);
  const expired = await order();
  await db.query("UPDATE orders SET status='expired' WHERE id=$1", [expired]);
  for (const [label, id] of Object.entries({ unpaid, queued, failed, review, expired })) {
    const result = await cancel(id);
    assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
    assert.equal(await status(id), 'cancelled', label);
    const [doc] = await db.query('SELECT d.id FROM documents d JOIN orders o ON o.document_id=d.id WHERE o.id=$1', [id]);
    assert.equal(doc, undefined, `${label}: the print file is deleted`);
  }
  const [paid] = await db.query('SELECT payment FROM orders WHERE id=$1', [queued]);
  assert.equal(paid.payment, 'paid', 'collected payment stays recorded so it can be refunded');
});

test('a claimed job that has not reached Windows is cancelled, and the connector can no longer print it', async t => {
  const { db, order, printer, claim, event, status, cancel, request } = await start(t);
  const device = await printer('Front desk');
  const id = await order();
  const job = (await claim(device)).body;
  assert.equal(job.id, id);
  assert.equal(await status(id), 'printing');

  const result = await cancel(id);
  assert.equal(result.status, 200);
  assert.equal(await status(id), 'cancelled');
  assert.equal((await db.query('SELECT * FROM print_leases WHERE order_id=$1', [id])).length, 0);
  // The connector's next steps are refused, so it never sends the file to the spooler.
  assert.equal((await request(`/api/device/jobs/${id}/document`, { token: device.token, lease: job.token })).status, 404);
  assert.notEqual((await event(device, job, 'submitted')).status, 200);
  assert.equal(await status(id), 'cancelled');
  assert.equal((await claim(device)).body, null, 'a cancelled order is never claimed again');
});

test('cancellation is refused, without changing anything, once printing may have started', async t => {
  const { db, owner, order, printer, claim, event, status, cancel, request } = await start(t);
  const device = await printer('Back office');

  const submitted = await order();
  const job = (await claim(device)).body;
  assert.equal((await event(device, job, 'submitted')).status, 200);
  let result = await cancel(submitted);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /already sent to the printer/);
  assert.equal(await status(submitted), 'printing');
  assert.equal((await db.query('SELECT state FROM print_leases WHERE order_id=$1', [submitted]))[0].state, 'submitted');

  assert.equal((await event(device, job, 'awaiting_confirmation')).status, 200);
  result = await cancel(submitted);
  assert.equal(result.status, 409);
  assert.equal(await status(submitted), 'awaiting_confirmation');

  await db.query("UPDATE print_leases SET expires='2000-01-01T00:00:00.000Z' WHERE order_id=$1", [submitted]);
  await sweepLeases(db);
  result = await cancel(submitted);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /uncertain/);
  assert.equal(await status(submitted), 'needs_review');

  // The documented path still works: stop the print, then cancel.
  assert.equal((await request(`/api/owner/orders/${submitted}/resolve-failed`, { method: 'POST', cookie: owner, body: { confirmed: true } })).status, 200);
  assert.equal((await cancel(submitted)).status, 200);

  assert.equal((await request(`/api/owner/devices/${device.id}`, { method: 'DELETE', cookie: owner })).status, 200);
  const manual = await order();
  assert.equal((await request(`/api/owner/orders/${manual}/start`, { method: 'POST', cookie: owner })).status, 200);
  result = await cancel(manual);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /printed manually/);
  assert.equal(await status(manual), 'printing');

  const done = await order();
  assert.equal((await request(`/api/owner/orders/${done}/start`, { method: 'POST', cookie: owner })).status, 200);
  assert.equal((await request(`/api/owner/orders/${done}/complete`, { method: 'POST', cookie: owner, body: { confirmed: true } })).status, 200);
  result = await cancel(done);
  assert.equal(result.status, 409);
  assert.equal(await status(done), 'completed');
});

test('cancellation is authorised server-side and owner-scoped', async t => {
  const { request, login, order, status, cancel } = await start(t);
  const id = await order();
  assert.equal((await request(`/api/owner/orders/${id}/cancel`, { method: 'POST', body: { confirmed: true } })).status, 401);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { email: 'rival@test.local', password: 'RivalShopPass!2026', name: 'Rival', location: 'Next door' } })).status, 201);
  const rival = await login('rival@test.local', 'RivalShopPass!2026');
  assert.equal((await cancel(id, rival)).status, 404);
  assert.equal((await cancel('00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal(await status(id), 'queued');
});

test('repeated and concurrent cancellations leave exactly one consistent cancellation', async t => {
  const { db, order, status, cancel } = await start(t);
  const id = await order();
  const results = await Promise.all(Array.from({ length: 5 }, () => cancel(id)));
  assert.deepEqual(results.map(r => r.status), [200, 200, 200, 200, 200]);
  assert.equal(results.filter(r => r.body.alreadyCancelled).length, 4);
  assert.equal(await status(id), 'cancelled');
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM order_history WHERE order_id=$1 AND to_status='cancelled'", [id]))[0].n, 1);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM audit WHERE target=$1 AND action='order.cancelled'", [id]))[0].n, 1);
});

test('cancel racing a claim or a connector submission has exactly one winner', async t => {
  const { db, order, printer, claim, event, status, cancel } = await start(t);
  const device = await printer('Race printer');
  for (let round = 0; round < 3; round++) {
    const id = await order();
    const [claimed, cancelled] = await Promise.all([claim(device), cancel(id)]);
    assert.equal(cancelled.status, 200, 'queued and claimed-not-submitted are both cancellable');
    assert.equal(await status(id), 'cancelled');
    assert.equal((await db.query('SELECT * FROM print_leases WHERE order_id=$1', [id])).length, 0);
    if (claimed.body) assert.notEqual((await event(device, claimed.body, 'submitted')).status, 200, 'the connector cannot print a cancelled job');
  }
  for (let round = 0; round < 3; round++) {
    const id = await order();
    const job = (await claim(device)).body;
    const [submit, cancelled] = await Promise.all([event(device, job, 'submitted'), cancel(id)]);
    assert.equal([submit.status, cancelled.status].filter(s => s === 200).length, 1, `submit=${submit.status} cancel=${cancelled.status}`);
    if (cancelled.status === 200) assert.equal(await status(id), 'cancelled');
    else {
      assert.equal(await status(id), 'printing');
      assert.equal((await event(device, job, 'awaiting_confirmation')).status, 200);
      await db.query("UPDATE orders SET status='completed' WHERE id=$1", [id]);
      await db.query('DELETE FROM print_leases WHERE order_id=$1', [id]);
    }
  }
});

test('an expired claim that was never submitted can be cancelled before the sweeper reviews it', async t => {
  const { db, order, printer, claim, event, status, cancel } = await start(t);
  const device = await printer('Sleepy printer');
  const id = await order();
  const job = (await claim(device)).body;
  await db.query("UPDATE print_leases SET expires='2000-01-01T00:00:00.000Z' WHERE order_id=$1", [id]);
  assert.equal((await event(device, job, 'submitted')).status, 404, 'a delayed connector cannot submit on an expired lease');
  assert.equal((await cancel(id)).status, 200);
  assert.equal(await status(id), 'cancelled');
});

test('cancellation rules match the order states the owner UI offers it for', () => {
  for (const status of ['awaiting_payment', 'queued', 'failed', 'expired', 'payment_review']) assert.equal(cancelRefusal({ status }), null, status);
  assert.equal(cancelRefusal({ status: 'printing', lease_state: 'claimed' }), null);
  for (const order of [{ status: 'printing', lease_state: 'submitted' }, { status: 'printing', lease_state: 'awaiting_confirmation' }, { status: 'printing' }, { status: 'awaiting_confirmation' }, { status: 'needs_review' }, { status: 'completed' }]) {
    assert.match(cancelRefusal(order), /\w/, JSON.stringify(order));
  }
});

// ---------- Printer capability routing ----------

test('printer compatibility: colour needs colour, duplex needs duplex, unknown is never assumed', () => {
  assert.equal(printerSupports({ color: 0, duplex: 0 }, { color: 'color' }), false);
  assert.equal(printerSupports({ color: 1, duplex: 0 }, { color: 'color' }), true);
  assert.equal(printerSupports({ color: 0, duplex: 0 }, { color: 'bw' }), true);
  assert.equal(printerSupports({ color: 1, duplex: 1 }, { color: 'bw' }), true);
  assert.equal(printerSupports({ color: 1, duplex: 0 }, { color: 'bw', duplex: true }), false);
  assert.equal(printerSupports({ color: 1, duplex: 1 }, { color: 'color', duplex: true }), true);
  assert.equal(printerSupports({}, { color: 'color' }), false);
  assert.equal(printerSupports({ color: null, duplex: undefined }, { color: 'bw', duplex: true }), false);
});

test('a colour job is never sent to a black & white printer, even when it is the only job', async t => {
  const { db, order, printer, claim, status, request, owner } = await start(t);
  const mono = await printer('Mono laser');
  const colourJob = await order({ color: 'color' });
  assert.equal((await claim(mono)).body, null);
  assert.equal((await claim(mono)).body, null);
  assert.equal(await status(colourJob), 'queued', 'it stays queued, not printed or failed');
  assert.equal((await db.query('SELECT * FROM print_leases WHERE order_id=$1', [colourJob])).length, 0);

  // The owner gets one actionable notification, not one per poll.
  let alerts = [];
  for (let i = 0; i < 20 && !alerts.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    alerts = (await request('/api/owner/notifications', { cookie: owner })).body.notifications.filter(n => n.event_type === 'print.no_compatible_printer');
  }
  await claim(mono);
  await new Promise(resolve => setTimeout(resolve, 150));
  alerts = (await request('/api/owner/notifications', { cookie: owner })).body.notifications.filter(n => n.event_type === 'print.no_compatible_printer');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].body, /colour/);

  const colour = await printer('Colour inkjet', { color: true });
  const job = (await claim(colour)).body;
  assert.equal(job.id, colourJob);
  assert.equal(job.options.color, 'color');
});

test('black & white jobs run on either printer; duplex jobs only on duplex printers', async t => {
  const { order, printer, claim, status } = await start(t);
  const mono = await printer('Mono');
  const colour = await printer('Colour', { color: true });
  const bwOnMono = await order({ color: 'bw' });
  assert.equal((await claim(mono)).body.id, bwOnMono);
  const bwOnColour = await order({ color: 'bw' });
  assert.equal((await claim(colour)).body.id, bwOnColour);

  const { order: order2, printer: printer2, claim: claim2, status: status2 } = await start(t);
  const simplex = await printer2('Simplex', { color: true });
  const duplexJob = await order2({ duplex: true });
  assert.equal((await claim2(simplex)).body, null);
  assert.equal(await status2(duplexJob), 'queued');
  const duplex = await printer2('Duplex', { duplex: true });
  assert.equal((await claim2(duplex)).body.id, duplexJob);
  assert.equal(await status(bwOnMono), 'printing');
});

test('multiple queued jobs are routed to the right printers in queue order', async t => {
  const { order, printer, claim } = await start(t);
  const firstColour = await order({ color: 'color' });
  const bw = await order({ color: 'bw' });
  const secondColour = await order({ color: 'color' });
  const mono = await printer('Mono');
  const colourA = await printer('Colour A', { color: true });
  const colourB = await printer('Colour B', { color: true });
  assert.equal((await claim(mono)).body.id, bw, 'the mono printer skips colour jobs and takes the B&W job');
  assert.equal((await claim(colourA)).body.id, firstColour);
  assert.equal((await claim(colourB)).body.id, secondColour);
  assert.equal((await claim(mono)).body, null);
});

test('concurrent claims never hand one job to two printers', async t => {
  const { db, order, printer, claim } = await start(t);
  const jobs = [await order({ color: 'color' }), await order({ color: 'color' })];
  const printers = await Promise.all(['P1', 'P2', 'P3', 'P4'].map(name => printer(name, { color: true })));
  const results = await Promise.all(printers.map(claim));
  const claimed = results.map(r => r.body?.id).filter(Boolean);
  assert.equal(claimed.length, 2);
  assert.deepEqual([...claimed].sort(), [...jobs].sort());
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM print_leases'))[0].n, 2);
});

test('connector capability reports, disconnection and reconnection', async t => {
  const { db, order, printer, claim, request, owner } = await start(t);
  const device = await printer('Connector printer');
  const colourJob = await order({ color: 'color' });
  assert.equal((await claim(device)).body, null, 'unknown capability is treated as black & white');

  // Non-boolean capability data is ignored.
  await request('/api/device/printers/scanned', { method: 'POST', token: device.token, body: { printers: [], capabilities: { color: 'yes', duplex: 1 } } });
  assert.equal((await db.query('SELECT color FROM devices WHERE id=$1', [device.id]))[0].color, 0);
  // A driver-verified report from the connector enables colour routing for this device only.
  await request('/api/device/printers/scanned', { method: 'POST', token: device.token, body: { printers: [], capabilities: { color: true, duplex: false } } });
  const job = (await claim(device)).body;
  assert.equal(job.id, colourJob);

  // A restarted connector with the same credential does not get a second job while one is in flight.
  await order({ color: 'bw' });
  assert.equal((await claim(device)).body, null);

  // A revoked connector is cut off.
  assert.equal((await request(`/api/owner/devices/${device.id}`, { method: 'DELETE', cookie: owner })).status, 200);
  assert.equal((await claim(device)).status, 401);
  assert.equal((await request('/api/device/printers/scanned', { method: 'POST', token: device.token, body: { capabilities: { color: false, duplex: false } } })).status, 401);
});

test('retry after a genuine failure goes back to a compatible printer; uncertain outcomes are not retried', async t => {
  const { db, owner, order, printer, claim, event, status, request } = await start(t);
  const colour = await printer('Colour', { color: true });
  const mono = await printer('Mono');
  const id = await order({ color: 'color' });
  const job = (await claim(colour)).body;
  assert.equal((await event(colour, job, 'failed', { error: 'Paper jam' })).status, 200);
  assert.equal(await status(id), 'failed');
  assert.equal((await request(`/api/owner/orders/${id}/retry`, { method: 'POST', cookie: owner })).status, 200);
  assert.equal((await claim(mono)).body, null, 'the retried colour job still skips the mono printer');
  const again = (await claim(colour)).body;
  assert.equal(again.id, id);
  assert.equal(again.attempt, 2);

  assert.equal((await event(colour, again, 'submitted')).status, 200);
  await db.query("UPDATE print_leases SET expires='2000-01-01T00:00:00.000Z' WHERE order_id=$1", [id]);
  await sweepLeases(db);
  assert.equal(await status(id), 'needs_review');
  assert.equal((await request(`/api/owner/orders/${id}/retry`, { method: 'POST', cookie: owner })).status, 409);
  assert.equal((await claim(colour)).body, null, 'an uncertain print is never re-claimed automatically');
});
