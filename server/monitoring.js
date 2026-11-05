import { randomUUID, timingSafeEqual } from 'node:crypto';
import { agentOnline } from './queue.js';
import { verifyLedger } from './wallet.js';
import { sendMail } from './mailer.js';
import { requirePermission } from './tenant.js';

// Operational alerts for institutions. Every check produces "findings" (kind + subject + message). A finding that is
// new opens an alert row and e-mails the institution administrators once; one that stays true only refreshes the row
// (no repeat mail until it has been resolved and comes back); one that stops being true is marked resolved.
// Business-mode shops are not touched: this only looks at education organizations.
const now = () => new Date().toISOString();
const minutes = (name, fallback) => Number(process.env[name] || fallback) * 60000;

export const THRESHOLDS = () => ({
  agentSilentMs: minutes('ALERT_AGENT_SILENT_MINUTES', 30),
  waitingMs: minutes('ALERT_QUEUE_WAIT_MINUTES', 5),
  uncertainMs: minutes('ALERT_UNCERTAIN_MINUTES', 30),
  ledgerEveryMs: minutes('LEDGER_CHECK_HOURS', 24) * 60
});

export async function collectFindings(db, orgId, at = Date.now()) {
  const t = THRESHOLDS(), findings = [];
  const iso = ms => new Date(at - ms).toISOString();

  const agents = await db.query("SELECT id, name, last_seen FROM agents WHERE org_id=$1 AND status='active'", [orgId]);
  for (const agent of agents) {
    if (!agent.last_seen || at - Date.parse(agent.last_seen) > t.agentSilentMs) {
      findings.push({ kind: 'agent_silent', subject: agent.id, message: `The print agent "${agent.name}" has not contacted the server for ${Math.round(((at - Date.parse(agent.last_seen || 0)) / 60000))} minutes. Check that the PC is on and has internet.` });
    }
  }

  // Jobs that have been waiting while no printer in their pool can take them.
  const waiting = await db.query("SELECT j.pool_id, p.name AS pool_name, COUNT(*) AS n, MIN(j.enqueued_at) AS oldest FROM print_jobs j JOIN printer_pools p ON p.id=j.pool_id WHERE j.org_id=$1 AND j.status='queued' AND j.enqueued_at<=$2 GROUP BY j.pool_id, p.name", [orgId, iso(t.waitingMs)]);
  for (const pool of waiting) {
    const printers = await db.query("SELECT pr.device_status, pr.paused, pr.status, a.last_seen AS agent_seen FROM pool_members m JOIN printers pr ON pr.id=m.printer_id JOIN agents a ON a.id=pr.agent_id WHERE m.pool_id=$1 AND pr.status='active' AND a.status='active'", [pool.pool_id]);
    const usable = printers.filter(p => !Number(p.paused) && agentOnline(p.agent_seen) && String(p.device_status ?? '').toLowerCase() !== 'offline');
    if (!usable.length) findings.push({ kind: 'printer_offline_with_work', subject: pool.pool_id, message: `${Number(pool.n)} job(s) in "${pool.pool_name}" are waiting and no printer in that group is available (offline, paused or its PC is not connected).` });
  }

  const uncertain = await db.query("SELECT j.id, MIN(a.created) AS since FROM print_jobs j JOIN print_attempts a ON a.job_id=j.id AND a.state='uncertain' WHERE j.org_id=$1 AND j.status='uncertain' GROUP BY j.id HAVING MIN(a.created)<=$2", [orgId, iso(t.uncertainMs)]);
  for (const job of uncertain) findings.push({ kind: 'stuck_uncertain', subject: job.id, message: 'A job has been "uncertain" for more than 30 minutes: it may or may not have printed. Open the queue and mark it as printed or reprint it.' });
  return findings;
}

async function recipients(db, orgId) {
  return db.query("SELECT DISTINCT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.role='institution_admin' AND COALESCE(u.status,'active')='active'", [orgId]);
}

