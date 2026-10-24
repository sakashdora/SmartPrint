import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { getIdempotentResult, saveIdempotentResult } from '../server/idempotency.js';

test('order submission resilience: migration, idempotency, cash workflow & error resilience', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text()
    };
  }

  // 1. Prepare sample document and quote
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText('Resilience Test Document');
  const pdfBytes = Buffer.from(await doc.save()).toString('base64');

  const quoteRes = await request('/api/quotes', {
    method: 'POST',
    body: {
      slug: 'campus-print',
      files: [{ data: pdfBytes, name: 'resilience.pdf' }],
      options: { copies: 1, color: 'bw', duplex: false, layout: 'single' }
    }
  });
  assert.equal(quoteRes.status, 201);
  const quote = quoteRes.body;
  assert.ok(quote.id);
  assert.ok(quote.token);
  assert.equal(quote.amount, 200); // 200 paisa = ₹2.00

  // 2. Submit order with Idempotency-Key
  const idemKey = 'client-order-idem-uuid-999';
  const orderRes1 = await request('/api/orders', {
    method: 'POST',
    token: quote.token,
    headers: { 'Idempotency-Key': idemKey },
    body: {
      quoteId: quote.id,
      method: 'cash',
      fileName: 'resilience.pdf'
    }
  });
  assert.equal(orderRes1.status, 201);
  assert.ok(orderRes1.body.id);
  assert.ok(orderRes1.body.token);
  const orderId = orderRes1.body.id;
  const receiptToken = orderRes1.body.token;

  // 3. Verify order initial cash-payment state
  const checkRes = await request(`/api/orders/${orderId}`, { token: receiptToken });
  assert.equal(checkRes.status, 200);
  assert.equal(checkRes.body.status, 'awaiting_payment');
  assert.equal(checkRes.body.payment, 'pending');
  assert.equal(checkRes.body.method, 'cash');

  // 4. Repeated submission with same Idempotency-Key (simulating retry after dropped response)
  const orderRes2 = await request('/api/orders', {
    method: 'POST',
    token: quote.token,
    headers: { 'Idempotency-Key': idemKey },
    body: {
      quoteId: quote.id,
      method: 'cash',
      fileName: 'resilience.pdf'
    }
  });
  assert.equal(orderRes2.status, 201, 'Idempotent retry must succeed with 201');
  assert.equal(orderRes2.body.id, orderId, 'Idempotent retry must return the exact same order ID');
  assert.equal(orderRes2.body.token, receiptToken, 'Idempotent retry must return the exact same receipt token');

  // Verify only 1 order exists in database
  const orders = await db.query('SELECT COUNT(*) AS count FROM orders WHERE id=$1', [orderId]);
  assert.equal(Number(orders[0].count), 1);

  // 5. Missing quoteId returns 400
  const badOrder = await request('/api/orders', {
    method: 'POST',
    token: quote.token,
    body: { method: 'cash' }
  });
  assert.equal(badOrder.status, 400);

  // 6. Invalid payment method returns 400
  const badMethod = await request('/api/orders', {
    method: 'POST',
    token: quote.token,
    body: { quoteId: quote.id, method: 'bitcoin' }
  });
  assert.equal(badMethod.status, 400);
});

test('idempotency service handles cache failures gracefully without crashing', async () => {
  const fakeDb = {
    query: async () => {
      throw new Error('relation "smartprint.idempotency_keys" does not exist');
    }
  };
  // Should not throw, should return null
  const result = await getIdempotentResult(fakeDb, 'key-123', 'actor', 'op');
  assert.equal(result, null);

  // saveIdempotentResult should not throw
  await assert.doesNotReject(async () => {
    await saveIdempotentResult(fakeDb, 'key-123', 'actor', 'op', 'res-1', 201, {});
  });
});
