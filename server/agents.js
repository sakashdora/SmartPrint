import { randomUUID } from 'node:crypto';
import { token, digest, encrypt, decrypt } from './security.js';
import { sendPdf } from './uploads.js';
import { generateTestPage } from './diagnostic-page.js';
import { auditV2 } from './orgs.js';
import { requirePermission } from './tenant.js';
import { readObject } from './storage.js';
import { ensureDefaultPool, storeObject, enqueueJob, claimJobs, recordEvent, renewLeases, releaseAgentWork, retryJob, cancelJob, resolveUncertain, jobSignal, agentOnline, LEASE_MS } from './queue.js';

const now = () => new Date().toISOString();
const later = ms => new Date(Date.now() + ms).toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const MIN_AGENT_VERSION = '3.0.0', LATEST_AGENT_VERSION = '3.0.0';
const bearer = req => req.headers.authorization?.replace(/^Bearer /, '') ?? '';
const flag = value => value === true ? 1 : value === false ? 0 : null; // null = unknown, which never qualifies

export function agentRoutes(app, { db, key }) {
  // ======================= Institution administration (browser session) =======================
  const manageAgents = requirePermission(db, 'agents.manage');
  const managePrinters = requirePermission(db, 'printers.manage');
  const managePools = requirePermission(db, 'pools.manage');
  const viewQueue = requirePermission(db, 'jobs.view_queue');
  const printer = async req => {
    const [row] = await db.query('SELECT * FROM printers WHERE id=$1 AND org_id=$2', [req.params.id, req.org.id]);
    if (!row) throw fail(404, 'Printer not found.');
    return row;
  };

  app.get('/api/v2/edu/agents', manageAgents, async (req, res) => {
    const agents = await db.query('SELECT id,name,status,version,hostname,os,last_seen,campus_id,created FROM agents WHERE org_id=$1 ORDER BY created', [req.org.id]);
    res.json(agents.map(a => ({ ...a, online: a.status === 'active' && agentOnline(a.last_seen) })));
  });
  // The enrolment code is shown once, works once and expires in 15 minutes.
  app.post('/api/v2/edu/agents', manageAgents, async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (name.length < 2 || name.length > 100) throw fail(400, 'Enter a name for the agent (for example "Library PC").');
    const id = randomUUID(), code = token().slice(0, 24);
    await db.transaction(async tx => {
      await tx.query("INSERT INTO agents (id,org_id,name,status,enrol_hash,enrol_expires,created) VALUES ($1,$2,$3,'pending',$4,$5,$6)", [id, req.org.id, name, digest(code), later(15 * 60000), now()]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'agent.created', targetType: 'agent', targetId: id });
    });
    res.status(201).json({ id, enrolmentCode: code, expiresInMinutes: 15 });
  });
  app.post('/api/v2/edu/agents/:id/revoke', manageAgents, async (req, res) => {
    await db.transaction(async tx => {
      const [agent] = await tx.query("UPDATE agents SET status='revoked', enrol_hash=NULL WHERE id=$1 AND org_id=$2 AND status<>'revoked' RETURNING id", [req.params.id, req.org.id]);
      if (!agent) throw fail(404, 'Agent not found.');
      await tx.query('UPDATE agent_credentials SET revoked_at=$1 WHERE agent_id=$2 AND revoked_at IS NULL', [now(), agent.id]);
      await releaseAgentWork(tx, agent.id);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'agent.revoked', targetType: 'agent', targetId: agent.id });
    });
    res.json({ ok: true });
  });

  app.get('/api/v2/edu/printers', managePrinters, async (req, res) => {
    const rows = await db.query('SELECT p.*, a.name AS agent_name, a.last_seen AS agent_seen, a.status AS agent_status FROM printers p JOIN agents a ON a.id=p.agent_id WHERE p.org_id=$1 ORDER BY p.display_name', [req.org.id]);
    res.json(rows.map(({ agent_seen, ...p }) => ({ ...p, online: p.status === 'active' && p.agent_status === 'active' && agentOnline(agent_seen) })));
  });
  app.patch('/api/v2/edu/printers/:id', managePrinters, async (req, res) => {
    const p = await printer(req), b = req.body;
    const name = b.displayName === undefined ? p.display_name : String(b.displayName).trim();
    if (name.length < 2 || name.length > 100) throw fail(400, 'Enter a printer name.');
    // An administrator can correct capabilities the driver could not report; that choice is not overwritten by later scans.
    const override = ['capColor', 'capDuplex'].some(k => typeof b[k] === 'boolean');
    await db.transaction(async tx => {
      await tx.query('UPDATE printers SET display_name=$1, cap_color=$2, cap_duplex=$3, cap_source=$4, status=$5 WHERE id=$6 AND org_id=$7',
        [name, typeof b.capColor === 'boolean' ? flag(b.capColor) : p.cap_color, typeof b.capDuplex === 'boolean' ? flag(b.capDuplex) : p.cap_duplex, override ? 'admin' : p.cap_source, ['active', 'inactive'].includes(b.status) ? b.status : p.status, p.id, req.org.id]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'printer.updated', targetType: 'printer', targetId: p.id, data: { override } });
    });
    res.json({ ok: true });
  });
  for (const [action, paused] of [['pause', 1], ['resume', 0]]) {
    app.post(`/api/v2/edu/printers/:id/${action}`, requirePermission(db, 'printers.pause'), async (req, res) => {
      const p = await printer(req);
      await db.query('UPDATE printers SET paused=$1 WHERE id=$2 AND org_id=$3', [paused, p.id, req.org.id]);
      res.json({ ok: true, paused: Boolean(paused) });
    });
  }
  // Moving a printer to another agent is deliberate: whatever the old agent was doing with it becomes uncertain.
  app.post('/api/v2/edu/printers/:id/reassign', managePrinters, async (req, res) => {
    const p = await printer(req);
    const [agent] = await db.query("SELECT id FROM agents WHERE id=$1 AND org_id=$2 AND status='active'", [String(req.body.agentId ?? ''), req.org.id]);
    if (!agent) throw fail(404, 'Agent not found.');
    await db.transaction(async tx => {
      const live = await tx.query("SELECT * FROM print_attempts WHERE printer_id=$1 AND state IN ('claimed','submitted')", [p.id]);
      for (const a of live) {
        const claimed = a.state === 'claimed';
        await tx.query('UPDATE print_attempts SET state=$1 WHERE id=$2', [claimed ? 'expired' : 'uncertain', a.id]);
        await tx.query('UPDATE print_jobs SET status=$1 WHERE id=$2', [claimed ? 'queued' : 'uncertain', a.job_id]);
      }
      await tx.query('UPDATE printers SET agent_id=$1, epoch=epoch+1 WHERE id=$2 AND org_id=$3', [agent.id, p.id, req.org.id]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'printer.reassigned', targetType: 'printer', targetId: p.id, data: { from: p.agent_id, to: agent.id } });
    });
    res.json({ ok: true });
  });
  app.post('/api/v2/edu/printers/:id/test-print', managePrinters, async (req, res) => {
    const p = await printer(req);
    const bytes = await generateTestPage(req.org.name, p.display_name);
    const jobId = await db.transaction(async tx => {
      const pools = await tx.query('SELECT pool_id FROM pool_members WHERE printer_id=$1', [p.id]);
      const objectId = await storeObject(tx, req.org.id, bytes, { encrypt, key, expiresMs: 3600000 });
      return enqueueJob(tx, { orgId: req.org.id, poolId: pools[0]?.pool_id, submitterId: req.user.id, jobClass: 'operator', objectId, options: { color: p.cap_color ? 'color' : 'bw', duplex: false, copies: 1, file_name: 'SmartPrint_Diagnostic_Test.pdf' }, pages: 1, priorityBoost: 100 });
    });
    res.status(201).json({ ok: true, jobId });
  });

  app.get('/api/v2/edu/pools', managePools, async (req, res) => {
    const pools = await db.query('SELECT id,name,scheduler,is_default,weights,aging_rate,max_wait_seconds,user_cap FROM printer_pools WHERE org_id=$1 ORDER BY is_default DESC, name', [req.org.id]);
    const members = await db.query('SELECT m.pool_id, m.printer_id FROM pool_members m JOIN printer_pools p ON p.id=m.pool_id WHERE p.org_id=$1', [req.org.id]);
    res.json(pools.map(p => ({ ...p, printerIds: members.filter(m => m.pool_id === p.id).map(m => m.printer_id) })));
  });
  app.post('/api/v2/edu/pools', managePools, async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (name.length < 2 || name.length > 80) throw fail(400, 'Enter a pool name.');
    const id = randomUUID();
    try { await db.query("INSERT INTO printer_pools (id,org_id,name,scheduler,is_default,created) VALUES ($1,$2,$3,'fifo_priority',0,$4)", [id, req.org.id, name, now()]); }
    catch (error) { if (/unique/i.test(error.message)) throw fail(409, 'A pool with this name exists.'); throw error; }
    res.status(201).json({ id });
  });
  app.put('/api/v2/edu/pools/:id/members', managePools, async (req, res) => {
    const [pool] = await db.query('SELECT id FROM printer_pools WHERE id=$1 AND org_id=$2', [req.params.id, req.org.id]);
    if (!pool) throw fail(404, 'Pool not found.');
    const ids = [...new Set(Array.isArray(req.body.printerIds) ? req.body.printerIds.map(String) : [])];
    await db.transaction(async tx => {
      for (const id of ids) if (!(await tx.query('SELECT id FROM printers WHERE id=$1 AND org_id=$2', [id, req.org.id])).length) throw fail(404, 'Printer not found.');
      await tx.query('DELETE FROM pool_members WHERE pool_id=$1', [pool.id]);
      for (const id of ids) await tx.query('INSERT INTO pool_members (pool_id,printer_id) VALUES ($1,$2)', [pool.id, id]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'pool.members_set', targetType: 'pool', targetId: pool.id, data: { count: ids.length } });
    });
    res.json({ ok: true });
  });

  // Scheduler settings of a pool. Weights are relative shares per class; agingRate (cost units per second) makes old
  // jobs overtake newer heavier-class work; maxWaitSeconds promotes any job that waited too long.
  app.put('/api/v2/edu/pools/:id/scheduler', managePools, async (req, res) => {
    const [pool] = await db.query('SELECT * FROM printer_pools WHERE id=$1 AND org_id=$2', [req.params.id, req.org.id]);
    if (!pool) throw fail(404, 'Pool not found.');
    const b = req.body, scheduler = b.scheduler ?? pool.scheduler;
    if (!['fifo_priority', 'wfq_aging'].includes(scheduler)) throw fail(400, 'Scheduler must be fifo_priority or wfq_aging.');
    let weights = pool.weights;
    if (b.weights !== undefined) {
      const entries = Object.entries(b.weights || {});
      if (!entries.length || entries.some(([k, v]) => !['staff', 'student', 'operator'].includes(k) || !(Number(v) > 0) || Number(v) > 1000)) throw fail(400, 'Weights are positive numbers for staff, student and operator.');
      weights = JSON.stringify(Object.fromEntries(entries.map(([k, v]) => [k, Number(v)])));
    }
    const num = (value, current, min, max, label) => { if (value === undefined) return current; const n = Number(value); if (!(n >= min && n <= max)) throw fail(400, `${label} must be between ${min} and ${max}.`); return n; };
    const aging = num(b.agingRate, pool.aging_rate, 0, 100, 'Aging rate'), maxWait = Math.round(num(b.maxWaitSeconds, pool.max_wait_seconds, 10, 86400, 'Maximum wait')), cap = Math.round(num(b.userCap, pool.user_cap, 1, 1000, 'Per-user cap'));
    await db.transaction(async tx => {
      await tx.query('UPDATE printer_pools SET scheduler=$1, weights=$2, aging_rate=$3, max_wait_seconds=$4, user_cap=$5 WHERE id=$6 AND org_id=$7', [scheduler, weights, aging, maxWait, cap, pool.id, req.org.id]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'pool.scheduler_set', targetType: 'pool', targetId: pool.id, data: { scheduler, weights, aging, maxWait, cap } });
    });
    res.json({ ok: true });
  });

  app.get('/api/v2/edu/queue', viewQueue, async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const rows = status
      ? await db.query('SELECT id,pool_id,class,status,pages,pages_printed,requires_color,requires_duplex,enqueued_at,finished_at FROM print_jobs WHERE org_id=$1 AND status=$2 ORDER BY enqueued_at DESC LIMIT 200', [req.org.id, status])
      : await db.query('SELECT id,pool_id,class,status,pages,pages_printed,requires_color,requires_duplex,enqueued_at,finished_at FROM print_jobs WHERE org_id=$1 ORDER BY enqueued_at DESC LIMIT 200', [req.org.id]);
    res.json(rows);
  });
  const action = (path, permission, fn) => app.post(`/api/v2/edu/jobs/:id/${path}`, requirePermission(db, permission), async (req, res) => {
    await db.transaction(tx => fn(tx, req));
    res.json({ ok: true });
  });
  action('retry', 'jobs.retry', (tx, req) => retryJob(tx, req.org.id, req.params.id, req.user.id));
  action('cancel', 'jobs.cancel_any', (tx, req) => cancelJob(tx, req.org.id, req.params.id, req.user.id));
  action('resolve-uncertain', 'jobs.resolve_uncertain', (tx, req) => resolveUncertain(tx, req.org.id, req.params.id, { printed: req.body.printed === true, pages: req.body.pages }, req.user.id));

  // ======================= Agent protocol v2 (bearer credential, no cookie, no Origin) =======================
  app.post('/api/agent/v2/enroll', async (req, res) => {
    const code = String(req.body.code ?? '');
    const secret = token();
    const result = await db.transaction(async tx => {
      const [agent] = await tx.query("UPDATE agents SET status='active', enrol_hash=NULL, hostname=$1, os=$2, version=$3, instance_id=$4, last_seen=$5 WHERE enrol_hash=$6 AND status='pending' AND enrol_expires>$5 RETURNING id, org_id", [String(req.body.hostname ?? '').slice(0, 100), String(req.body.os ?? '').slice(0, 60), String(req.body.version ?? '').slice(0, 30), String(req.body.instanceId ?? '').slice(0, 64), now(), digest(code)]);
      if (!agent) throw fail(400, 'The enrolment code is invalid, expired or already used.');
      await tx.query('INSERT INTO agent_credentials (id,agent_id,hash,created) VALUES ($1,$2,$3,$4)', [randomUUID(), agent.id, digest(secret), now()]);
      await auditV2(tx, { orgId: agent.org_id, actorType: 'agent', actorId: agent.id, action: 'agent.enrolled', targetType: 'agent', targetId: agent.id });
      return agent;
    });
    res.status(201).json({ agentId: result.id, credential: secret });
  });

  app.use('/api/agent/v2', async (req, res, next) => {
    const [row] = await db.query("SELECT a.*, c.id AS credential_id FROM agent_credentials c JOIN agents a ON a.id=c.agent_id WHERE c.hash=$1 AND c.revoked_at IS NULL AND (c.expires IS NULL OR c.expires>$2) AND a.status='active'", [digest(bearer(req)), now()]);
    if (!row) return next(fail(401, 'Agent credential is invalid or revoked.', 'agent.unauthorized'));
    // Two machines using one credential would both claim work: the one that spoke last is refused for a minute.
    const instance = String(req.headers['x-agent-instance'] ?? '').slice(0, 64);
    if (instance && row.instance_id && row.instance_id !== instance && row.last_seen && Date.now() - Date.parse(row.last_seen) < 60000) return next(fail(409, 'Another instance of this agent is active. Only one installation may use a credential.', 'agent.instance_conflict'));
    await db.query('UPDATE agents SET last_seen=$1, instance_id=COALESCE($2, instance_id) WHERE id=$3', [now(), instance || null, row.id]);
    req.agent = row;
    next();
  });

  // Overlapping credentials: the old one keeps working for 24 hours, then expires. At most two stay valid.
  app.post('/api/agent/v2/credentials/rotate', async (req, res) => {
    const secret = token();
    await db.transaction(async tx => {
      await tx.query('UPDATE agent_credentials SET revoked_at=$1 WHERE agent_id=$2 AND id<>$3 AND revoked_at IS NULL', [now(), req.agent.id, req.agent.credential_id]);
      await tx.query('UPDATE agent_credentials SET expires=$1 WHERE id=$2', [later(24 * 3600000), req.agent.credential_id]);
      await tx.query('INSERT INTO agent_credentials (id,agent_id,hash,created) VALUES ($1,$2,$3,$4)', [randomUUID(), req.agent.id, digest(secret), now()]);
      await auditV2(tx, { orgId: req.agent.org_id, actorType: 'agent', actorId: req.agent.id, action: 'agent.credential_rotated', targetType: 'agent', targetId: req.agent.id });
    });
    res.json({ credential: secret, previousValidHours: 24 });
  });

  app.get('/api/agent/v2/config', async (req, res) => {
    const printers = await db.query('SELECT id, windows_name, display_name, status, paused FROM printers WHERE agent_id=$1 AND org_id=$2', [req.agent.id, req.agent.org_id]);
    res.json({ minVersion: MIN_AGENT_VERSION, latestVersion: LATEST_AGENT_VERSION, heartbeatSeconds: 15, maxClaimWaitSeconds: 25, leaseSeconds: LEASE_MS / 1000, printers });
  });

  app.post('/api/agent/v2/heartbeat', async (req, res) => {
    const version = String(req.body.version ?? '').slice(0, 30);
    await db.transaction(async tx => {
      if (version) await tx.query('UPDATE agents SET version=$1 WHERE id=$2', [version, req.agent.id]);
      for (const item of (Array.isArray(req.body.printers) ? req.body.printers : []).slice(0, 50)) {
        await tx.query('UPDATE printers SET device_status=$1, last_seen=$2 WHERE id=$3 AND agent_id=$4 AND org_id=$5', [String(item.status ?? '').slice(0, 40), now(), String(item.id ?? ''), req.agent.id, req.agent.org_id]);
      }
    });
    await renewLeases(db, req.agent);
    const outdated = Boolean(version) && version.localeCompare(MIN_AGENT_VERSION, undefined, { numeric: true }) < 0;
    res.json({ ok: true, updateRequired: outdated, latestVersion: LATEST_AGENT_VERSION });
  });

  // Discovery report. New printers join the organization's default pool automatically, so a one-printer college
  // needs no setup. Capabilities an administrator set by hand are kept; "unknown" (null) never qualifies a job.
  app.post('/api/agent/v2/printers/report', async (req, res) => {
    const list = (Array.isArray(req.body.printers) ? req.body.printers : []).filter(p => p && typeof p.name === 'string' && p.name.trim()).slice(0, 50);
    const out = await db.transaction(async tx => {
      const poolId = await ensureDefaultPool(tx, req.agent.org_id), result = [];
      for (const item of list) {
        const name = item.name.trim().slice(0, 200), connection = item.connection === 'network' ? 'network' : 'usb';
        let [existing] = await tx.query('SELECT * FROM printers WHERE org_id=$1 AND agent_id=$2 AND windows_name=$3', [req.agent.org_id, req.agent.id, name]);
        if (!existing) {
          const id = randomUUID();
          await tx.query('INSERT INTO printers (id,org_id,agent_id,windows_name,display_name,cap_color,cap_duplex,cap_source,connection_class,device_status,last_seen,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [id, req.agent.org_id, req.agent.id, name, name.slice(0, 100), flag(item.color), flag(item.duplex), 'driver', connection, String(item.status ?? '').slice(0, 40), now(), now()]);
          await tx.query('INSERT INTO pool_members (pool_id,printer_id) VALUES ($1,$2)', [poolId, id]);
          existing = { id };
        } else if (existing.cap_source !== 'admin') {
          await tx.query('UPDATE printers SET cap_color=$1, cap_duplex=$2, cap_source=$3, connection_class=$4, device_status=$5, last_seen=$6 WHERE id=$7', [flag(item.color), flag(item.duplex), 'driver', connection, String(item.status ?? '').slice(0, 40), now(), existing.id]);
        } else {
          await tx.query('UPDATE printers SET connection_class=$1, device_status=$2, last_seen=$3 WHERE id=$4', [connection, String(item.status ?? '').slice(0, 40), now(), existing.id]);
        }
        result.push({ id: existing.id, name });
      }
      return result;
    });
    res.json({ printers: out });
  });

  // Long poll: answers at once if work exists, otherwise waits (up to 25 s) for a new job instead of being polled every second.
  app.post('/api/agent/v2/jobs/claim', async (req, res) => {
    const ids = (Array.isArray(req.body.printerIds) ? req.body.printerIds : []).map(String);
    const waitMs = Math.min(25, Math.max(0, Number(req.body.waitSeconds) || 0)) * 1000, deadline = Date.now() + waitMs;
    let aborted = false;
    req.on('close', () => { aborted = true; });
    for (;;) {
      const jobs = await claimJobs(db, req.agent, ids);
      if (jobs.length || aborted || Date.now() >= deadline) return res.json({ jobs });
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); jobSignal.off('job', onJob); resolve(); };
        const onJob = orgId => { if (!orgId || orgId === req.agent.org_id) done(); };
        const timer = setTimeout(done, Math.min(5000, deadline - Date.now()));
        jobSignal.on('job', onJob);
      });
    }
  });

  const liveAttempt = async req => {
    const [row] = await db.query("SELECT a.*, j.object_id FROM print_attempts a JOIN print_jobs j ON j.id=a.job_id WHERE a.id=$1 AND a.agent_id=$2 AND a.org_id=$3 AND a.lease_token_hash=$4 AND a.state='claimed' AND a.lease_expires>$5", [req.params.id, req.agent.id, req.agent.org_id, digest(String(req.headers['x-lease-token'] ?? '')), now()]);
    if (!row) throw fail(409, 'This attempt is not active for this agent. Do not print it.', 'agent.fenced');
    return row;
  };
  app.get('/api/agent/v2/attempts/:id/document', async (req, res) => {
    const attempt = await liveAttempt(req);
    const [object] = await db.query('SELECT * FROM stored_objects WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL AND expires>$3', [attempt.object_id, req.agent.org_id, now()]);
    if (!object) throw fail(404, 'The document is no longer available.');
    res.set('X-Content-SHA256', object.sha256);
    sendPdf(req, res, await readObject(db, object));
  });
  app.post('/api/agent/v2/attempts/:id/events', async (req, res) => {
    res.json(await recordEvent(db, req.agent, req.params.id, req.headers['x-lease-token'], req.body));
  });
}