// Reconcile one organization's findings with its alert rows. Returns what changed.
export async function applyFindings(db, org, findings) {
  const opened = [], resolved = [];
  const existing = await db.query('SELECT * FROM alerts WHERE org_id=$1', [org.id]);
  const byKey = new Map(existing.map(a => [`${a.kind}:${a.subject}`, a]));
  const live = new Set();
  for (const f of findings) {
    const key = `${f.kind}:${f.subject}`; live.add(key);
    const row = byKey.get(key);
    if (!row) {
      await db.query('INSERT INTO alerts (id,org_id,kind,subject,message,opened,last_seen) VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(org_id,kind,subject) DO NOTHING', [randomUUID(), org.id, f.kind, f.subject, f.message, now()]);
      opened.push(f);
    } else if (row.resolved_at) {
      await db.query('UPDATE alerts SET resolved_at=NULL, opened=$1, last_seen=$1, message=$2, notified_at=NULL WHERE id=$3', [now(), f.message, row.id]);
      opened.push(f);
    } else {
      await db.query('UPDATE alerts SET last_seen=$1, message=$2 WHERE id=$3', [now(), f.message, row.id]);
    }
  }
  for (const [key, row] of byKey) {
    if (!live.has(key) && !row.resolved_at) { await db.query('UPDATE alerts SET resolved_at=$1 WHERE id=$2', [now(), row.id]); resolved.push(row); }
  }
  if (opened.length) {
    const to = await recipients(db, org.id);
    for (const r of to) await sendMail(db, { to: r.email, kind: 'alert', subject: `[SmartPrint] ${org.name}: ${opened.length} thing${opened.length > 1 ? 's' : ''} need attention`, text: `${opened.map(f => `- ${f.message}`).join('\n')}\n\nSign in to SmartPrint and open Alerts for details.` });
    await db.query('UPDATE alerts SET notified_at=$1 WHERE org_id=$2 AND resolved_at IS NULL AND notified_at IS NULL', [now(), org.id]);
  }
  return { opened, resolved };
}

// Ledger verification, at most once per LEDGER_CHECK_HOURS (default 24) across all server processes.
export async function verifyLedgersIfDue(db, at = Date.now()) {
  const [row] = await db.query("SELECT last_success FROM worker_status WHERE id='ledger-verify'");
  if (row && at - Date.parse(row.last_success) < THRESHOLDS().ledgerEveryMs) return null;
  // Claim the slot first so two server instances do not both run it.
  const stamp = new Date(at).toISOString();
  if (row) { const claimed = await db.query("UPDATE worker_status SET last_success=$1 WHERE id='ledger-verify' AND last_success=$2 RETURNING id", [stamp, row.last_success]); if (!claimed.length) return null; }
  else await db.query("INSERT INTO worker_status (id,last_success) VALUES ('ledger-verify',$1) ON CONFLICT(id) DO NOTHING", [stamp]);
  const orgs = await db.query("SELECT id, name FROM organizations WHERE type='education' AND status='active'");
  const results = [];
  for (const org of orgs) results.push({ org, ...(await verifyLedger(db, org.id)) });
  return results;
}

