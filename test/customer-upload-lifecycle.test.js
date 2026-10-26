import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { PDFDocument } from 'pdf-lib';

test('Customer upload, preview, print-request lifecycle & negative scenarios', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const contentType = res.headers.get('content-type') || '';
    return {
      status: res.status,
      headers: res.headers,
      data: contentType.includes('json') ? await res.json() : await res.text()
    };
  }

  // 1. Customer validates active shop
  const shopRes = await call('/api/shops/campus-print');
  assert.equal(shopRes.status, 200);
  assert.equal(shopRes.data.slug, 'campus-print');
  assert.equal(shopRes.data.status, 'active');

  // Negative scenario: invalid shop slug
  const badShopRes = await call('/api/shops/nonexistent-shop-12345');
  assert.equal(badShopRes.status, 404);

  // 2. Generate a valid 2-page test PDF
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([595, 842]);
  pdfDoc.addPage([595, 842]);
  const pdfBytes = await pdfDoc.save();
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

  // Negative scenario: oversized upload initiation
  const badSizeUpload = await call('/api/uploads', {
    method: 'POST',
    body: { slug: 'campus-print', name: 'huge.pdf', size: 25 * 1024 * 1024 }
  });
  assert.equal(badSizeUpload.status, 400);

  // 3. Customer initiates valid chunked upload
  const uploadInit = await call('/api/uploads', {
    method: 'POST',
    body: { slug: 'campus-print', name: 'syllabus.pdf', size: pdfBytes.length }
  });
  assert.equal(uploadInit.status, 201);
  assert.ok(uploadInit.data.id);
  assert.ok(uploadInit.data.token);

  // Negative scenario: upload chunk with wrong part index
  const badChunk = await call(`/api/uploads/${uploadInit.data.id}/chunks/99`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${uploadInit.data.token}` },
    body: { data: pdfBase64 }
  });
  assert.equal(badChunk.status, 400);

  // 4. Customer uploads genuine chunk
  const chunkRes = await call(`/api/uploads/${uploadInit.data.id}/chunks/0`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${uploadInit.data.token}` },
    body: { data: pdfBase64 }
  });
  assert.equal(chunkRes.status, 200);
  assert.equal(chunkRes.data.received, true);

  // 5. Customer requests price quote with options
  const quoteRes = await call('/api/quotes', {
    method: 'POST',
    body: {
      slug: 'campus-print',
      files: [{ uploadId: uploadInit.data.id, token: uploadInit.data.token }],
      options: { color: 'bw', duplex: false, copies: 1 }
    }
  });
  if (quoteRes.status !== 201) console.error('QUOTE ERROR:', quoteRes.data);
  assert.equal(quoteRes.status, 201);
  assert.equal(quoteRes.data.pages, 2);
  assert.equal(quoteRes.data.sheets, 2);
  assert.ok(quoteRes.data.amount > 0);

  // 6. Customer previews the document
  const previewRes = await call(`/api/quotes/${quoteRes.data.id}/preview`, {
    headers: { Authorization: `Bearer ${quoteRes.data.token}` }
  });
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.headers.get('content-type'), 'application/pdf');

  // 7. Customer submits print order (Cash method)
  const orderRes = await call('/api/orders', {
    method: 'POST',
    body: {
      quoteId: quoteRes.data.id,
      method: 'cash'
    },
    headers: { Authorization: `Bearer ${quoteRes.data.token}` }
  });
  assert.equal(orderRes.status, 201);
  assert.ok(orderRes.data.id);
  assert.ok(orderRes.data.token);

  // 8. Customer tracks order status
  const trackRes = await call(`/api/orders/${orderRes.data.id}`, {
    headers: { Authorization: `Bearer ${orderRes.data.token}` }
  });
  assert.equal(trackRes.status, 200);
  assert.equal(trackRes.data.id, orderRes.data.id);
  assert.equal(trackRes.data.status, 'awaiting_payment');

  // Negative scenario: tracking order without authorization token
  const unauthTrack = await call(`/api/orders/${orderRes.data.id}`);
  assert.equal(unauthTrack.status, 404);

  // 9. Shop Owner logs in and checks incoming orders
  const ownerLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(ownerLogin.status, 200);
  const ownerCookie = ownerLogin.headers.get('set-cookie')?.split(';')[0];

  const ownerOrders = await call('/api/owner/orders', {
    headers: { Cookie: ownerCookie }
  });
  assert.equal(ownerOrders.status, 200);
  const foundOrder = ownerOrders.data.find(o => o.id === orderRes.data.id);
  assert.ok(foundOrder, 'Order must appear in Shop Owner queue');

  // 10. Shop Owner accepts cash payment at counter
  const cashConfirm = await call(`/api/owner/orders/${orderRes.data.id}/cash`, {
    method: 'POST',
    headers: { Cookie: ownerCookie }
  });
  assert.equal(cashConfirm.status, 200);
  assert.equal(cashConfirm.data.ok, true);

  // Verify order transitioned to 'queued'
  const queuedOrder = await call(`/api/orders/${orderRes.data.id}`, {
    headers: { Authorization: `Bearer ${orderRes.data.token}` }
  });
  assert.equal(queuedOrder.data.status, 'queued');
  assert.equal(queuedOrder.data.payment, 'paid');
});
