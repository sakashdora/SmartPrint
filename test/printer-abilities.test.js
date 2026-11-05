import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'smartprint-abilities-')); // never touch the real connector folder

const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');

async function start(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'X-Forwarded-For': '203.0.113.7', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' }, body: JSON.stringify({ email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }) });
  const owner = login.headers.get('set-cookie')?.split(';')[0];
  const connect = (body = {}) => request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name: 'Shop Printer', ...body } });
  const devices = async () => (await request('/api/owner/devices', { cookie: owner })).body;
  const shopInfo = async () => (await request('/api/shops/campus-print')).body;
  const connectorReport = (token, color, duplex) => request('/api/device/printers/scanned', { method: 'POST', token, body: { printers: [], capabilities: { color, duplex } } });
  return { db, request, owner, connect, devices, shopInfo, connectorReport };
}
const flags = async devices => { const [d] = await devices(); return [Number(d.color), Number(d.duplex)]; };

test('the owner chooses what a printer can do when connecting it, and the order page follows', async t => {
  const { connect, devices, shopInfo } = await start(t);
  assert.equal((await shopInfo()).printerCount, 0, 'no printer yet');
  const added = (await connect({ color: false, duplex: false, manual: true })).body;
  const [device] = await devices();
  assert.deepEqual([Number(device.color), Number(device.duplex), device.cap_source], [0, 0, 'manual']);
  const info = await shopInfo();
  assert.deepEqual([info.printerCount, info.colorAvailable, info.duplexAvailable], [1, false, false], 'customers are not offered colour or two-sided');
  assert.ok(added.token);
});

test('what the owner sets is never overwritten by detection; "use detected" hands control back', async t => {
  const { connect, devices, request, owner, connectorReport, shopInfo } = await start(t);
  const { token } = (await connect({ color: false, duplex: false, manual: true })).body;
  const [{ id }] = await devices();
  // A (wrong) driver report claims colour and duplex: ignored, the owner said black & white, one-sided.
  await connectorReport(token, true, true);
  assert.deepEqual(await flags(devices), [0, 0]);
  // The owner turns colour on; the next driver report (saying no colour) cannot undo it.
  const set = await request(`/api/owner/devices/${id}`, { method: 'PATCH', cookie: owner, body: { color: true } });
  assert.deepEqual([set.status, set.body.color, set.body.duplex, set.body.cap_source], [200, true, false, 'manual']);
  await connectorReport(token, false, false);
  assert.deepEqual(await flags(devices), [1, 0]);
  assert.equal((await shopInfo()).colorAvailable, true);
  assert.equal((await shopInfo()).duplexAvailable, false);
  await request(`/api/owner/devices/${id}`, { method: 'PATCH', cookie: owner, body: { duplex: true } });
  assert.equal((await shopInfo()).duplexAvailable, true);
  // Reconnecting without a choice keeps the owner's settings.
  await connect({ color: false, duplex: false });
  assert.deepEqual(await flags(devices), [1, 1]);
  // Hand control back to detection: the connector's report counts again.
  assert.equal((await request(`/api/owner/devices/${id}`, { method: 'PATCH', cookie: owner, body: { useDetected: true } })).body.cap_source, 'driver');
  await connectorReport(token, false, false);
  assert.deepEqual(await flags(devices), [0, 0]);
});

test('detected capabilities are used until the owner decides', async t => {
  const { connect, devices, connectorReport } = await start(t);
  const { token } = (await connect({ color: true, duplex: false })).body; // no `manual`: just what the scan found
  assert.equal((await devices())[0].cap_source, 'driver');
  await connectorReport(token, false, false);
  assert.deepEqual(await flags(devices), [0, 0], 'a later, better driver reading replaces a detected value');
});

test("only the shop owner can change abilities, and only on their own shop's printers", async t => {
  const { connect, devices, request, owner, db } = await start(t);
  await connect({ color: false, duplex: false, manual: true });
  const [{ id }] = await devices();
  assert.equal((await request(`/api/owner/devices/${id}`, { method: 'PATCH', body: { color: true } })).status, 401, 'not signed in');
  assert.equal((await request(`/api/owner/devices/${id}`, { method: 'PATCH', cookie: owner, body: {} })).status, 400, 'nothing chosen');
  assert.equal((await request('/api/owner/devices/does-not-exist', { method: 'PATCH', cookie: owner, body: { color: true } })).status, 404);
  // A printer that belongs to another shop is invisible to this owner.
  await db.query("INSERT INTO users (id,email,password,role) VALUES ('u-other','other@x.test','x','owner')");
  await db.query("INSERT INTO shops (id,owner_id,slug,name,location,status) VALUES ('shop-other','u-other','other-shop','Other','Here','active')");
  await db.query("INSERT INTO devices (id,shop_id,name,token,color,duplex,active) VALUES ('dev-other','shop-other','Their Printer','tok-other',0,0,1)");
  assert.equal((await request('/api/owner/devices/dev-other', { method: 'PATCH', cookie: owner, body: { color: true } })).status, 404);
  assert.equal(Number((await db.query("SELECT color FROM devices WHERE id='dev-other'"))[0].color), 0);
});
