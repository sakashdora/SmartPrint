import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { token, digest } from './security.js';

// Education print queue: jobs, fenced attempts and the rules that keep a job from printing twice.
//
//  * A job is claimed with one conditional UPDATE (status 'queued' -> 'claimed'); on PostgreSQL the candidate
//    rows are also taken with FOR UPDATE SKIP LOCKED so concurrent agents never even look at the same row.
//  * Every claim creates an attempt. A partial unique index allows only ONE live attempt (claimed, submitted
//    or uncertain) per job, so a second live attempt is impossible even if this code were wrong.
//  * Every agent call carries the attempt id and its lease token. An attempt that is no longer live, or a
//    wrong token, is "fenced": the agent must discard the job and never print it.
//  * Agents write a durable journal and report `submitted` BEFORE handing the file to Windows. Expiry of a
//    lease that was only `claimed` is therefore safe to re-queue; anything after `submitted` becomes
//    `uncertain` and is never retried automatically.
const now = () => new Date().toISOString();
const later = ms => new Date(Date.now() + ms).toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

export const LEASE_MS = 90000;
export const AGENT_ONLINE_MS = 45000;
export const LIVE_STATES = ['claimed', 'submitted', 'uncertain'];
export const jobSignal = new EventEmitter();
jobSignal.setMaxListeners(0);

export const printerSupports = (printer, job) =>
  (!Number(job.requires_color) || Number(printer.cap_color) === 1) && (!Number(job.requires_duplex) || Number(printer.cap_duplex) === 1);
export const agentOnline = lastSeen => Boolean(lastSeen) && Date.now() - Date.parse(lastSeen) < AGENT_ONLINE_MS;

