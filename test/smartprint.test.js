import test from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { price, validateOptions, selectedPages, prepare } from '../server/printing.js';

test('pricing counts two-up and duplex independently for odd pages and copies', () => {
  assert.deepEqual(price(5, validateOptions({ layout: 'two', duplex: true, copies: 2 }), { bw: 200, color: 1000 }), { sides: 6, sheets: 4, amount: 1200 });
  assert.throws(() => validateOptions({ copies: -1 }));
  assert.throws(() => validateOptions({ layout: 'card', duplex: true }));
  assert.deepEqual(selectedPages('1-3, 3,5', 5), [0, 1, 2, 4]);
  assert.throws(() => selectedPages('0-3', 5));
  assert.throws(() => selectedPages('1-99999', 5));
});
test('normalization generates two-up A4 pages and card sheet from real files', async () => {
  const source = await PDFDocument.create(); for (let i = 0; i < 5; i++) source.addPage().drawText(`Page ${i + 1}`);
  const generated = await prepare([{ data: Buffer.from(await source.save()).toString('base64') }], validateOptions({ layout: 'two' }));
  const pdf = await PDFDocument.load(generated.bytes);
  assert.equal(pdf.getPageCount(), 3); assert.equal(generated.pages, 5); assert.equal(pdf.getPage(0).getWidth(), 595.28);
  const image = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#d4e7d7' } }).png().toBuffer();
  const card = await prepare([{ data: image.toString('base64') }, { data: image.toString('base64') }], validateOptions({ layout: 'card', enhance: true, crop: 5 }));
  assert.equal(card.outputPages, 1);
  await assert.rejects(() => prepare([{ data: Buffer.from('<html>bad</html>').toString('base64') }], validateOptions()), /Supported files/);
});
test('cash lifecycle, tenant isolation, quote replay, deletion and expiry', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, cookie, token, origin } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'admin@smartprint.local', password: 'SmartPrintDemo!2026', role: 'owner' } })).status, 401);
  const owner = await request('/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } }); assert.equal(owner.status, 200);
  assert.equal((await request('/api/owner/orders')).status, 401);
  assert.equal((await request('/api/owner/prices', { method: 'PUT', cookie: owner.cookie, origin: 'https://evil.example', body: { bw: 1, color: 1 } })).status, 403);
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Private test document');
  const quote = await request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: Buffer.from(await pdf.save()).toString('base64') }], options: { copies: 2 }, amount: 1 } }); assert.equal(quote.status, 201); assert.equal(quote.body.amount, 400);
  const order = await request('/api/orders', { method: 'POST', token: quote.body.token, body: { quoteId: quote.body.id, method: 'cash' } }); assert.equal(order.status, 201);
  assert.equal((await request('/api/orders', { method: 'POST', token: quote.body.token, body: { quoteId: quote.body.id, method: 'cash' } })).status, 409);
  const path = `/api/owner/orders/${order.body.id}`;
  assert.equal((await request(path + '/start', { method: 'POST', cookie: owner.cookie })).status, 409);
  assert.equal((await request(`/api/orders/${order.body.id}`, { token: 'bad' })).status, 404);
  const other = await request('/api/auth/register', { method: 'POST', body: { email: 'other@example.com', password: 'long-password-test', name: 'Another Shop', location: 'Another road' } }); assert.equal(other.status, 201);
  const loginOther = await request('/api/auth/login', { method: 'POST', body: { email: 'other@example.com', password: 'long-password-test' } });
  assert.equal((await request(path + '/cash', { method: 'POST', cookie: loginOther.cookie })).status, 404);
  assert.equal((await request(path + '/cash', { method: 'POST', cookie: owner.cookie })).status, 200);
  assert.equal((await request(path + '/cash', { method: 'POST', cookie: owner.cookie })).status, 409);
  assert.equal((await request(path + '/complete', { method: 'POST', cookie: owner.cookie, body: { confirmed: true } })).status, 409);
  assert.equal((await request(path + '/start', { method: 'POST', cookie: owner.cookie })).status, 200);
  assert.equal((await request(path + '/document', { cookie: owner.cookie })).status, 200);
  assert.equal((await request(path + '/complete', { method: 'POST', cookie: owner.cookie, body: { confirmed: true } })).status, 200);
  const receipt = await request(`/api/orders/${order.body.id}`, { token: order.body.token }); assert.equal(receipt.body.status, 'completed'); assert.ok(receipt.body.deleted_at);
  assert.equal((await db.query('SELECT * FROM documents')).length, 0);
  assert.equal((await request(path + '/document', { cookie: owner.cookie })).status, 409);
  assert.equal((await request('/api/owner/transactions', { cookie: owner.cookie })).body.length, 1);
  const admin = await request('/api/auth/login', { method: 'POST', body: { email: 'admin@smartprint.local', password: 'SmartPrintDemo!2026' } });
  assert.equal((await request(path + '/document', { cookie: admin.cookie })).status, 403);
  assert.equal((await request('/api/admin/shops', { cookie: owner.cookie })).status, 403);
  const pending = (await request('/api/admin/shops', { cookie: admin.cookie })).body.find(s => s.email === 'other@example.com');
  assert.equal((await request(`/api/admin/shops/${pending.id}/status`, { method: 'POST', cookie: admin.cookie, body: { status: 'active' } })).status, 200);
  assert.equal((await request(`/api/shops/${pending.slug}`)).status, 200);
  await db.query("INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ('expired','shop-demo',$1,'x','x','2000-01-01')", [Buffer.from('test')]);
  await service.cleanup(); assert.equal((await db.query("SELECT id FROM documents WHERE id='expired'")).length, 0);
  process.env.RAZORPAY_WEBHOOK_SECRET = 'test-only-webhook-secret';
  t.after(() => delete process.env.RAZORPAY_WEBHOOK_SECRET);
  await db.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,status,created,provider_order) VALUES ('online-test','shop-demo','expired','none','{}',1,1,1,200,'online','expired','2026-01-01','order_test')");
  async function webhook(amount, eventId, valid = true, providerOrder = 'order_test') {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_test', order_id: providerOrder, status: 'captured', currency: 'INR', amount } } } });
    return fetch(base + '/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-event-id': eventId, 'x-razorpay-signature': valid ? createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex') : 'bad' }, body });
  }
  assert.equal((await webhook(200, 'event-bad', false)).status, 401);
  assert.equal((await webhook(100, 'event-mismatch')).status, 409);
  assert.equal((await webhook(200, 'event-captured')).status, 200);
  assert.equal((await webhook(200, 'event-captured')).status, 200);
  const [latePayment] = await db.query("SELECT * FROM orders WHERE id='online-test'");
  assert.equal(latePayment.payment, 'paid'); assert.equal(latePayment.status, 'payment_review');
  assert.equal((await db.query("SELECT * FROM transactions WHERE order_id='online-test'")).length, 1);
  await db.query("INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ('live-online-doc','shop-demo',$1,'x','x',$2)", [Buffer.from('test'), new Date(Date.now() + 60000).toISOString()]);
  await db.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,created,provider_order) VALUES ('auto-online','shop-demo','live-online-doc','none','{}',1,1,1,200,'online',$1,'order_auto')", [new Date().toISOString()]);
  const device = await request('/api/owner/devices', { method: 'POST', cookie: owner.cookie, body: { name: 'Automatic printer', color: true, duplex: true } });
  assert.equal((await request('/api/device/claim', { method: 'POST', token: device.body.token })).body, null);
  assert.equal((await webhook(200, 'event-auto', true, 'order_auto')).status, 200);
  assert.equal((await db.query("SELECT status FROM orders WHERE id='auto-online'"))[0].status, 'queued');
  const claim = await request('/api/device/claim', { method: 'POST', token: device.body.token });
  assert.equal(claim.body.id, 'auto-online'); // No owner acceptance or start action.
  assert.equal((await request('/api/owner/orders/auto-online/retry', { method: 'POST', cookie: owner.cookie })).status, 409);
  assert.equal((await webhook(200, 'event-auto', true, 'order_auto')).status, 200);
  assert.equal((await webhook(200, 'event-auto-second', true, 'order_auto')).status, 200);
  assert.equal((await db.query("SELECT * FROM transactions WHERE order_id='auto-online'")).length, 1);
  assert.equal((await request('/api/device/claim', { method: 'POST', token: device.body.token })).body, null);
});
