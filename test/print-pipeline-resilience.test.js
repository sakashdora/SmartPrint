import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.js';
import { openDatabase } from '../server/db.js';
import { token, digest, encrypt, loadKey, hashPassword } from '../server/security.js';
import { sweepLeases } from '../server/devices.js';

async function listen(service) {
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function request(url, path, { method = 'GET', body, cookie, token, headers = {} } = {}) {
  const res = await fetch(url + path, {
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
    status: res.status,
    cookie: res.headers.get('set-cookie'),
    data: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
  };
}

test('Cash payment triggers durable queue, device claims with attempt tracking, failed print records error, and retry recovers', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();
  const key = loadKey();

  const ownerId = randomUUID(), shopId = randomUUID(), docId = randomUUID(), orderId = randomUUID();
  const deviceId = randomUUID(), deviceSecret = token(), receipt = token();

  // Create owner and shop
  await db.query("INSERT INTO users (id,email,password,role) VALUES ($1,'owner@test.invalid','hash','owner')", [ownerId]);
  await db.query("INSERT INTO shops (id,owner_id,slug,name,location,status,bw,color) VALUES ($1,$2,'test-shop','Test Shop','Loc','active',200,1000)", [shopId, ownerId]);
  
  // Create device
  await db.query("INSERT INTO devices (id,shop_id,name,token,color,duplex,active,heartbeat,status_note,is_paused) VALUES ($1,$2,'Brother DCP-T820DW Printer',$3,1,1,1,$4,'Ready',0)", [
    deviceId, shopId, digest(deviceSecret), new Date().toISOString()
  ]);

  // Create document and order awaiting cash payment
  const sealed = encrypt(Buffer.from('%PDF-1.4 test document'), key);
  await db.query("INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,$3,$4,$5,$6)", [
    docId, shopId, sealed.payload, sealed.iv, sealed.tag, new Date(Date.now() + 3600000).toISOString()
  ]);

  const options = { color: 'color', duplex: false, copies: 1, file_name: 'test.pdf', priority: 0 };
  await db.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,payment,status,created) VALUES ($1,$2,$3,$4,$5,1,1,1,200,'cash','pending','awaiting_payment',$6)", [
    orderId, shopId, docId, digest(receipt), JSON.stringify(options), new Date().toISOString()
  ]);

  // Create owner session
  const sessionId = randomUUID();
  await db.query("INSERT INTO sessions (id,user_id,expires,mfa) VALUES ($1,$2,$3,1)", [
    digest(sessionId), ownerId, new Date(Date.now() + 3600000).toISOString()
  ]);
  const cookie = `sp_session=${sessionId}`;

  const service = await createApp({ database: db, seed: false });
  const { server, url } = await listen(service);
  t.after(async () => {
    await new Promise(r => server.close(r));
    await service.close();
  });

  // 1. Confirm cash payment
  const cashRes = await request(url, `/api/owner/orders/${orderId}/cash`, { method: 'POST', cookie });
  assert.equal(cashRes.status, 200);

  // Verify database state: order is now queued and paid
  const [orderAfterCash] = await db.query("SELECT * FROM orders WHERE id=$1", [orderId]);
  assert.equal(orderAfterCash.status, 'queued');
  assert.equal(orderAfterCash.payment, 'paid');

  // 2. Device claims the print job
  const claimRes = await request(url, '/api/device/claim', { method: 'POST', token: deviceSecret });
  assert.equal(claimRes.status, 200);
  assert.ok(claimRes.data);
  assert.equal(claimRes.data.id, orderId);
  assert.equal(claimRes.data.attempt, 1);
  const leaseToken = claimRes.data.token;
  assert.ok(leaseToken);

  // Verify order transitioned to 'printing' and lease exists
  const [orderAfterClaim] = await db.query("SELECT * FROM orders WHERE id=$1", [orderId]);
  assert.equal(orderAfterClaim.status, 'printing');
  const [lease] = await db.query("SELECT * FROM print_leases WHERE order_id=$1", [orderId]);
  assert.equal(lease.state, 'claimed');

  // 3. Device downloads document
  const docRes = await request(url, `/api/device/jobs/${orderId}/document`, {
    token: deviceSecret,
    headers: { 'X-Lease-Token': leaseToken }
  });
  assert.equal(docRes.status, 200);
  assert.ok(docRes.data.toString().startsWith('%PDF-'));

  // 4. Device sends submitted event
  const submitRes = await request(url, `/api/device/jobs/${orderId}/events`, {
    method: 'POST',
    token: deviceSecret,
    headers: { 'X-Lease-Token': leaseToken },
    body: { event: 'submitted' }
  });
  assert.equal(submitRes.status, 200);

  // 5. Device reports print failed (e.g. printer error / offline)
  const failRes = await request(url, `/api/device/jobs/${orderId}/events`, {
    method: 'POST',
    token: deviceSecret,
    headers: { 'X-Lease-Token': leaseToken },
    body: { event: 'failed', error: 'Printer reported paper jam or offline' }
  });
  assert.equal(failRes.status, 200);

  // Verify database state: order is marked 'needs_review' (ambiguous print outcome) and error is logged in lease detail and order history
  const [orderAfterFail] = await db.query("SELECT * FROM orders WHERE id=$1", [orderId]);
  assert.equal(orderAfterFail.status, 'needs_review');
  const [leaseAfterFail] = await db.query("SELECT * FROM print_leases WHERE order_id=$1", [orderId]);
  assert.equal(leaseAfterFail.state, 'failed');
  assert.match(leaseAfterFail.detail, /paper jam/);

  // 6. Owner retries the order
  const retryRes = await request(url, `/api/owner/orders/${orderId}/retry`, { method: 'POST', cookie });
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.data.ok, true);

  // Verify order is back in 'queued' with incremented attempt
  const [orderAfterRetry] = await db.query("SELECT * FROM orders WHERE id=$1", [orderId]);
  assert.equal(orderAfterRetry.status, 'queued');
  assert.equal(orderAfterRetry.attempts, 2);

  // Verify old lease was cleaned up
  const [leaseAfterRetry] = await db.query("SELECT * FROM print_leases WHERE order_id=$1", [orderId]);
  assert.equal(leaseAfterRetry, undefined);

  // 7. Device claims retry job
  const claim2Res = await request(url, '/api/device/claim', { method: 'POST', token: deviceSecret });
  assert.equal(claim2Res.status, 200);
  assert.equal(claim2Res.data.id, orderId);
  assert.equal(claim2Res.data.attempt, 2);
  const leaseToken2 = claim2Res.data.token;

  // 8. Device reports awaiting_confirmation after successful spooling
  await request(url, `/api/device/jobs/${orderId}/events`, {
    method: 'POST',
    token: deviceSecret,
    headers: { 'X-Lease-Token': leaseToken2 },
    body: { event: 'submitted' }
  });
  const awaitRes = await request(url, `/api/device/jobs/${orderId}/events`, {
    method: 'POST',
    token: deviceSecret,
    headers: { 'X-Lease-Token': leaseToken2 },
    body: { event: 'awaiting_confirmation' }
  });
  assert.equal(awaitRes.status, 200);

  const [orderFinal] = await db.query("SELECT status FROM orders WHERE id=$1", [orderId]);
  assert.equal(orderFinal.status, 'awaiting_confirmation');
});

