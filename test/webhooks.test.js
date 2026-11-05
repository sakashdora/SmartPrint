import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { boot } from './helpers/edu.js';
import { isPublicAddress, validateWebhookUrl, runDeliveries, safeLookup, sign } from '../server/webhooks.js';

// A tiny receiver on 127.0.0.1 that records requests and answers with whatever `behaviour.status` says.
async function receiver(t) {
  const seen = [], behaviour = { status: 200 };
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString() }); res.statusCode = behaviour.status; res.end('ok'); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return { seen, behaviour, url: `http://127.0.0.1:${server.address().port}/hook` };
}
const verify = (secret, message) => {
  const [, t, v1] = message.headers['smartprint-signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  return createHmac('sha256', secret).update(`${t}.${message.body}`).digest('hex') === v1;
};
async function setup(t, events = ['*']) {
  const ctx = await boot(t), admin = await ctx.org('hooks'), rx = await receiver(t);
  const created = await ctx.call('/api/v2/edu/webhooks', { method: 'POST', cookie: admin.cookie, body: { url: 'https://erp.example.com/smartprint', events } });
  assert.equal(created.status, 201);
  await ctx.db.query('UPDATE webhook_endpoints SET url=$1 WHERE id=$2', [rx.url, created.body.id]); // aim at the local receiver
  const deliver = (opts = {}) => runDeliveries(ctx.db, { allowPrivate: true, ...opts });
  return { ctx, admin, rx, id: created.body.id, secret: created.body.secret, deliver };
}

test('addresses on private networks are never acceptable, however they are written', () => {
  for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.5', '64:ff9b::7f00:1', 'not-an-ip']) assert.equal(isPublicAddress(bad), false, bad);
  for (const good of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(good), true, good);
});

test('web addresses are checked when they are saved', () => {
  for (const bad of ['http://erp.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://10.0.0.8/x', 'https://169.254.169.254/latest/meta-data', 'https://intranet/x', 'https://user:pass@erp.example.com/x', 'https://printer.local/x', 'ftp://erp.example.com', 'javascript:alert(1)', '', 'https://a.example.com/' + 'x'.repeat(500)]) assert.throws(() => validateWebhookUrl(bad), /address|https|reachable|web|long|password/i, bad);
  assert.equal(validateWebhookUrl('https://erp.example.com:8443/hooks/smartprint?a=1').port, '8443');
});

test('the connection itself refuses private addresses, even when a name resolves to one (DNS rebinding)', async () => {
  const lookup = safeLookup(false);
  const outcome = await new Promise(resolve => lookup('localhost', {}, (error, address) => resolve({ error, address })));
  assert.equal(outcome.error?.code, 'EBLOCKED');
  const allowed = await new Promise(resolve => safeLookup(true)('localhost', {}, (error, address) => resolve({ error, address })));
  assert.ok(allowed.address, 'only the tests may switch the guard off');
});

test('events are delivered signed, once, with opaque ids only', async t => {
  const { ctx, admin, rx, secret, deliver } = await setup(t);
  const agent = await ctx.agent(admin);
  await ctx.job(admin.orgId);
  assert.deepEqual(await deliver(), { delivered: 1, failed: 0 });
  const queued = JSON.parse(rx.seen[0].body);
  assert.equal(queued.type, 'job.queued');
  assert.ok(verify(secret, rx.seen[0]), 'the signature matches the secret shown at creation');
  assert.equal(rx.seen[0].headers['smartprint-event'], 'job.queued');
  assert.equal(rx.seen[0].headers['smartprint-event-id'], queued.id);
  assert.ok(!verify('whsec_wrong', rx.seen[0]));
  const printed = await agent.printNext('Mono');
  await deliver();
  const types = rx.seen.map(m => JSON.parse(m.body).type);
  assert.deepEqual(types, ['job.queued', 'job.completed']);
  const done = JSON.parse(rx.seen[1].body);
  assert.equal(done.data.jobId, printed.jobId);
  assert.ok(!rx.seen.some(m => m.body.includes(admin.email)), 'no personal data in events');
  assert.deepEqual(await deliver(), { delivered: 0, failed: 0 }, 'delivered events are not sent again');
});

test('only subscribed events go to an endpoint, and a disabled endpoint receives nothing', async t => {
  const { ctx, admin, rx, id, deliver } = await setup(t, ['job.completed']);
  const agent = await ctx.agent(admin);
  await ctx.job(admin.orgId); await agent.printNext('Mono');
  await deliver();
  assert.deepEqual(rx.seen.map(m => JSON.parse(m.body).type), ['job.completed']);
  assert.equal((await ctx.call(`/api/v2/edu/webhooks/${id}`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'disabled' } })).status, 200);
  await ctx.job(admin.orgId); await agent.printNext('Mono'); await deliver();
  assert.equal(rx.seen.length, 1);
  assert.equal(await ctx.number("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status='pending'"), 0, 'nothing even queued for a disabled endpoint');
});

