import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { requirePermission } from './tenant.js';
import { auditV2 } from './orgs.js';
import { policiesOf } from './edu.js';
import { ensureAccount, post, balanceOf } from './wallet.js';

// Offline printing for students, without any new payment.
//
//  * A student sets money aside BEFORE the outage: a reservation moves it from "available" to "held" and binds it to
//    ONE agent. The agent can spend only up to that amount, and no other agent has any claim on it, so the same money
//    cannot be spent twice, whatever happens to the network.
//  * Offline the agent identifies the student with the PIN chosen at reservation time (the cloud password cannot be
//    checked without the cloud), and writes every spend to a numbered local log.
//  * On reconnection the agent syncs its log. Each spend is keyed by (agent, sequence number), so a repeated or
//    interrupted sync changes nothing. Spends beyond the reservation are capped and become a reconciliation case that
//    the institution carries, never the student.
//  * Unspent money returns when the agent acknowledges that the reservation is closed, or after expiry plus a grace
//    period.
const now = () => new Date().toISOString();
const later = ms => new Date(Date.now() + ms).toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
export const EXPIRY_GRACE_MS = 6 * 3600000;
const PIN = /^\d{4,8}$/;
const bearerAgent = req => req.agent;

export function pinVerifier(pin) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(pin, salt, 32, { N: 16384 }).toString('hex') };
}
export const pinMatches = (pin, { salt, hash }) => {
  const candidate = scryptSync(String(pin), salt, 32, { N: 16384 }), expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
};

