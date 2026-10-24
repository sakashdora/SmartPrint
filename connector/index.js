import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureSumatraPDF, printPdfToWindowsPrinter } from './sumatra-helper.js';

const run = promisify(execFile);
const root = resolve(process.env.LOCALAPPDATA || '.', 'SmartPrintConnector');
await mkdir(root, { recursive: true });

// Load persisted settings with BOM stripping
const settingsPath = join(root, 'settings.json');
export function loadConfig() {
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '').trim();
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn('[Warning] Could not parse settings.json:', err.message);
    }
  }
  return {};
}

let savedConfig = loadConfig();
const base = (process.env.SMARTPRINT_URL || savedConfig.Url || 'http://localhost:3000').replace(/\/+$/, '');
let secret = process.env.SMARTPRINT_DEVICE_TOKEN || savedConfig.Token;
let printer = process.env.SMARTPRINT_PRINTER || savedConfig.Printer;
const processorSecret = process.env.PROCESSOR_SECRET || savedConfig.ProcessorSecret;

// Record process PID for single-instance connector management
const pidPath = join(root, 'connector.pid');
try {
  await writeFile(pidPath, String(process.pid), 'utf8');
} catch {}
const cleanupPid = () => { try { unlink(pidPath).catch(() => {}); } catch {} };

if (!secret) {
  console.error('\n[Error] Missing device token. Please provide SMARTPRINT_DEVICE_TOKEN in .env or pair directly in dashboard.\n');
  cleanupPid();
  process.exit(1);
}

// Auto-detect printer if not specified
if (!printer) {
  try {
    const { stdout: defOut } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device'], { timeout: 3000, windowsHide: true });
    const defMatch = defOut.match(/Device\s+REG_SZ\s+([^,]+)/i);
    if (defMatch) printer = defMatch[1].trim();
  } catch {}
}
if (!printer) {
  console.error('\n[Error] No Windows printer detected. Please connect or install a printer first.\n');
  process.exit(1);
}

// Ensure SumatraPDF is ready or fallback to native
let sumatra = process.env.SUMATRA_PATH || savedConfig.Sumatra;
if (!sumatra || !existsSync(sumatra)) {
  sumatra = await ensureSumatraPDF();
}

let connectionType = 'Wired / Local';
try {
  const { stdout: portOut } = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${printer}`, '/v', 'Port'], { timeout: 1500, windowsHide: true });
  const portMatch = portOut.match(/Port\s+REG_SZ\s+(.*)/i);
  const printerPort = portMatch ? portMatch[1].trim() : '';
  if (/^WSD|^TCP|^IP_/i.test(printerPort) || /\d+\.\d+\.\d+\.\d+/.test(printerPort)) {
    connectionType = `📶 WiFi / Wireless Network (Port: ${printerPort})`;
  } else if (/^USB|^DOT4/i.test(printerPort)) {
    connectionType = `🔌 Wired USB Cable (Port: ${printerPort})`;
  } else if (printerPort) {
    connectionType = `Port: ${printerPort}`;
  }
} catch {}

async function scanAndReportLocalPrinters() {
  if (process.platform !== 'win32') return;
  try {
    let defPrinter = '';
    try {
      const { stdout: defOut } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device'], { timeout: 3000, windowsHide: true });
      const defMatch = defOut.match(/Device\s+REG_SZ\s+([^,]+)/i);
      if (defMatch) defPrinter = defMatch[1].trim();
    } catch {}

    const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices'], { timeout: 3000, windowsHide: true });
    if (!stdout || !stdout.trim()) return;

    const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('HKEY_'));
    const printers = [];

    for (const line of lines) {
      const parts = line.split(/\s{2,}REG_SZ\s{2,}/);
      if (!parts || !parts[0]) continue;
      const name = parts[0].trim();
      if (!name || /OneNote|Fax|Microsoft XPS/i.test(name)) continue;

      let port = '';
      try {
        const { stdout: portOut } = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${name}`, '/v', 'Port'], { timeout: 1500, windowsHide: true });
        const portMatch = portOut.match(/Port\s+REG_SZ\s+(.*)/i);
        if (portMatch) port = portMatch[1].trim();
      } catch {}

      if (!port && parts[1]) {
        port = (parts[1].split(',')[1] || '').trim();
      }

      let isWifi = false, isWired = false, connType = 'Local Spooler';
      if (/^WSD|^TCP|^IP_/i.test(port) || /\b\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(port) || /wifi|wireless|network/i.test(name)) {
        connType = 'WiFi / Wireless Network';
        isWifi = true;
      } else if (/^USB|^DOT4|^LPT|^COM/i.test(port) || /usb/i.test(name)) {
        connType = 'Wired USB Cable';
        isWired = true;
      } else if (/PORTPROMPT|nul:|PDF/i.test(port) || /PDF/i.test(name)) {
        connType = 'Virtual / PDF';
      }

      printers.push({
        name,
        portName: port,
        driverName: name,
        connectionType: connType,
        isWifi,
        isWired,
        isDefault: Boolean(defPrinter && (name.toLowerCase() === defPrinter.toLowerCase())),
        status: 'Ready',
        color: !/mono|black/i.test(name),
        duplex: /DCP-|MFC-|LaserJet|Duplex/i.test(name)
      });
    }

    if (printers.length) {
      await request('/api/device/printers/scanned', { method: 'POST', body: { printers } }).catch(() => {});
    }
  } catch {}
}