test('a failing receiver is retried with back-off and finally given up on', async t => {
  const { ctx, admin, rx, id, deliver } = await setup(t, ['job.queued']);
  await ctx.agent(admin);
  rx.behaviour.status = 500;
  await ctx.job(admin.orgId);
  const start = Date.now();
  assert.deepEqual(await deliver({ at: start }), { delivered: 0, failed: 1 });
  let [row] = await ctx.db.query('SELECT * FROM webhook_deliveries');
  assert.equal([row.status, Number(row.attempts), Number(row.last_status)].join(), 'pending,1,500');
  assert.deepEqual(await deliver({ at: start + 30000 }), { delivered: 0, failed: 0 }, 'not due yet');
  // Back in service: the next try delivers the same event.
  rx.behaviour.status = 200;
  assert.deepEqual(await deliver({ at: start + 90000 }), { delivered: 1, failed: 0 });
  assert.equal(JSON.parse(rx.seen.at(-1).body).id, JSON.parse(rx.seen[0].body).id, 'same event id on every retry, so receivers can de-duplicate');
  // A receiver that never recovers.
  rx.behaviour.status = 503;
  await ctx.job(admin.orgId);
  let at = start + 3600000;
  for (let i = 0; i < 6; i++) { await deliver({ at }); at += 7 * 3600000; }
  [row] = await ctx.db.query("SELECT * FROM webhook_deliveries WHERE status<>'delivered'");
  assert.equal(row.status, 'dead');
  assert.equal(Number(row.attempts), 6);
  const history = (await ctx.call(`/api/v2/edu/webhooks/${id}/deliveries`, { cookie: admin.cookie })).body;
  assert.ok(history.some(d => d.status === 'dead' && d.lastError));
});

test('an unreachable receiver is recorded, not thrown', async t => {
  const { ctx, admin, id, deliver } = await setup(t, ['job.queued']);
  await ctx.agent(admin);
  await ctx.db.query('UPDATE webhook_endpoints SET url=$1 WHERE id=$2', ['http://127.0.0.1:1/never', id]);
  await ctx.job(admin.orgId);
  assert.deepEqual(await deliver(), { delivered: 0, failed: 1 });
  assert.match((await ctx.db.query('SELECT last_error FROM webhook_deliveries'))[0].last_error, /Could not connect/);
  // With the guard on (production behaviour) a private target is refused outright.
  await ctx.db.query("UPDATE webhook_deliveries SET next_attempt='2000-01-01T00:00:00.000Z'");
  await ctx.db.query('UPDATE webhook_endpoints SET url=$1 WHERE id=$2', ['https://127.0.0.1/never', id]);
  await runDeliveries(ctx.db, { allowPrivate: false });
  assert.match((await ctx.db.query('SELECT last_error FROM webhook_deliveries'))[0].last_error, /reachable|private/i);
});

