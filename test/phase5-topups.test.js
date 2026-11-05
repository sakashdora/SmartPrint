import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { boot } from './helpers/edu.js';

const KEY_ID = 'rzp_test_AbCdEf123456', KEY_SECRET = 'key-secret-for-tests', WEBHOOK_SECRET = 'webhook-secret-for-tests';
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');

// A stand-in for Razorpay's API: checks the credentials and records every call.
async function fakeRazorpay(t) {
  const calls = [], state = { refundFails: false };
  const server = createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)).on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const auth = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
      calls.push({ path: req.url, body, auth });
      res.setHeader('Content-Type', 'application/json');
      if (auth !== `${KEY_ID}:${KEY_SECRET}`) return res.writeHead(401).end(JSON.stringify({ error: { description: 'Authentication failed' } }));
      if (req.url === '/v1/orders') return res.end(JSON.stringify({ id: `order_${randomUUID().slice(0, 8)}`, amount: body.amount, currency: body.currency }));
      if (/^\/v1\/payments\/[^/]+\/refund$/.test(req.url)) return state.refundFails ? res.writeHead(400).end(JSON.stringify({ error: { description: 'Refund not possible' } })) : res.end(JSON.stringify({ id: `rfnd_${randomUUID().slice(0, 8)}` }));
      res.writeHead(404).end('{}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const previous = process.env.RAZORPAY_API_BASE;
  process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { previous === undefined ? delete process.env.RAZORPAY_API_BASE : (process.env.RAZORPAY_API_BASE = previous); await new Promise(r => server.close(r)); });
  return { calls, state };
}

async function setup(t, name, { configure = true, enable = true } = {}) {
  const ctx = await boot(t), gateway = await fakeRazorpay(t);
  const admin = await ctx.org(name), student = await ctx.member(admin.orgId, 'student');
  const info = (await ctx.call('/api/v2/edu/institution', { cookie: admin.cookie })).body;
  if (enable) await ctx.call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: admin.cookie, body: { version: info.version, policies: { onlineTopups: true, minTopupMinor: 1000 } } });
  let webhookUrl = null;
  if (configure) {
    assert.equal((await ctx.call('/api/v2/edu/payments/settings', { method: 'PUT', cookie: admin.cookie, body: { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET } })).status, 200);
    webhookUrl = new URL((await ctx.call('/api/v2/edu/payments/settings', { cookie: admin.cookie })).body.webhookUrl).pathname;
  }
  const topup = (amountMinor, key = `topup-${Math.random()}`, who = student) => ctx.call('/api/v2/edu/wallet/topups', { method: 'POST', cookie: who.cookie, headers: { 'Idempotency-Key': key }, body: { amountMinor } });
  const confirm = (intent, paymentId, who = student, secret = KEY_SECRET) => ctx.call(`/api/v2/edu/wallet/topups/${intent.intentId}/confirm`, { method: 'POST', cookie: who.cookie, body: { razorpay_payment_id: paymentId, razorpay_order_id: intent.orderId, razorpay_signature: sign(secret, `${intent.orderId}|${paymentId}`) } });
  const hook = (event, { eventId = `evt_${randomUUID()}`, secret = WEBHOOK_SECRET, path = webhookUrl } = {}) => {
    const body = JSON.stringify(event);
    return fetch(ctx.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sign(secret, body), 'X-Razorpay-Event-Id': eventId }, body }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  };
  const captured = (intent, paymentId, extra = {}) => ({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: intent.orderId, amount: intent.amount, currency: 'INR', status: 'captured', ...extra } } } });
  const wallet = async who => (await ctx.call('/api/v2/edu/wallet', { cookie: who.cookie })).body;
  const problems = async () => (await ctx.call('/api/v2/edu/wallets/verify', { cookie: admin.cookie })).body.problems;
  return { ...ctx, gateway, admin, student, topup, confirm, hook, captured, wallet, problems, webhookUrl };
}

test('payment settings: validated, sealed, never shown again, limited to the institution administrator', async t => {
  const s = await setup(t, 'settings', { configure: false });
  const put = body => s.call('/api/v2/edu/payments/settings', { method: 'PUT', cookie: s.admin.cookie, body });
  assert.equal((await put({ keyId: 'nope', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET })).status, 400);
  assert.equal((await put({ keyId: KEY_ID, keySecret: 'x', webhookSecret: WEBHOOK_SECRET })).status, 400);
  const live = await put({ keyId: 'rzp_live_AbCdEf123456', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET });
  assert.deepEqual([live.status, live.body.code], [400, 'topups.confirm_live'], 'live keys need an explicit confirmation');
  assert.equal((await put({ keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET })).status, 200);
  const shown = (await s.call('/api/v2/edu/payments/settings', { cookie: s.admin.cookie })).body;
  assert.deepEqual([shown.configured, shown.keyId, shown.mode], [true, KEY_ID, 'test']);
  assert.ok(!JSON.stringify(shown).includes(KEY_SECRET) && !JSON.stringify(shown).includes(WEBHOOK_SECRET), 'secrets are never returned');
  const row = (await s.db.query('SELECT * FROM payment_settings'))[0];
  assert.ok(!JSON.stringify(row).includes(KEY_SECRET) && !JSON.stringify(row).includes(WEBHOOK_SECRET), 'secrets are stored sealed with the institution key');
  assert.equal((await s.call('/api/v2/edu/payments/settings', { method: 'PUT', cookie: s.student.cookie, body: { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET } })).status, 403);
  const other = await s.org('settings-b');
  assert.equal((await s.call('/api/v2/edu/payments/settings', { cookie: other.cookie })).body.configured, false);
  assert.equal((await s.call('/api/v2/edu/payments/settings', { method: 'DELETE', cookie: s.admin.cookie })).status, 200);
  assert.equal((await s.topup(2000)).status, 409, 'disabled settings: no top-ups');
});

