import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ensureSumatraPDF, printPdfToWindowsPrinter, getWindowsPrinters, pickPrinter, checkPrinterStatus, clearStaleConnectorJobs, setWindowsDefaultPrinter } from './sumatra-helper.js';
import { probePrinterCapabilities, classifyConnection, guessCapabilities, extractManufacturerModel } from '../server/printer-capabilities.js';
import { startBridge, BRIDGE_PORT } from './local-bridge.js';

const CONNECTOR_VERSION = '2.1.0';
const machineName = process.env.COMPUTERNAME || hostname() || 'Windows-PC';

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
let connectorId = savedConfig.ConnectorId || randomUUID();
if (!savedConfig.ConnectorId) {
  try {
    await writeFile(settingsPath, JSON.stringify({ ...savedConfig, ConnectorId: connectorId }, null, 2), 'utf8');
    savedConfig = loadConfig();
  } catch {}
}
let base = (process.env.SMARTPRINT_URL || savedConfig.Url || 'http://localhost:3000').replace(/\/+$/, '');
let secret = process.env.SMARTPRINT_DEVICE_TOKEN || savedConfig.Token;
let printer = process.env.SMARTPRINT_PRINTER || savedConfig.Printer;
const processorSecret = process.env.PROCESSOR_SECRET || savedConfig.ProcessorSecret;

// Multi-printer bindings: each connected Windows printer has its own device token so multiple
// printers on this PC operate independently without overwriting each other's credentials.
function loadBindings(cfg) {
  const list = Array.isArray(cfg.Bindings) ? cfg.Bindings.filter(b => b && b.token && b.printer) : [];
  if (!list.length && secret) {
    list.push({ url: base, token: secret, printer: printer || '', authFailed: false, lastError: null });
  }
  return list.map(b => ({ url: (b.url || base).replace(/\/+$/, ''), token: b.token, printer: b.printer, authFailed: false, lastError: null }));
}
let bindings = loadBindings(savedConfig);
async function saveBindings() {
  const primary = bindings[0] || {};
  const cfg = loadConfig();
  await writeFile(settingsPath, JSON.stringify({
    ...cfg,
    ConnectorId: connectorId,
    Url: primary.url || base,
    Token: primary.token || '',
    Printer: primary.printer || '',
    Bindings: bindings.map(b => ({ url: b.url, token: b.token, printer: b.printer })),
    LastUpdated: new Date().toISOString()
  }, null, 2), 'utf8');
  secret = primary.token || '';
  printer = primary.printer || '';
  if (primary.url) base = primary.url;
}

// Record process PID for single-instance connector management
const pidPath = join(root, 'connector.pid');
try {
  await writeFile(pidPath, String(process.pid), 'utf8');
} catch {}
const cleanupPid = () => { try { unlink(pidPath).catch(() => {}); } catch {} };

// Without a key the connector waits to be linked from the Printers page opened on this PC.
let authFailed = false;
if (!secret) log('[Connector] Not linked yet. Open SmartPrint > Printers on this PC and click Connect.');

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

// A shop PC set up from the dashboard's one-time key starts with environment variables only. Save them
// on first run so a restart or the Windows startup task reconnects without the key. Existing settings
// are never overwritten here.
if (!savedConfig.Token && process.env.SMARTPRINT_DEVICE_TOKEN) {
  try {
    await writeFile(settingsPath, JSON.stringify({ ...savedConfig, Url: base, Token: secret, Printer: printer || '', LastUpdated: new Date().toISOString() }, null, 2), 'utf8');
    savedConfig = loadConfig();
    log(`[Connector] Saved connection settings to ${settingsPath}.`);
  } catch (err) {
    log(`[Connector] Could not save settings: ${err.message}`);
  }
}

// Resolve the configured name to an installed Windows printer: exact name, an online copy of it, the
// same model or brand (e.g. "HP Printer" -> "HP LaserJet 1020"), the default printer, then any real
// printer. Software printers such as PDF or PaperPort are never chosen by fallback.
if (process.platform === 'win32') {
  const installedPrinters = await getWindowsPrinters();
  if (installedPrinters.length) {
    const res = pickPrinter(printer, installedPrinters);
    if (res.name && res.name !== printer) {
      log(`[Printer] ${res.reason}`);
      printer = res.name;
      try {
        const cfg = loadConfig();
        // Keep the owner's choice when the chosen printer is only a temporary online copy.
        if (!cfg.Printer || !installedPrinters.some(p => p.Name.toLowerCase() === String(cfg.Printer).toLowerCase())) {
          cfg.Printer = printer;
          await writeFile(settingsPath, JSON.stringify(cfg, null, 2), 'utf8');
        }
      } catch {}
    }
    if (res.status === 'Offline') {
      log(`[Printer] WARNING: Printer "${printer}" is currently OFFLINE in Windows. Check the USB cable / power. Waiting for connection...`);
    }
  } else if (printer && !(await checkPrinterExists(printer))) {
    log(`[Printer] WARNING: Could not list Windows printers and "${printer}" was not found in the registry.`);
  }
}