test('Lease sweeper marks expired in-flight leases as uncertain and needs_review', async () => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();
  const ownerId = randomUUID(), shopId = randomUUID(), docId = randomUUID(), orderId = randomUUID(), devId = randomUUID();

  await db.query("INSERT INTO users (id,email,password,role) VALUES ($1,'owner2@test.invalid','hash','owner')", [ownerId]);
  await db.query("INSERT INTO shops (id,owner_id,slug,name,location,status) VALUES ($1,$2,'s2','Shop 2','Loc','active')", [shopId, ownerId]);
  await db.query("INSERT INTO devices (id,shop_id,name,token,active) VALUES ($1,$2,'P1','tok',1)", [devId, shopId]);
  await db.query("INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,'p','i','t','2099-01-01')", [docId, shopId]);
  await db.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,payment,status,created) VALUES ($1,$2,$3,'t','{}',1,1,1,200,'cash','paid','printing','2020-01-01')", [orderId, shopId, docId]);

  // Insert expired lease
  await db.query("INSERT INTO print_leases (order_id,device_id,token,expires,state) VALUES ($1,$2,'t','2020-01-01','claimed')", [orderId, devId]);

  await sweepLeases(db);

  const [order] = await db.query("SELECT status FROM orders WHERE id=$1", [orderId]);
  assert.equal(order.status, 'needs_review');
  const [lease] = await db.query("SELECT state FROM print_leases WHERE order_id=$1", [orderId]);
  assert.equal(lease.state, 'uncertain');
  await db.close();
});

test('Device pause state persists in database and prevents job claiming until resumed', async () => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();
  const shopId = randomUUID(), devId = randomUUID(), docId = randomUUID(), orderId = randomUUID(), devTok = token();

  await db.query("INSERT INTO users (id,email,password,role) VALUES ('u3','owner3@test.invalid','hash','owner')");
  await db.query("INSERT INTO shops (id,owner_id,slug,name,location,status) VALUES ($1,'u3','s3','Shop 3','Loc','active')", [shopId]);
  await db.query("INSERT INTO devices (id,shop_id,name,token,active,is_paused,heartbeat) VALUES ($1,$2,'P3',$3,1,1,$4)", [
    devId, shopId, digest(devTok), new Date().toISOString()
  ]);
  await db.query("INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,'p','i','t','2099-01-01')", [docId, shopId]);
  await db.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,payment,status,created) VALUES ($1,$2,$3,'t','{}',1,1,1,200,'cash','paid','queued',$4)", [orderId, shopId, docId, new Date().toISOString()]);

  const service = await createApp({ database: db, seed: false });
  const { server, url } = await listen(service);

  // Claim when paused should return null
  const claimPaused = await request(url, '/api/device/claim', { method: 'POST', token: devTok });
  assert.equal(claimPaused.status, 200);
  assert.equal(claimPaused.data, null);

  // Resume device
  await db.query("UPDATE devices SET is_paused=0 WHERE id=$1", [devId]);

  // Claim when resumed should succeed
  const claimResumed = await request(url, '/api/device/claim', { method: 'POST', token: devTok });
  assert.equal(claimResumed.status, 200);
  assert.equal(claimResumed.data.id, orderId);

  await new Promise(r => server.close(r));
  await service.close();
});
