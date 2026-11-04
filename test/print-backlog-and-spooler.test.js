import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'smartprint-backlog-'));
const { openDatabase } = await import('../server/db.js');
const { createApp } = await import('../server/index.js');
const { digest } = await import('../server/security.js');
const { spoolerVerdict } = await import('../connector/sumatra-helper.js');

async function start(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', cookie, token } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }) });
  return { db, request, owner: login.headers.get('set-cookie')?.split(';')[0] };
}
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
async function queued(db, { minutesAgo, test = false }) {
  const id = randomUUID();
  const options = { color: 'bw', duplex: false, copies: 1, layout: 'single', ...(test ? { file_name: 'SmartPrint_Diagnostic_Test.pdf' } : {}) };
  await db.query("INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,'shop-demo',$2,'iv','tag',$3)", [id, Buffer.from('x'), new Date(Date.now() + 86400000).toISOString()]);
  await db.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,payment,status,created) VALUES ($1,'shop-demo',$2,$3,$4,1,1,1,$5,'cash','paid','queued',$6)", [id, id, digest(id), JSON.stringify(options), test ? 0 : 200, ago(minutesAgo)]);
  return id;
}

test('a printer coming back online does not print the backlog nonstop', async t => {
  const { db, request, owner } = await start(t);
  const oldTest = await queued(db, { minutesAgo: 40, test: true });
  const oldOrder = await queued(db, { minutesAgo: 30 });
  await db.query("INSERT INTO devices (id,shop_id,name,token,active,heartbeat) VALUES ('dev-1','shop-demo','HP LaserJet 1020',$1,1,$2)", [digest('key-1'), ago(60)]);

  // First check-in after an hour offline: old test page cancelled, printer paused, owner told.
  assert.equal((await request('/api/device/heartbeat', { method: 'POST', token: 'key-1' })).status, 200);
  const [testRow] = await db.query('SELECT status FROM orders WHERE id=$1', [oldTest]);
  assert.equal(testRow.status, 'cancelled');
  assert.equal((await request('/api/device/claim', { method: 'POST', token: 'key-1' })).body, null, 'nothing prints while held');
  const [device] = (await request('/api/owner/devices', { cookie: owner })).body;
  assert.equal(device.is_paused, 1);
  assert.match(device.status_note, /1 older job/);
  const [note] = await db.query("SELECT title FROM notifications WHERE event_type='print.backlog_held'");
  assert.match(note.title, /1 job waited while it was offline/);

  // The owner resumes: the waiting order prints.
  assert.equal((await request('/api/owner/devices/dev-1/pause', { method: 'POST', cookie: owner })).body.is_paused, 0);
  const job = await request('/api/device/claim', { method: 'POST', token: 'key-1' });
  assert.equal(job.body.id, oldOrder);
});

test('fresh jobs print normally when the printer checks in', async t => {
  const { db, request } = await start(t);
  const fresh = await queued(db, { minutesAgo: 1 });
  const freshTest = await queued(db, { minutesAgo: 1, test: true });
  await db.query("INSERT INTO devices (id,shop_id,name,token,active,heartbeat) VALUES ('dev-2','shop-demo','Brother',$1,1,NULL)", [digest('key-2')]);
  const first = await request('/api/device/claim', { method: 'POST', token: 'key-2' });
  assert.ok([fresh, freshTest].includes(first.body?.id), 'a recent job is not held');
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM notifications WHERE event_type='print.backlog_held'"))[0].n, 0);
});

test('a job the printer never starts is taken back out of the Windows queue', () => {
  const file = '6240c4f3-aaaa-bbbb-cccc-1234567890ab.pdf';
  const own = { Id: 7, DocumentName: `C:\\Users\\shop\\AppData\\Local\\SmartPrintConnector\\${file}`, JobStatus: '', PagesPrinted: 0 };
  assert.equal(spoolerVerdict([], file, { idleMs: 0, idleLimit: 90000 }).verdict, 'taken', 'left the queue: printed');
  assert.equal(spoolerVerdict([{ ...own, JobStatus: 'Printing' }], file, { idleMs: 0, idleLimit: 90000 }).verdict, 'taken');
  assert.equal(spoolerVerdict([own], file, { idleMs: 5000, idleLimit: 90000 }).verdict, 'wait');
  // Unplugged USB cable: Windows shows "Error, Printing" and nothing comes out.
  assert.equal(spoolerVerdict([{ ...own, JobStatus: 'Error, Printing' }], file, { idleMs: 95000, idleLimit: 90000 }).verdict, 'cancel');
  assert.equal(spoolerVerdict([own], file, { idleMs: 95000, idleLimit: 90000 }).verdict, 'cancel');
  // Another job is printing ahead of ours: the printer is working, keep waiting.
  const ahead = { Id: 6, DocumentName: 'Report.docx', JobStatus: 'Printing', PagesPrinted: 3 };
  assert.equal(spoolerVerdict([ahead, own], file, { idleMs: 95000, idleLimit: 90000 }).verdict, 'wait');
});