console.log('============================================================');
console.log('       SmartPrint Windows Shop Connector · v2.0            ');
console.log('============================================================');
console.log(`  Server URL  : ${base}`);
console.log(`  Printer     : ${printer}`);
console.log(`  Connection  : ${connectionType}`);
console.log(`  Print Engine: ${sumatra ? 'SumatraPDF Portable (' + sumatra + ')' : 'Native Windows Print Spooler'}`);
console.log(`  Status      : ONLINE · Listening for shop print jobs...`);
console.log('============================================================\n');

// Clean up stale files older than 10 minutes
for (const name of await readdir(root)) {
  if (!/^[a-f0-9-]{36}\.pdf$/.test(name)) continue;
  const path = join(root, name);
  try {
    const info = await stat(path);
    if (info.isFile() && Date.now() - info.mtimeMs > 600000) await unlink(path);
  } catch {}
}

async function request(path, { method = 'GET', body, lease, binary, range } = {}) {
  const url = new URL(path, base);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(lease ? { 'X-Lease-Token': lease } : {}),
      ...(range ? { Range: range } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    if (response.status === 401) {
      // Re-read settings.json in case shop regenerated token or autoconnect updated it
      const refreshed = loadConfig();
      if (refreshed.Token && refreshed.Token !== secret) {
        secret = refreshed.Token;
        if (refreshed.Printer) printer = refreshed.Printer;
        console.log('[Connector] Detected new token in settings.json. Reconnecting...');
      }
    }
    const err = new Error(`SmartPrint request failed (${response.status} on ${path}).`);
    err.status = response.status;
    throw err;
  }
  return binary ? { bytes: Buffer.from(await response.arrayBuffer()), range: response.headers.get('Content-Range') } : response.json();
}