if (!printer) log('[Printer] WARNING: No Windows printer detected. Install the printer driver and print a Windows test page.');

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

// This PC's real printers with driver-verified capabilities, for the Printers page.
// Cached briefly because the page polls it. Virtual printers are included only when requested.
let lastScan = { at: 0, list: [], error: null };
async function collectLocalPrinters({ maxAge = 15000, includeVirtual = false } = {}) {
  if (process.platform !== 'win32') return [];
  if (Date.now() - lastScan.at < maxAge && !includeVirtual) return lastScan.list;
  try {
    const rawWindows = await getWindowsPrinters();
    const printers = [];
    for (const p of rawWindows) {
      if (!p || !p.Name) continue;
      const port = String(p.PortName || '').trim();
      const name = String(p.Name).trim();
      const driver = String(p.DriverName || name).trim();
      const conn = classifyConnection({ name, port, driver, shared: Boolean(p.Shared), type: p.Type, portHost: p.PortHost });
      if (conn.isVirtual && !includeVirtual) continue;
      const st = checkPrinterStatus(p.PrinterStatus, p.WorkOffline);
      const { manufacturer, model } = extractManufacturerModel(name, driver);
      printers.push({
        name,
        portName: port,
        driverName: driver,
        manufacturer,
        model,
        connectionType: conn.connectionType,
        connectionCode: conn.connectionCode,
        isWifi: conn.isWifi,
        isWired: conn.isWired,
        isNetwork: conn.isNetwork,
        isShared: conn.isShared,
        isVirtual: conn.isVirtual,
        isDefault: Boolean(p.Default),
        workOffline: Boolean(p.WorkOffline),
        status: st.status,
        operationalStatus: st.operationalStatus,
        needsAttention: st.needsAttention,
        isBusy: st.isBusy,
        jobCount: Number.isFinite(Number(p.JobCount)) ? Number(p.JobCount) : 0,
        ...guessCapabilities(name, driver),
        paperSizes: [],
        resolution: null,
        verified: false
      });
    }
    const capabilities = await probePrinterCapabilities(printers.map(p => p.name));
    for (const p of printers) {
      if (capabilities.has(p.name)) Object.assign(p, capabilities.get(p.name), { verified: true });
    }
    if (!includeVirtual) {
      lastScan = { at: Date.now(), list: printers, error: null };
    }
    return printers;
  } catch (err) {
    lastScan.error = err.message;
    return lastScan.list;
  }
}

