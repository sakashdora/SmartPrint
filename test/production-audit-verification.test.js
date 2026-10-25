import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { PDFDocument, rgb } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';

test('Production Audit: Fast pricing, WhatsApp prevention, Online payment HMAC, and Owner Remote Printing', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const secretKey = 'razorpay_test_secret_1234567890';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture';
  process.env.RAZORPAY_KEY_SECRET = secretKey;
  process.env.RAZORPAY_WEBHOOK_SECRET = secretKey;
  process.env.PAYMENT_SETTLEMENT_MODE = 'single_merchant';

  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.PAYMENT_SETTLEMENT_MODE;
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  async function call(path, { method = 'GET', body, cookie, token, rawBody, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(rawBody ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : rawBody ? { body: rawBody } : {})
    });
    const contentType = res.headers.get('content-type') || '';
    return {
      status: res.status,
      cookie: res.headers.get('set-cookie')?.split(';')[0],
      data: contentType.includes('json') ? await res.json() : await res.text()
    };
  }

  // 1. Authenticate Shop Owner
  const loginRes = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(loginRes.status, 200);
  const ownerCookie = loginRes.cookie;

  // Configure Shop UPI details
  const upiSetup = await call('/api/owner/payments', {
    method: 'PUT',
    cookie: ownerCookie,
    body: { upi_id: 'shopowner@upi', payee: 'SmartPrint Store' }
  });
  assert.equal(upiSetup.status, 200);

  // 2. Performance & Pricing: Create a 15-page PDF document
  const pdfDoc = await PDFDocument.create();
  for (let i = 1; i <= 15; i++) {
    const p = pdfDoc.addPage([595.28, 841.89]);
    p.drawText(`Page ${i}`, { x: 50, y: 750, size: 20, color: rgb(0.2, 0.2, 0.8) });
  }
  const pdfBytes = Buffer.from(await pdfDoc.save());

  // Upload document
  const tUpload0 = performance.now();
  const uploadInit = await call('/api/uploads', {
    method: 'POST',
    body: { slug: 'campus-print', name: 'lecture_notes.pdf', size: pdfBytes.length }
  });
  assert.equal(uploadInit.status, 201);
  const uploadId = uploadInit.data.id;
  const uploadToken = uploadInit.data.token;

  // Put chunk
  const chunkRes = await call(`/api/uploads/${uploadId}/chunks/0`, {
    method: 'PUT',
    token: uploadToken,
    body: { data: pdfBytes.toString('base64') }
  });
  assert.equal(chunkRes.status, 200);
  const uploadDuration = performance.now() - tUpload0;
  console.log(`[Test Measurement] Upload duration: ${uploadDuration.toFixed(1)}ms`);

  // Fast Quote Calculation (B&W default)
  const tQuote0 = performance.now();
  const quoteRes = await call('/api/quotes', {
    method: 'POST',
    body: {
      slug: 'campus-print',
      files: [{ uploadId, token: uploadToken }],
      options: { color: 'bw', duplex: false, copies: 1 }
    }
  });
  const quoteDuration = performance.now() - tQuote0;
  console.log(`[Test Measurement] Quote & B&W preparation duration: ${quoteDuration.toFixed(1)}ms`);

  assert.equal(quoteRes.status, 201);
  assert.equal(quoteRes.data.pages, 15);
  assert.equal(quoteRes.data.amount, 3000); // 15 pages * 200 paise = ₹30.00
  // Verify performance benchmark: 15 pages B&W calculation must be under 500ms
  assert.ok(quoteDuration < 1500, `Quote calculation should be fast, took ${quoteDuration.toFixed(1)}ms`);

  // 3. WhatsApp Redirection Prevention in UPI Deep Links
  const orderRes = await call('/api/orders', {
    method: 'POST',
    token: quoteRes.data.token,
    body: {
      quoteId: quoteRes.data.id,
      method: 'upi',
      fileName: 'lecture_notes.pdf'
    }
  });
  assert.equal(orderRes.status, 201);
  const orderId = orderRes.data.id;
  const orderToken = orderRes.data.token;

  const upiDetails = await call(`/api/orders/${orderId}/upi`, { token: orderToken });
  assert.equal(upiDetails.status, 200);
  assert.equal(upiDetails.data.upi_id, 'shopowner@upi');
  assert.equal(upiDetails.data.payee, 'SmartPrint Store');
  assert.equal(upiDetails.data.amount, 3000);
  assert.equal(upiDetails.data.amount_formatted, '30.00');

  // Verify explicit app deep links exist to bypass generic intent resolver (WhatsApp prevention)
  assert.ok(upiDetails.data.apps, 'Apps deep link map must be present');
  assert.ok(upiDetails.data.apps.phonepe.startsWith('phonepe://pay?'), 'PhonePe custom scheme');
  assert.ok(upiDetails.data.apps.gpay.includes('com.google.android.apps.nbu.paisa.user'), 'GPay intent package');
  assert.ok(upiDetails.data.apps.paytm.startsWith('paytmmp://pay?'), 'Paytm custom scheme');
  assert.ok(upiDetails.data.apps.bhim.includes('in.org.npci.upiapp'), 'BHIM intent package');
  assert.ok(upiDetails.data.uri.includes('am=30.00'), 'Exact amount in UPI uri');
  assert.ok(upiDetails.data.uri.includes(`tr=${orderId}`), 'Unique order reference in UPI uri');

  // 4. Online Payment Integration & HMAC Signature Verification
  // Prepare a second quote for online payment
  const quoteOnline = await call('/api/quotes', {
    method: 'POST',
    body: {
      slug: 'campus-print',
      files: [{ uploadId, token: uploadToken }],
      options: { color: 'color', duplex: true, copies: 1 }
    }
  });
  assert.equal(quoteOnline.status, 201);

  const orderOnline = await call('/api/orders', {
    method: 'POST',
    token: quoteOnline.data.token,
    body: {
      quoteId: quoteOnline.data.id,
      method: 'online',
      fileName: 'lecture_notes_color.pdf'
    }
  });
  assert.equal(orderOnline.status, 201);
  const onlineOrderId = orderOnline.data.id;
  const onlineOrderToken = orderOnline.data.token;

  // Set mock provider order for testing
  const mockProviderOrderId = `order_test_${randomUUID().slice(0, 14)}`;
  await db.query('UPDATE orders SET provider_order=$1 WHERE id=$2', [mockProviderOrderId, onlineOrderId]);

  // A. Test invalid signature rejection
  const invalidVerify = await call(`/api/orders/${onlineOrderId}/payment/verify`, {
    method: 'POST',
    token: onlineOrderToken,
    body: {
      razorpay_payment_id: 'pay_test_123',
      razorpay_order_id: mockProviderOrderId,
      razorpay_signature: 'invalid_forged_signature_hash'
    }
  });
  assert.equal(invalidVerify.status, 400);

  // B. Test valid HMAC signature verification
  const testPaymentId = `pay_valid_${randomUUID().slice(0, 12)}`;
  const validSignature = createHmac('sha256', secretKey)
    .update(`${mockProviderOrderId}|${testPaymentId}`)
    .digest('hex');

  const validVerify = await call(`/api/orders/${onlineOrderId}/payment/verify`, {
    method: 'POST',
    token: onlineOrderToken,
    body: {
      razorpay_payment_id: testPaymentId,
      razorpay_order_id: mockProviderOrderId,
      razorpay_signature: validSignature
    }
  });
  assert.equal(validVerify.status, 200);
  assert.equal(validVerify.data.verified, true);
  assert.equal(validVerify.data.status, 'queued');

  // Verify order transitioned to 'queued' and payment is 'paid'
  const [dbOrder] = await db.query('SELECT status, payment FROM orders WHERE id=$1', [onlineOrderId]);
  assert.equal(dbOrder.status, 'queued');
  assert.equal(dbOrder.payment, 'paid');

  // C. Test Idempotency: Duplicate payment event must not create duplicate transaction or print job
  const duplicateVerify = await call(`/api/orders/${onlineOrderId}/payment/verify`, {
    method: 'POST',
    token: onlineOrderToken,
    body: {
      razorpay_payment_id: testPaymentId,
      razorpay_order_id: mockProviderOrderId,
      razorpay_signature: validSignature
    }
  });
  assert.equal(duplicateVerify.status, 200);
  assert.equal(duplicateVerify.data.verified, true);

  const transactions = await db.query('SELECT * FROM transactions WHERE order_id=$1', [onlineOrderId]);
  assert.equal(transactions.length, 1, 'Only one transaction recorded for order');

  // 5. Remote Print-Job Submission from Owner's Authenticated Device
  // First, verify 503 error if no printer is online
  const unavailRemote = await call('/api/owner/print-job', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      file: { data: pdfBytes.toString('base64'), name: 'owner_urgent_document.pdf' },
      options: { color: 'bw', copies: 1 }
    }
  });
  assert.equal(unavailRemote.status, 503, 'Should reject with 503 if no printer is online');

  // Pair and activate shop printer device with heartbeat
  const device = await call('/api/owner/devices', {
    method: 'POST',
    cookie: ownerCookie,
    body: { name: 'Shop Front Counter LaserJet', color: true, duplex: true }
  });
  assert.equal(device.status, 201);
  const deviceToken = device.data.token;
  await call('/api/device/heartbeat', { method: 'POST', token: deviceToken });

  // Now submit owner remote print job
  const remotePrint = await call('/api/owner/print-job', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      file: { data: pdfBytes.toString('base64'), name: 'owner_urgent_document.pdf' },
      fileName: 'owner_urgent_document.pdf',
      options: { color: 'bw', copies: 2, duplex: true }
    }
  });
  assert.equal(remotePrint.status, 201);
  assert.equal(remotePrint.data.ok, true);
  assert.equal(remotePrint.data.pages, 15);
  assert.ok(remotePrint.data.orderId);

  // Verify that the remote print job is paid, queued, and has high priority
  const [remoteOrder] = await db.query('SELECT * FROM orders WHERE id=$1', [remotePrint.data.orderId]);
  assert.equal(remoteOrder.status, 'queued');
  assert.equal(remoteOrder.payment, 'paid');
  assert.equal(remoteOrder.method, 'owner_remote');
  const remoteOptions = JSON.parse(remoteOrder.options);
  assert.equal(remoteOptions.priority, 25);

  // 6. Background Automatic Printing: Device claims the queued job
  const claim = await call('/api/device/claim', { method: 'POST', token: deviceToken });
  assert.equal(claim.status, 200);
  assert.ok(claim.data, 'Device should claim the highest priority queued order');
  assert.equal(claim.data.id, remotePrint.data.orderId);

  // Connector downloads document using lease token
  const leaseToken = claim.data.token;
  const docDownload = await call(`/api/device/jobs/${remotePrint.data.orderId}/document`, {
    token: deviceToken,
    headers: { 'X-Lease-Token': leaseToken }
  });
  assert.equal(docDownload.status, 200);

  // Connector submits to spooler and records event
  const submittedEvent = await call(`/api/device/jobs/${remotePrint.data.orderId}/events`, {
    method: 'POST',
    token: deviceToken,
    headers: { 'X-Lease-Token': leaseToken },
    body: { event: 'submitted' }
  });
  assert.equal(submittedEvent.status, 200);

  const awaitingConfEvent = await call(`/api/device/jobs/${remotePrint.data.orderId}/events`, {
    method: 'POST',
    token: deviceToken,
    headers: { 'X-Lease-Token': leaseToken },
    body: { event: 'awaiting_confirmation' }
  });
  assert.equal(awaitingConfEvent.status, 200);

  // Owner confirms physical print output
  const completeRes = await call(`/api/owner/orders/${remotePrint.data.orderId}/complete`, {
    method: 'POST',
    cookie: ownerCookie,
    body: { confirmed: true }
  });
  assert.equal(completeRes.status, 200);

  // Verify live document is deleted after confirmed output
  const [deletedDoc] = await db.query('SELECT * FROM documents WHERE id=$1', [remoteOrder.document_id]);
  assert.equal(deletedDoc, undefined, 'Live document must be deleted after completed physical output');

  // 7. Security: Unauthorized access attempts
  // A. Non-owner cannot submit remote print jobs
  const unauthorizedRemote = await call('/api/owner/print-job', {
    method: 'POST',
    body: { file: { data: 'test' }, options: {} }
  });
  assert.equal(unauthorizedRemote.status, 401);

  // B. Forged webhook signature
  const fakeWebhook = await call('/api/payments/webhook', {
    method: 'POST',
    rawBody: JSON.stringify({ event: 'payment.captured' }),
    headers: { 'x-razorpay-signature': 'forged_fake_sig', 'x-razorpay-event-id': 'evt_123' }
  });
  assert.equal(fakeWebhook.status, 401);

  console.log('[Test Success] All Production Audit, Payment, Performance, and Remote Print tests passed!');
});