test('the signing secret is stored sealed, can be rotated, and is shown only once', async t => {
  const { ctx, admin, rx, id, secret, deliver } = await setup(t, ['ping']);
  const [row] = await ctx.db.query('SELECT secret_sealed FROM webhook_endpoints WHERE id=$1', [id]);
  assert.ok(!row.secret_sealed.includes(secret));
  assert.ok(!JSON.stringify((await ctx.call('/api/v2/edu/webhooks', { cookie: admin.cookie })).body).includes(secret), 'listing never shows it');
  assert.equal((await ctx.call(`/api/v2/edu/webhooks/${id}/test`, { method: 'POST', cookie: admin.cookie })).status, 202);
  await deliver();
  assert.equal(JSON.parse(rx.seen[0].body).type, 'ping');
  assert.ok(verify(secret, rx.seen[0]));
  const rotated = (await ctx.call(`/api/v2/edu/webhooks/${id}/rotate-secret`, { method: 'POST', cookie: admin.cookie })).body.secret;
  assert.notEqual(rotated, secret);
  await ctx.call(`/api/v2/edu/webhooks/${id}/test`, { method: 'POST', cookie: admin.cookie }); await deliver();
  assert.ok(verify(rotated, rx.seen[1]) && !verify(secret, rx.seen[1]));
  assert.equal(sign('k', '{}', 1700000000), `t=1700000000,v1=${createHmac('sha256', 'k').update('1700000000.{}').digest('hex')}`);
});

test('webhooks are managed by the institution administrator only, inside their own institution', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('mine'), rival = await ctx.org('rival');
  const student = await ctx.member(admin.orgId, 'student'), hod = await ctx.member(admin.orgId, 'department_admin');
  const body = { url: 'https://erp.example.com/h', events: ['job.completed'] };
  assert.equal((await ctx.call('/api/v2/edu/webhooks', { method: 'POST', cookie: student.cookie, body })).status, 403);
  assert.equal((await ctx.call('/api/v2/edu/webhooks', { method: 'POST', cookie: hod.cookie, body })).status, 403);
  assert.equal((await ctx.call('/api/v2/edu/webhooks', { method: 'POST' , body })).status, 401);
  const id = (await ctx.call('/api/v2/edu/webhooks', { method: 'POST', cookie: admin.cookie, body })).body.id;
  assert.deepEqual((await ctx.call('/api/v2/edu/webhooks', { cookie: rival.cookie })).body.endpoints, []);
  for (const [method, path] of [['PATCH', ''], ['DELETE', ''], ['POST', '/rotate-secret'], ['POST', '/test'], ['GET', '/deliveries']]) assert.equal((await ctx.call(`/api/v2/edu/webhooks/${id}${path}`, { method, cookie: rival.cookie, body: method === 'PATCH' ? { status: 'disabled' } : undefined })).status, 404, `${method} ${path}`);
  // Validation and limits.
  for (const bad of [{ url: 'http://erp.example.com/h', events: ['*'] }, { url: 'https://10.0.0.1/h', events: ['*'] }, { url: 'https://erp.example.com/h', events: [] }, { url: 'https://erp.example.com/h', events: ['made.up'] }]) assert.equal((await ctx.call('/api/v2/edu/webhooks', { method: 'POST', cookie: admin.cookie, body: bad })).status, 400, JSON.stringify(bad));
  for (let i = 0; i < 4; i++) assert.equal((await ctx.call('/api/v2/edu/webhooks', { method: 'POST', cookie: admin.cookie, body })).status, 201);
  assert.equal((await ctx.call('/api/v2/edu/webhooks', { method: 'POST', cookie: admin.cookie, body })).status, 409, 'at most five');
  // A rival's events never reach this institution's endpoint.
  await ctx.agent(rival);
  await ctx.job(rival.orgId);
  assert.equal(await ctx.number('SELECT COUNT(*) AS n FROM webhook_deliveries'), 0);
  assert.equal((await ctx.call(`/api/v2/edu/webhooks/${id}`, { method: 'DELETE', cookie: admin.cookie })).status, 200);
  assert.ok((await ctx.db.query("SELECT action FROM audit_log_v2 WHERE org_id=$1", [admin.orgId])).some(r => r.action === 'webhook.deleted'));
});
