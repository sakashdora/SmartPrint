import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { token, digest, decrypt, encrypt } from './security.js';
import { sendPdf } from './uploads.js';
import { price, validateOptions } from './print-options.js';
import { generateTestPage } from './diagnostic-page.js';

const runExec = promisify(execFile);
const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function queuePreparation(req, db, shop) {
  const files = req.body.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) throw fail(400, 'Choose one document or two images.');
  let options;
  try { options = validateOptions(req.body.options); } catch (error) { throw fail(400, error.message); }
  if (options.layout === 'card' ? files.length !== 2 : files.length !== 1) throw fail(400, 'Choose two images for ID card layout, or one document for other layouts.');
  const id = randomUUID(), secret = token(), ids = []; let total = 0;
  await db.transaction(async tx => {
    await tx.query('UPDATE shops SET version=version WHERE id=$1 RETURNING id', [shop.id]);
    const pending = await tx.query("SELECT files FROM preparations WHERE shop_id=$1 AND state IN ('queued','processing') AND expires>$2", [shop.id, now()]);
    if (pending.length >= 50) throw fail(429, 'This shop is preparing several files. Please try again shortly.');
    const [device] = await tx.query('SELECT id FROM devices WHERE shop_id=$1 AND active=1 AND heartbeat>$2 AND (color=1 OR $3=0) AND (duplex=1 OR $4=0)', [shop.id, new Date(Date.now() - 180000).toISOString(), options.color === 'color' ? 1 : 0, options.duplex ? 1 : 0]);
    if (!device) throw fail(503, 'No online shop printer supports these settings. Ask the shop to connect a compatible printer or choose different colour/sides settings.');
    for (const file of files) {
      const [upload] = await tx.query('SELECT * FROM uploads WHERE id=$1 AND token=$2 AND shop_id=$3 AND expires>$4', [file.uploadId, digest(file.token), shop.id, now()]);
      if (!upload) throw fail(400, 'Upload is missing or expired.');
      const [count] = await tx.query('SELECT COUNT(*) AS count FROM upload_chunks WHERE upload_id=$1', [upload.id]);
      if (Number(count.count) !== Math.ceil(upload.size / 1048576)) throw fail(409, 'Upload is incomplete.');
      total += upload.size; ids.push(upload.id);
    }
    if (total > 20 * 1048576 || new Set(ids).size !== ids.length) throw fail(400, 'Invalid file selection or files exceed 20 MiB.');
    if (pending.some(prep => JSON.parse(prep.files).some(id => ids.includes(id)))) throw fail(409, 'This upload is already being prepared.');
    await tx.query('INSERT INTO preparations (id,shop_id,token,files,options,expires,created) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, shop.id, digest(secret), JSON.stringify(ids), JSON.stringify(options), new Date(Date.now() + 15 * 60000).toISOString(), now()]);
  });
  return { pending: true, id, token: secret };
}

export const shopScannedPrinters = new Map();

export function formatPrinterList(rawList) {
  return rawList
    .filter(p => p && p.Name && !/OneNote|Fax|Microsoft XPS/i.test(p.Name))
    .map(p => {
      const port = String(p.PortName || '').trim();
      const driver = String(p.DriverName || '').trim();
      const name = String(p.Name || '').trim();

      let isWifi = false;
      let isWired = false;
      let connectionType = 'Local Spooler';

      // Check for WiFi / Wireless Network indicators
      if (
        /^WSD/i.test(port) ||
        /^TCP/i.test(port) ||
        /^IP_/i.test(port) ||
        /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(port) ||
        /ipp|wifi|wireless|network/i.test(driver) ||
        /wifi|wireless|network/i.test(name) ||
        Boolean(p.Network) ||
        p.Type === 1
      ) {
        connectionType = 'WiFi / Wireless Network';
        isWifi = true;
      } else if (
        /^USB/i.test(port) ||
        /^DOT4/i.test(port) ||
        /^LPT/i.test(port) ||
        /^COM/i.test(port) ||
        /usb/i.test(driver) ||
        /usb/i.test(name)
      ) {
        connectionType = 'Wired USB Cable';
        isWired = true;
      } else if (/PORTPROMPT|nul:|PDF/i.test(port) || /PDF/i.test(name)) {
        connectionType = 'Virtual / PDF';
      }

      const isColor = !/mono|black/i.test(driver || name);
      const isDuplex = /DCP-|MFC-|LaserJet|Duplex/i.test(driver || name);

      return {
        name,
        portName: port,
        driverName: driver,
        connectionType,
        isWifi,
        isWired,
        isDefault: Boolean(p.Default || p.IsDefault),
        status: (p.PrinterStatus === 0 || p.PrinterStatus === 3 || p.PrinterStatus === 'Normal' || !p.PrinterStatus) ? 'Ready' : 'Normal',
        color: isColor,
        duplex: isDuplex
      };
    });
}

