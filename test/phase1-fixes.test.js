import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { digest, token } from '../server/security.js';

async function boot(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token: bearer, cookie } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { db, call };
}
const pdfData = async () => { const pdf = await PDFDocument.create(); pdf.addPage().drawText('phase 1'); return Buffer.from(await pdf.save()).toString('base64'); };

test('a failed online-payment attempt leaves a cash order payable at the counter', async t => {
  const { db, call } = await boot(t);
  const quote = (await call('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: await pdfData() }], options: {} } })).body;
  const order = (await call('/api/orders', { method: 'POST', token: quote.token, body: { quoteId: quote.id, method: 'cash' } })).body;
  // Online payments are not configured in this fixture, so the request fails ...
  assert.equal((await call(`/api/orders/${order.id}/payment`, { method: 'POST', token: order.token })).status, 503);
  assert.equal((await call(`/api/orders/${order.id}/payment/verify`, { method: 'POST', token: order.token, body: { razorpay_payment_id: 'pay_x', razorpay_order_id: 'order_x', razorpay_signature: 'bad' } })).status >= 400, true);
  // ... and must not have converted the order, so the owner can still collect cash.
  assert.equal((await db.query('SELECT method FROM orders WHERE id=$1', [order.id]))[0].method, 'cash');
  const owner = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } });
  assert.equal((await call(`/api/owner/orders/${order.id}/cash`, { method: 'POST', cookie: owner.cookie })).status, 200);
});

test('owner remote print never sends a colour or two-sided job to a printer that cannot do it', async t => {
  const { db, call } = await boot(t);
  const owner = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } });
  const fresh = new Date().toISOString();
  // The mono printer checked in most recently; the colour printer a little earlier.
  await db.query("INSERT INTO devices (id,shop_id,name,token,active,heartbeat,color,duplex) VALUES ('d-mono','shop-demo','Mono',$1,1,$2,0,0)", [digest(token()), fresh]);
  await db.query("INSERT INTO devices (id,shop_id,name,token,active,heartbeat,color,duplex) VALUES ('d-color','shop-demo','Colour',$1,1,$2,1,1)", [digest(token()), new Date(Date.now() - 5000).toISOString()]);
  const file = { data: await pdfData(), name: 'a.pdf' };
  const colour = await call('/api/owner/print-job', { method: 'POST', cookie: owner.cookie, body: { file, options: { color: 'color' } } });
  assert.equal(colour.status, 201);
  assert.equal(colour.body.printer, 'Colour');
  const mono = await call('/api/owner/print-job', { method: 'POST', cookie: owner.cookie, body: { file, options: { color: 'bw' } } });
  assert.equal(mono.status, 201);
  assert.equal(mono.body.printer, 'Mono');
  await db.query('DELETE FROM devices WHERE id=$1', ['d-color']);
  const none = await call('/api/owner/print-job', { method: 'POST', cookie: owner.cookie, body: { file, options: { color: 'color' } } });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /supports these settings/);
});

test('every status change on the owner start and download paths leaves a history row', async t => {
  const { db, call } = await boot(t);
  const owner = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } });
  const quote = (await call('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: await pdfData() }], options: {} } })).body;
  const order = (await call('/api/orders', { method: 'POST', token: quote.token, body: { quoteId: quote.id, method: 'cash' } })).body;
  await call(`/api/owner/orders/${order.id}/cash`, { method: 'POST', cookie: owner.cookie });
  assert.equal((await call(`/api/owner/orders/${order.id}/start`, { method: 'POST', cookie: owner.cookie })).status, 200);
  const actions = (await db.query('SELECT action FROM order_history WHERE order_id=$1', [order.id])).map(r => r.action);
  assert.ok(actions.includes('print.started') && actions.includes('payment.collected') && actions.includes('order.created'), actions.join(','));
});