async function prepareJob(job) {
  if (!processorSecret) {
    console.log(`[Preview] Skipping local processor for job ${job.id} (processor secret not configured).`);
    return;
  }
  const files = [];
  for (const file of job.files) {
    const chunks = [];
    for (let part = 0; part < Math.ceil(file.size / 1048576); part++) {
      chunks.push((await request(`/api/device/preparations/${job.id}/files/${file.id}/${part}`, { binary: true })).bytes);
    }
    files.push({ data: Buffer.concat(chunks).toString('base64'), name: file.name });
  }

  const response = await fetch('http://127.0.0.1:4000/prepare', {
    method: 'POST',
    headers: { Authorization: `Bearer ${processorSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, options: job.options }),
    signal: AbortSignal.timeout(125000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Scanner or converter failed.');
  const bytes = Buffer.from(result.data, 'base64');
  await request(`/api/device/preparations/${job.id}/result`, { method: 'POST', body: { size: bytes.length } });
  for (let start = 0, part = 0; start < bytes.length; start += 1048576, part++) {
    await request(`/api/device/preparations/${job.id}/result/${part}`, { method: 'PUT', body: { data: bytes.subarray(start, start + 1048576).toString('base64') } });
  }
  await request(`/api/device/preparations/${job.id}/complete`, { method: 'POST', body: { pages: result.pages } });
  console.log(`[Preview] Preparation complete for job ${job.id}`);
}

async function printJob(job) {
  if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('Invalid job identifier.');
  const path = join(root, `${job.id}.pdf`), journal = join(root, `${job.id}.submitted`);

  try {
    await readFile(journal);
    console.warn(`[Queue] Job ${job.id} was already submitted. Waiting for owner confirmation.`);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    console.log(`\n>>> [Incoming Job] #${job.id.slice(0, 8).toUpperCase()}`);
    console.log(`    Options: ${job.options.color === 'color' ? 'Full Colour' : 'Black & White'}, ${job.options.copies || 1} copies, ${job.options.duplex ? 'Double-sided' : 'Single-sided'}`);

    const chunks = [];
    let start = 0, total;
    do {
      const result = await request(`/api/device/jobs/${job.id}/document`, { binary: true, lease: job.token, range: `bytes=${start}-${start + 1048575}` });
      chunks.push(result.bytes);
      total = Number(result.range?.split('/')[1] || result.bytes.length);
      start += result.bytes.length;
      if (total > 40 * 1048576 || !result.bytes.length) throw new Error('Invalid print file size.');
    } while (start < total);

    const bytes = Buffer.concat(chunks);
    await writeFile(path, bytes, { mode: 0o600 });

    // Durable journal entry before submission
    await writeFile(journal, JSON.stringify({ id: job.id, sha256: createHash('sha256').update(bytes).digest('hex'), submitted: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'submitted' } });

    console.log(`    Sending to physical printer: "${printer}"...`);
    await printPdfToWindowsPrinter({ pdfPath: path, printerName: printer, options: job.options, sumatraPath: sumatra });

    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'awaiting_confirmation' } });
    console.log(`✓ [Print Queued] Job #${job.id.slice(0, 8).toUpperCase()} sent to printer. Confirm physical output in SmartPrint.\n`);
  } catch (err) {
    console.error(`! [Print Error] Failed to submit job #${job.id}: ${err.message}`);
    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'failed' } }).catch(() => {});
  } finally {
    await unlink(path).catch(() => {});
  }
}

let running = true;
process.on('SIGINT', () => { running = false; cleanupPid(); console.log('\nStopping connector...'); });
process.on('SIGTERM', () => { running = false; cleanupPid(); console.log('\nStopping connector...'); });
process.on('exit', cleanupPid);

const heartbeat = setInterval(() => request('/api/device/heartbeat', { method: 'POST' }).catch(() => {}), 30000);
heartbeat.unref();

await scanAndReportLocalPrinters();
const printerScanner = setInterval(() => scanAndReportLocalPrinters(), 60000);
printerScanner.unref();

// Conversion can take minutes. Keep it out of the paid-print dispatch loop.
async function preparationLoop() {
  while (running && processorSecret) {
    try {
      const preparation = await request('/api/device/preparations/claim', { method: 'POST' });
      if (preparation) {
        try { await prepareJob(preparation); }
        catch {
          await request(`/api/device/preparations/${preparation.id}/fail`, {
            method: 'POST', body: { error: 'The shop computer could not convert this file. Please export it as PDF and retry.' }
          }).catch(() => {});
        }
        continue;
      }
    } catch {}
    if (running) await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
const preparing = preparationLoop();
let claimRetryDelay = 1000;
while (running) {
  try {
    // Claim print jobs
    const print = await request('/api/device/claim', { method: 'POST' });
    claimRetryDelay = 1000;
    if (print) {
      await printJob(print);
      continue;
    }
  } catch (err) {
    // Exponential retry backoff on network failure
    claimRetryDelay = Math.min(10000, claimRetryDelay * 1.5);
  }

  if (running) await new Promise(resolve => setTimeout(resolve, claimRetryDelay));
}

await preparing;
clearInterval(heartbeat);