export async function scanWindowsPrinters() {
  if (process.platform !== 'win32') return [];
  try {
    let defPrinter = '';
    try {
      const { stdout: defOut } = await runExec('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device'], { timeout: 3000, windowsHide: true });
      const defMatch = defOut.match(/Device\s+REG_SZ\s+([^,]+)/i);
      if (defMatch) defPrinter = defMatch[1].trim();
    } catch {}

    const { stdout } = await runExec('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices'], { timeout: 3000, windowsHide: true });
    if (!stdout || !stdout.trim()) return [];

    const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('HKEY_'));
    const rawList = [];

    for (const line of lines) {
      const parts = line.split(/\s{2,}REG_SZ\s{2,}/);
      if (!parts || !parts[0]) continue;
      const name = parts[0].trim();
      if (!name || /OneNote|Fax|Microsoft XPS/i.test(name)) continue;

      let port = '';
      try {
        const { stdout: portOut } = await runExec('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${name}`, '/v', 'Port'], { timeout: 1500, windowsHide: true });
        const portMatch = portOut.match(/Port\s+REG_SZ\s+(.*)/i);
        if (portMatch) port = portMatch[1].trim();
      } catch {}

      if (!port && parts[1]) {
        port = (parts[1].split(',')[1] || '').trim();
      }

      let driver = '';
      try {
        const { stdout: drvOut } = await runExec('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${name}`, '/v', 'Printer Driver'], { timeout: 1500, windowsHide: true });
        const drvMatch = drvOut.match(/Printer Driver\s+REG_SZ\s+(.*)/i);
        if (drvMatch) driver = drvMatch[1].trim();
      } catch {}

      rawList.push({
        Name: name,
        PortName: port,
        DriverName: driver || name,
        PrinterStatus: 'Ready',
        IsDefault: Boolean(defPrinter && (name.toLowerCase() === defPrinter.toLowerCase()))
      });
    }

    return formatPrinterList(rawList);
  } catch (err) {
    return [];
  }
}

export const deviceMetadata = new Map();