async function scanAndReportLocalPrinters() {
  if (process.platform !== 'win32' || !bindings.length) return;
  try {
    const printers = await collectLocalPrinters({ maxAge: 0 });
    for (const b of bindings) {
      if (b.authFailed || !b.token) continue;
      const own = printers.find(p => p.name.toLowerCase() === String(b.printer || '').toLowerCase());
      if (printers.length || own) {
        await request('/api/device/printers/scanned', {
          method: 'POST',
          token: b.token,
          baseUrl: b.url,
          body: { printers, ...(own ? { capabilities: own } : {}) }
        }).catch(() => {});
      }
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
log(`  Status      : ${secret ? 'ONLINE · Listening for shop print jobs...' : 'Waiting to be linked from the SmartPrint Printers page'}`);
try {
  await startBridge({
    state: () => ({
      base,
      connectorId,
      connectorVersion: CONNECTOR_VERSION,
      machineName,
      linked: bindings.some(b => !b.authFailed),
      needsRelink: bindings.length > 0 && bindings.every(b => b.authFailed),
      printer,
      bindings: bindings.map(b => ({ printer: b.printer, linked: !b.authFailed, needsRelink: b.authFailed, server: b.url })),
      lastScanAt: lastScan.at ? new Date(lastScan.at).toISOString() : null,
      lastScanError: lastScan.error
    }),
    printers: ({ fresh, includeVirtual } = {}) => collectLocalPrinters({ maxAge: fresh ? 0 : 15000, includeVirtual }),
    pair,
    unpair,
    setDefault: ({ printer: targetName }) => setWindowsDefaultPrinter(targetName).then(() => { lastScan.at = 0; })
  }, { extraOrigins: String(process.env.SMARTPRINT_TRUSTED_ORIGINS || '').split(',').filter(Boolean), log });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    // One connector per PC: a second copy would compete for the same jobs.
    log(`[Connector] Another SmartPrint connector is already running on this PC (port ${BRIDGE_PORT}). Exiting.`);
    cleanupPid();
    process.exit(0);
  }
  log(`[Connector] Dashboard link unavailable: ${err.message}`);
}
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

async function request(path, { method = 'GET', body, lease, binary, range, token: overrideToken, baseUrl } = {}) {
  const url = new URL(path, baseUrl || base);
  const authToken = overrideToken || secret;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${authToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(lease ? { 'X-Lease-Token': lease } : {}),
      ...(range ? { Range: range } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    if (response.status === 401 && !overrideToken) {
      const refreshed = loadConfig();
      if (refreshed.Token && refreshed.Token !== secret) {
        secret = refreshed.Token;
        if (refreshed.Url) base = refreshed.Url.replace(/\/+$/, '');
        if (refreshed.Printer) printer = refreshed.Printer;
        authFailed = false;
        log('[Connector] Detected new token in settings.json. Reconnected.');
      } else if (!authFailed) {
        // Logged once, not on every poll: the old behaviour wrote thousands of identical lines.
        authFailed = true;
        log("[Auth] The server rejected this connector's device key (401): the printer was disconnected or linked again elsewhere. Open SmartPrint > Printers on this PC and click Connect to link it again.");
      }
    }
    const err = new Error(`SmartPrint request failed (${response.status} on ${path}).`);
    err.status = response.status;
    throw err;
  }
  if (authFailed && !overrideToken) { authFailed = false; log('[Auth] Device key accepted again.'); }
  return binary ? { bytes: Buffer.from(await response.arrayBuffer()), range: response.headers.get('Content-Range') } : response.json();
}

// Called by the local bridge when the owner clicks Connect on the Printers page of this PC. The key is
// checked with the server before anything is saved.
async function pair({ url, token, printer: chosen, replace = false }) {
  const target = url.replace(/\/+$/, '');
  const check = await fetch(new URL('/api/device/heartbeat', target), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectorId, version: CONNECTOR_VERSION, machineName }),
    signal: AbortSignal.timeout(20000)
  }).catch(err => ({ ok: false, status: err.message }));
  if (!check.ok) throw Object.assign(new Error(`The SmartPrint server did not accept this device key (${check.status}).`), { status: 400 });
  let name = chosen || printer || '';
  if (process.platform === 'win32') {
    const res = pickPrinter(name, await getWindowsPrinters());
    if (res.name) name = res.name;
  }
  if (replace) {
    bindings = [];
  }
  const idx = bindings.findIndex(b => b.printer.toLowerCase() === name.toLowerCase());
  const entry = { url: target, token, printer: name, authFailed: false, lastError: null };
  if (idx >= 0) bindings[idx] = entry;
  else bindings.push(entry);
  base = target; secret = token; printer = name; authFailed = false; lastScan.at = 0;
  await saveBindings();
  log(`[Connector] Linked "${name}" to ${target} (total bound printers: ${bindings.length}).`);
  scanAndReportLocalPrinters().catch(() => {});
  return { printer: name };
}

async function unpair({ printer: targetName }) {
  const before = bindings.length;
  bindings = bindings.filter(b => b.printer.toLowerCase() !== String(targetName || '').toLowerCase());
  if (bindings.length !== before) {
    await saveBindings();
    log(`[Connector] Unbound "${targetName}" from SmartPrint (Windows driver/queue untouched).`);
  }
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

async function printJob(job, binding = null) {
  const activeToken = binding?.token || secret;
  const activeUrl = binding?.url || base;
  const targetPrinter = binding?.printer || printer;
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
      const result = await request(`/api/device/jobs/${job.id}/document`, { binary: true, lease: job.token, range: `bytes=${start}-${start + 1048575}`, token: activeToken, baseUrl: activeUrl });
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

    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'submitted' }, token: activeToken, baseUrl: activeUrl });

    log(`    Sending to physical printer: "${targetPrinter}"...`);
    const printResult = await printPdfToWindowsPrinter({
      pdfPath: path,
      printerName: targetPrinter,
      options: job.options,
      sumatraPath: sumatra,
      exactOnly: Boolean(job.options?.targetDeviceId)
    });

    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'awaiting_confirmation' }, token: activeToken, baseUrl: activeUrl });
    if (binding) binding.lastError = null;
    log(`✓ [Print Queued] Job #${job.id.slice(0, 8).toUpperCase()} sent to printer (${printResult.method}). Confirm physical output in SmartPrint.\n`);
  } catch (err) {
    log(`! [Print Error] Failed to submit job #${job.id}: ${err.message}`);
    if (binding) binding.lastError = err.message;
    // Clean up journal on failure so retry will never be blocked
    await unlink(journal).catch(() => {});
    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'failed', error: err.message }, token: activeToken, baseUrl: activeUrl }).catch(() => {});
  } finally {
    await unlink(path).catch(() => {});
  }
}

