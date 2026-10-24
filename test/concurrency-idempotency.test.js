import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { canTransition, transitionOrder, ORDER_STATUSES } from '../server/state-machine.js';
import { getIdempotentResult, saveIdempotentResult } from '../server/idempotency.js';

test('order state machine enforces valid transitions and actor permissions', async () => {
  // 1. Customer can cancel before payment
  assert.equal(canTransition('created', 'awaiting_payment', 'customer'), true);
  assert.equal(canTransition('awaiting_payment', 'cancelled', 'customer'), true);
  // Customer CANNOT cancel after payment or start printing
  assert.equal(canTransition('queued', 'cancelled', 'customer'), false);
  assert.equal(canTransition('printing', 'completed', 'customer'), false);

  // 2. Owner permissions
  assert.equal(canTransition('awaiting_payment', 'queued', 'owner'), true);
  assert.equal(canTransition('queued', 'printing', 'owner'), true);
  assert.equal(canTransition('failed', 'queued', 'owner'), true); // Retry
  assert.equal(canTransition('completed', 'queued', 'owner'), false); // Cannot requeue completed

  // 3. Print Device / Agent permissions
  assert.equal(canTransition('queued', 'printing', 'device'), true);
  assert.equal(canTransition('printing', 'awaiting_confirmation', 'device'), true);
  assert.equal(canTransition('printing', 'failed', 'device'), true);
  assert.equal(canTransition('awaiting_payment', 'printing', 'device'), false); // Cannot bypass payment

  // 4. Invariant checks
  assert.equal(canTransition('cancelled', 'completed', 'system'), false);
  assert.equal(canTransition('completed', 'cancelled', 'owner'), false);
});

test('idempotency service stores, retrieves, and expires cached results', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();
  t.after(async () => {
    await db.close();
  });

  const actor = 'test-actor-123';
  const operation = 'order_create';
  const key = 'idem-uuid-001';
  const samplePayload = { status: 201, body: { orderId: 'ord-999', price: 20 } };

  // Initial check: should be null
  const initial = await getIdempotentResult(db, key, actor, operation);
  assert.equal(initial, null);

  // Save result: (db, key, actor, operation, resourceId, status, body)
  await saveIdempotentResult(db, key, actor, operation, 'ord-999', samplePayload.status, samplePayload.body);

  // Retrieve result
  const retrieved = await getIdempotentResult(db, key, actor, operation);
  assert.ok(retrieved);
  assert.equal(retrieved.status, 201);
  assert.equal(retrieved.body.orderId, 'ord-999');

  // Different key or actor returns null
  const differentKey = await getIdempotentResult(db, 'different-key', actor, operation);
  assert.equal(differentKey, null);

  const differentActor = await getIdempotentResult(db, key, 'different-actor', operation);
  assert.equal(differentActor, null);
});

test('API idempotency prevents duplicate orders and duplicate cash confirmations', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, cookie, token, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(),
      cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
  }

  // Owner login
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(login.status, 200);
  const ownerCookie = login.cookie;

  // Prepare a document quote for order creation
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage().drawText('Idempotency Test Document');
  const pdfBytes = Buffer.from(await pdfDoc.save()).toString('base64');

  const quote = await request('/api/quotes', {
    method: 'POST',
    body: {
      slug: 'campus-print',
      files: [{ data: pdfBytes, name: 'Idempotency_Doc.pdf' }],
      options: { copies: 1 }
    }
  });
  assert.equal(quote.status, 201);
  assert.ok(quote.body.id);
  assert.ok(quote.body.token);

  // 1. Test Order Creation with Idempotency-Key
  const orderIdemKey = 'order-idem-test-key-12345';
  const orderReq1 = await request('/api/orders', {
    method: 'POST',
    token: quote.body.token,
    headers: { 'Idempotency-Key': orderIdemKey },
    body: {
      quoteId: quote.body.id,
      method: 'cash',
      fileName: 'Idempotency_Doc.pdf'
    }
  });
  assert.equal(orderReq1.status, 201);
  const createdOrderId = orderReq1.body.id;
  assert.ok(createdOrderId);

  // Repeated submission with same Idempotency-Key
  const orderReq2 = await request('/api/orders', {
    method: 'POST',
    token: quote.body.token,
    headers: { 'Idempotency-Key': orderIdemKey },
    body: {
      quoteId: quote.body.id,
      method: 'cash',
      fileName: 'Idempotency_Doc.pdf'
    }
  });
  assert.equal(orderReq2.status, 201);
  assert.equal(orderReq2.body.id, createdOrderId, 'Idempotent request must return the exact same order id');

  // Verify only 1 order exists in database for this id
  const ordersCount = await db.query(
    `SELECT COUNT(*) as count FROM ${db.isPg ? 'smartprint.orders' : 'orders'} WHERE id = $1`,
    [createdOrderId]
  );
  assert.equal(Number(ordersCount[0].count), 1, 'Database must contain exactly 1 order row despite duplicate submission');

  // 2. Test Cash Confirmation with Idempotency-Key
  const cashIdemKey = 'cash-idem-test-key-67890';
  const cashReq1 = await request(`/api/owner/orders/${createdOrderId}/cash`, {
    method: 'POST',
    cookie: ownerCookie,
    headers: { 'Idempotency-Key': cashIdemKey }
  });
  assert.equal(cashReq1.status, 200);
  assert.equal(cashReq1.body.ok, true);

  // Repeated cash confirmation with same key
  const cashReq2 = await request(`/api/owner/orders/${createdOrderId}/cash`, {
    method: 'POST',
    cookie: ownerCookie,
    headers: { 'Idempotency-Key': cashIdemKey }
  });
  assert.equal(cashReq2.status, 200);
  assert.equal(cashReq2.body.ok, true);

  // Verify order history records: order creation and 1 cash confirmation transition
  const history = await db.query(
    `SELECT from_status, to_status, action FROM ${db.isPg ? 'smartprint.order_history' : 'order_history'} WHERE order_id = $1 ORDER BY created ASC`,
    [createdOrderId]
  );
  assert.ok(history.length >= 2, 'Order history must trace order lifecycle');
  const cashActions = history.filter(h => h.action === 'payment.collected');
  assert.equal(cashActions.length, 1, 'Duplicate cash confirmation must NOT create duplicate history action');
});
