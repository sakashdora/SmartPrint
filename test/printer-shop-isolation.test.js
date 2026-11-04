import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never let this file touch the real connector folder of the PC running the tests.
const sandbox = mkdtempSync(join(tmpdir(), 'smartprint-isolation-'));
process.env.LOCALAPPDATA = sandbox;

const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { isLocalRequest, formatPrinterList } = await import('../server/devices.js');
const { createBridgeHandler } = await import('../connector/local-bridge.js');
const { pickPrinter, checkPrinterStatus } = await import('../connector/sumatra-helper.js');
const { guessCapabilities, classifyConnection, isVirtualPrinter } = await import('../server/printer-capabilities.js');

// Every request carries a forwarding header, as through Render's proxy: the server must treat the
// owner as remote and never read, write or launch anything on this PC.
async function start(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie, token, local = false } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(local ? {} : { 'X-Forwarded-For': '203.0.113.7' }),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' }, body: JSON.stringify({ email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }) });
  return { db, request, owner: login.headers.get('set-cookie')?.split(';')[0] };
}

test('connecting a printer issues a fresh key and never shows it online before its connector checks in', async t => {
  const { db, request, owner } = await start(t);
  const added = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, local: true, body: { name: 'HP LaserJet 1020', color: false, duplex: false } });
  assert.equal(added.status, 200);
  assert.match(added.body.token, /^[a-f0-9]{64}$/);
  assert.equal('setup' in added.body, false, 'no copy-paste command is offered any more');
  assert.ok(!existsSync(join(sandbox, 'SmartPrintConnector')), 'the server never writes connector settings or starts a connector');

  let [device] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.equal(device.heartbeat, null);
  assert.match(device.status_note, /Offline/);
  const before = (await db.query('SELECT COUNT(*) AS n FROM orders'))[0].n;
  const offline = await request(`/api/owner/devices/${device.id}/test-print`, { method: 'POST', cookie: owner });
  assert.equal(offline.status, 409, 'a test page is never queued for an offline printer');
  assert.match(offline.body.error, /offline/);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM orders'))[0].n, before);

  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: added.body.token })).status, 200);
  [device] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.equal(device.status_note, 'Ready');
  assert.equal((await request(`/api/owner/devices/${device.id}/test-print`, { method: 'POST', cookie: owner })).status, 200);

  // Connecting again: the running connector keeps its key until a connector uses the new one.
  const again = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name: 'HP LaserJet 1020' } });
  assert.equal(again.body.id, added.body.id);
  assert.notEqual(again.body.token, added.body.token);
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: added.body.token })).status, 200, 'a Connect alone never locks out the running connector');
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: again.body.token })).status, 200, 'the connector that received the new key is accepted');
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: added.body.token })).status, 401, 'then the old key stops working');
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: again.body.token })).status, 200);
});

test('a Connect whose key never reaches the connector does not break printing', async t => {
  const { request, owner } = await start(t);
  const first = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name: 'HP LaserJet 1020' } });
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: first.body.token })).status, 200);
  // Owner clicks Connect twice more, but the connector is asleep / the browser blocked the hand-over.
  const lost1 = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name: 'HP LaserJet 1020' } });
  const lost2 = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name: 'HP LaserJet 1020' } });
  assert.equal((await request('/api/device/claim', { method: 'POST', token: first.body.token })).status, 200, 'the running connector still claims jobs');
  // The newest key wins once it arrives; an older unused one does not override it afterwards.
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: lost2.body.token })).status, 200);
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: lost1.body.token })).status, 401);
});

test("a remote shop never sees or reports the server PC's printers", async t => {
  const { request, owner } = await start(t);
  const report = await request('/api/owner/printers/scanned-report', { method: 'POST', cookie: owner, body: { printers: [{ name: 'Brother DCP-T820DW Printer (Copy 1) USB' }] } });
  assert.equal(report.body.count, 0);
  const scan = await request('/api/owner/printers/scan', { cookie: owner });
  assert.deepEqual(scan.body, [], 'only printers reported by this shop’s own connector are listed');
  const local = await request('/api/local/printers', { cookie: owner });
  assert.deepEqual(local.body.printers, []);
});

test('isLocalRequest accepts only a direct browser on the server PC', () => {
  const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers: { host: 'localhost:3000', ...headers } });
  assert.equal(isLocalRequest(req('127.0.0.1')), true);
  assert.equal(isLocalRequest(req('::ffff:127.0.0.1')), true);
  assert.equal(isLocalRequest(req('::1', { host: '[::1]:3000' })), true);
  assert.equal(isLocalRequest(req('10.0.0.5')), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false, 'a tunnel or proxy is remote');
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'smartprint.onrender.com' })), false);
});

