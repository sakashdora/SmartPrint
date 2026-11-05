import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { requirePermission } from './tenant.js';
import { auditV2 } from './orgs.js';
import { sealText, openText } from './topups.js';

// Outbound webhooks for an institution's own systems (ERP, student portal, accounting). Events are written to
// `webhook_deliveries` in the same transaction as the thing that happened (outbox pattern), so nothing is lost and
// nothing is sent for a change that rolled back. A worker delivers them with retries and exponential back-off.
//
// Every request is signed:  SmartPrint-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
// The receiver recomputes the HMAC with its secret and rejects old timestamps. Events carry opaque ids only: no
// names, e-mail addresses or document titles.
//
// SSRF: institutions are tenants, so the URL is untrusted. https only, no credentials in the URL, and the address the
// connection really uses (checked at connect time, which also defeats DNS rebinding) must be a public one.
const fail = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
export const EVENTS = ['job.queued', 'job.completed', 'job.failed', 'job.uncertain', 'job.cancelled', 'job.retried', 'job.uncertain_resolved', 'wallet.topup', 'alert.opened', 'ping'];
const BACKOFF_MINUTES = [1, 5, 30, 120, 360]; // after the 6th failed attempt the delivery is marked dead
const TIMEOUT_MS = 10000, MAX_RESPONSE = 64 * 1024;

// queue_events type -> public event name
const FROM_QUEUE = { 'job.queued': 'job.queued', 'attempt.completed': 'job.completed', 'attempt.failed': 'job.failed', 'attempt.uncertain': 'job.uncertain', 'job.cancelled': 'job.cancelled', 'job.retried': 'job.retried', 'job.uncertain_resolved': 'job.uncertain_resolved' };
export const publicEventName = queueType => FROM_QUEUE[queueType] ?? null;