let running = true;
process.on('SIGINT', () => { running = false; cleanupPid(); console.log('\nStopping connector...'); });
process.on('SIGTERM', () => { running = false; cleanupPid(); console.log('\nStopping connector...'); });
process.on('exit', cleanupPid);

// Send device heartbeat every 10 seconds for every bound printer on this PC
const heartbeat = setInterval(async () => {
  if (!bindings.length) return;
  const cached = lastScan.list || [];
  for (const b of bindings) {
    if (!b.token) continue;
    const match = cached.find(p => p.name.toLowerCase() === String(b.printer || '').toLowerCase());
    request('/api/device/heartbeat', {
      method: 'POST',
      token: b.token,
      baseUrl: b.url,
      body: {
        connectorId,
        version: CONNECTOR_VERSION,
        machineName,
        deviceStatus: match ? (match.operationalStatus || match.status) : undefined,
        queueDepth: match ? match.jobCount : undefined,
        isWindowsDefault: match ? match.isDefault : undefined,
        lastError: b.lastError || ''
      }
    }).then(() => {
      if (b.authFailed) { b.authFailed = false; log(`[Auth] "${b.printer}" reconnected.`); }
    }).catch(err => {
      if (err.status === 401) {
        if (!b.authFailed) {
          b.authFailed = true;
          log(`[Auth] Device key rejected (401) for "${b.printer}". Reconnect from SmartPrint > Printers.`);
        }
      } else {
        log(`[Heartbeat] Warning for "${b.printer}": ${err.message}`);
      }
    });
  }
}, 10000);

// Old SmartPrint jobs still waiting in a Windows queue would all print when a cable is plugged back in.
const clearStale = () => clearStaleConnectorJobs(root, { log }).catch(() => 0);
await clearStale();
const staleCleaner = setInterval(clearStale, 10 * 60000);
await scanAndReportLocalPrinters();
const printerScanner = setInterval(() => scanAndReportLocalPrinters(), 60000);

// Conversion can take minutes. Keep it out of the paid-print dispatch loop.
// Idle polling is the dominant load on the server (every shop PC polls around the clock), so an idle
// connector slows down gradually: 1 s right after activity, up to 4 s for claims and 3 s for preparations
// when nothing has happened for a while. Any job resets it immediately.
const idleDelay = (streak, base, max) => Math.min(max, base + Math.floor(streak / 10) * 500);
async function preparationLoop() {
  let idleStreak = 0;
  while (running && processorSecret) {
    if (!secret || authFailed) { await new Promise(resolve => setTimeout(resolve, 5000)); continue; }
    try {
      const preparation = await request('/api/device/preparations/claim', { method: 'POST' });
      if (preparation) {
        idleStreak = 0;
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
    idleStreak++;
    if (running) await new Promise(resolve => setTimeout(resolve, idleDelay(idleStreak, 1500, 3000)));
  }
}
const preparing = preparationLoop();
let claimRetryDelay = 1000;
let claimIdleStreak = 0;
let lastClaimErrorLog = 0;
while (running) {
  const activeBindings = bindings.filter(b => b.token && !b.authFailed);
  if (!activeBindings.length) { await new Promise(resolve => setTimeout(resolve, 3000)); continue; }
  let claimedAny = false;
  try {
    for (const b of activeBindings) {
      const print = await request('/api/device/claim', { method: 'POST', token: b.token, baseUrl: b.url });
      if (print) {
        claimedAny = true;
        claimIdleStreak = 0;
        claimRetryDelay = 1000;
        await printJob(print, b);
      }
    }
    if (claimedAny) continue;
    claimIdleStreak++;
    claimRetryDelay = idleDelay(claimIdleStreak, 1000, 4000);
  } catch (err) {
    if (err.status === 401) {
      // Handled per-binding on next heartbeat
    } else if (Date.now() - lastClaimErrorLog > 30000) {
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
clearInterval(staleCleaner);