const HP_PC = [
  { Name: 'OneNote (Desktop)', PrinterStatus: 0, PortName: 'nul:', DriverName: 'Send to Microsoft OneNote 16 Driver', Default: false },
  { Name: 'PaperPort Image Printer', PrinterStatus: 0, PortName: 'Kofax Image Printer Writer Port', DriverName: 'Kofax Image Printer Driver', Default: false },
  { Name: 'Microsoft Print to PDF', PrinterStatus: 0, PortName: 'PORTPROMPT:', DriverName: 'Microsoft Print To PDF', Default: true },
  { Name: 'HP LaserJet 1020', PrinterStatus: 0x1000000, PortName: 'USB001', DriverName: 'HP LaserJet 1020', Default: false }
];

test('connector finds an HP LaserJet 1020 on USB instead of a software printer', () => {
  for (const configured of ['HP Printer', 'HP LaserJet Series', 'HP LaserJet 1020', 'Hewlett-Packard LaserJet 1020 USB', undefined]) {
    assert.equal(pickPrinter(configured, HP_PC).name, 'HP LaserJet 1020', `configured: ${configured}`);
  }
  // Power save / printing / toner low are working states; only the offline bit blocks.
  assert.equal(checkPrinterStatus(0x1000000).isOffline, false);
  assert.equal(checkPrinterStatus(0x400).status, 'Ready');
  assert.equal(checkPrinterStatus(0x20000).status, 'Ready');
  assert.equal(checkPrinterStatus(0x80 | 0x1000000).isOffline, true);
});

test('connector follows a USB printer that Windows reinstalled as a copy on another port', () => {
  const moved = [
    { Name: 'HP LaserJet 1020', PrinterStatus: 0x80, PortName: 'USB001', DriverName: 'HP LaserJet 1020' },
    { Name: 'HP LaserJet 1020 (Copy 1)', PrinterStatus: 0, PortName: 'USB002', DriverName: 'HP LaserJet 1020' }
  ];
  assert.equal(pickPrinter('HP LaserJet 1020', moved).name, 'HP LaserJet 1020 (Copy 1)');
  const renamed = [moved[1], { Name: 'Canon LBP2900', PrinterStatus: 0, PortName: 'USB003', DriverName: 'Canon LBP2900' }];
  assert.equal(pickPrinter('HP LaserJet 1020', renamed).name, 'HP LaserJet 1020 (Copy 1)');
  // Nothing matches: the Windows default physical printer, never a PDF/OneNote printer.
  assert.equal(pickPrinter('Epson Printer', [...HP_PC.slice(0, 3), { ...renamed[1], Default: true }]).name, 'Canon LBP2900');
  assert.equal(pickPrinter('HP Printer', HP_PC.slice(0, 3)).name, '');
  // The working Brother set-up is unchanged.
  const brother = [
    { Name: 'Brother DCP-T820DW Printer', PrinterStatus: 128, PortName: 'WSD-c6dcd302', DriverName: 'Brother DCP-T820DW Printer' },
    { Name: 'Brother DCP-T820DW Printer (Copy 1) USB', PrinterStatus: 0, PortName: 'USB001', DriverName: 'Brother DCP-T820DW Printer' }
  ];
  assert.equal(pickPrinter('Brother DCP-T820DW Printer (Copy 1) USB', brother).name, 'Brother DCP-T820DW Printer (Copy 1) USB');
  assert.equal(pickPrinter('Brother DCP-T820DW Printer', brother).name, 'Brother DCP-T820DW Printer (Copy 1) USB');
});

test('mono and simplex HP lasers are not advertised as colour or two-sided', () => {
  assert.deepEqual(guessCapabilities('HP LaserJet 1020'), { color: false, duplex: false });
  assert.deepEqual(guessCapabilities('HP LaserJet Professional P1108'), { color: false, duplex: false });
  assert.deepEqual(guessCapabilities('HP LaserJet M1005'), { color: false, duplex: false });
  assert.deepEqual(guessCapabilities('HP LaserJet Pro M404dn'), { color: false, duplex: true });
  assert.equal(guessCapabilities('HP Color LaserJet Pro M454dw').color, true);
  assert.equal(guessCapabilities('HP Ink Tank 315').color, true);
  assert.deepEqual(guessCapabilities('Brother DCP-T820DW Printer'), { color: true, duplex: true });
  const [hp] = formatPrinterList([{ Name: 'HP LaserJet 1020', PortName: 'USB001', DriverName: 'HP LaserJet 1020', PrinterStatus: 0x1000000 }]);
  assert.deepEqual([hp.isWired, hp.color, hp.duplex, hp.status], [true, false, false, 'Ready']);
});