test('top-ups need the policy and settings, an idempotency key, sensible amounts, and create one order per request', async t => {
  const off = await setup(t, 'gated', { enable: false });
  assert.deepEqual([(await off.topup(2000)).status, (await off.topup(2000)).body.code], [403, 'topups.disabled']);
  const s = await setup(t, 'topup');
  assert.equal((await s.call('/api/v2/edu/wallet/topups', { method: 'POST', cookie: s.student.cookie, body: { amountMinor: 2000 } })).status, 400, 'idempotency key required');
  assert.equal((await s.topup(500)).status, 400, 'below the minimum');
  assert.equal((await s.topup(99999999)).status, 400);
  assert.equal((await s.topup(1.5)).status, 400);
  const first = await s.topup(2500, 'same-request-key');
  assert.equal(first.status, 201);
  const second = await s.topup(2500, 'same-request-key');
  assert.deepEqual([second.status, second.body.orderId, second.body.replay], [200, first.body.orderId, true]);
  assert.equal(s.gateway.calls.filter(c => c.path === '/v1/orders').length, 1, 'repeating the request created no second order');
  assert.deepEqual(s.gateway.calls[0].body, { amount: 2500, currency: 'INR', receipt: first.body.intentId, notes: { org: s.admin.orgId, user: s.student.userId } });
  assert.equal(s.gateway.calls[0].auth, `${KEY_ID}:${KEY_SECRET}`, "the institution's own keys are used");
  const staff = await s.member(s.admin.orgId, 'staff');
  assert.equal((await s.topup(2000, 'k-staff-1234', staff)).status, 403, 'only students have wallets');
});

test('the student\'s signed confirmation credits the wallet exactly once', async t => {
  const s = await setup(t, 'confirm');
  const intent = (await s.topup(5000)).body;
  assert.equal((await s.confirm(intent, 'pay_1', s.student, 'wrong-secret')).status, 400, 'a forged signature is refused');
  assert.equal((await s.wallet(s.student)).available, 0);
  assert.deepEqual([(await s.confirm(intent, 'pay_1')).status, (await s.wallet(s.student)).available], [200, 5000]);
  assert.equal((await s.confirm(intent, 'pay_1')).status, 200);
  assert.equal((await s.wallet(s.student)).available, 5000, 'confirming again credits nothing more');
  const other = await s.member(s.admin.orgId, 'student');
  assert.equal((await s.confirm(intent, 'pay_1', other)).status, 404, "somebody else's top-up cannot be confirmed");
  assert.deepEqual(await s.problems(), []);
});

test('webhooks: verified, deduplicated, and converging with the confirmation on one credit', async t => {
  const s = await setup(t, 'hooks');
  const intent = (await s.topup(4000)).body;
  const bad = await s.hook(s.captured(intent, 'pay_9'), { secret: 'wrong' });
  assert.equal(bad.status, 401);
  assert.equal((await s.hook(s.captured(intent, 'pay_9'), { path: '/api/v2/payments/webhook/razorpay/unknown-token' })).status, 404);
  assert.equal((await s.wallet(s.student)).available, 0);
  const event = s.captured(intent, 'pay_9');
  assert.equal((await s.hook(event, { eventId: 'evt_A' })).status, 200);
  assert.equal((await s.wallet(s.student)).available, 4000);
  assert.equal((await s.hook(event, { eventId: 'evt_A' })).status, 200, 'the same delivery again');
  assert.equal((await s.hook(event, { eventId: 'evt_B' })).status, 200, 'a different delivery of the same payment');
  assert.equal((await s.confirm(intent, 'pay_9')).status, 200, 'and the student confirming too');
  assert.equal((await s.wallet(s.student)).available, 4000, 'four deliveries, one credit');
  assert.equal(await s.number("SELECT COUNT(*) AS n FROM ledger_entries WHERE kind='topup'"), 2, 'one posting: two ledger lines');
  assert.deepEqual(await s.problems(), []);
});

test('ten simultaneous deliveries of one payment credit it once', async t => {
  const s = await setup(t, 'burst');
  const intent = (await s.topup(3000)).body, event = s.captured(intent, 'pay_burst');
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => s.hook(event, { eventId: `evt_${i % 4}` })));
  assert.ok(results.every(r => r.status === 200), results.map(r => r.status).join(','));
  assert.equal((await s.wallet(s.student)).available, 3000);
  assert.deepEqual(await s.problems(), []);
});