export function deviceRoutes(app, { db, key, ownerShop, requireRole, audit, maintenance }) {
  const owner = requireRole('owner');

  app.get('/api/owner/printers/scan', owner, async (req, res) => {
    const shop = await ownerShop(req);
    let localList = [];
    if (process.platform === 'win32') {
      localList = await scanWindowsPrinters();
    }
    const connectorList = shopScannedPrinters.get(shop.id) || [];
    const merged = new Map();
    for (const p of [...localList, ...connectorList]) {
      if (p && p.name && !merged.has(p.name)) {
        merged.set(p.name, p);
      }
    }
    res.json(Array.from(merged.values()));
  });

  app.post('/api/owner/printers/scanned-report', owner, async (req, res) => {
    const shop = await ownerShop(req);
    const list = Array.isArray(req.body.printers) ? req.body.printers : [];
    if (list.length) {
      const existing = shopScannedPrinters.get(shop.id) || [];
      const map = new Map();
      for (const p of [...existing, ...list]) {
        if (p && p.name) map.set(p.name, p);
      }
      shopScannedPrinters.set(shop.id, Array.from(map.values()));
    }
    res.json({ ok: true, count: list.length });
  });

  app.get('/api/local/printers', owner, async (req, res) => {
    let printers = [];
    if (process.platform === 'win32') {
      try { printers = await scanWindowsPrinters(); } catch {}
    }
    res.json({ ok: true, platform: process.platform, printers });
  });

  app.post('/api/owner/devices/heartbeat', owner, async (req, res) => {
    const shop = await ownerShop(req);
    await db.query('UPDATE devices SET heartbeat=$1, active=1 WHERE shop_id=$2 AND active=1', [now(), shop.id]);
    res.json({ ok: true, heartbeat: now() });
  });

  app.post('/api/owner/devices/:id/heartbeat', owner, async (req, res) => {
    const shop = await ownerShop(req);
    await db.query('UPDATE devices SET heartbeat=$1, active=1 WHERE id=$2 AND shop_id=$3', [now(), req.params.id, shop.id]);
    res.json({ ok: true, heartbeat: now() });
  });

  app.post('/api/owner/printers/autoconnect', owner, async (req, res) => {
    const shop = await ownerShop(req);
    const printerName = String(req.body.name || '').trim();
    if (!printerName) throw fail(400, 'Choose a printer.');

    let [device] = await db.query(
      'SELECT id, name, active FROM devices WHERE shop_id=$1 AND (LOWER(name) = LOWER($2) OR LOWER(name) LIKE LOWER($3) OR LOWER($2) LIKE LOWER(name)) ORDER BY active DESC LIMIT 1',
      [shop.id, printerName, `%${printerName}%`]
    );
    let secret = token();
    if (!device) {
      const id = randomUUID();
      await db.query('INSERT INTO devices (id,shop_id,name,token,color,duplex,active,heartbeat) VALUES ($1,$2,$3,$4,$5,$6,1,$7)', [
        id, shop.id, printerName, digest(secret), req.body.color !== false ? 1 : 0, req.body.duplex !== false ? 1 : 0, now()
      ]);
      device = { id, name: printerName, active: 1 };
    } else {
      await db.query('UPDATE devices SET name=$1, active=1, token=$2, heartbeat=$3 WHERE id=$4', [printerName, digest(secret), now(), device.id]);
      device.name = printerName;
      device.active = 1;
    }

    deviceMetadata.set(device.id, { is_paused: 0, status_note: 'Ready' });

    const connectorRoot = join(process.env.LOCALAPPDATA || '.', 'SmartPrintConnector');
    mkdirSync(connectorRoot, { recursive: true });
    const settingsPath = join(connectorRoot, 'settings.json');
    let existingSumatra = '';
    try {
      if (existsSync(settingsPath)) {
        const raw = readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '').trim();
        if (raw) existingSumatra = JSON.parse(raw).Sumatra || '';
      }
    } catch {}

    const serverUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    writeFileSync(settingsPath, JSON.stringify({
      Url: serverUrl,
      Token: secret,
      Printer: printerName,
      Sumatra: existingSumatra,
      LastUpdated: new Date().toISOString()
    }, null, 2), 'utf8');

    // Terminate any previous connector process to prevent token or device conflict
    const pidFile = join(connectorRoot, 'connector.pid');
    try {
      if (existsSync(pidFile)) {
        const oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
          try { process.kill(oldPid, 'SIGTERM'); } catch {}
          if (process.platform === 'win32') {
            try { spawn('taskkill', ['/F', '/PID', String(oldPid)], { windowsHide: true }); } catch {}
          }
        }
      }
    } catch {}

    try {
      const connectorScript = fileURLToPath(new URL('../connector/index.js', import.meta.url));
      const logPath = join(connectorRoot, 'connector.log');
      let outFd = 'ignore';
      try {
        const { openSync } = await import('node:fs');
        outFd = openSync(logPath, 'a');
      } catch {}
      const child = spawn(process.execPath, [connectorScript], {
        cwd: resolve(fileURLToPath(new URL('../', import.meta.url))),
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: {
          ...process.env,
          SMARTPRINT_URL: serverUrl,
          SMARTPRINT_DEVICE_TOKEN: secret,
          SMARTPRINT_PRINTER: printerName
        }
      });
      if (child.pid) {
        writeFileSync(pidFile, String(child.pid), 'utf8');
      }
      child.unref();
    } catch (err) {
      console.error('[Autoconnect] Could not spawn connector process:', err.message);
    }

    await audit(db, req.user.id, 'device.autoconnected', device.id);
    res.json({ ok: true, id: device.id, name: device.name, token: secret, message: `${printerName} connected successfully!` });
  });
  app.get('/api/owner/devices', owner, async (req, res) => {
    const shop = await ownerShop(req);
    const rows = await db.query('SELECT id,name,active,heartbeat,color,duplex FROM devices WHERE shop_id=$1 ORDER BY active DESC, name ASC', [shop.id]);
    res.json(rows.map(d => {
      const meta = deviceMetadata.get(d.id) || {};
      const isOnline = d.active && d.heartbeat && (Date.now() - new Date(d.heartbeat).getTime() < 180000);
      return {
        ...d,
        is_paused: meta.is_paused ?? 0,
        status_note: meta.status_note ?? (meta.is_paused ? 'Paused by owner' : isOnline ? 'Ready' : 'Offline')
      };
    }));
  });
  app.post('/api/owner/devices', owner, async (req, res) => {
    const shop = await ownerShop(req), name = String(req.body.name || '').trim();
    if (name.length < 2 || name.length > 100) throw fail(400, 'Enter a printer name.');
    const id = randomUUID(), secret = token();
    await db.query('INSERT INTO devices (id,shop_id,name,token,color,duplex) VALUES ($1,$2,$3,$4,$5,$6)', [id, shop.id, name, digest(secret), req.body.color === true ? 1 : 0, req.body.duplex === true ? 1 : 0]);
    deviceMetadata.set(id, { is_paused: 0, status_note: 'Ready' });
    await audit(db, req.user.id, 'device.paired', id);
    res.status(201).json({ id, token: secret });
  });
  app.post('/api/owner/devices/:id/pause', owner, async (req, res) => {
    const shop = await ownerShop(req);
    const [device] = await db.query('SELECT id FROM devices WHERE id=$1 AND shop_id=$2', [req.params.id, shop.id]);
    if (!device) throw fail(404, 'Device not found.');
    const current = deviceMetadata.get(device.id)?.is_paused ?? 0;
    const nextState = current ? 0 : 1;
    deviceMetadata.set(device.id, { is_paused: nextState, status_note: nextState ? 'Paused by owner' : 'Ready' });
    await audit(db, req.user.id, nextState ? 'device.paused' : 'device.resumed', device.id);
    res.json({ ok: true, is_paused: nextState });
  });
  app.post('/api/owner/devices/:id/test-print', owner, async (req, res) => {
    const shop = await ownerShop(req);
    const [device] = await db.query('SELECT * FROM devices WHERE id=$1 AND shop_id=$2 AND active=1', [req.params.id, shop.id]);
    if (!device) throw fail(404, 'Active device not found.');
    const testBytes = await generateTestPage(shop.name, device.name);
    const docId = randomUUID(), orderId = randomUUID(), receipt = token();
    const sealed = encrypt(testBytes, key);
    const options = { color: device.color ? 'color' : 'bw', duplex: false, copies: 1, layout: 'single', range: '', file_name: 'SmartPrint_Diagnostic_Test.pdf', priority: 100 };
    await db.transaction(async tx => {
      await tx.query('INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,$3,$4,$5,$6)', [docId, shop.id, sealed.payload, sealed.iv, sealed.tag, new Date(Date.now() + 86400000).toISOString()]);
      await tx.query("INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,payment,status,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paid','queued',$11)", [orderId, shop.id, docId, digest(receipt), JSON.stringify(options), 1, 1, 1, 0, 'cash', now()]);
      await audit(tx, req.user.id, 'device.test_printed', device.id);
    });
    res.json({ ok: true, orderId, message: 'Test page queued for printer!' });
  });

  app.post('/api/owner/orders/:id/priority', owner, async (req, res) => {
    const shop = await ownerShop(req);
    const [order] = await db.query('SELECT id, options FROM orders WHERE id=$1 AND shop_id=$2', [req.params.id, shop.id]);
    if (!order) throw fail(404, 'Order not found.');
    const opts = JSON.parse(order.options);
    opts.priority = 10;
    await db.query('UPDATE orders SET options=$1 WHERE id=$2', [JSON.stringify(opts), order.id]);
    await audit(db, req.user.id, 'order.prioritized', req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/owner/orders/:id/retry', owner, async (req, res) => {
    const shop = await ownerShop(req);
    await db.transaction(async tx => {
      const [order] = await tx.query("UPDATE orders SET status='queued' WHERE id=$1 AND shop_id=$2 AND status='failed' AND payment='paid' AND EXISTS (SELECT id FROM documents WHERE id=orders.document_id AND expires>$3) RETURNING id, options", [req.params.id, shop.id, now()]);
      if (!order) throw fail(409, 'Confirm the previous print is stopped before retrying a paid order with an unexpired file.');
      await tx.query('DELETE FROM print_leases WHERE order_id=$1', [order.id]);
      const opts = JSON.parse(order.options);
      opts.priority = 5;
      await tx.query("UPDATE orders SET status='queued', options=$1 WHERE id=$2", [JSON.stringify(opts), order.id]);
      await audit(tx, req.user.id, 'order.retried', order.id);
    });
    res.json({ ok: true });
  });
  app.delete('/api/owner/devices/:id', owner, async (req, res) => { const shop = await ownerShop(req); const changed = await db.query('UPDATE devices SET active=0 WHERE id=$1 AND shop_id=$2 RETURNING id', [req.params.id, shop.id]); if (!changed.length) throw fail(404, 'Device not found.'); await audit(db, req.user.id, 'device.revoked', req.params.id); res.json({ ok: true }); });
  app.get('/api/preparations/:id', async (req, res) => {
    const [prep] = await db.query('SELECT * FROM preparations WHERE id=$1 AND token=$2 AND expires>$3', [req.params.id, digest(req.headers.authorization?.replace(/^Bearer /, '') || ''), now()]);
    if (!prep) throw fail(404, 'Preview preparation expired. Try again.');
    if (prep.state === 'ready') {
      const [quote] = await db.query('SELECT id,options,pages,sides,sheets,amount,expires FROM quotes WHERE id=$1 AND used=0 AND expires>$2', [prep.id, now()]);
      if (!quote) throw fail(409, 'This preparation has expired or has already been ordered. Prepare a new quote.');
      return res.json({ ...quote, options: JSON.parse(quote.options), token: req.headers.authorization.replace(/^Bearer /, '') });
    }
    res.json({ pending: prep.state !== 'failed', state: prep.state, error: prep.error });
  });
  app.use('/api/device', async (req, res, next) => {
    const [device] = await db.query('SELECT * FROM devices WHERE token=$1 AND active=1', [digest(req.headers.authorization?.replace(/^Bearer /, '') || '')]);
    if (!device) throw fail(401, 'Device credential is invalid or revoked.'); req.device = device;
    await db.query('UPDATE devices SET heartbeat=$1 WHERE id=$2', [now(), device.id]); next();
  });
  app.post('/api/device/heartbeat', async (req, res) => {
    // Respond immediately so device heartbeats are fast (<5ms) and never timeout
    res.json({ ok: true });
    // Run cleanup asynchronously in background if overdue
    db.query("SELECT last_success FROM worker_status WHERE id='cleanup'").then(([worker]) => {
      if (!worker || Date.now() - Date.parse(worker.last_success) > 60000) {
        maintenance().catch(() => {});
      }
    }).catch(() => {});
  });
  app.post('/api/device/printers/scanned', async (req, res) => {
    const list = Array.isArray(req.body.printers) ? req.body.printers : [];
    if (list.length) {
      shopScannedPrinters.set(req.device.shop_id, list);
    }
    res.json({ ok: true, count: list.length });
  });
  app.post('/api/device/preparations/claim', async (req, res) => {
    const result = await db.transaction(async tx => {
      let [prep] = await tx.query("SELECT * FROM preparations WHERE shop_id=$1 AND device_id=$2 AND state='processing' AND expires>$3 ORDER BY created LIMIT 1", [req.device.shop_id, req.device.id, now()]);
      if (!prep) { const [next] = await tx.query("SELECT * FROM preparations WHERE shop_id=$1 AND state='queued' AND expires>$2 ORDER BY created LIMIT 1", [req.device.shop_id, now()]); if (!next) return null; [prep] = await tx.query("UPDATE preparations SET state='processing',device_id=$1 WHERE id=$2 AND state='queued' RETURNING *", [req.device.id, next.id]); }
      if (!prep) return null;
      const files = []; for (const id of JSON.parse(prep.files)) { const [file] = await tx.query('SELECT id,name,size FROM uploads WHERE id=$1', [id]); if (!file) throw fail(409, 'An input file expired.'); files.push(file); }
      return { id: prep.id, options: JSON.parse(prep.options), files };
    }); res.json(result);
  });
  const ownPrep = async req => { const [prep] = await db.query("SELECT * FROM preparations WHERE id=$1 AND device_id=$2 AND shop_id=$3 AND state='processing' AND expires>$4", [req.params.id, req.device.id, req.device.shop_id, now()]); if (!prep) throw fail(404, 'Preparation not assigned to this device.'); return prep; };
  app.get('/api/device/preparations/:id/files/:file/:part', async (req, res) => {
    const prep = await ownPrep(req); if (!JSON.parse(prep.files).includes(req.params.file)) throw fail(404, 'File not part of this preparation.');
    const [chunk] = await db.query('SELECT * FROM upload_chunks WHERE upload_id=$1 AND part=$2', [req.params.file, Number(req.params.part)]); if (!chunk) throw fail(404, 'Upload part unavailable.'); res.type('application/octet-stream').send(decrypt(chunk, key));
  });
  app.post('/api/device/preparations/:id/result', async (req, res) => {
    const prep = await ownPrep(req); const size = req.body.size;
    if (!Number.isInteger(size) || size < 1 || size > 40 * 1048576) throw fail(400, 'Prepared file is too large.');
    const id = `result-${prep.id}`;
    await db.query('INSERT INTO uploads (id,shop_id,token,name,size,expires) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING', [id, prep.shop_id, prep.token, 'prepared.pdf', size, prep.expires]); res.json({ id });
  });
  app.put('/api/device/preparations/:id/result/:part', async (req, res) => {
    const prep = await ownPrep(req); const [upload] = await db.query('SELECT * FROM uploads WHERE id=$1', [`result-${prep.id}`]);
    const part = Number(req.params.part), data = req.body.data;
    if (!upload || !Number.isInteger(part) || part < 0 || part >= Math.ceil(upload.size / 1048576) || typeof data !== 'string' || data.length > 1400000) throw fail(400, 'Invalid result chunk.');
    const bytes = Buffer.from(data, 'base64'); if (bytes.length !== Math.min(1048576, upload.size - part * 1048576)) throw fail(400, 'Invalid result size.');
    const sealed = encrypt(bytes, key); await db.query('INSERT INTO upload_chunks (upload_id,part,payload,iv,tag) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(upload_id,part) DO NOTHING', [upload.id, part, sealed.payload, sealed.iv, sealed.tag]); res.json({ ok: true });
  });
  app.post('/api/device/preparations/:id/complete', async (req, res) => {
    const pages = req.body.pages;
    if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw fail(400, 'Invalid source page count.');
    await db.transaction(async tx => {
      const [prep] = await tx.query("UPDATE preparations SET state='ready' WHERE id=$1 AND shop_id=$2 AND device_id=$3 AND state='processing' AND expires>$4 RETURNING *", [req.params.id, req.device.shop_id, req.device.id, now()]);
      if (!prep) throw fail(409, 'Preparation already completed or expired.');
      const [upload] = await tx.query('SELECT * FROM uploads WHERE id=$1', [`result-${prep.id}`]);
      const chunks = await tx.query('SELECT * FROM upload_chunks WHERE upload_id=$1 ORDER BY part', [`result-${prep.id}`]);
      if (!upload || chunks.length !== Math.ceil(upload.size / 1048576)) throw fail(409, 'Prepared document is incomplete.');
      const bytes = Buffer.concat(chunks.map(c => decrypt(c, key))); if (bytes.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'Prepared result must be a PDF.');
      const [shop] = await tx.query('SELECT * FROM shops WHERE id=$1', [prep.shop_id]), options = validateOptions(JSON.parse(prep.options));
      const quote = price(pages, options, shop), sealed = encrypt(bytes, key), documentId = randomUUID();
      await tx.query('INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,$3,$4,$5,$6)', [documentId, shop.id, sealed.payload, sealed.iv, sealed.tag, new Date(Date.now() + 86400000).toISOString()]);
      const expires = new Date(Date.now() + 15 * 60000).toISOString();
      await tx.query('UPDATE preparations SET expires=$1 WHERE id=$2', [expires, prep.id]);
      await tx.query('INSERT INTO quotes (id,shop_id,document_id,token,options,pages,sides,sheets,amount,version,expires) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [prep.id, shop.id, documentId, prep.token, prep.options, pages, quote.sides, quote.sheets, quote.amount, shop.version, expires]);
      await tx.query('DELETE FROM uploads WHERE id=$1', [upload.id]);
    }); res.json({ ok: true });
  });
  app.post('/api/device/preparations/:id/fail', async (req, res) => { const prep = await ownPrep(req); await db.transaction(async tx => { await tx.query("UPDATE preparations SET state='failed',error=$1 WHERE id=$2", [String(req.body.error || 'Unable to prepare this file. Export it as PDF and retry.').slice(0, 200), prep.id]); for (const id of [...JSON.parse(prep.files), `result-${prep.id}`]) await tx.query('DELETE FROM uploads WHERE id=$1', [id]); }); res.json({ ok: true }); });
  app.post('/api/device/claim', async (req, res) => {
    const leaseToken = token();
    const result = await db.transaction(async tx => {
      // Serialize claims from duplicated connector processes using the same credential.
      await tx.query('UPDATE devices SET heartbeat=$1 WHERE id=$2 RETURNING id', [now(), req.device.id]);
      if (deviceMetadata.get(req.device.id)?.is_paused) return null;
      const [existing] = await tx.query("SELECT order_id FROM print_leases WHERE device_id=$1 AND state IN ('claimed','submitted') AND expires>$2", [req.device.id, now()]); if (existing) return null;
      const candidates = await tx.query("SELECT o.* FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.shop_id=$1 AND o.status='queued' AND o.payment='paid' AND s.status='active' ORDER BY o.created ASC LIMIT 200", [req.device.shop_id]);
      candidates.sort((a, b) => {
        try {
          const pA = (typeof a.options === 'string' ? JSON.parse(a.options) : a.options).priority || 0;
          const pB = (typeof b.options === 'string' ? JSON.parse(b.options) : b.options).priority || 0;
          return (pB - pA) || (a.created.localeCompare(b.created));
        } catch {
          return a.created.localeCompare(b.created);
        }
      });
      const order = candidates.find(o => {
        try {
          const options = typeof o.options === 'string' ? JSON.parse(o.options) : o.options;
          const colorMatch = options.color !== 'color' || req.device.color || candidates.length === 1;
          const duplexMatch = !options.duplex || req.device.duplex || candidates.length === 1;
          return colorMatch && duplexMatch;
        } catch {
          return false;
        }
      });
      if (!order) return null;
      const changed = await tx.query("UPDATE orders SET status='printing' WHERE id=$1 AND status='queued' AND EXISTS (SELECT id FROM documents WHERE id=orders.document_id AND expires>$2) RETURNING id", [order.id, now()]); if (!changed.length) return null;
      await tx.query("INSERT INTO print_leases (order_id,device_id,token,expires) VALUES ($1,$2,$3,$4)", [order.id, req.device.id, digest(leaseToken), new Date(Date.now() + 180000).toISOString()]);
      return { id: order.id, token: leaseToken, options: JSON.parse(order.options) };
    }); res.json(result);
  });
  const ownLease = async req => { const [row] = await db.query('SELECT o.*,l.state AS lease_state FROM print_leases l JOIN orders o ON o.id=l.order_id WHERE l.order_id=$1 AND l.device_id=$2 AND l.token=$3 AND l.expires>$4', [req.params.id, req.device.id, digest(req.headers['x-lease-token'] || ''), now()]); if (!row) throw fail(404, 'Print lease expired or does not belong to this device.'); return row; };
  app.get('/api/device/jobs/:id/document', async (req, res) => { const order = await ownLease(req); if (order.lease_state !== 'claimed') throw fail(409, 'Document already submitted.'); const [doc] = await db.query('SELECT * FROM documents WHERE id=$1 AND expires>$2', [order.document_id, now()]); if (!doc) throw fail(404, 'Document expired.'); sendPdf(req, res, decrypt(doc, key)); });
  app.post('/api/device/jobs/:id/events', async (req, res) => {
    const order = await ownLease(req), event = req.body.event;
    if (!['submitted', 'awaiting_confirmation', 'failed'].includes(event)) throw fail(400, 'Unknown print event.');
    if (event === 'submitted' && order.lease_state !== 'claimed') throw fail(409, 'Job was already submitted. Do not reprint.');
    if (event === 'awaiting_confirmation' && order.lease_state !== 'submitted') throw fail(409, 'Job has not been submitted.');
    await db.transaction(async tx => {
      const targetStatus = event === 'failed' ? 'needs_review' : event === 'submitted' ? 'printing' : event;
      const current = await tx.query("UPDATE orders SET status=$1 WHERE id=$2 AND status='printing' AND payment='paid' RETURNING id", [targetStatus, order.id]);
      if (!current.length) throw fail(409, 'This print has already been resolved.');
      const changed = await tx.query('UPDATE print_leases SET state=$1,expires=$2 WHERE order_id=$3 AND state=$4 RETURNING order_id', [event, new Date(Date.now() + 600000).toISOString(), order.id, order.lease_state]);
      if (!changed.length) throw fail(409, 'Print state changed. Do not resubmit.');
      try {
        await tx.query('SAVEPOINT dev_hist_sp');
        await tx.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), order.id, order.status, targetStatus, req.device.id, `device.${event}`, event, now()]);
        await tx.query('RELEASE SAVEPOINT dev_hist_sp');
      } catch (histErr) {
        await tx.query('ROLLBACK TO SAVEPOINT dev_hist_sp').catch(() => {});
        console.warn('[SmartPrint Devices] Non-critical order_history audit insert failed:', histErr.message);
      }
      await audit(tx, req.device.id, `device.${event}`, order.id);
    }); res.json({ ok: true });
  });
  app.post('/api/owner/orders/:id/resolve-failed', owner, async (req, res) => {
    if (req.body.confirmed !== true) throw fail(400, 'Check the physical output and stop any remaining Windows print queue job first.');
    const shop = await ownerShop(req);
    await db.transaction(async tx => {
      const changed = await tx.query("UPDATE orders SET status='failed' WHERE id=$1 AND shop_id=$2 AND status IN ('needs_review','awaiting_confirmation','printing') RETURNING id, status", [req.params.id, shop.id]);
      if (!changed.length) throw fail(409, 'This order does not need print review.');
      await tx.query('DELETE FROM print_leases WHERE order_id=$1', [req.params.id]);
      try {
        await tx.query('SAVEPOINT resolve_hist_sp');
        await tx.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), req.params.id, changed[0].status, 'failed', req.user.id, 'print.stopped_by_owner', 'manual_stop', now()]);
        await tx.query('RELEASE SAVEPOINT resolve_hist_sp');
      } catch (histErr) {
        await tx.query('ROLLBACK TO SAVEPOINT resolve_hist_sp').catch(() => {});
        console.warn('[SmartPrint Devices] Non-critical order_history audit insert failed in resolve-failed:', histErr.message);
      }
      await audit(tx, req.user.id, 'print.stopped_by_owner', req.params.id);
    }); res.json({ ok: true });
  });
  app.post('/api/owner/orders/:id/cancel', owner, async (req, res) => {
    const shop = await ownerShop(req);
    await db.transaction(async tx => {
      const [order] = await tx.query("UPDATE orders SET status='cancelled',deleted_at=$1 WHERE id=$2 AND shop_id=$3 AND status IN ('awaiting_payment','queued','failed','expired','payment_review') RETURNING *", [now(), req.params.id, shop.id]);
      if (!order) throw fail(409, 'This order cannot be cancelled while a print may be running.');
      await tx.query('DELETE FROM documents WHERE id=$1', [order.document_id]);
      await tx.query('DELETE FROM print_leases WHERE order_id=$1', [order.id]);
      try {
        await tx.query('SAVEPOINT cancel_hist_sp');
        await tx.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), order.id, order.status, 'cancelled', req.user.id, 'order.cancelled', 'manual', now()]);
        await tx.query('RELEASE SAVEPOINT cancel_hist_sp');
      } catch (histErr) {
        await tx.query('ROLLBACK TO SAVEPOINT cancel_hist_sp').catch(() => {});
        console.warn('[SmartPrint Devices] Non-critical order_history audit insert failed in cancel:', histErr.message);
      }
      await audit(tx, req.user.id, 'order.cancelled', order.id);
    }); res.json({ ok: true });
  });
}
export async function sweepLeases(db) {
  await db.transaction(async tx => {
    const leases = await tx.query("SELECT * FROM print_leases WHERE expires<$1 AND state IN ('claimed','submitted')", [now()]);
    for (const lease of leases) { const changed = await tx.query("UPDATE print_leases SET state='uncertain' WHERE order_id=$1 AND state=$2 RETURNING order_id", [lease.order_id, lease.state]); if (changed.length) await tx.query("UPDATE orders SET status='needs_review' WHERE id=$1 AND status='printing'", [lease.order_id]); }
  });
}