test('HP, Brother, Canon and Epson ports are classified', () => {
  assert.equal(classifyConnection({ port: 'USB001' }).isWired, true);
  assert.equal(classifyConnection({ port: 'DOT4_001' }).isWired, true);
  assert.equal(classifyConnection({ port: 'NPI1A2B3C' }).isWifi, true);
  assert.equal(classifyConnection({ port: 'HP1A2B3C' }).isWifi, true);
  assert.equal(classifyConnection({ port: '192.168.1.40' }).isWifi, true);
  assert.equal(classifyConnection({ port: 'WSD-1234' }).isWifi, true);
  assert.equal(classifyConnection({ name: 'Microsoft Print to PDF', port: 'PORTPROMPT:' }).connectionType, 'Virtual / PDF');
  assert.equal(isVirtualPrinter({ name: 'PaperPort Image Printer', port: 'Kofax Image Printer Writer Port' }), true);
  assert.equal(isVirtualPrinter({ name: 'HP LaserJet 1020', port: 'USB001', driver: 'HP LaserJet 1020' }), false);
});

// The connector's local link, exercised over real HTTP with a fake connector behind it.
async function bridge(t, initial = {}) {
  let state = { base: 'https://smartprint-ieks.onrender.com', linked: true, needsRelink: false, printer: 'HP LaserJet 1020', ...initial };
  const paired = [];
  const server = createServer(createBridgeHandler({
    state: () => state,
    printers: async () => [{ name: 'HP LaserJet 1020', portName: 'USB001', isWired: true, color: false, duplex: false, verified: true }],
    pair: async args => { paired.push(args); state = { ...state, base: args.url, linked: true, needsRelink: false, printer: args.printer }; return { printer: args.printer }; }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = async (path, { origin, method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, cors: response.headers.get('access-control-allow-origin'), pna: response.headers.get('access-control-allow-private-network'), body: await response.json().catch(() => null) };
  };
  return { call, paired };
}
const KEY = 'a'.repeat(64);
const DASHBOARD = 'https://smartprint-ieks.onrender.com';

test('connector link lists printers only to the SmartPrint dashboard', async t => {
  const { call } = await bridge(t);
  const ok = await call('/status', { origin: DASHBOARD });
  assert.equal(ok.status, 200);
  assert.equal(ok.cors, DASHBOARD);
  assert.equal(ok.body.linkedHere, true);
  assert.equal(ok.body.printers[0].name, 'HP LaserJet 1020');
  assert.equal((await call('/status', { origin: 'http://localhost:3000' })).status, 200, 'a dashboard served from this PC');
  const evil = await call('/status', { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.cors, null, 'the browser blocks other websites from reading the response');
  assert.equal((await call('/status')).status, 403, 'requests without an Origin get nothing');
  const preflight = await call('/pair', { origin: DASHBOARD, method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.pna, 'true', 'Chrome private-network preflight is answered');
});

test('connector link pairs only with the page server and asks before moving shops', async t => {
  const { call, paired } = await bridge(t);
  assert.equal((await call('/pair', { origin: 'https://evil.example', method: 'POST', body: { url: 'https://evil.example', token: KEY } })).status, 403);
  assert.equal((await call('/pair', { origin: DASHBOARD, method: 'POST', body: { url: 'https://other.example', token: KEY } })).status, 400, 'a page cannot point the connector at another server');
  assert.equal((await call('/pair', { origin: DASHBOARD, method: 'POST', body: { url: DASHBOARD, token: 'short' } })).status, 400);

  const moved = await call('/pair', { origin: 'http://localhost:3000', method: 'POST', body: { url: 'http://localhost:3000', token: KEY, printer: 'HP LaserJet 1020' } });
  assert.equal(moved.status, 409, 'a connector printing for another server is not moved silently');
  assert.equal(moved.body.server, DASHBOARD);
  assert.equal(paired.length, 0);

  const ok = await call('/pair', { origin: DASHBOARD, method: 'POST', body: { url: DASHBOARD, token: KEY, printer: 'HP LaserJet 1020' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(paired, [{ url: DASHBOARD, token: KEY, printer: 'HP LaserJet 1020' }]);
  assert.equal((await call('/pair', { origin: 'http://localhost:3000', method: 'POST', body: { url: 'http://localhost:3000', token: KEY, replace: true } })).status, 200, 'moving is allowed once the owner confirms');
});

test('a connector whose key was rejected accepts a new link from its dashboard', async t => {
  const { call } = await bridge(t, { linked: false, needsRelink: true });
  const status = await call('/status', { origin: DASHBOARD });
  assert.equal(status.body.needsRelink, true);
  assert.equal(status.body.linkedHere, false);
  assert.equal((await call('/pair', { origin: 'http://localhost:3000', method: 'POST', body: { url: 'http://localhost:3000', token: KEY } })).status, 200, 'an unlinked connector needs no confirmation');
});