export async function runMonitoring(db, { at = Date.now() } = {}) {
  const summary = { orgs: 0, opened: 0, resolved: 0, ledger: null };
  const orgs = await db.query("SELECT id, name FROM organizations WHERE type='education' AND status='active'");
  const ledgerRuns = await verifyLedgersIfDue(db, at);
  for (const org of orgs) {
    const findings = await collectFindings(db, org.id, at);
    const ledger = ledgerRuns?.find(r => r.org.id === org.id);
    if (ledger) {
      await db.query("INSERT INTO worker_status (id,last_success) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET last_success=$2", [`ledger-ok:${org.id}`, ledger.ok ? new Date(at).toISOString() : '1970-01-01T00:00:00.000Z']);
    }
    // A ledger problem stays open until a later verification passes (the alert is not recomputed on every minute tick).
    const [flag] = await db.query('SELECT last_success FROM worker_status WHERE id=$1', [`ledger-ok:${org.id}`]);
    if (flag && flag.last_success.startsWith('1970')) {
      const detail = ledger ? ledger.problems.slice(0, 3).join('; ') : 'see the wallet consistency report';
      findings.push({ kind: 'ledger_mismatch', subject: 'ledger', message: `The wallet ledger check found a problem (${detail}). Money movements for this institution should be reviewed.` });
    }
    const { opened, resolved } = await applyFindings(db, org, findings);
    summary.orgs++; summary.opened += opened.length; summary.resolved += resolved.length;
  }
  summary.ledger = ledgerRuns ? { checked: ledgerRuns.length, failing: ledgerRuns.filter(r => !r.ok).length } : null;
  return summary;
}

// Prometheus text format. Platform-wide, no personal data, protected by METRICS_TOKEN.
export async function renderMetrics(db) {
  const lines = [], add = (name, help, type, samples) => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); for (const [labels, value] of samples) lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`); };
  const jobs = await db.query("SELECT status, COUNT(*) AS n FROM print_jobs GROUP BY status");
  add('smartprint_jobs', 'Education print jobs by status', 'gauge', jobs.map(j => [`status="${j.status}"`, Number(j.n)]));
  const [wait] = await db.query("SELECT MIN(enqueued_at) AS oldest FROM print_jobs WHERE status='queued'");
  add('smartprint_oldest_queued_seconds', 'Age of the oldest waiting education job', 'gauge', [['', wait?.oldest ? Math.max(0, Math.round((Date.now() - Date.parse(wait.oldest)) / 1000)) : 0]]);
  const agents = await db.query("SELECT last_seen FROM agents WHERE status='active'");
  add('smartprint_agents', 'Active print agents', 'gauge', [['state="online"', agents.filter(a => agentOnline(a.last_seen)).length], ['state="silent"', agents.filter(a => !agentOnline(a.last_seen)).length]]);
  const alerts = await db.query("SELECT kind, COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL GROUP BY kind");
  add('smartprint_open_alerts', 'Open institution alerts by kind', 'gauge', alerts.map(a => [`kind="${a.kind}"`, Number(a.n)]));
  const [ledger] = await db.query("SELECT last_success FROM worker_status WHERE id='ledger-verify'");
  add('smartprint_ledger_last_check_timestamp_seconds', 'When the wallet ledger was last verified', 'gauge', [['', ledger ? Math.round(Date.parse(ledger.last_success) / 1000) : 0]]);
  const [cleanup] = await db.query("SELECT last_success FROM worker_status WHERE id='cleanup'");
  add('smartprint_maintenance_last_success_timestamp_seconds', 'When the maintenance loop last finished', 'gauge', [['', cleanup ? Math.round(Date.parse(cleanup.last_success) / 1000) : 0]]);
  return lines.join('\n') + '\n';
}

export function monitoringRoutes(app, { db }) {
  app.get('/api/v2/edu/alerts', requirePermission(db, 'agents.view_health'), async (req, res) => {
    const rows = await db.query('SELECT id, kind, message, opened, last_seen, resolved_at FROM alerts WHERE org_id=$1 ORDER BY (resolved_at IS NULL) DESC, last_seen DESC LIMIT 100', [req.org.id]);
    res.json(rows.map(r => ({ id: r.id, kind: r.kind, message: r.message, opened: r.opened, lastSeen: r.last_seen, resolved: Boolean(r.resolved_at) })));
  });
  app.get('/metrics', async (req, res) => {
    const token = process.env.METRICS_TOKEN || '';
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, '')), want = Buffer.from(token);
    if (!token || given.length !== want.length || !timingSafeEqual(given, want)) return res.sendStatus(404);
    res.type('text/plain; version=0.0.4').send(await renderMetrics(db));
  });
}