const revenueOf = async (tx, orgId) => ensureAccount(tx, orgId, orgId, 'revenue');
async function release(tx, reservation, key) {
  const remaining = Number(reservation.limit_minor) - Number(reservation.spent_minor);
  if (remaining > 0) await post(tx, { orgId: reservation.org_id, key, kind: 'reservation_release', refType: 'reservation', refId: reservation.id, lines: [{ accountId: reservation.account_id, available: remaining, held: -remaining }] });
}
async function caseFor(tx, orgId, kind, ref, detail) {
  await tx.query('INSERT INTO reconciliation_cases (id,org_id,kind,ref,detail,created) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), orgId, kind, ref, JSON.stringify(detail), now()]);
}

// Releases what was never spent once a reservation is past expiry plus the grace period.
export async function sweepReservations(db) {
  await db.transaction(async tx => {
    const due = await tx.query("SELECT * FROM offline_reservations WHERE state IN ('active','closing') AND expires<$1", [new Date(Date.now() - EXPIRY_GRACE_MS).toISOString()]);
    for (const r of due) {
      const moved = await tx.query("UPDATE offline_reservations SET state='expired', closed=$1 WHERE id=$2 AND state IN ('active','closing') RETURNING id", [now(), r.id]);
      if (moved.length) await release(tx, r, `offrel:${r.id}`);
    }
  });
}

export function offlineRoutes(app, { db }) {
  const need = permission => requirePermission(db, permission);
  const view = r => ({ id: r.id, agentId: r.agent_id, limitMinor: Number(r.limit_minor), spentMinor: Number(r.spent_minor), state: r.state, expires: r.expires, created: r.created });

  // ---------------- student ----------------
  app.post('/api/v2/edu/wallet/reservations', need('wallet.reserve_offline'), async (req, res) => {
    const { policies } = await policiesOf(db, req.org.id);
    if (!policies.offlineStudentPrinting) throw fail(403, 'Offline printing is not enabled for this institution.', 'offline.disabled');
    const amountMinor = Number(req.body.amountMinor), pin = String(req.body.pin ?? '');
    if (!Number.isInteger(amountMinor) || amountMinor < 100) throw fail(400, 'Reserve at least ₹1.00.');
    if (!PIN.test(pin)) throw fail(400, 'Choose a PIN of 4–8 digits. You will enter it at the printer when the internet is down.');
    const verifier = pinVerifier(pin);
    const reservation = await db.transaction(async tx => {
      const [agent] = await tx.query("SELECT id FROM agents WHERE id=$1 AND org_id=$2 AND status='active'", [String(req.body.agentId ?? ''), req.org.id]);
      if (!agent) throw fail(404, 'Print point not found.');
      const account = await ensureAccount(tx, req.org.id, req.user.id, 'student');
      const [{ total }] = await tx.query("SELECT COALESCE(SUM(limit_minor - spent_minor),0) AS total FROM offline_reservations WHERE user_id=$1 AND org_id=$2 AND state IN ('active','closing')", [req.user.id, req.org.id]);
      if (Number(total) + amountMinor > policies.maxReservationMinor) throw fail(400, `You can keep at most ₹${(policies.maxReservationMinor / 100).toFixed(2)} reserved for offline printing at a time.`, 'offline.limit');
      const id = randomUUID();
      await post(tx, { orgId: req.org.id, key: `reserve:${id}`, kind: 'reserve', refType: 'reservation', refId: id, actor: req.user.id, lines: [{ accountId: account, available: -amountMinor, held: amountMinor }] });
      await tx.query("INSERT INTO offline_reservations (id,org_id,account_id,user_id,agent_id,limit_minor,spent_minor,state,pin_salt,pin_hash,expires,created) VALUES ($1,$2,$3,$4,$5,$6,0,'active',$7,$8,$9,$10)", [id, req.org.id, account, req.user.id, agent.id, amountMinor, verifier.salt, verifier.hash, later(policies.reservationHours * 3600000), now()]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'offline.reserved', targetType: 'reservation', targetId: id, data: { amountMinor, agent: agent.id } });
      return (await tx.query('SELECT * FROM offline_reservations WHERE id=$1', [id]))[0];
    });
    res.status(201).json(view(reservation));
  });
  app.get('/api/v2/edu/wallet/reservations', need('wallet.reserve_offline'), async (req, res) => {
    res.json((await db.query('SELECT * FROM offline_reservations WHERE user_id=$1 AND org_id=$2 ORDER BY created DESC LIMIT 50', [req.user.id, req.org.id])).map(view));
  });
  // Cancelling cannot pull money back from an agent that may be holding a copy: it becomes "closing" and the unspent part
  // returns when the agent acknowledges it (or after expiry plus the grace period).
  app.delete('/api/v2/edu/wallet/reservations/:id', need('wallet.reserve_offline'), async (req, res) => {
    const moved = await db.query("UPDATE offline_reservations SET state='closing' WHERE id=$1 AND user_id=$2 AND org_id=$3 AND state='active' RETURNING id", [req.params.id, req.user.id, req.org.id]);
    if (!moved.length) throw fail(404, 'Active reservation not found.');
    res.json({ ok: true, state: 'closing', message: 'The money returns to your wallet once the print point has synced, or when the reservation expires.' });
  });
  // A staff member chooses an offline PIN while online; agents receive only a salted verifier of it.
  app.put('/api/v2/edu/me/offline-pin', need('print.unlimited_official'), async (req, res) => {
    const { policies } = await policiesOf(db, req.org.id);
    if (!policies.offlineStaffPrinting) throw fail(403, 'Offline printing for staff is not enabled for this institution.', 'offline.disabled');
    const pin = String(req.body.pin ?? '');
    if (!PIN.test(pin)) throw fail(400, 'Choose a PIN of 4–8 digits.');
    const v = pinVerifier(pin);
    await db.transaction(async tx => {
      await tx.query('DELETE FROM offline_staff_pins WHERE user_id=$1', [req.user.id]);
      await tx.query('INSERT INTO offline_staff_pins (user_id,org_id,pin_salt,pin_hash,created) VALUES ($1,$2,$3,$4,$5)', [req.user.id, req.org.id, v.salt, v.hash, now()]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'offline.staff_pin_set', targetType: 'user', targetId: req.user.id });
    });
    res.json({ ok: true });
  });
  app.get('/api/v2/edu/offline/reservations', need('wallet.view_any'), async (req, res) => {
    res.json((await db.query('SELECT r.*, p.name, p.college_id FROM offline_reservations r LEFT JOIN edu_profiles p ON p.user_id=r.user_id AND p.org_id=r.org_id WHERE r.org_id=$1 ORDER BY r.created DESC LIMIT 200', [req.org.id])).map(r => ({ ...view(r), name: r.name, collegeId: r.college_id })));
  });
  app.get('/api/v2/edu/offline/cases', need('wallet.view_any'), async (req, res) => {
    res.json((await db.query('SELECT id,kind,ref,detail,created,resolved FROM reconciliation_cases WHERE org_id=$1 ORDER BY created DESC LIMIT 200', [req.org.id])).map(c => ({ ...c, detail: JSON.parse(c.detail) })));
  });

  // ---------------- agent ----------------
  // What this agent may spend: only reservations bound to it. The PIN itself is never sent, only a salted verifier.
  app.get('/api/agent/v2/offline/grants', async (req, res) => {
    const rows = await db.query("SELECT r.*, p.college_id FROM offline_reservations r LEFT JOIN edu_profiles p ON p.user_id=r.user_id AND p.org_id=r.org_id WHERE r.agent_id=$1 AND r.org_id=$2 AND r.state IN ('active','closing')", [bearerAgent(req).id, bearerAgent(req).org_id]);
    const { policies } = await policiesOf(db, bearerAgent(req).org_id);
    const staff = policies.offlineStaffPrinting
      ? await db.query('SELECT p.college_id, s.pin_salt, s.pin_hash FROM offline_staff_pins s JOIN edu_profiles p ON p.user_id=s.user_id AND p.org_id=s.org_id WHERE s.org_id=$1', [bearerAgent(req).org_id])
      : [];
    res.json({
      grants: rows.map(r => ({ id: r.id, collegeId: r.college_id, limitMinor: Number(r.limit_minor), spentMinor: Number(r.spent_minor), state: r.state, expires: r.expires, pin: { salt: r.pin_salt, hash: r.pin_hash } })),
      staff: staff.map(r => ({ collegeId: r.college_id, pin: { salt: r.pin_salt, hash: r.pin_hash } })),
      rates: { bw: policies.studentRateBwMinor, color: policies.studentRateColourMinor },
      limits: { maxPagesPerJob: policies.maxPagesPerJob, maxCopies: policies.maxCopies, colourStudents: policies.colourStudents, colourStaff: policies.colourStaff, staffDailyPages: policies.offlineStaffDailyPages, studentsEnabled: policies.offlineStudentPrinting, staffEnabled: policies.offlineStaffPrinting }
    });
  });

  app.post('/api/agent/v2/sync', async (req, res) => {
    const agent = bearerAgent(req), spends = (Array.isArray(req.body.spends) ? req.body.spends : []).slice(0, 500), jobs = (Array.isArray(req.body.jobs) ? req.body.jobs : []).slice(0, 500), closed = (Array.isArray(req.body.closed) ? req.body.closed : []).slice(0, 100);
    const out = { accepted: 0, replayed: 0, problems: [] };
    await db.transaction(async tx => {
      const fresh = async (seq, kind) => {
        const done = await tx.query('INSERT INTO offline_sync_log (agent_id,seq,kind,created) VALUES ($1,$2,$3,$4) ON CONFLICT(agent_id, seq, kind) DO NOTHING RETURNING seq', [agent.id, seq, kind, now()]);
        return done.length > 0;
      };
      for (const spend of [...spends].sort((a, b) => a.seq - b.seq)) {
        if (!Number.isInteger(spend.seq) || spend.seq < 1 || !Number.isInteger(spend.amountMinor) || spend.amountMinor < 1) { out.problems.push({ seq: spend.seq, problem: 'invalid' }); continue; }
        if (!(await fresh(spend.seq, 'spend'))) { out.replayed++; continue; }
        const [r] = await tx.query('SELECT * FROM offline_reservations WHERE id=$1 AND agent_id=$2 AND org_id=$3', [String(spend.reservationId ?? ''), agent.id, agent.org_id]);
        if (!r) { out.problems.push({ seq: spend.seq, problem: 'unknown_reservation' }); await caseFor(tx, agent.org_id, 'unknown_reservation', `${agent.id}:${spend.seq}`, spend); continue; }
        // Money already returned to the student (expired and swept) cannot be taken again: the institution carries it.
        const room = r.state === 'expired' ? 0 : Number(r.limit_minor) - Number(r.spent_minor);
        const allowed = Math.max(0, Math.min(spend.amountMinor, room));
        if (allowed > 0) {
          await post(tx, { orgId: agent.org_id, key: `offcap:${agent.id}:${spend.seq}`, kind: 'reservation_capture', refType: 'reservation', refId: r.id, lines: [{ accountId: r.account_id, available: 0, held: -allowed }, { accountId: await revenueOf(tx, agent.org_id), available: allowed, held: 0 }] });
          await tx.query('UPDATE offline_reservations SET spent_minor=spent_minor+$1 WHERE id=$2', [allowed, r.id]);
        }
        if (allowed < spend.amountMinor) { out.problems.push({ seq: spend.seq, problem: r.state === 'expired' ? 'expired' : 'over_limit', uncharged: spend.amountMinor - allowed }); await caseFor(tx, agent.org_id, r.state === 'expired' ? 'spend_after_expiry' : 'spend_over_limit', `${agent.id}:${spend.seq}`, { reservation: r.id, requested: spend.amountMinor, charged: allowed }); }
        out.accepted++;
      }
      // Staff jobs printed offline are recorded so usage reports stay complete.
      for (const job of jobs) {
        if (!Number.isInteger(job.seq) || !Number.isInteger(job.pages) || job.pages < 1) { out.problems.push({ seq: job.seq, problem: 'invalid' }); continue; }
        if (!(await fresh(job.seq, 'job'))) { out.replayed++; continue; }
        const [profile] = await tx.query("SELECT p.user_id FROM edu_profiles p JOIN memberships m ON m.user_id=p.user_id AND m.org_id=p.org_id WHERE p.org_id=$1 AND LOWER(p.college_id)=LOWER($2) AND p.kind='staff'", [agent.org_id, String(job.collegeId ?? '')]);
        const [pool] = await tx.query('SELECT id FROM printer_pools WHERE org_id=$1 AND is_default=1', [agent.org_id]);
        if (!profile || !pool) { out.problems.push({ seq: job.seq, problem: 'unknown_staff' }); await caseFor(tx, agent.org_id, 'unknown_staff', `${agent.id}:${job.seq}`, job); continue; }
        await tx.query("INSERT INTO print_jobs (id,org_id,pool_id,submitter_id,class,status,options,pages,sheets,pages_printed,payer,enqueued_at,finished_at) VALUES ($1,$2,$3,$4,'staff','completed',$5,$6,$6,$6,'institution',$7,$7)", [randomUUID(), agent.org_id, pool.id, profile.user_id, JSON.stringify({ offline: true, file_name: String(job.fileName ?? 'offline job').slice(0, 150) }), job.pages, typeof job.at === 'string' && !Number.isNaN(Date.parse(job.at)) ? new Date(job.at).toISOString() : now()]);
        out.accepted++;
      }
      // The agent confirms it will spend no more: the unspent money goes back.
      for (const id of closed) {
        const [r] = await tx.query("SELECT * FROM offline_reservations WHERE id=$1 AND agent_id=$2 AND org_id=$3 AND state IN ('active','closing','expired')", [String(id), agent.id, agent.org_id]);
        if (!r) continue;
        if (r.state === 'expired') continue; // already returned by the sweep
        const moved = await tx.query("UPDATE offline_reservations SET state='closed', closed=$1 WHERE id=$2 AND state IN ('active','closing') RETURNING id", [now(), r.id]);
        if (moved.length) await release(tx, r, `offrel:${r.id}`);
      }
    });
    res.json(out);
  });
}
