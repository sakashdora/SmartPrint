import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'smartprint-connect-setup-'));

const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { formatPrinterList } = await import('../server/devices.js');
const { classifyConnection, extractManufacturerModel, probePrinterCapabilities } = await import('../server/printer-capabilities.js');
const { checkPrinterStatus, getWindowsPrinters } = await import('../connector/sumatra-helper.js');
const { createBridgeHandler } = await import('../connector/local-bridge.js');
const { createServer } = await import('node:http');

async function startApp(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, { method = 'GET', body, cookie, token, lease } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'X-Forwarded-For': '203.0.113.9',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(lease ? { 'X-Lease-Token': lease } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
    body: JSON.stringify({ email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' })
  });
  return { db, req, owner: login.headers.get('set-cookie')?.split(';')[0] };
}

test('classifyConnection distinguishes USB, Wi-Fi, Ethernet/LAN, TCP/IP, Shared, and Virtual printers', () => {
  assert.equal(classifyConnection({ port: 'USB001', name: 'HP LaserJet 1020' }).connectionCode, 'usb');
  assert.equal(classifyConnection({ port: 'WSD-1234', name: 'Brother DCP-T820DW' }).connectionCode, 'wifi');
  assert.equal(classifyConnection({ port: 'NPI1A2B3C', name: 'HP OfficeJet' }).connectionCode, 'ethernet');
  assert.equal(classifyConnection({ port: '192.168.1.55', name: 'Canon iR', portHost: '192.168.1.55' }).connectionCode, 'tcpip');
  assert.equal(classifyConnection({ port: '\\\\DESK-01\\Canon', name: '\\\\DESK-01\\Canon', shared: true }).connectionCode, 'shared');
  assert.equal(classifyConnection({ port: 'PORTPROMPT:', name: 'Microsoft Print to PDF' }).connectionCode, 'virtual');
});

test('extractManufacturerModel parses vendor and model cleanly', () => {
  assert.deepEqual(extractManufacturerModel('HP LaserJet 1020 (Copy 1)', 'HP LaserJet 1020'), { manufacturer: 'HP', model: 'LaserJet 1020' });
  assert.deepEqual(extractManufacturerModel('Brother DCP-T820DW Printer', 'Brother DCP-T820DW Printer'), { manufacturer: 'Brother', model: 'DCP-T820DW' });
});

test('checkPrinterStatus handles WorkOffline and granular spooler states', () => {
  assert.equal(checkPrinterStatus(0, true).isOffline, true);
  assert.equal(checkPrinterStatus(0, true).operationalStatus, 'Offline');
  assert.equal(checkPrinterStatus(0x1, false).operationalStatus, 'Paused');
  assert.equal(checkPrinterStatus(0x2, false).operationalStatus, 'Error');
  assert.equal(checkPrinterStatus(0x400, false).operationalStatus, 'Printing');
  assert.equal(checkPrinterStatus(0x200, false).operationalStatus, 'Busy');
  assert.equal(checkPrinterStatus(0, false).operationalStatus, 'Ready');
});

test('formatPrinterList formats multiple USB, Wi-Fi, Ethernet, Shared, and duplicate queues', () => {
  const formatted = formatPrinterList([
    { Name: 'HP LaserJet 1020', PortName: 'USB001', DriverName: 'HP LaserJet 1020', PrinterStatus: 0, Default: true },
    { Name: 'HP LaserJet 1020 (Copy 1)', PortName: 'USB002', DriverName: 'HP LaserJet 1020', PrinterStatus: 128, WorkOffline: true },
    { Name: 'Brother DCP-T820DW', PortName: 'WSD-999', DriverName: 'Brother DCP-T820DW', PrinterStatus: 0 },
    { Name: 'Epson L3250', PortName: '192.168.1.22', PortHost: '192.168.1.22', DriverName: 'EPSON L3250 Series', PrinterStatus: 0 },
    { Name: '\\\\SERVER\\Ricoh MP', PortName: '\\\\SERVER\\Ricoh', Shared: true, DriverName: 'Ricoh PCL6', PrinterStatus: 0 }
  ]);
  assert.equal(formatted.length, 5);
  assert.equal(formatted[0].isDefault, true);
  assert.equal(formatted[1].status, 'Offline');
  assert.equal(formatted[2].connectionType, 'Wi-Fi');
  assert.equal(formatted[3].connectionType, 'TCP/IP');
  assert.equal(formatted[4].connectionType, 'Shared Network');
});

test('multiple printers connect independently, default switches cleanly, and test print targets only selected printer', async t => {
  const { req, owner } = await startApp(t);
  const p1 = (await req('/api/owner/printers/autoconnect', {
    method: 'POST', cookie: owner,
    body: { name: 'HP LaserJet 1020', portName: 'USB001', driverName: 'HP LaserJet 1020', connectionType: 'USB', color: false, duplex: false, manual: true }
  })).body;
  const p2 = (await req('/api/owner/printers/autoconnect', {
    method: 'POST', cookie: owner,
    body: { name: 'Brother DCP-T820DW', portName: 'WSD-123', driverName: 'Brother DCP-T820DW', connectionType: 'Wi-Fi', color: true, duplex: true, manual: true }
  })).body;
  assert.equal(p1.isDefault, true);
  assert.equal(p2.isDefault, false);

  await req('/api/device/heartbeat', { method: 'POST', token: p1.token, body: { connectorId: 'conn-1', version: '2.1.0', machineName: 'SHOP-PC', deviceStatus: 'Ready' } });
  await req('/api/device/heartbeat', { method: 'POST', token: p2.token, body: { connectorId: 'conn-1', version: '2.1.0', machineName: 'SHOP-PC', deviceStatus: 'Ready' } });

  // Switch default to p2
  const defRes = await req(`/api/owner/devices/${p2.id}/default`, { method: 'POST', cookie: owner });
  assert.equal(defRes.status, 200);
  const list = (await req('/api/owner/devices', { cookie: owner })).body;
  assert.equal(list.find(d => d.id === p2.id).is_default, 1);
  assert.equal(list.find(d => d.id === p1.id).is_default, 0);

  // Target test print specifically to p1
  const tp = await req(`/api/owner/devices/${p1.id}/test-print`, { method: 'POST', cookie: owner });
  assert.equal(tp.status, 200);
  // p2 must NOT be able to claim p1's test print
  const p2Claim = await req('/api/device/claim', { method: 'POST', token: p2.token });
  assert.equal(p2Claim.body, null);
  // p1 claims its own test print
  const p1Claim = await req('/api/device/claim', { method: 'POST', token: p1.token });
  assert.equal(p1Claim.body.id, tp.body.orderId);

  // Track test print status transitions
  await req(`/api/device/jobs/${tp.body.orderId}/events`, { method: 'POST', token: p1.token, lease: p1Claim.body.token, body: { event: 'submitted' } });
  let st = (await req(`/api/owner/devices/${p1.id}/test-print/${tp.body.orderId}`, { cookie: owner })).body;
  assert.equal(st.leaseState, 'submitted');
  await req(`/api/device/jobs/${tp.body.orderId}/events`, { method: 'POST', token: p1.token, lease: p1Claim.body.token, body: { event: 'awaiting_confirmation' } });
  st = (await req(`/api/owner/devices/${p1.id}/test-print/${tp.body.orderId}`, { cookie: owner })).body;
  assert.equal(st.status, 'awaiting_confirmation');

  // Disconnect p1 safely without breaking p2
  const del = await req(`/api/owner/devices/${p1.id}`, { method: 'DELETE', cookie: owner });
  assert.equal(del.status, 200);
  assert.equal((await req('/api/device/heartbeat', { method: 'POST', token: p1.token })).status, 401);
  assert.equal((await req('/api/device/heartbeat', { method: 'POST', token: p2.token })).status, 200);
});

test('local-bridge supports /status, /pair, /unpair, and /default-printer with origin enforcement', async t => {
  let bound = [];
  let defaultSet = null;
  const server = createServer(createBridgeHandler({
    state: () => ({ base: 'http://localhost:3000', connectorId: 'cid-1', connectorVersion: '2.1.0', machineName: 'WIN-PC', linked: bound.length > 0, needsRelink: false, printer: bound[0]?.printer || '', bindings: bound }),
    printers: async () => [{ name: 'HP LaserJet 1020', connectionType: 'USB', status: 'Ready' }],
    pair: async ({ url, token, printer }) => { bound.push({ url, token, printer }); return { printer }; },
    unpair: async ({ printer }) => { bound = bound.filter(b => b.printer !== printer); },
    setDefault: async ({ printer }) => { defaultSet = printer; }
  }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const bridgeBase = `http://127.0.0.1:${server.address().port}`;

  const untrusted = await fetch(`${bridgeBase}/status`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(untrusted.status, 403);

  const pair = await fetch(`${bridgeBase}/pair`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://localhost:3000', token: 'a'.repeat(32), printer: 'HP LaserJet 1020' })
  });
  assert.equal(pair.status, 200);

  const def = await fetch(`${bridgeBase}/default-printer`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ printer: 'HP LaserJet 1020' })
  });
  assert.equal(def.status, 200);
  assert.equal(defaultSet, 'HP LaserJet 1020');

  const unpair = await fetch(`${bridgeBase}/unpair`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ printer: 'HP LaserJet 1020' })
  });
  assert.equal(unpair.status, 200);
  assert.equal(bound.length, 0);
});

if (process.platform === 'win32') {
  test('Windows integration: getWindowsPrinters and probePrinterCapabilities enumerate real local queues', async () => {
    const printers = await getWindowsPrinters();
    assert.ok(Array.isArray(printers));
    if (printers.length > 0) {
      assert.ok(printers[0].Name);
      const caps = await probePrinterCapabilities([printers[0].Name]);
      assert.ok(caps instanceof Map);
    }
  });
}