test('a payment that matches nothing is never credited: it becomes a case, as does a wrong amount', async t => {
  const s = await setup(t, 'orphans');
  const intent = (await s.topup(4000)).body;
  assert.equal((await s.hook(s.captured(intent, 'pay_wrong_amount', { amount: 999999 }))).status, 200);
  assert.equal((await s.hook({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_stranger', order_id: 'order_unknown', amount: 4000, currency: 'INR' } } } })).status, 200);
  assert.equal((await s.hook(s.captured(intent, 'pay_usd', { currency: 'USD' }))).status, 200);
  assert.equal((await s.wallet(s.student)).available, 0, 'nothing credited');
  const rec = (await s.call('/api/v2/edu/payments/reconciliation', { cookie: s.admin.cookie })).body;
  assert.equal(rec.orphans.length, 3);
  assert.equal((await s.call('/api/v2/edu/offline/cases', { cookie: s.admin.cookie })).body.filter(c => c.kind === 'orphan_payment').length, 3);
  // A top-up that was started but never confirmed shows up as unconfirmed after an hour.
  await s.db.query('UPDATE payment_intents SET created=$1', [new Date(Date.now() - 2 * 3600000).toISOString()]);
  assert.equal((await s.call('/api/v2/edu/payments/reconciliation', { cookie: s.admin.cookie })).body.unconfirmed.length, 1);
  assert.equal((await s.hook({ event: 'payment.failed', payload: { payment: { entity: { order_id: intent.orderId } } } })).status, 200);
  assert.equal((await s.db.query('SELECT state FROM payment_intents'))[0].state, 'failed');
});

test('refund to the original payment method: wallet first, then the provider; refused or failed refunds are undone', async t => {
  const s = await setup(t, 'refunds');
  const intent = (await s.topup(5000)).body;
  await s.confirm(intent, 'pay_r1');
  const refund = body => s.call(`/api/v2/edu/wallets/${s.student.userId}/refund-to-source`, { method: 'POST', cookie: s.admin.cookie, body: { intentId: intent.intentId, reason: 'Student left', ...body } });
  assert.equal((await refund({ amountMinor: 6000 })).status, 400, 'more than was paid');
  assert.equal((await refund({ amountMinor: 50 })).status, 400);
  assert.equal((await refund({ reason: '' })).status, 400);
  const part = await refund({ amountMinor: 2000 });
  assert.deepEqual([part.status, part.body.state], [201, 'issued']);
  assert.equal((await s.wallet(s.student)).available, 3000);
  assert.deepEqual(s.gateway.calls.at(-1).path, '/v1/payments/pay_r1/refund');
  assert.equal(s.gateway.calls.at(-1).body.amount, 2000);
  assert.equal((await refund({ amountMinor: 3500 })).status, 400, 'only 3000 of the top-up is still refundable');
  // The provider refuses: the wallet is restored and the refund is marked failed.
  s.gateway.state.refundFails = true;
  const refused = await refund({ amountMinor: 1000 });
  assert.equal(refused.status, 502);
  assert.equal((await s.wallet(s.student)).available, 3000, 'the debit was reversed');
  assert.equal(await s.number("SELECT COUNT(*) AS n FROM refunds_v2 WHERE state='failed'"), 1);
  s.gateway.state.refundFails = false;
  // Money the student already spent cannot be refunded: the wallet would go negative, and the provider is never asked.
  const before = s.gateway.calls.length;
  await s.call(`/api/v2/edu/wallets/${s.student.userId}/debit`, { method: 'POST', cookie: s.admin.cookie, body: { amountMinor: 2900, note: 'spent', idempotencyKey: 'debit-spent-1' } });
  assert.equal((await refund({ amountMinor: 1000 })).status, 402);
  assert.equal(s.gateway.calls.length, before, 'no provider call when the wallet cannot cover it');
  // The provider's confirmation arrives.
  const issued = (await s.db.query("SELECT provider_refund_id FROM refunds_v2 WHERE state='issued'"))[0];
  assert.equal((await s.hook({ event: 'refund.processed', payload: { refund: { entity: { id: issued.provider_refund_id } } } })).status, 200);
  assert.equal((await s.db.query("SELECT state FROM refunds_v2 WHERE state='processed'")).length, 1);
  assert.deepEqual(await s.problems(), []);
  // Roles and isolation.
  assert.equal((await s.call(`/api/v2/edu/wallets/${s.student.userId}/refund-to-source`, { method: 'POST', cookie: s.student.cookie, body: { intentId: intent.intentId, reason: 'x' } })).status, 403);
  const other = await s.org('refunds-b');
  assert.equal((await s.call(`/api/v2/edu/wallets/${s.student.userId}/refund-to-source`, { method: 'POST', cookie: other.cookie, body: { intentId: intent.intentId, reason: 'x' } })).status, 404);
});
