import { randomUUID } from 'node:crypto';
import { requirePermission } from './tenant.js';
import { auditV2 } from './orgs.js';

// Student wallet: an immutable ledger with cached balances.
//
//  * `ledger_entries` is insert-only (database triggers refuse UPDATE and DELETE). Every posting is a set of lines
//    that sum to zero, grouped by `txn_id`; money entering or leaving the institution passes through the system
//    account "external", so the sum of all lines of an institution is always zero.
//  * `wallet_balances` is a cache updated in the SAME transaction as the lines. A conditional UPDATE refuses to take
//    a balance below zero, so concurrent spends cannot overspend; the CHECK constraint is the last line of defence.
//  * A posting is idempotent: its lines carry `idem_key = <posting key>:<line>` which is unique per institution, so a
//    repeated request or a retried event changes nothing.
//  * A print job first HOLDS its price (available -> held), then CAPTURES it when it printed (held -> institution
//    revenue, any unused part back to available) or RELEASES it if it never printed.
// Money is in minor units (paise), as integers.
const now = () => new Date().toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const MAX_MANUAL_MINOR = 5_000_000; // ₹50,000 per manual posting

export async function ensureAccount(tx, orgId, ownerId, kind) {
  const [existing] = await tx.query('SELECT id FROM wallet_accounts WHERE org_id=$1 AND owner_id=$2 AND kind=$3', [orgId, ownerId, kind]);
  if (existing) return existing.id;
  const id = randomUUID();
  await tx.query('INSERT INTO wallet_accounts (id,org_id,owner_id,kind,created) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(org_id, owner_id, kind) DO NOTHING', [id, orgId, ownerId, kind, now()]);
  const [account] = await tx.query('SELECT id FROM wallet_accounts WHERE org_id=$1 AND owner_id=$2 AND kind=$3', [orgId, ownerId, kind]);
  await tx.query('INSERT INTO wallet_balances (account_id,available_minor,held_minor,version,allow_negative) VALUES ($1,0,0,0,$2) ON CONFLICT(account_id) DO NOTHING', [account.id, kind === 'student' ? 0 : 1]);
  return account.id;
}
const systemAccount = (tx, orgId, kind) => ensureAccount(tx, orgId, orgId, kind); // 'external' and 'revenue'