const queueEvent = (tx, orgId, jobId, type, actor, data = {}) =>
  tx.query('INSERT INTO queue_events (id,org_id,job_id,type,actor,data,created) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), orgId, jobId, type, actor, JSON.stringify(data), now()]);

export async function ensureDefaultPool(tx, orgId) {
  const [existing] = await tx.query('SELECT id FROM printer_pools WHERE org_id=$1 AND is_default=1', [orgId]);
  if (existing) return existing.id;
  const id = randomUUID();
  await tx.query("INSERT INTO printer_pools (id,org_id,name,scheduler,is_default,created) VALUES ($1,$2,'Default','fifo_priority',1,$3) ON CONFLICT(org_id, name) DO NOTHING", [id, orgId, now()]);
  const [pool] = await tx.query('SELECT id FROM printer_pools WHERE org_id=$1 AND is_default=1', [orgId]);
  return pool.id;
}

export async function storeObject(tx, orgId, bytes, { encrypt, key, expiresMs = 24 * 3600000, ownerId = null }) {
  const { createHash } = await import('node:crypto');
  const sealed = encrypt(bytes, key), id = randomUUID();
  await tx.query('INSERT INTO stored_objects (id,org_id,size,sha256,iv,tag,payload,expires,created,owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, orgId, bytes.length, createHash('sha256').update(bytes).digest('hex'), sealed.iv, sealed.tag, sealed.payload, later(expiresMs), now(), ownerId]);
  return id;
}

// Default: the document is wiped as soon as the job is done. An institution may keep it for up to 30 days
// (institution_settings.retentionHoursAfterPrint); the expiry sweep then wipes it.
async function deleteObject(tx, orgId, objectId) {
  if (!objectId) return;
  const [settings] = await tx.query('SELECT policies FROM institution_settings WHERE org_id=$1', [orgId]);
  const hours = Number(JSON.parse(settings?.policies || '{}').retentionHoursAfterPrint) || 0;
  if (hours > 0) await tx.query('UPDATE stored_objects SET expires=$1 WHERE id=$2 AND org_id=$3 AND deleted_at IS NULL', [later(hours * 3600000), objectId, orgId]);
  else await tx.query('UPDATE stored_objects SET payload=$1, deleted_at=$2 WHERE id=$3 AND org_id=$4', [Buffer.alloc(0), now(), objectId, orgId]);
}

// Rejects a job nobody can print instead of leaving it queued for ever: some active printer of the pool must
// be able to do it and be reachable through an agent that reported in recently.
export async function enqueueJob(tx, { orgId, poolId = null, submitterId = null, jobClass = 'staff', objectId, options = {}, pages, sheets = pages, payer = 'institution', costMinor = 0, priorityBoost = 0 }) {
  const pool = poolId ? (await tx.query('SELECT id FROM printer_pools WHERE id=$1 AND org_id=$2', [poolId, orgId]))[0] : { id: await ensureDefaultPool(tx, orgId) };
  if (!pool) throw fail(404, 'Printer pool not found.');
  const job = { requires_color: options.color === 'color' ? 1 : 0, requires_duplex: options.duplex ? 1 : 0 };
  const printers = await tx.query(
    "SELECT p.*, a.last_seen AS agent_seen FROM pool_members m JOIN printers p ON p.id=m.printer_id JOIN agents a ON a.id=p.agent_id WHERE m.pool_id=$1 AND p.org_id=$2 AND p.status='active' AND a.status='active'",
    [pool.id, orgId]
  );
  if (!printers.some(p => printerSupports(p, job) && agentOnline(p.agent_seen))) {
    const needs = [job.requires_color && 'colour', job.requires_duplex && 'two-sided'].filter(Boolean).join(' and ');
    throw fail(409, `No online printer${needs ? ` that supports ${needs} printing` : ''} is available in this pool.`, 'job.no_compatible_printer');
  }
  const id = randomUUID();
  await tx.query(
    "INSERT INTO print_jobs (id,org_id,pool_id,submitter_id,class,status,object_id,options,pages,sheets,requires_color,requires_duplex,priority_boost,payer,cost_minor,enqueued_at) VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    [id, orgId, pool.id, submitterId, jobClass, objectId, JSON.stringify(options), pages, sheets, job.requires_color, job.requires_duplex, priorityBoost, payer, costMinor, now()]
  );
  await queueEvent(tx, orgId, id, 'job.queued', submitterId, { pool: pool.id, pages });
  setImmediate(() => jobSignal.emit('job', orgId));
  return id;
}

// Hands each named printer of this agent at most one job. Returns [{attemptId, jobId, printerId, ...}].
export async function claimJobs(db, agent, printerIds) {
  const skipLocked = db.kind?.includes('PostgreSQL') ? ' FOR UPDATE SKIP LOCKED' : '';
  return db.transaction(async tx => {
    const claimed = [];
    for (const printerId of printerIds.slice(0, 20)) {
      const [printer] = await tx.query("SELECT * FROM printers WHERE id=$1 AND agent_id=$2 AND org_id=$3 AND status='active' AND paused=0", [printerId, agent.id, agent.org_id]);
      if (!printer) continue;
      const [busy] = await tx.query(`SELECT id FROM print_attempts WHERE printer_id=$1 AND state IN ('claimed','submitted','uncertain') LIMIT 1`, [printer.id]);
      if (busy) continue; // one job at a time per printer; an uncertain job blocks it until an operator decides
      const pools = (await tx.query('SELECT pool_id FROM pool_members WHERE printer_id=$1', [printer.id])).map(r => r.pool_id);
      if (!pools.length) continue;
      // Compatibility is decided in SQL and ONE row is taken. Locking a long candidate list with SKIP LOCKED made a
      // single agent lock every waiting job, so concurrent agents found nothing (PostgreSQL, 5 agents / 20 jobs).
      const marks = pools.map((_, i) => `$${i + 4}`).join(',');
      for (let tries = 0; tries < 3; tries++) {
        const [job] = await tx.query(
          `SELECT * FROM print_jobs WHERE org_id=$1 AND status='queued' AND (requires_color=0 OR $2=1) AND (requires_duplex=0 OR $3=1) AND pool_id IN (${marks}) ORDER BY priority_boost DESC, enqueued_at ASC LIMIT 1${skipLocked}`,
          [agent.org_id, Number(printer.cap_color) === 1 ? 1 : 0, Number(printer.cap_duplex) === 1 ? 1 : 0, ...pools]
        );
        if (!job) break;
        if (!printerSupports(printer, job)) break; // defence in depth: the SQL above already excludes these
        const taken = await tx.query("UPDATE print_jobs SET status='claimed' WHERE id=$1 AND status='queued' RETURNING id", [job.id]);
        if (!taken.length) continue;
        const [{ next }] = await tx.query('SELECT COALESCE(MAX(attempt_no),0)+1 AS next FROM print_attempts WHERE job_id=$1', [job.id]);
        const attemptId = randomUUID(), secret = token();
        await tx.query(
          "INSERT INTO print_attempts (id,org_id,job_id,printer_id,agent_id,attempt_no,state,lease_token_hash,lease_expires,created) VALUES ($1,$2,$3,$4,$5,$6,'claimed',$7,$8,$9)",
          [attemptId, agent.org_id, job.id, printer.id, agent.id, Number(next), digest(secret), later(LEASE_MS), now()]
        );
        await queueEvent(tx, agent.org_id, job.id, 'attempt.claimed', agent.id, { attempt: Number(next), printer: printer.id });
        claimed.push({ attemptId, leaseToken: secret, jobId: job.id, printerId: printer.id, attemptNo: Number(next), options: JSON.parse(job.options), pages: job.pages, objectId: job.object_id, leaseSeconds: LEASE_MS / 1000 });
        break;
      }
    }
    return claimed;
  });
}

const FINAL = { completed: 'completed', failed: 'failed' };

// Applies one agent report to its attempt. 409 `agent.fenced` means: stop, this attempt is not yours any more.
export async function recordEvent(db, agent, attemptId, leaseToken, body) {
  const event = body.event;
  if (!['submitted', 'progress', 'completed', 'failed'].includes(event)) throw fail(400, 'Unknown print event.');
  const pages = Number.isInteger(body.pages) && body.pages >= 0 ? body.pages : null;
  return db.transaction(async tx => {
    const [attempt] = await tx.query('SELECT * FROM print_attempts WHERE id=$1 AND agent_id=$2 AND org_id=$3 AND lease_token_hash=$4', [attemptId, agent.id, agent.org_id, digest(String(leaseToken || ''))]);
    if (!attempt) throw fail(409, 'This attempt does not belong to this agent.', 'agent.fenced');
    if (!LIVE_STATES.includes(attempt.state)) {
      if (FINAL[event] === attempt.state) return { ok: true, state: attempt.state, replay: true };
      throw fail(409, 'This attempt is no longer active. Do not print it.', 'agent.fenced');
    }
    if (attempt.state === 'claimed' && now() > attempt.lease_expires) throw fail(409, 'The lease expired before the job was submitted. Do not print it.', 'agent.fenced');
    const live = (state, jobStatus, extra = '') => Promise.all([
      tx.query(`UPDATE print_attempts SET state=$1, pages_reported=COALESCE($2,pages_reported), error=$3, lease_expires=$4${extra} WHERE id=$5`, [state, pages, body.error ? String(body.error).slice(0, 300) : null, later(LEASE_MS), attempt.id]),
      tx.query('UPDATE print_jobs SET status=$1 WHERE id=$2', [jobStatus, attempt.job_id])
    ]);
    if (event === 'submitted') {
      if (attempt.state !== 'claimed') return { ok: true, state: attempt.state, replay: true };
      await live('submitted', 'submitted');
    } else if (event === 'progress') {
      if (attempt.state !== 'submitted') throw fail(409, 'The job has not been submitted.', 'agent.fenced');
      await tx.query('UPDATE print_attempts SET pages_reported=COALESCE($1,pages_reported), lease_expires=$2 WHERE id=$3', [pages, later(LEASE_MS), attempt.id]);
      return { ok: true, state: 'submitted' };
    } else {
      const [job] = await tx.query('SELECT * FROM print_jobs WHERE id=$1', [attempt.job_id]);
      if (event === 'completed') {
        if (attempt.state === 'claimed') throw fail(409, 'Report `submitted` before `completed`.', 'agent.protocol');
        // A late report from an agent whose lease had been marked uncertain is accepted: it proves the outcome.
        const printedPages = pages ?? job.pages; // computed here: two untyped COALESCE parameters are ambiguous on PostgreSQL
        await tx.query("UPDATE print_attempts SET state='completed', pages_reported=$1, finished=$2 WHERE id=$3", [printedPages, now(), attempt.id]);
        await tx.query("UPDATE print_jobs SET status='completed', pages_printed=$1, finished_at=$2 WHERE id=$3", [printedPages, now(), attempt.job_id]);
        await deleteObject(tx, agent.org_id, job.object_id);
      } else if (attempt.state === 'claimed' || (body.nothingPrinted === true && !(pages > 0))) {
        // Nothing reached the printer, so the operator may retry safely.
        await tx.query("UPDATE print_attempts SET state='failed', error=$1, pages_reported=COALESCE($2,pages_reported), finished=$3 WHERE id=$4", [body.error ? String(body.error).slice(0, 300) : null, pages, now(), attempt.id]);
        await tx.query("UPDATE print_jobs SET status='failed', pages_printed=COALESCE($1,pages_printed) WHERE id=$2", [pages, attempt.job_id]);
      } else {
        // The file was handed to Windows and the outcome is unknown or partial: a person must look at the paper.
        await tx.query("UPDATE print_attempts SET state='uncertain', error=$1, pages_reported=COALESCE($2,pages_reported) WHERE id=$3", [body.error ? String(body.error).slice(0, 300) : null, pages, attempt.id]);
        await tx.query("UPDATE print_jobs SET status='uncertain', pages_printed=COALESCE($1,pages_printed) WHERE id=$2", [pages, attempt.job_id]);
      }
    }
    await queueEvent(tx, agent.org_id, attempt.job_id, `attempt.${event}`, agent.id, { attempt: attempt.attempt_no, pages });
    const [state] = await tx.query('SELECT state FROM print_attempts WHERE id=$1', [attempt.id]);
    return { ok: true, state: state.state };
  });
}

// Heartbeats renew the leases of work the agent is still carrying, so a slow job is not expired while the agent
// is alive; if heartbeats stop, the lease runs out and the sweep below decides.
export async function renewLeases(db, agent) {
  await db.query("UPDATE print_attempts SET lease_expires=$1 WHERE agent_id=$2 AND state IN ('claimed','submitted')", [later(LEASE_MS), agent.id]);
}

// Expired claimed attempt: nothing was handed to Windows -> back to the queue (new attempt later).
// Expired submitted attempt: outcome unknown -> uncertain, a person decides.
export async function sweepAttempts(db) {
  await db.transaction(async tx => {
    const expired = await tx.query("SELECT * FROM print_attempts WHERE state IN ('claimed','submitted') AND lease_expires<$1", [now()]);
    for (const attempt of expired) {
      if (attempt.state === 'claimed') {
        const moved = await tx.query("UPDATE print_attempts SET state='expired', finished=$1 WHERE id=$2 AND state='claimed' RETURNING id", [now(), attempt.id]);
        if (!moved.length) continue;
        await tx.query("UPDATE print_jobs SET status='queued' WHERE id=$1 AND status='claimed'", [attempt.job_id]);
        await queueEvent(tx, attempt.org_id, attempt.job_id, 'attempt.expired_requeued', 'system', { attempt: attempt.attempt_no });
      } else {
        const moved = await tx.query("UPDATE print_attempts SET state='uncertain' WHERE id=$1 AND state='submitted' RETURNING id", [attempt.id]);
        if (!moved.length) continue;
        await tx.query("UPDATE print_jobs SET status='uncertain' WHERE id=$1 AND status='submitted'", [attempt.job_id]);
        await queueEvent(tx, attempt.org_id, attempt.job_id, 'attempt.uncertain', 'system', { attempt: attempt.attempt_no });
      }
    }
  });
  jobSignal.emit('job', null);
}

// Used when an agent is revoked: its unsent work returns to the queue, anything already submitted turns uncertain.
export async function releaseAgentWork(tx, agentId) {
  const live = await tx.query("SELECT * FROM print_attempts WHERE agent_id=$1 AND state IN ('claimed','submitted')", [agentId]);
  for (const attempt of live) {
    const claimed = attempt.state === 'claimed';
    await tx.query('UPDATE print_attempts SET state=$1, finished=$2 WHERE id=$3', [claimed ? 'expired' : 'uncertain', claimed ? now() : null, attempt.id]);
    await tx.query('UPDATE print_jobs SET status=$1 WHERE id=$2', [claimed ? 'queued' : 'uncertain', attempt.job_id]);
    await queueEvent(tx, attempt.org_id, attempt.job_id, claimed ? 'attempt.agent_revoked_requeued' : 'attempt.agent_revoked_uncertain', 'system');
  }
}

// ---- Operator actions (org-scoped; the caller has already checked the permission) ------------------------
export async function retryJob(tx, orgId, jobId, actor) {
  const [job] = await tx.query('SELECT * FROM print_jobs WHERE id=$1 AND org_id=$2', [jobId, orgId]);
  if (!job) throw fail(404, 'Job not found.');
  if (job.status !== 'failed') throw fail(409, job.status === 'uncertain' ? 'The outcome is uncertain: check the paper and resolve it first. Retrying could print twice.' : `A job that is "${job.status}" cannot be retried.`, 'job.not_retryable');
  const [live] = await tx.query("SELECT id FROM print_attempts WHERE job_id=$1 AND state IN ('claimed','submitted','uncertain')", [job.id]);
  if (live) throw fail(409, 'An attempt is still active for this job.', 'job.not_retryable');
  const [object] = job.object_id ? await tx.query('SELECT deleted_at FROM stored_objects WHERE id=$1', [job.object_id]) : [];
  if (!object || object.deleted_at) throw fail(409, 'The document is no longer stored. Ask the user to submit it again.');
  await tx.query("UPDATE print_jobs SET status='queued' WHERE id=$1 AND status='failed'", [job.id]);
  await queueEvent(tx, orgId, job.id, 'job.retried', actor);
  setImmediate(() => jobSignal.emit('job', orgId));
}

export async function cancelJob(tx, orgId, jobId, actor) {
  const [job] = await tx.query('SELECT * FROM print_jobs WHERE id=$1 AND org_id=$2', [jobId, orgId]);
  if (!job) throw fail(404, 'Job not found.');
  if (job.status === 'cancelled') return;
  if (!['queued', 'claimed', 'failed'].includes(job.status)) throw fail(409, job.status === 'completed' ? 'This job already printed.' : 'The job was already sent to a printer. Resolve the outcome first.', 'job.not_cancellable');
  if (job.status === 'claimed') await tx.query("UPDATE print_attempts SET state='cancelled', finished=$1 WHERE job_id=$2 AND state='claimed'", [now(), job.id]);
  await tx.query("UPDATE print_jobs SET status='cancelled', finished_at=$1 WHERE id=$2", [now(), job.id]);
  await deleteObject(tx, orgId, job.object_id);
  await queueEvent(tx, orgId, job.id, 'job.cancelled', actor);
}

export async function resolveUncertain(tx, orgId, jobId, { printed, pages }, actor) {
  const [job] = await tx.query('SELECT * FROM print_jobs WHERE id=$1 AND org_id=$2', [jobId, orgId]);
  if (!job) throw fail(404, 'Job not found.');
  if (job.status !== 'uncertain') throw fail(409, 'This job does not need a decision.');
  const count = Number.isInteger(pages) && pages >= 0 ? pages : (printed ? job.pages : 0);
  await tx.query("UPDATE print_attempts SET state=$1, pages_reported=$2, finished=$3 WHERE job_id=$4 AND state='uncertain'", [printed ? 'completed' : 'failed', count, now(), job.id]);
  await tx.query('UPDATE print_jobs SET status=$1, pages_printed=$2, finished_at=$3 WHERE id=$4', [printed ? 'completed' : 'failed', count, now(), job.id]);
  if (printed) await deleteObject(tx, orgId, job.object_id);
  await queueEvent(tx, orgId, job.id, 'job.uncertain_resolved', actor, { printed, pages: count });
}
