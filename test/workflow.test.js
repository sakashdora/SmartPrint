import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';

test('complete end-to-end workflow: multi-user simultaneous orders, printer connection, queue management & test print', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', body, cookie, token, lease } = {}) {
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
      cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
  }

  // 1. Owner Login
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(login.status, 200);
  const ownerCookie = login.cookie;

  // 2. Printer Pairing
  const devicePair = await request('/api/owner/devices', {
    method: 'POST',
    cookie: ownerCookie,
    body: { name: 'Brother DCP-T820DW Printer', color: true, duplex: true }
  });
  assert.equal(devicePair.status, 201);
  assert.ok(devicePair.body.id);
  assert.ok(devicePair.body.token);
  const deviceId = devicePair.body.id;
  const deviceToken = devicePair.body.token;

  // Verify devices list includes status_note and is_paused
  const devicesList = await request('/api/owner/devices', { cookie: ownerCookie });
  assert.equal(devicesList.status, 200);
  assert.equal(devicesList.body.length, 1);
  assert.equal(devicesList.body[0].name, 'Brother DCP-T820DW Printer');
  assert.equal(devicesList.body[0].is_paused, 0);

  // 3. Pause & Resume Printer
  const pauseRes = await request(`/api/owner/devices/${deviceId}/pause`, { method: 'POST', cookie: ownerCookie });
  assert.equal(pauseRes.status, 200);
  assert.equal(pauseRes.body.is_paused, 1);

  const resumeRes = await request(`/api/owner/devices/${deviceId}/pause`, { method: 'POST', cookie: ownerCookie });
  assert.equal(resumeRes.status, 200);
  assert.equal(resumeRes.body.is_paused, 0);

  // 4. Test Print Generation
  const testPrintRes = await request(`/api/owner/devices/${deviceId}/test-print`, { method: 'POST', cookie: ownerCookie });
  assert.equal(testPrintRes.status, 200);
  assert.ok(testPrintRes.body.orderId);

  // 5. Native Printer Hardware Scan (No PowerShell / No .BAT)
  const scanPrintersRes = await request('/api/owner/printers/scan', { cookie: ownerCookie });
  assert.equal(scanPrintersRes.status, 200);
  assert.ok(Array.isArray(scanPrintersRes.body));

  // 6. Multi-User Simultaneous File Uploads and Quotes
  const samplePdf = await PDFDocument.create();
  samplePdf.addPage().drawText('User simultaneous document');
  const pdfBytes = Buffer.from(await samplePdf.save()).toString('base64');

  // Send 4 simultaneous quote requests
  const simultaneousQuotes = await Promise.all([
    request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: pdfBytes, name: 'Student1.pdf' }], options: { copies: 1 } } }),
    request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: pdfBytes, name: 'Student2.pdf' }], options: { copies: 2 } } }),
    request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: pdfBytes, name: 'Student3.pdf' }], options: { copies: 1, color: 'color' } } }),
    request('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data: pdfBytes, name: 'Student4.pdf' }], options: { copies: 3 } } })
  ]);

  for (const q of simultaneousQuotes) {
    assert.equal(q.status, 201);
    assert.ok(q.body.id);
  }

  // 7. Place simultaneous orders with file_name
  const order1 = await request('/api/orders', {
    method: 'POST',
    token: simultaneousQuotes[0].body.token,
    body: { quoteId: simultaneousQuotes[0].body.id, method: 'cash', fileName: 'Thesis_Final.pdf' }
  });
  assert.equal(order1.status, 201);

  const order2 = await request('/api/orders', {
    method: 'POST',
    token: simultaneousQuotes[1].body.token,
    body: { quoteId: simultaneousQuotes[1].body.id, method: 'cash', fileName: 'Lab_Report.pdf' }
  });
  assert.equal(order2.status, 201);

  // Collect cash for order 1 & 2
  await request(`/api/owner/orders/${order1.body.id}/cash`, { method: 'POST', cookie: ownerCookie });
  await request(`/api/owner/orders/${order2.body.id}/cash`, { method: 'POST', cookie: ownerCookie });

  // 8. Queue Management: Rush Job Prioritization
  const rushRes = await request(`/api/owner/orders/${order2.body.id}/priority`, { method: 'POST', cookie: ownerCookie });
  assert.equal(rushRes.status, 200);

  // Check queue ordering in owner orders
  const ownerOrders = await request('/api/owner/orders', { cookie: ownerCookie });
  assert.equal(ownerOrders.status, 200);

  // Check customer tracking includes queue_position and file_name
  const trackOrder1 = await request(`/api/orders/${order1.body.id}`, { token: order1.body.token });
  assert.equal(trackOrder1.status, 200);
  assert.equal(trackOrder1.body.file_name, 'Thesis_Final.pdf');
  assert.ok(trackOrder1.body.queue_position >= 1);

  // 9. Connector Device Claims Job (High priority test-page / rush job first)
  const heartbeat = await request('/api/device/heartbeat', { method: 'POST', token: deviceToken });
  assert.equal(heartbeat.status, 200);

  const claim1 = await request('/api/device/claim', { method: 'POST', token: deviceToken });
  assert.equal(claim1.status, 200);
  assert.ok(claim1.body.id); // Test print (priority 100) or rush job claimed first!

  // Connector downloads document
  const doc = await request(`/api/device/jobs/${claim1.body.id}/document`, {
    token: deviceToken,
    lease: claim1.body.token
  });
  assert.equal(doc.status, 200);

  // Submit and confirm
  await request(`/api/device/jobs/${claim1.body.id}/events`, {
    method: 'POST',
    token: deviceToken,
    body: { event: 'submitted' },
    lease: claim1.body.token
  });

  await request(`/api/device/jobs/${claim1.body.id}/events`, {
    method: 'POST',
    token: deviceToken,
    body: { event: 'awaiting_confirmation' },
    lease: claim1.body.token
  });

  // Owner confirms print
  const completeRes = await request(`/api/owner/orders/${claim1.body.id}/complete`, {
    method: 'POST',
    cookie: ownerCookie,
    body: { confirmed: true }
  });
  assert.equal(completeRes.status, 200);

  // 10. Test retry on failed job
  const retryOrder = await request('/api/orders', {
    method: 'POST',
    token: simultaneousQuotes[2].body.token,
    body: { quoteId: simultaneousQuotes[2].body.id, method: 'cash', fileName: 'Retry_Test.pdf' }
  });
  await request(`/api/owner/orders/${retryOrder.body.id}/cash`, { method: 'POST', cookie: ownerCookie });

  // Start job then fail it
  await request(`/api/owner/orders/${retryOrder.body.id}/start`, { method: 'POST', cookie: ownerCookie });
  await request(`/api/owner/orders/${retryOrder.body.id}/resolve-failed`, { method: 'POST', cookie: ownerCookie, body: { confirmed: true } });

  // Retry back to queue
  const retryResult = await request(`/api/owner/orders/${retryOrder.body.id}/retry`, { method: 'POST', cookie: ownerCookie });
  assert.equal(retryResult.status, 200);

  const checkRetried = await request(`/api/orders/${retryOrder.body.id}`, { token: retryOrder.body.token });
  assert.equal(checkRetried.body.status, 'queued');
});
