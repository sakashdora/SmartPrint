import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// SmartPrint agent v3 core: talks to /api/agent/v2, keeps a durable local journal, and never prints a job twice.
//
// The order of events for every job is fixed:
//   claim -> download (SHA-256 checked, stored encrypted) -> journal "about_to_submit" -> report `submitted` to the
//   server -> only after the server accepted that, hand the file to the printer -> report the outcome.
// If the agent dies at any point, the journal says what is safe:
//   downloaded / about_to_submit : nothing has reached the printer -> ask the server; if it still owns the lease go on,
//                                  if the attempt was fenced, drop the job (the server already gave it elsewhere)
//   submitted                    : the printer may have received it -> NEVER print again; report it as uncertain
// Outcomes that cannot be delivered (no internet) wait in a durable outbox and are replayed in order.
const sha256 = data => createHash('sha256').update(data).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const AGENT_VERSION = '3.0.0';

// ---- secrets at rest ---------------------------------------------------------------------------------------------
// On Windows the credential and the cache key are protected with DPAPI (bound to the Windows user), so copying the
// folder to another machine or user does not reveal them. Elsewhere (and in tests) a key file with owner-only
// permissions is used. Nothing secret is ever written in plain text.
function dpapi(mode, buffer) {
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:SP_IN); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${mode}($b,$null,'CurrentUser'))`;
  return Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SP_IN: buffer.toString('base64') }, windowsHide: true, timeout: 20000 }).toString().trim(), 'base64');
}
export class Vault {
  constructor(dir, { mode = process.platform === 'win32' ? 'dpapi' : 'file' } = {}) { this.dir = dir; this.mode = mode; this.keyPath = join(dir, 'vault.key'); }
  #wrap(buffer) { return this.mode === 'dpapi' ? dpapi('Protect', buffer) : buffer; }
  #unwrap(buffer) { return this.mode === 'dpapi' ? dpapi('Unprotect', buffer) : buffer; }
  get key() {
    if (!this._key) {
      if (!existsSync(this.keyPath)) writeFileSync(this.keyPath, this.#wrap(randomBytes(32)), { mode: 0o600 });
      this._key = this.#unwrap(readFileSync(this.keyPath));
    }
    return this._key;
  }
  seal(bytes) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv); const body = Buffer.concat([c.update(bytes), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); }
  open(blob) { const d = createDecipheriv('aes-256-gcm', this.key, blob.subarray(0, 12)); d.setAuthTag(blob.subarray(12, 28)); return Buffer.concat([d.update(blob.subarray(28)), d.final()]); }
  sealText(text) { return this.seal(Buffer.from(text)).toString('base64'); }
  openText(text) { return this.open(Buffer.from(text, 'base64')).toString(); }
}

export class AgentCore {
  constructor({ dir, driver, url = null, fetchImpl = fetch, version = AGENT_VERSION, log = () => {}, instanceId = null, vaultMode, rotateAfterDays = 30, heartbeatMs = 15000, reportMs = 60000, hooks = {} }) {
    this.hooks = hooks; this.dir = dir; this.driver = driver; this.fetch = fetchImpl; this.version = version; this.log = log; this.rotateAfterDays = rotateAfterDays;
    this.heartbeatMs = heartbeatMs; this.reportMs = reportMs;
    mkdirSync(join(dir, 'cache'), { recursive: true });
    this.vault = new Vault(dir, vaultMode ? { mode: vaultMode } : {});
    this.settingsPath = join(dir, 'settings.json');
    this.settings = existsSync(this.settingsPath) ? JSON.parse(readFileSync(this.settingsPath, 'utf8')) : {};
    if (url) this.settings.url = url.replace(/\/+$/, '');
    this.instanceId = instanceId || this.settings.instanceId || randomUUID();
    this.db = new DatabaseSync(join(dir, 'agent.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS journal (attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, printer_id TEXT NOT NULL, lease_token TEXT NOT NULL, state TEXT NOT NULL, sha256 TEXT, options TEXT, pages INTEGER, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, lease_token TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);`);
    this.status = 'idle'; this.lastHeartbeat = 0; this.lastReport = 0; this.printerIds = this.settings.printerIds || {};
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
  #save() { writeFileSync(this.settingsPath, JSON.stringify({ ...this.settings, instanceId: this.instanceId, printerIds: this.printerIds }, null, 2)); }
  get credential() { return this.settings.credential ? this.vault.openText(this.settings.credential) : null; }
  set credential(value) { this.settings.credential = this.vault.sealText(value); this.settings.credentialCreated = new Date().toISOString(); this.#save(); }

  // ---- HTTP -------------------------------------------------------------------------------------------------------
  async #request(path, { method = 'GET', body, lease, range, binary = false, anonymous = false } = {}) {
    const response = await this.fetch(new URL(path, this.settings.url), {
      method, signal: AbortSignal.timeout(40000),
      headers: { ...(anonymous ? {} : { Authorization: `Bearer ${this.credential}` }), 'X-Agent-Instance': this.instanceId, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(lease ? { 'X-Lease-Token': lease } : {}), ...(range ? { Range: range } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 401) { this.status = 'unauthorized'; throw Object.assign(new Error('The server rejected this agent\'s credential (revoked?).'), { status: 401, halt: true }); }
    if (response.status === 409) {
      const info = await response.json().catch(() => ({}));
      if (info.code === 'agent.instance_conflict') this.status = 'conflict';
      throw Object.assign(new Error(info.error || 'Conflict'), { status: 409, code: info.code, halt: info.code === 'agent.instance_conflict' });
    }
    if (!response.ok) throw Object.assign(new Error(`Server answered ${response.status}`), { status: response.status });
    return binary ? { bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers } : response.json();
  }
  // Only genuine network trouble (no connection, timeout) or a server error is worth retrying; anything else is a bug and must surface.
  static transient = error => error.status ? error.status >= 500 : ['TypeError', 'TimeoutError', 'AbortError'].includes(error.name);

  // ---- enrolment, credentials ----------------------------------------------------------------------------------------
  async enroll(code) {
    const result = await this.#request('/api/agent/v2/enroll', { method: 'POST', anonymous: true, body: { code, hostname: process.env.COMPUTERNAME || 'agent', os: process.platform, version: this.version, instanceId: this.instanceId } });
    this.settings.agentId = result.agentId; this.credential = result.credential; this.#save();
    return result.agentId;
  }
  async rotateIfDue(now = Date.now()) {
    const created = Date.parse(this.settings.credentialCreated || 0);
    if (!created || now - created < this.rotateAfterDays * 86400000) return false;
    const result = await this.#request('/api/agent/v2/credentials/rotate', { method: 'POST' });
    this.credential = result.credential; // the old one still works for 24 hours
    return true;
  }

  // ---- printers and health ------------------------------------------------------------------------------------------
  async reportPrinters(force = false) {
    if (!force && Date.now() - this.lastReport < this.reportMs) return;
    const printers = await this.driver.listPrinters();
    const result = await this.#request('/api/agent/v2/printers/report', { method: 'POST', body: { printers } });
    this.printerIds = Object.fromEntries(result.printers.map(p => [p.name, p.id]));
    this.printerStatus = Object.fromEntries(printers.map(p => [p.name, p.status]));
    this.lastReport = Date.now(); this.#save();
  }
  async heartbeat(force = false) {
    if (!force && Date.now() - this.lastHeartbeat < this.heartbeatMs) return;
    const result = await this.#request('/api/agent/v2/heartbeat', { method: 'POST', body: { version: this.version, printers: Object.entries(this.printerIds).map(([name, id]) => ({ id, status: this.printerStatus?.[name] ?? 'Unknown' })) } });
    this.lastHeartbeat = Date.now();
    if (result.updateRequired) { this.updateRequired = true; this.log(`[Agent] This version (${this.version}) is below the minimum; update to ${result.latestVersion}.`); }
  }

  // ---- journal ----------------------------------------------------------------------------------------------------
  #journal(attemptId, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE journal SET ${keys.map(k => `${k}=?`).join(', ')} WHERE attempt_id=?`).run(...keys.map(k => fields[k]), attemptId);
  }
  #cachePath = id => join(this.dir, 'cache', `${id}.enc`);
  #drop(attemptId) { try { unlinkSync(this.#cachePath(attemptId)); } catch {} this.db.prepare('DELETE FROM journal WHERE attempt_id=?').run(attemptId); }
  liveJournal() { return this.db.prepare('SELECT * FROM journal ORDER BY created').all(); }

  // Outcomes are queued first and delivered after, so a lost connection cannot lose a result.
  #queueOutcome(attemptId, lease, body) { this.db.prepare('INSERT INTO outbox (attempt_id,lease_token,body,created) VALUES (?,?,?,?)').run(attemptId, lease, JSON.stringify(body), new Date().toISOString()); }
  async drainOutbox() {
    for (const item of this.db.prepare('SELECT * FROM outbox ORDER BY seq').all()) {
      try {
        await this.#request(`/api/agent/v2/attempts/${item.attempt_id}/events`, { method: 'POST', lease: item.lease_token, body: JSON.parse(item.body) });
      } catch (error) {
        if (AgentCore.transient(error) || error.halt) return false; // try again later, keep order
        // 409 "fenced" and other refusals: the server no longer wants this report; discard it.
        this.log(`[Agent] Discarded a report the server refused (${error.code || error.status}).`);
      }
      this.db.prepare('DELETE FROM outbox WHERE seq=?').run(item.seq);
    }
    return true;
  }

  // ---- the print path -----------------------------------------------------------------------------------------------
  async #download(claim) {
    const chunks = []; let start = 0, total, sha;
    do {
      const { bytes, headers } = await this.#request(`/api/agent/v2/attempts/${claim.attemptId}/document`, { lease: claim.leaseToken, binary: true, range: `bytes=${start}-${start + 1048575}` });
      chunks.push(bytes); sha = headers.get('x-content-sha256') || sha;
      total = Number(headers.get('content-range')?.split('/')[1] || bytes.length); start += bytes.length;
      if (!bytes.length || total > 60 * 1048576) throw Object.assign(new Error('Invalid document size.'), { status: 400 });
    } while (start < total);
    const bytes = Buffer.concat(chunks);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw Object.assign(new Error('The downloaded document is not a PDF.'), { status: 400 });
    if (sha && sha256(bytes) !== sha) throw Object.assign(new Error('The downloaded document does not match its checksum.'), { status: 400 });
    return { bytes, sha: sha256(bytes) };
  }

  async #runPrint(entry) {
    const printerName = Object.entries(this.printerIds).find(([, id]) => id === entry.printer_id)?.[0];
    const file = this.#cachePath(entry.attempt_id);
    const pdfPath = join(this.dir, 'cache', `${entry.attempt_id}.pdf`);
    let outcome;
    try {
      writeFileSync(pdfPath, this.vault.open(readFileSync(file)), { mode: 0o600 }); // plain text only while printing
      outcome = await this.driver.print({ printerName, pdfPath, options: JSON.parse(entry.options || '{}'), jobPages: entry.pages });
    } catch (error) {
      outcome = { outcome: 'failed', error: error.message, nothingPrinted: false };
    } finally { try { unlinkSync(pdfPath); } catch {} }
    const body = outcome.outcome === 'completed'
      ? { event: 'completed', pages: outcome.pages ?? undefined }
      : { event: 'failed', error: String(outcome.error || 'The printer did not finish the job.').slice(0, 280), pages: outcome.pages ?? undefined, nothingPrinted: outcome.nothingPrinted === true };
    this.#queueOutcome(entry.attempt_id, entry.lease_token, body);
    this.#drop(entry.attempt_id);
    await this.drainOutbox().catch(() => {});
  }

  // Tells the server the file is about to be sent. The server may refuse (the lease was lost): then it must not print.
  async #submit(entry) {
    try {
      await this.#request(`/api/agent/v2/attempts/${entry.attempt_id}/events`, { method: 'POST', lease: entry.lease_token, body: { event: 'submitted' } });
      return 'accepted';
    } catch (error) {
      if (error.code === 'agent.fenced') return 'fenced';
      if (AgentCore.transient(error)) return 'unreachable';
      throw error;
    }
  }

  async #advance(entry) {
    if (entry.state === 'submitted') {
      // We do not know whether the printer got the file. Reprinting could waste paper twice: report it as uncertain.
      this.#queueOutcome(entry.attempt_id, entry.lease_token, { event: 'failed', error: 'The agent restarted while this job was being printed.', nothingPrinted: false });
      this.#drop(entry.attempt_id);
      return;
    }
    if (entry.state === 'downloaded') { this.#journal(entry.attempt_id, { state: 'about_to_submit' }); entry.state = 'about_to_submit'; }
    const result = await this.#submit(entry);
    if (result === 'unreachable') return; // keep "about_to_submit"; try again on the next cycle
    if (result === 'fenced') { this.log(`[Agent] Job ${entry.job_id.slice(0, 8)} was taken away from this agent; not printing it.`); this.#drop(entry.attempt_id); return; }
    this.#journal(entry.attempt_id, { state: 'submitted' });
    await this.hooks.afterSubmitAck?.(entry); // test hook: simulates the process dying at this exact point
    await this.#runPrint({ ...entry, state: 'submitted' });
  }

  // One pass: finish interrupted work, deliver pending reports, keep the server informed, then take at most one new job
  // per idle printer. `wait` is the long-poll time in seconds (0 in tests).
  async cycle({ wait = 0 } = {}) {
    if (!this.settings.agentId || this.status === 'unauthorized' || this.status === 'conflict') return { halted: this.status };
    try {
      await this.rotateIfDue().catch(() => {});
      await this.reportPrinters(); await this.heartbeat();
      await this.drainOutbox();
      for (const entry of this.liveJournal()) await this.#advance(entry);
      const busy = new Set(this.liveJournal().map(e => e.printer_id));
      const idle = Object.values(this.printerIds).filter(id => !busy.has(id));
      if (!idle.length) return { jobs: 0 };
      const { jobs } = await this.#request('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: idle, waitSeconds: wait } });
      for (const claim of jobs) {
        this.db.prepare('INSERT INTO journal (attempt_id,job_id,printer_id,lease_token,state,options,pages,created) VALUES (?,?,?,?,?,?,?,?)').run(claim.attemptId, claim.jobId, claim.printerId, claim.leaseToken, 'claimed', JSON.stringify(claim.options), claim.pages, new Date().toISOString());
        try {
          const { bytes, sha } = await this.#download(claim);
          writeFileSync(this.#cachePath(claim.attemptId), this.vault.seal(bytes), { mode: 0o600 });
          this.#journal(claim.attemptId, { state: 'downloaded', sha256: sha });
        } catch (error) {
          if (error.code === 'agent.fenced') { this.#drop(claim.attemptId); continue; }
          // Nothing reached the printer: report a clean failure so the job can be retried.
          this.#queueOutcome(claim.attemptId, claim.leaseToken, { event: 'failed', error: error.message, nothingPrinted: true });
          this.#drop(claim.attemptId);
          continue;
        }
        await this.hooks.afterDownload?.(claim); // test hook: simulates the process dying with the file cached
        await this.#advance(this.db.prepare('SELECT * FROM journal WHERE attempt_id=?').get(claim.attemptId));
      }
      await this.drainOutbox();
      return { jobs: jobs.length };
    } catch (error) {
      if (error.halt) return { halted: this.status };
      if (AgentCore.transient(error)) { this.log(`[Agent] Server not reachable (${error.message}); will retry.`); return { offline: true }; }
      throw error;
    }
  }

  // Long-running loop with back-off; stops when told to or when the credential is revoked.
  async run({ signal } = {}) {
    let delay = 1000;
    while (!signal?.aborted) {
      const result = await this.cycle({ wait: 20 }).catch(error => { this.log(`[Agent] ${error.message}`); return { offline: true }; });
      if (result.halted) { this.log(`[Agent] Stopped: ${result.halted}. Work in progress is kept in the journal.`); return result; }
      delay = result.offline ? Math.min(30000, delay * 2) : 1000;
      if (result.offline || !result.jobs) await sleep(result.offline ? delay : 500);
    }
  }
}

// Removes cached files that belong to no journal entry (left by a crash between steps).
export function sweepCache(dir, keep = new Set()) {
  const cache = join(dir, 'cache');
  if (!existsSync(cache)) return 0;
  let removed = 0;
  for (const name of readdirSync(cache)) {
    const id = name.replace(/\.(enc|pdf)$/, '');
    if (keep.has(id) || Date.now() - statSync(join(cache, name)).mtimeMs < 60000) continue;
    try { unlinkSync(join(cache, name)); removed++; } catch {}
  }
  return removed;
}