// ---- SSRF guard ---------------------------------------------------------------------------------------------------
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32], ['100::', 64]]) blocked.addSubnet(net, bits, 'ipv6');
export function isPublicAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped: judge the IPv4 address inside
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(address)) return false;
  }
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
export function validateWebhookUrl(value, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { throw fail(400, 'Enter a full web address, for example https://erp.college.edu/smartprint.'); }
  if (String(value).length > 500) throw fail(400, 'That address is too long.');
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw fail(400, 'The address must start with https://.');
  if (url.username || url.password) throw fail(400, 'Do not put a user name or password in the address; use the signing secret.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host))) throw fail(400, 'That address is not reachable from the internet.');
  if (!allowPrivate && isIP(host) && !isPublicAddress(host)) throw fail(400, 'That address is not reachable from the internet.');
  return url;
}
export const safeLookup = allowPrivate => (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    const bad = !allowPrivate && addresses.find(a => !isPublicAddress(a.address));
    if (bad || !addresses.length) return callback(Object.assign(new Error('Blocked: the address resolves to a private network.'), { code: 'EBLOCKED' }));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

export const sign = (secret, body, timestamp = Math.floor(Date.now() / 1000)) => `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

// POST one body; resolves { status } or { error }. Redirects are never followed.
export function post(urlString, body, headers, { allowPrivate = false } = {}) {
  return new Promise(resolve => {
    let url;
    try { url = validateWebhookUrl(urlString, { allowPrivate }); } catch (error) { return resolve({ error: error.message }); }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && !isPublicAddress(host)) return resolve({ error: 'Blocked: private address.' });
    const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'SmartPrint-Webhook/1', ...headers }, lookup: safeLookup(allowPrivate), timeout: TIMEOUT_MS }, response => {
      let received = 0;
      response.on('data', chunk => { received += chunk.length; if (received > MAX_RESPONSE) response.destroy(); });
      response.on('end', () => resolve({ status: response.statusCode }));
      response.on('error', () => resolve({ status: response.statusCode }));
      response.on('close', () => resolve({ status: response.statusCode }));
    });
    request.on('timeout', () => { request.destroy(); resolve({ error: 'Timed out.' }); });
    request.on('error', error => resolve({ error: error.code === 'EBLOCKED' ? error.message : `Could not connect (${error.code || 'error'}).` }));
    request.end(body);
  });
}

// ---- outbox -------------------------------------------------------------------------------------------------------------
// Call inside the transaction that made the change.
export async function emitEvent(q, orgId, type, data = {}) {
  const endpoints = await q.query("SELECT id, events FROM webhook_endpoints WHERE org_id=$1 AND status='active'", [orgId]);
  if (!endpoints.length) return 0;
  const eventId = randomUUID(), payload = JSON.stringify({ id: eventId, type, created: now(), data });
  let count = 0;
  for (const endpoint of endpoints) {
    const wanted = JSON.parse(endpoint.events || '[]');
    if (!wanted.includes('*') && !wanted.includes(type)) continue;
    await q.query("INSERT INTO webhook_deliveries (id,org_id,endpoint_id,event_id,type,payload,status,attempts,next_attempt,created) VALUES ($1,$2,$3,$4,$5,$6,'pending',0,$7,$7)", [randomUUID(), orgId, endpoint.id, eventId, type, payload, now()]);
    count++;
  }
  return count;
}

// Deliver everything that is due. Safe to run on several servers: each row is claimed with a compare-and-set.
export async function runDeliveries(db, { allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === 'true', limit = 20, at = Date.now() } = {}) {
  const due = await db.query("SELECT d.*, e.url, e.secret_sealed, e.status AS endpoint_status FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.status='pending' AND d.next_attempt<=$1 ORDER BY d.next_attempt LIMIT $2", [new Date(at).toISOString(), limit]);
  let delivered = 0, failed = 0;
  for (const d of due) {
    const lease = new Date(at + 2 * 60000).toISOString();
    const claimed = await db.query("UPDATE webhook_deliveries SET next_attempt=$1 WHERE id=$2 AND next_attempt=$3 AND status='pending' RETURNING id", [lease, d.id, d.next_attempt]);
    if (!claimed.length) continue;
    if (d.endpoint_status !== 'active') { await db.query("UPDATE webhook_deliveries SET status='dead', last_error='Endpoint is disabled.' WHERE id=$1", [d.id]); continue; }
    const secret = await openText(db, d.org_id, d.secret_sealed);
    const result = await post(d.url, d.payload, { 'SmartPrint-Signature': sign(secret, d.payload), 'SmartPrint-Event': d.type, 'SmartPrint-Event-Id': d.event_id, 'SmartPrint-Delivery': d.id }, { allowPrivate });
    const attempts = Number(d.attempts) + 1;
    if (result.status >= 200 && result.status < 300) {
      await db.query("UPDATE webhook_deliveries SET status='delivered', attempts=$1, last_status=$2, last_error=NULL, delivered_at=$3 WHERE id=$4", [attempts, result.status, now(), d.id]);
      delivered++;
    } else {
      const dead = attempts > BACKOFF_MINUTES.length;
      await db.query('UPDATE webhook_deliveries SET status=$1, attempts=$2, last_status=$3, last_error=$4, next_attempt=$5 WHERE id=$6', [dead ? 'dead' : 'pending', attempts, result.status ?? null, result.error ?? `The server answered ${result.status}.`, new Date(at + (BACKOFF_MINUTES[attempts - 1] ?? 360) * 60000).toISOString(), d.id]);
      failed++;
    }
  }
  await db.query("DELETE FROM webhook_deliveries WHERE status IN ('delivered','dead') AND created<=$1", [new Date(at - 30 * 86400000).toISOString()]);
  return { delivered, failed };
}

// ---- admin API ------------------------------------------------------------------------------------------------------------
export function webhookRoutes(app, { db }) {
  const manage = requirePermission(db, 'integrations.manage');
  const present = e => ({ id: e.id, url: e.url, events: JSON.parse(e.events), status: e.status, created: e.created });
  const eventsOf = value => {
    const list = [...new Set(Array.isArray(value) ? value.map(String) : [])];
    if (!list.length) throw fail(400, 'Choose at least one event.');
    for (const name of list) if (name !== '*' && !EVENTS.includes(name)) throw fail(400, `Unknown event "${name}".`);
    return list;
  };
  const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === 'true';
  const own = async req => { const [row] = await db.query('SELECT * FROM webhook_endpoints WHERE id=$1 AND org_id=$2', [req.params.id, req.org.id]); if (!row) throw fail(404, 'Webhook not found.'); return row; };

  app.get('/api/v2/edu/webhooks', manage, async (req, res) => {
    res.json({ events: EVENTS, endpoints: (await db.query('SELECT * FROM webhook_endpoints WHERE org_id=$1 ORDER BY created', [req.org.id])).map(present) });
  });
  app.post('/api/v2/edu/webhooks', manage, async (req, res) => {
    const url = validateWebhookUrl(req.body.url, { allowPrivate: allowPrivate() });
    const events = eventsOf(req.body.events);
    const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM webhook_endpoints WHERE org_id=$1', [req.org.id]);
    if (Number(n) >= 5) throw fail(409, 'An institution can have at most 5 webhooks.');
    const id = randomUUID(), secret = `whsec_${randomBytes(24).toString('hex')}`;
    await db.transaction(async tx => {
      await tx.query("INSERT INTO webhook_endpoints (id,org_id,url,secret_sealed,events,status,created) VALUES ($1,$2,$3,$4,$5,'active',$6)", [id, req.org.id, url.toString(), await sealText(tx, req.org.id, secret), JSON.stringify(events), now()]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'webhook.created', targetType: 'webhook', targetId: id, data: { host: url.host } });
    });
    res.status(201).json({ id, secret, note: 'Copy the signing secret now. It is not shown again.' });
  });
  app.patch('/api/v2/edu/webhooks/:id', manage, async (req, res) => {
    const row = await own(req);
    const url = req.body.url === undefined ? row.url : validateWebhookUrl(req.body.url, { allowPrivate: allowPrivate() }).toString();
    const events = req.body.events === undefined ? row.events : JSON.stringify(eventsOf(req.body.events));
    const status = req.body.status === undefined ? row.status : req.body.status;
    if (!['active', 'disabled'].includes(status)) throw fail(400, 'Status must be active or disabled.');
    await db.transaction(async tx => {
      await tx.query('UPDATE webhook_endpoints SET url=$1, events=$2, status=$3 WHERE id=$4', [url, events, status, row.id]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'webhook.updated', targetType: 'webhook', targetId: row.id, data: { status } });
    });
    res.json({ ok: true });
  });
  app.post('/api/v2/edu/webhooks/:id/rotate-secret', manage, async (req, res) => {
    const row = await own(req), secret = `whsec_${randomBytes(24).toString('hex')}`;
    await db.transaction(async tx => {
      await tx.query('UPDATE webhook_endpoints SET secret_sealed=$1 WHERE id=$2', [await sealText(tx, req.org.id, secret), row.id]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'webhook.secret_rotated', targetType: 'webhook', targetId: row.id });
    });
    res.json({ secret, note: 'The old secret stopped working. Copy this one now; it is not shown again.' });
  });
  app.delete('/api/v2/edu/webhooks/:id', manage, async (req, res) => {
    const row = await own(req);
    await db.transaction(async tx => {
      await tx.query('DELETE FROM webhook_deliveries WHERE endpoint_id=$1', [row.id]);
      await tx.query('DELETE FROM webhook_endpoints WHERE id=$1', [row.id]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'webhook.deleted', targetType: 'webhook', targetId: row.id });
    });
    res.json({ ok: true });
  });
  // Queue a `ping` to this endpoint only, so the institution can check its receiver.
  app.post('/api/v2/edu/webhooks/:id/test', manage, async (req, res) => {
    const row = await own(req), eventId = randomUUID();
    await db.query("INSERT INTO webhook_deliveries (id,org_id,endpoint_id,event_id,type,payload,status,attempts,next_attempt,created) VALUES ($1,$2,$3,$4,'ping',$5,'pending',0,$6,$6)", [randomUUID(), req.org.id, row.id, eventId, JSON.stringify({ id: eventId, type: 'ping', created: now(), data: {} }), now()]);
    res.status(202).json({ ok: true });
  });
  app.get('/api/v2/edu/webhooks/:id/deliveries', manage, async (req, res) => {
    const row = await own(req);
    const rows = await db.query('SELECT id, event_id, type, status, attempts, last_status, last_error, next_attempt, created, delivered_at FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY created DESC LIMIT 50', [row.id]);
    res.json(rows.map(r => ({ id: r.id, eventId: r.event_id, type: r.type, status: r.status, attempts: Number(r.attempts), lastStatus: r.last_status, lastError: r.last_error, nextAttempt: r.status === 'pending' ? r.next_attempt : null, created: r.created, deliveredAt: r.delivered_at })));
  });
}
