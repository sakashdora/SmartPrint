import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../server/index.js';
import { openDatabase } from '../server/db.js';
import { hashPassword, checkPassword, loadKey, encrypt, decrypt, totp } from '../server/security.js';
import { prepare, validateOptions } from '../server/printing.js';

async function listen(service) {
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function request(url, path, { method = 'GET', body, cookie, token, headers = {} } = {}) {
  const res = await fetch(url + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, cookie: res.headers.get('set-cookie'), data: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

test('prepared card artwork remains visible and black-and-white output really has no colour', async () => {
  const png = await sharp({ create: { width: 300, height: 180, channels: 3, background: '#ed2839' } }).png().toBuffer();
  const files = [{ data: png.toString('base64') }, { data: png.toString('base64') }];
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const color of ['color', 'bw']) {
    const result = await prepare(files, validateOptions({ layout: 'card', color }));
    const task = getDocument({ data: new Uint8Array(result.bytes), isEvalSupported: false });
    try {
      const pdf = await task.promise; assert.equal(pdf.numPages, 1);
      const page = await pdf.getPage(1), viewport = page.getViewport({ scale: 1 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0, coloured = 0;
      for (let i = 0; i < pixels.length; i += 4) { if (pixels[i] < 230 || pixels[i+1] < 230 || pixels[i+2] < 230) visible++; if (Math.max(pixels[i], pixels[i+1], pixels[i+2]) - Math.min(pixels[i], pixels[i+1], pixels[i+2]) > 5) coloured++; }
      assert.ok(visible > 50000, 'Both card images must remain visible in the final PDF');
      if (color === 'bw') assert.equal(coloured, 0); else assert.ok(coloured > 50000);
    } finally { await task.destroy(); }
  }
});

test('production sessions survive app instances, require MFA, enforce origin and revoke after password change', async t => {
  const names = ['NODE_ENV','DATABASE_URL','PUBLIC_BASE_URL','FILE_ENCRYPTION_KEY','CRON_SECRET','ENFORCE_MFA'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { NODE_ENV: 'production', ENFORCE_MFA: 'true', DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture?sslmode=verify-full', PUBLIC_BASE_URL: 'https://smartprint.example', FILE_ENCRYPTION_KEY: 'a'.repeat(64), CRON_SECRET: 'b'.repeat(32) });
  const db = await openDatabase({ url: null, path: ':memory:' }); await db.migrate();
  const password = 'Example-long-password!2026', hash = await hashPassword(password);
  assert.ok(hash.startsWith('$argon2') || hash.startsWith('scrypt$')); assert.equal(await checkPassword('wrong', hash), false); assert.equal(await checkPassword(password, 'invalid'), false);
  await db.query("INSERT INTO users (id,email,password,role) VALUES ('admin','admin@test.invalid',$1,'admin')", [hash]);
  const first = await createApp({ database: db, seed: false }), second = await createApp({ database: { ...db, close: async () => {} }, seed: false });
  const a = await listen(first), b = await listen(second);
  t.after(async () => { await Promise.all([new Promise(r => a.server.close(r)), new Promise(r => b.server.close(r))]); await second.close(); await first.close(); for (const [name,value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const body = { email: 'admin@test.invalid', password }, headers = { Origin: 'https://smartprint.example' };
  assert.equal((await request(a.url, '/api/auth/login', { method: 'POST', body })).status, 403);
  const login = await request(a.url, '/api/auth/login', { method: 'POST', body, headers });
  assert.equal(login.status, 200); assert.match(login.cookie, /HttpOnly/); assert.match(login.cookie, /Secure/); assert.equal(login.data.mfaRequired, true);
  let cookie = login.cookie.split(';')[0];
  assert.equal((await request(b.url, '/api/me', { cookie })).data.email, body.email);
  assert.equal((await request(b.url, '/api/admin/shops', { cookie })).status, 403);
  await request(a.url, '/api/auth/mfa/setup', { method: 'POST', cookie, headers });
  const [row] = await db.query('SELECT * FROM mfa WHERE user_id=$1', ['admin']), code = totp(decrypt(row, loadKey()));
  const verified = await request(b.url, '/api/auth/mfa/confirm', { method: 'POST', cookie, headers, body: { code } });
  assert.equal(verified.status, 200); assert.equal(verified.data.mfaRequired, false);
  assert.equal((await request(a.url, '/api/me', { cookie })).data, null);
  cookie = verified.cookie.split(';')[0];
  assert.equal((await request(a.url, '/api/admin/shops', { cookie })).status, 200);
  assert.equal((await request(a.url, '/api/auth/login', { method: 'POST', headers, body: { ...body, code } })).status, 401);
  assert.equal((await request(a.url, '/api/auth/password', { method: 'POST', cookie, headers, body: { current: password, password: 'Replacement-password!2026' } })).status, 200);
  assert.equal((await request(b.url, '/api/me', { cookie })).data, null);
});

test('uncertain printing requires owner review before refund and totals include refunds', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' }), service = await createApp({ database: db }), { server, url } = await listen(service);
  t.after(async () => { await new Promise(r => server.close(r)); await service.close(); });
  const login = await request(url, '/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } }), cookie = login.cookie.split(';')[0];
  const device = await request(url, '/api/owner/devices', { method: 'POST', cookie, body: { name: 'Review printer' } }), token = device.data.token;
  const document = await PDFDocument.create(); document.addPage(); const sealed = encrypt(Buffer.from(await document.save()), loadKey());
  const id = randomUUID(), documentId = randomUUID(), created = new Date().toISOString();
  await db.query('INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,$3,$4,$5,$6)', [documentId, 'shop-demo', sealed.payload, sealed.iv, sealed.tag, new Date(Date.now()+3600000).toISOString()]);
  await db.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,payment,status,created) VALUES ($1,'shop-demo',$2,'fixture',$3,1,1,1,200,'cash','paid','queued',$4)", [id, documentId, JSON.stringify(validateOptions()), created]);
  await db.query("INSERT INTO transactions (id,order_id,shop_id,amount,method,reference,created) VALUES ($1,$2,'shop-demo',200,'cash','counter',$3)", [randomUUID(), id, created]);
  const job = (await request(url, '/api/device/claim', { method: 'POST', token })).data, headers = { 'X-Lease-Token': job.token };
  await request(url, `/api/device/jobs/${id}/events`, { method: 'POST', token, headers, body: { event: 'submitted' } });
  await request(url, `/api/device/jobs/${id}/events`, { method: 'POST', token, headers, body: { event: 'failed' } });
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [id]))[0].status, 'needs_review');
  assert.equal((await request(url, `/api/owner/orders/${id}/refund`, { method: 'POST', cookie, body: { confirmed: true, reference: 'cash-fixture' } })).status, 409);
  assert.equal((await request(url, `/api/owner/orders/${id}/resolve-failed`, { method: 'POST', cookie, body: { confirmed: false } })).status, 400);
  assert.equal((await request(url, `/api/owner/orders/${id}/resolve-failed`, { method: 'POST', cookie, body: { confirmed: true } })).status, 200);
  assert.equal((await request(url, `/api/device/jobs/${id}/events`, { method: 'POST', token, headers, body: { event: 'awaiting_confirmation' } })).status, 404);
  assert.equal((await request(url, `/api/owner/orders/${id}/refund`, { method: 'POST', cookie, body: { confirmed: true, reference: 'cash-fixture' } })).status, 200);
  const summary = (await request(url, '/api/owner/summary', { cookie })).data;
  assert.equal(summary.collected, 200); assert.equal(summary.refunded, 200); assert.equal(summary.net, 0);
  assert.equal((await request(url, '/api/owner/transactions?offset=1&limit=1', { cookie })).data.length, 0);
  assert.equal((await request(url, '/api/owner/transactions?offset=-1', { cookie })).status, 400);
  assert.equal((await db.query('SELECT * FROM documents')).length, 0);
});
