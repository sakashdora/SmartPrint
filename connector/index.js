import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureSumatraPDF, printPdfToWindowsPrinter } from './sumatra-helper.js';

const run = promisify(execFile);
const root = resolve(process.env.LOCALAPPDATA || '.', 'SmartPrintConnector');
await mkdir(root, { recursive: true });

const logFile = join(root, 'connector.log');
export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(logFile, line + '\n', 'utf8'); } catch {}
}

process.on('uncaughtException', err => {
  log(`[UncaughtException] ${err.stack || err.message}`);
});
process.on('unhandledRejection', reason => {
  log(`[UnhandledRejection] ${reason?.stack || reason?.message || reason}`);
});

// Load .env file if present in working directory or repo root
for (const envDir of [process.cwd(), resolve(process.cwd(), '..'), root]) {
  const envCandidate = join(envDir, '.env');
  if (existsSync(envCandidate)) {
    try {
      const content = readFileSync(envCandidate, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = (match[2] || '').trim().replace(/^['"](.*)['"]$/, '$1');
        }
      }
    } catch {}
    break;
  }
}

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

// Auto-detect printer if not specified or if configured printer doesn't exist
async function checkPrinterExists(name) {
  if (process.platform !== 'win32' || !name) return false;
  try {
    const { stdout } = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${name}`], { timeout: 1500, windowsHide: true });
    if (stdout) return true;
  } catch {}
  try {
    const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices', '/v', name], { timeout: 1500, windowsHide: true });
    if (stdout) return true;
  } catch {}
  return false;
}

if (!printer || !(await checkPrinterExists(printer))) {
  try {
    const { stdout: defOut } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', '/v', 'Device'], { timeout: 3000, windowsHide: true });
    const defMatch = defOut.match(/Device\s+REG_SZ\s+([^,]+)/i);
    if (defMatch && (await checkPrinterExists(defMatch[1].trim()))) {
      printer = defMatch[1].trim();
    }
  } catch {}
}

if (!printer || !(await checkPrinterExists(printer))) {
  // Find any available printer
  try {
    const { stdout: devList } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices'], { timeout: 3000, windowsHide: true });
    const candidates = devList.split(/\r?\n/).map(l => l.trim().split(/\s{2,}REG_SZ\s{2,}/)[0]).filter(n => n && !/OneNote|Fax|Microsoft XPS/i.test(n));
    if (candidates.length) printer = candidates[0];
  } catch {}
}

if (!printer) {
  console.error('\n[Error] No Windows printer detected. Please connect or install a printer first.\n');
  cleanupPid();
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

log('============================================================');
log('       SmartPrint Windows Shop Connector · v2.0            ');
log('============================================================');
log(`  Server URL  : ${base}`);
log(`  Printer     : ${printer}`);
log(`  Connection  : ${connectionType}`);
log(`  Print Engine: ${sumatra ? 'SumatraPDF Portable (' + sumatra + ')' : 'Native Windows Print Spooler'}`);
log(`  Status      : ONLINE · Listening for shop print jobs...`);
log('============================================================');

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
      log(`[Auth] 401 Unauthorized for ${path}. Reloading settings.json...`);
      const refreshed = loadConfig();
      if (refreshed.Token && refreshed.Token !== secret) {
        secret = refreshed.Token;
        if (refreshed.Printer) printer = refreshed.Printer;
        log('[Connector] Detected new token in settings.json. Reconnected.');
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

  // Check if a previous journal exists for this job
  let previousJournal = null;
  try {
    const raw = await readFile(journal, 'utf8');
    previousJournal = JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // If this job was recently submitted in the exact same attempt, wait for physical confirmation
  if (previousJournal && (!job.attempt || job.attempt <= (previousJournal.attempt || 1))) {
    const ageMs = Date.now() - new Date(previousJournal.submitted || 0).getTime();
    if (ageMs < 180000) {
      log(`[Queue] Job #${job.id.slice(0, 8).toUpperCase()} was recently submitted (${Math.round(ageMs/1000)}s ago). Waiting for owner confirmation.`);
      return;
    }
  }

  // If this is a retry or stale submission, clean up previous journal so printing can proceed
  if (previousJournal) {
    log(`[Queue] Re-processing job #${job.id.slice(0, 8).toUpperCase()} (Attempt ${job.attempt || 2}). Re-dispatching to printer.`);
    await unlink(journal).catch(() => {});
  }

  try {
    log(`\n>>> [Incoming Job] #${job.id.slice(0, 8).toUpperCase()} (Attempt ${job.attempt || 1})`);
    log(`    Options: ${job.options.color === 'color' ? 'Full Colour' : 'Black & White'}, ${job.options.copies || 1} copies, ${job.options.duplex ? 'Double-sided' : 'Single-sided'}`);

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
    if (bytes.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('Downloaded document is not a valid PDF file.');
    }
    await writeFile(path, bytes, { mode: 0o600 });

    // Durable journal entry before submission
    await writeFile(journal, JSON.stringify({
      id: job.id,
      attempt: job.attempt || 1,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      submitted: new Date().toISOString()
    }), { flag: 'w', mode: 0o600 });

    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'submitted' } });

    log(`    Sending to physical printer: "${printer}"...`);
    const printResult = await printPdfToWindowsPrinter({ pdfPath: path, printerName: printer, options: job.options, sumatraPath: sumatra });

    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'awaiting_confirmation' } });
    log(`✓ [Print Queued] Job #${job.id.slice(0, 8).toUpperCase()} sent to printer (${printResult.method}). Confirm physical output in SmartPrint.\n`);
  } catch (err) {
    log(`! [Print Error] Failed to submit job #${job.id}: ${err.message}`);
    // Clean up journal on failure so retry will never be blocked
    await unlink(journal).catch(() => {});
    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'failed', error: err.message } }).catch(() => {});
  } finally {
    await unlink(path).catch(() => {});
  }
}

let running = true;
process.on('SIGINT', () => { running = false; cleanupPid(); console.log('\nStopping connector...'); });
process.on('SIGTERM', () => { running = false; cleanupPid(); console.log('\nStopping connector...'); });
process.on('exit', cleanupPid);

// Send device heartbeat every 10 seconds to ensure the printer never drops offline
const heartbeat = setInterval(() => {
  request('/api/device/heartbeat', { method: 'POST' })
    .catch(err => {
      if (err.status !== 401) {
        log(`[Heartbeat] Warning: Device heartbeat failed: ${err.message}`);
      }
    });
}, 10000);

await scanAndReportLocalPrinters();
const printerScanner = setInterval(() => scanAndReportLocalPrinters(), 60000);

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
    } catch (prepErr) {
      log(`[Preview] Preparation loop notice: ${prepErr.message}`);
    }
    if (running) await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
const preparing = preparationLoop();
let claimRetryDelay = 1000;
let lastClaimErrorLog = 0;
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
    // Exponential retry backoff on network failure with periodic log
    if (Date.now() - lastClaimErrorLog > 30000) {
      log(`[Queue] Claim check notice (${err.status || err.message}). Will retry...`);
      lastClaimErrorLog = Date.now();
    }
    claimRetryDelay = Math.min(10000, claimRetryDelay * 1.5);
  }

  if (running) await new Promise(resolve => setTimeout(resolve, claimRetryDelay));
}

await preparing;
clearInterval(heartbeat);
clearInterval(printerScanner);