// Applies one balanced posting. Returns { replay: true } when the key was already posted.
export async function post(tx, { orgId, key, kind, refType = null, refId = null, actor = null, note = null, lines }) {
  if (lines.reduce((sum, l) => sum + l.available + l.held, 0) !== 0) throw new Error('A posting must sum to zero.');
  const [seen] = await tx.query('SELECT txn_id FROM ledger_entries WHERE org_id=$1 AND idem_key=$2', [orgId, `${key}:0`]);
  if (seen) return { replay: true, txnId: seen.txn_id };
  const txnId = randomUUID();
  // Lock order is by account id so two postings touching the same accounts cannot deadlock.
  const ordered = lines.map((line, index) => ({ ...line, index })).sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
  for (const line of ordered) {
    const moved = await tx.query(
      'UPDATE wallet_balances SET available_minor=available_minor+$1, held_minor=held_minor+$2, version=version+1 WHERE account_id=$3 AND (allow_negative=1 OR (available_minor+$1>=0 AND held_minor+$2>=0)) RETURNING available_minor',
      [line.available, line.held, line.accountId]
    );
    if (!moved.length) throw fail(402, 'The wallet balance is not enough.', 'wallet.insufficient_funds');
  }
  for (const line of lines.map((l, i) => ({ ...l, index: i }))) {
    await tx.query('INSERT INTO ledger_entries (id,org_id,account_id,txn_id,kind,available_delta,held_delta,idem_key,ref_type,ref_id,note,actor,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [randomUUID(), orgId, line.accountId, txnId, kind, line.available, line.held, `${key}:${line.index}`, refType, refId, note, actor, now()]);
  }
  return { replay: false, txnId };
}

export async function balanceOf(q, accountId) {
  const [b] = await q.query('SELECT available_minor, held_minor FROM wallet_balances WHERE account_id=$1', [accountId]);
  return { available: Number(b?.available_minor ?? 0), held: Number(b?.held_minor ?? 0) };
}

export async function creditStudent(tx, { orgId, userId, amountMinor, key, kind = 'credit', actor = null, note = null }) {
  const account = await ensureAccount(tx, orgId, userId, 'student'), external = await systemAccount(tx, orgId, 'external');
  return post(tx, { orgId, key, kind, refType: 'user', refId: userId, actor, note, lines: [{ accountId: external, available: -amountMinor, held: 0 }, { accountId: account, available: amountMinor, held: 0 }] });
}
export async function debitStudent(tx, { orgId, userId, amountMinor, key, actor = null, note = null }) {
  const account = await ensureAccount(tx, orgId, userId, 'student'), external = await systemAccount(tx, orgId, 'external');
  return post(tx, { orgId, key, kind: 'debit', refType: 'user', refId: userId, actor, note, lines: [{ accountId: account, available: -amountMinor, held: 0 }, { accountId: external, available: amountMinor, held: 0 }] });
}

// ---- print jobs -------------------------------------------------------------------------------------------------
// Called inside the transaction that creates the job: not enough money means no job.
export async function holdForJob(tx, { orgId, userId, jobId, amountMinor }) {
  if (amountMinor <= 0) return null;
  const account = await ensureAccount(tx, orgId, userId, 'student');
  const holdId = randomUUID();
  try {
    await post(tx, { orgId, key: `hold:${jobId}`, kind: 'hold', refType: 'job', refId: jobId, actor: userId, lines: [{ accountId: account, available: -amountMinor, held: amountMinor }] });
  } catch (error) {
    if (error.code === 'wallet.insufficient_funds') {
      const { available } = await balanceOf(tx, account);
      throw fail(402, `Not enough wallet balance: this job costs ₹${(amountMinor / 100).toFixed(2)} and you have ₹${(available / 100).toFixed(2)}.`, 'wallet.insufficient_funds');
    }
    throw error;
  }
  await tx.query("INSERT INTO wallet_holds (id,org_id,account_id,job_id,amount_minor,state,created) VALUES ($1,$2,$3,$4,$5,'open',$6)", [holdId, orgId, account, jobId, amountMinor, now()]);
  return holdId;
}

const openHold = async (tx, jobId) => (await tx.query("SELECT * FROM wallet_holds WHERE job_id=$1 AND state='open'", [jobId]))[0];
const proRata = (cost, pages, printed) => printed >= pages ? cost : Math.min(cost, Math.ceil(cost * Math.max(0, printed) / pages));

// The job printed `printedPages` of `job.pages`: charge for what came out, give the rest back.
export async function settleJob(tx, job, printedPages) {
  if (job.payer !== 'wallet') return;
  const hold = await openHold(tx, job.id);
  if (!hold) return;
  const charge = Math.min(Number(hold.amount_minor), proRata(Number(job.cost_minor), Number(job.pages), Number(printedPages)));
  const revenue = await systemAccount(tx, job.org_id, 'revenue');
  await post(tx, { orgId: job.org_id, key: `capture:${job.id}`, kind: 'capture', refType: 'job', refId: job.id, lines: [
    { accountId: hold.account_id, available: Number(hold.amount_minor) - charge, held: -Number(hold.amount_minor) },
    { accountId: revenue, available: charge, held: 0 }
  ] });
  await tx.query("UPDATE wallet_holds SET state='captured', closed=$1 WHERE id=$2 AND state='open'", [now(), hold.id]);
}
// Nothing printed and the job is gone: the whole hold goes back.
export async function releaseJob(tx, job) {
  if (job.payer !== 'wallet') return;
  const hold = await openHold(tx, job.id);
  if (!hold) return;
  await post(tx, { orgId: job.org_id, key: `release:${job.id}`, kind: 'release', refType: 'job', refId: job.id, lines: [{ accountId: hold.account_id, available: Number(hold.amount_minor), held: -Number(hold.amount_minor) }] });
  await tx.query("UPDATE wallet_holds SET state='released', closed=$1 WHERE id=$2 AND state='open'", [now(), hold.id]);
}

// ---- consistency check ------------------------------------------------------------------------------------------
export async function verifyLedger(q, orgId) {
  const problems = [];
  const accounts = await q.query('SELECT a.id, a.kind, b.available_minor, b.held_minor FROM wallet_accounts a JOIN wallet_balances b ON b.account_id=a.id WHERE a.org_id=$1', [orgId]);
  for (const account of accounts) {
    const [sum] = await q.query('SELECT COALESCE(SUM(available_delta),0) AS a, COALESCE(SUM(held_delta),0) AS h FROM ledger_entries WHERE account_id=$1', [account.id]);
    if (Number(sum.a) !== Number(account.available_minor) || Number(sum.h) !== Number(account.held_minor)) problems.push(`account ${account.id}: cached balance differs from the ledger`);
    if (account.kind === 'student' && (Number(account.available_minor) < 0 || Number(account.held_minor) < 0)) problems.push(`account ${account.id}: negative balance`);
  }
  const unbalanced = await q.query('SELECT txn_id FROM ledger_entries WHERE org_id=$1 GROUP BY txn_id HAVING SUM(available_delta + held_delta) <> 0', [orgId]);
  for (const row of unbalanced) problems.push(`posting ${row.txn_id} does not sum to zero`);
  const [total] = await q.query('SELECT COALESCE(SUM(available_delta + held_delta),0) AS s FROM ledger_entries WHERE org_id=$1', [orgId]);
  if (Number(total.s) !== 0) problems.push('the institution ledger does not sum to zero');
  const orphans = await q.query("SELECT h.id FROM wallet_holds h WHERE h.org_id=$1 AND h.state='open' AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.id=h.job_id AND j.status IN ('queued','claimed','submitted','uncertain','failed'))", [orgId]);
  for (const row of orphans) problems.push(`hold ${row.id} is open but its job is over`);
  return { ok: problems.length === 0, accounts: accounts.length, problems };
}

// ---- HTTP ---------------------------------------------------------------------------------------------------------------
export function walletRoutes(app, { db }) {
  const need = permission => requirePermission(db, permission);
  const amount = value => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MANUAL_MINOR) throw fail(400, `Enter an amount between 1 paisa and ₹${MAX_MANUAL_MINOR / 100}.`);
    return n;
  };
  const idem = req => {
    const key = String(req.headers['idempotency-key'] ?? req.body.idempotencyKey ?? '');
    if (key.length < 8 || key.length > 100) throw fail(400, 'An idempotency key of 8–100 characters is required, so a repeated request cannot post twice.', 'wallet.idempotency_required');
    return key;
  };
  const student = async (tx, req) => {
    const [profile] = await tx.query("SELECT user_id, name, college_id FROM edu_profiles WHERE user_id=$1 AND org_id=$2 AND kind='student'", [req.params.userId, req.org.id]);
    if (!profile) throw fail(404, 'Student not found.');
    return profile;
  };
  const entries = (q, accountId, limit = 50) => q.query('SELECT id, kind, available_delta, held_delta, ref_type, ref_id, note, created FROM ledger_entries WHERE account_id=$1 ORDER BY created DESC, id DESC LIMIT $2', [accountId, limit]);

  app.get('/api/v2/edu/wallet', need('wallet.view_own'), async (req, res) => {
    const out = await db.transaction(async tx => {
      const account = await ensureAccount(tx, req.org.id, req.user.id, 'student');
      return { balance: await balanceOf(tx, account), ledger: await entries(tx, account) };
    });
    res.json({ available: out.balance.available, held: out.balance.held, ledger: out.ledger.map(e => ({ ...e, available_delta: Number(e.available_delta), held_delta: Number(e.held_delta) })) });
  });
  app.get('/api/v2/edu/wallets', need('wallet.view_any'), async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const rows = await db.query("SELECT p.user_id, p.name, p.college_id, COALESCE(b.available_minor,0) AS available, COALESCE(b.held_minor,0) AS held FROM edu_profiles p LEFT JOIN wallet_accounts a ON a.owner_id=p.user_id AND a.org_id=p.org_id AND a.kind='student' LEFT JOIN wallet_balances b ON b.account_id=a.id WHERE p.org_id=$1 AND p.kind='student' ORDER BY p.name LIMIT 1000", [req.org.id]);
    res.json(rows.filter(r => !q || r.name.toLowerCase().includes(q) || r.college_id.toLowerCase().includes(q)).map(r => ({ ...r, available: Number(r.available), held: Number(r.held) })));
  });
  app.get('/api/v2/edu/wallets/verify', need('wallet.view_any'), async (req, res) => res.json(await verifyLedger(db, req.org.id)));
  app.get('/api/v2/edu/wallets/:userId/ledger', need('wallet.view_any'), async (req, res) => {
    const out = await db.transaction(async tx => {
      const profile = await student(tx, req), account = await ensureAccount(tx, req.org.id, profile.user_id, 'student');
      return { profile, balance: await balanceOf(tx, account), ledger: await entries(tx, account, 200) };
    });
    res.json({ name: out.profile.name, collegeId: out.profile.college_id, ...out.balance, ledger: out.ledger.map(e => ({ ...e, available_delta: Number(e.available_delta), held_delta: Number(e.held_delta) })) });
  });
  for (const [path, fn] of [['credit', creditStudent], ['debit', debitStudent]]) {
    app.post(`/api/v2/edu/wallets/:userId/${path}`, need('wallet.adjust'), async (req, res) => {
      const amountMinor = amount(req.body.amountMinor), key = idem(req), note = String(req.body.note ?? '').trim().slice(0, 200);
      if (!note) throw fail(400, 'A reason is required for a manual wallet change.');
      const result = await db.transaction(async tx => {
        const profile = await student(tx, req);
        const posted = await fn(tx, { orgId: req.org.id, userId: profile.user_id, amountMinor, key: `manual:${path}:${key}`, kind: path === 'credit' ? 'credit' : undefined, actor: req.user.id, note });
        if (!posted.replay) await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: `wallet.${path}`, targetType: 'user', targetId: profile.user_id, data: { amountMinor, note } });
        return { posted, balance: await balanceOf(tx, await ensureAccount(tx, req.org.id, profile.user_id, 'student')) };
      });
      res.status(result.posted.replay ? 200 : 201).json({ ok: true, replay: result.posted.replay, ...result.balance });
    });
  }
}
