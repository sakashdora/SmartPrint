import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never let this file touch the real connector folder of the PC running the tests.
const sandbox = mkdtempSync(join(tmpdir(), 'smartprint-isolation-'));
process.env.LOCALAPPDATA = sandbox;

const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { isLocalRequest, formatPrinterList } = await import('../server/devices.js');
const { digest } = await import('../server/security.js');
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

test('adding a printer never shows it online before its own connector checks in', async t => {
  const { request, owner } = await start(t);
  const added = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name: 'HP Printer' } });
  assert.equal(added.status, 200);
  assert.equal(added.body.launched, false, 'a remote owner never starts a connector on the server PC');
  assert.ok(added.body.setup?.token, 'a remote owner receives the one-time connector key');
  assert.match(added.body.setup.command, /SMARTPRINT_DEVICE_TOKEN=/);
  assert.ok(!existsSync(join(sandbox, 'SmartPrintConnector', 'settings.json')), 'no connector settings are written for a remote owner');

  let [device] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.equal(device.heartbeat, null);
  assert.match(device.status_note, /Offline/);

  // The real connector brings it online.
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: added.body.setup.token })).status, 200);
  [device] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.ok(device.heartbeat);
  assert.equal(device.status_note, 'Ready');

  // Reconnecting an online printer keeps its key, so the running connector is not cut off.
  const again = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, body: { name: 'HP Printer' } });
  assert.equal(again.body.token, null);
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: added.body.setup.token })).status, 200);
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

test("the server PC's connector is never taken over by another shop", { skip: process.platform !== 'win32' && 'local connector launch is Windows-only' }, async t => {
  const { db, request, owner } = await start(t);
  await db.query("INSERT INTO users (id,email,password,role) VALUES ('owner-other','other@shop.test','x','owner')");
  await db.query("INSERT INTO shops (id,owner_id,slug,name,location,status) VALUES ('shop-other','owner-other','other-shop','Other Shop','Elsewhere','active')");
  await db.query("INSERT INTO devices (id,shop_id,name,token,active) VALUES ('dev-other','shop-other','Brother DCP-T820DW Printer',$1,1)", [digest('other-shop-key')]);
  const root = join(sandbox, 'SmartPrintConnector');
  mkdirSync(root, { recursive: true });
  const settings = JSON.stringify({ Url: 'https://example.test', Token: 'other-shop-key', Printer: 'Brother DCP-T820DW Printer' });
  writeFileSync(join(root, 'settings.json'), settings);

  const taken = await request('/api/owner/printers/autoconnect', { method: 'POST', cookie: owner, local: true, body: { name: 'Brother DCP-T820DW Printer', color: true, duplex: true } });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /another shop/);
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), settings, 'the other shop’s connector settings are untouched');
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
