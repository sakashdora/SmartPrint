import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const run = promisify(execFile);
const base = process.env.SMARTPRINT_URL, secret = process.env.SMARTPRINT_DEVICE_TOKEN, processorSecret = process.env.PROCESSOR_SECRET;
const printer = process.env.SMARTPRINT_PRINTER, sumatra = process.env.SUMATRA_PATH;
if (!base || !secret || !processorSecret || !printer || !sumatra) throw new Error('Run connector/start.ps1 after connector/setup.ps1.');
if (!base.startsWith('https://') && !base.startsWith('http://localhost:')) throw new Error('Use an HTTPS SmartPrint URL.');
const root = resolve(process.env.LOCALAPPDATA || '.', 'SmartPrintConnector');
await mkdir(root, { recursive: true });
// Remove only this connector's stale plaintext print files after a crash.
for (const name of await readdir(root)) {
  if (!/^[a-f0-9-]{36}\.pdf$/.test(name)) continue;
  const path = join(root, name), info = await stat(path);
  if (info.isFile() && Date.now() - info.mtimeMs > 600000) await unlink(path);
}
async function request(path, { method = 'GET', body, lease, binary, range } = {}) {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(lease ? { 'X-Lease-Token': lease } : {}), ...(range ? { Range: range } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`SmartPrint request failed (${response.status}).`);
  return binary ? { bytes: Buffer.from(await response.arrayBuffer()), range: response.headers.get('Content-Range') } : response.json();
}
async function prepareJob(job) {
  const files = [];
  for (const file of job.files) {
    const chunks = [];
    for (let part = 0; part < Math.ceil(file.size / 1048576); part++) chunks.push((await request(`/api/device/preparations/${job.id}/files/${file.id}/${part}`, { binary: true })).bytes);
    files.push({ data: Buffer.concat(chunks).toString('base64'), name: file.name });
  }
  const response = await fetch('http://127.0.0.1:4000/prepare', { method: 'POST', headers: { Authorization: `Bearer ${processorSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ files, options: job.options }), signal: AbortSignal.timeout(125000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Scanner or converter failed.');
  const bytes = Buffer.from(result.data, 'base64');
  await request(`/api/device/preparations/${job.id}/result`, { method: 'POST', body: { size: bytes.length } });
  for (let start = 0, part = 0; start < bytes.length; start += 1048576, part++) await request(`/api/device/preparations/${job.id}/result/${part}`, { method: 'PUT', body: { data: bytes.subarray(start, start + 1048576).toString('base64') } });
  await request(`/api/device/preparations/${job.id}/complete`, { method: 'POST', body: { pages: result.pages } });
}
async function printJob(job) {
  if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('Invalid job identifier.');
  const path = join(root, `${job.id}.pdf`), journal = join(root, `${job.id}.submitted`);
  try { await readFile(journal); console.error('A previously submitted job requires owner review. It was not reprinted.'); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    const chunks = []; let start = 0, total;
    do { const result = await request(`/api/device/jobs/${job.id}/document`, { binary: true, lease: job.token, range: `bytes=${start}-${start + 1048575}` }); chunks.push(result.bytes); total = Number(result.range?.split('/')[1] || result.bytes.length); start += result.bytes.length; if (total > 40 * 1048576 || !result.bytes.length) throw new Error('Invalid print file size.'); } while (start < total);
    const bytes = Buffer.concat(chunks); await writeFile(path, bytes, { mode: 0o600 });
    // Durable intent is written before submission. Ambiguous results are never retried automatically.
    await writeFile(journal, JSON.stringify({ id: job.id, sha256: createHash('sha256').update(bytes).digest('hex'), submitted: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'submitted' } });
    const options = job.options;
    const settings = ['paper=A4', 'noscale', options.color === 'color' ? 'color' : 'monochrome', options.duplex ? 'duplexlong' : 'simplex', `${options.copies}x`, 'collate'].join(',');
    await run(sumatra, ['-print-to', printer, '-print-settings', settings, '-silent', path], { timeout: 180000, windowsHide: true, maxBuffer: 65536 });
    await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'awaiting_confirmation' } });
    console.log('Print submitted. Owner must confirm physical output in SmartPrint.');
  } catch { await request(`/api/device/jobs/${job.id}/events`, { method: 'POST', lease: job.token, body: { event: 'failed' } }).catch(() => {}); console.error('Print outcome is uncertain. Check printer and order; do not automatically resend.'); }
  finally { await unlink(path).catch(error => { if (error.code !== 'ENOENT') console.error('Temporary file cleanup failed; clear the connector cache.'); }); }
}
let running = true; process.on('SIGINT', () => { running = false; }); process.on('SIGTERM', () => { running = false; });
const heartbeat = setInterval(() => request('/api/device/heartbeat', { method: 'POST' }).catch(() => {}), 30000);
heartbeat.unref();
console.log('SmartPrint connector running. Press Ctrl+C to stop.');
while (running) {
  try {
    await request('/api/device/heartbeat', { method: 'POST' });
    const preparation = await request('/api/device/preparations/claim', { method: 'POST' });
    if (preparation) { try { await prepareJob(preparation); } catch { await request(`/api/device/preparations/${preparation.id}/fail`, { method: 'POST', body: { error: 'The shop computer could not scan or convert the file. Please export it as PDF or ask the shop for help.' } }).catch(() => {}); } }
    const print = await request('/api/device/claim', { method: 'POST' }); if (print) await printJob(print);
  } catch { console.error('Connection unavailable. Waiting before trying again.'); }
  if (running) await new Promise(resolve => setTimeout(resolve, 5000));
}
clearInterval(heartbeat);
