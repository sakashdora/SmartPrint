import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { requirePermission } from './tenant.js';
import { auditV2 } from './orgs.js';
import { policiesOf } from './edu.js';
import { orgKey } from './storage.js';
import { encrypt, decrypt } from './security.js';
import { creditStudent, debitStudent, ensureAccount, balanceOf } from './wallet.js';

// Online wallet top-ups through each institution's OWN Razorpay account.
//
//  * The institution stores its Razorpay keys (sealed with its own data key) and gets a private webhook address.
//    Money therefore settles to the institution, never through the platform. Nothing works until an administrator
//    configures keys AND switches the `onlineTopups` policy on.
//  * A top-up is an intent -> a Razorpay order -> a payment. The wallet is credited from whichever arrives first, the
//    student's signed confirmation or Razorpay's webhook; both use the same ledger key (the payment id), so the money is
//    credited exactly once, however often either is repeated.
//  * Webhooks are verified with the institution's webhook secret over the raw body. A captured payment that matches no
//    intent is never credited to a guessed account: it becomes a reconciliation case.
//  * Refunds to the original payment method reduce the wallet first, then call Razorpay; if Razorpay refuses, the debit is
//    reversed.
const now = () => new Date().toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const apiBase = () => (process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com').replace(/\/+$/, '');
const MAX_TOPUP = 5_000_000; // ₹50,000
const sealText = async (q, orgId, text) => { const s = encrypt(Buffer.from(text), await orgKey(q, orgId)); return JSON.stringify({ p: s.payload.toString('hex'), i: s.iv, t: s.tag }); };
const openText = async (q, orgId, sealed) => { const o = JSON.parse(sealed); return decrypt({ payload: Buffer.from(o.p, 'hex'), iv: o.i, tag: o.t }, await orgKey(q, orgId)).toString(); };
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');

async function razorpay(settings, path, body) {
  const response = await fetch(`${apiBase()}${path}`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${settings.key_id}:${settings.secret}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(502, data?.error?.description || `The payment provider answered ${response.status}.`, 'gateway.error');
  return data;
}

async function loadSettings(q, orgId, { requireEnabled = true } = {}) {
  const [row] = await q.query('SELECT * FROM payment_settings WHERE org_id=$1', [orgId]);
  if (!row || (requireEnabled && !row.enabled)) throw fail(409, 'Online top-ups are not set up for this institution.', 'topups.unavailable');
  return { ...row, secret: await openText(q, orgId, row.secret_enc), webhook_secret: await openText(q, orgId, row.webhook_secret_enc) };
}

// Credits the wallet for a captured payment. Safe to call any number of times for the same payment.
async function applyCapture(tx, { intent, paymentId, source }) {
  const credited = await creditStudent(tx, { orgId: intent.org_id, userId: intent.user_id, amountMinor: Number(intent.amount_minor), key: `gw:razorpay:${paymentId}`, kind: 'topup', actor: source, note: `Online top-up ${paymentId}` });
  await tx.query("UPDATE payment_intents SET state='captured', provider_payment_id=$1, captured_at=$2 WHERE id=$3 AND state<>'captured'", [paymentId, now(), intent.id]);
  return credited;
}

// Registered BEFORE the JSON body parser: the signature covers the raw bytes.
export function topupWebhook(app, { db }) {
  app.post('/api/v2/payments/webhook/razorpay/:token', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const [row] = await db.query('SELECT org_id FROM payment_settings WHERE webhook_token=$1 AND enabled=1', [String(req.params.token)]);
    if (!row) throw fail(404, 'Unknown webhook address.');
    const settings = await loadSettings(db, row.org_id);
    const signature = String(req.headers['x-razorpay-signature'] ?? ''), body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!signature || !same(signature, sign(settings.webhook_secret, body))) throw fail(401, 'Invalid signature.');
    const eventId = String(req.headers['x-razorpay-event-id'] ?? '');
    if (!eventId) throw fail(400, 'Missing event id.');
    let event; try { event = JSON.parse(body.toString()); } catch { throw fail(400, 'Invalid body.'); }
    await db.transaction(async tx => {
      const fresh = await tx.query("INSERT INTO gateway_events (provider,event_id,org_id,type,state,created) VALUES ('razorpay',$1,$2,$3,'received',$4) ON CONFLICT(provider, event_id) DO NOTHING RETURNING event_id", [eventId, row.org_id, String(event.event).slice(0, 60), now()]);
      if (!fresh.length) return; // a repeated delivery
      const payment = event.payload?.payment?.entity, refund = event.payload?.refund?.entity;
      if (event.event === 'payment.captured' && payment) {
        const [intent] = await tx.query('SELECT * FROM payment_intents WHERE provider_order_id=$1 AND org_id=$2', [String(payment.order_id ?? ''), row.org_id]);
        // Amount, currency and order must match what we created; anything else is a case for a person, never an auto-credit.
        if (!intent || payment.currency !== 'INR' || Number(payment.amount) !== Number(intent.amount_minor)) {
          await tx.query("UPDATE gateway_events SET state='orphan', detail=$1 WHERE provider='razorpay' AND event_id=$2", [JSON.stringify({ payment: payment.id, order: payment.order_id, amount: payment.amount }), eventId]);
          await tx.query('INSERT INTO reconciliation_cases (id,org_id,kind,ref,detail,created) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), row.org_id, 'orphan_payment', String(payment.id), JSON.stringify({ order: payment.order_id, amount: payment.amount, currency: payment.currency }), now()]);
          return;
        }
        await applyCapture(tx, { intent, paymentId: payment.id, source: 'webhook' });
        await tx.query("UPDATE gateway_events SET state='applied' WHERE provider='razorpay' AND event_id=$1", [eventId]);
      } else if (event.event === 'payment.failed' && payment) {
        await tx.query("UPDATE payment_intents SET state='failed' WHERE provider_order_id=$1 AND org_id=$2 AND state='created'", [String(payment.order_id ?? ''), row.org_id]);
        await tx.query("UPDATE gateway_events SET state='applied' WHERE provider='razorpay' AND event_id=$1", [eventId]);
      } else if (event.event === 'refund.processed' && refund) {
        await tx.query("UPDATE refunds_v2 SET state='processed' WHERE provider_refund_id=$1 AND org_id=$2 AND state='issued'", [String(refund.id), row.org_id]);
        await tx.query("UPDATE gateway_events SET state='applied' WHERE provider='razorpay' AND event_id=$1", [eventId]);
      } else await tx.query("UPDATE gateway_events SET state='ignored' WHERE provider='razorpay' AND event_id=$1", [eventId]);
    });
    res.json({ received: true });
  });
}

export function topupRoutes(app, { db, config }) {
  const need = permission => requirePermission(db, permission);
  const idem = req => { const key = String(req.headers['idempotency-key'] ?? ''); if (key.length < 8 || key.length > 100) throw fail(400, 'An idempotency key of 8–100 characters is required.', 'topups.idempotency_required'); return key; };

  // ---------------- institution administrator ----------------
  app.get('/api/v2/edu/payments/settings', need('payments.configure'), async (req, res) => {
    const [row] = await db.query('SELECT key_id, mode, enabled, webhook_token, updated FROM payment_settings WHERE org_id=$1', [req.org.id]);
    res.json(row ? { configured: true, keyId: row.key_id, mode: row.mode, enabled: Boolean(row.enabled), webhookUrl: new URL(`/api/v2/payments/webhook/razorpay/${row.webhook_token}`, config.origin).href, updated: row.updated } : { configured: false });
  });
  app.put('/api/v2/edu/payments/settings', need('payments.configure'), async (req, res) => {
    const keyId = String(req.body.keyId ?? '').trim(), keySecret = String(req.body.keySecret ?? '').trim(), webhookSecret = String(req.body.webhookSecret ?? '').trim();
    if (!/^rzp_(test|live)_[A-Za-z0-9]{8,40}$/.test(keyId)) throw fail(400, 'Enter the Razorpay Key ID (it starts with rzp_test_ or rzp_live_).');
    if (keySecret.length < 8 || keySecret.length > 100 || webhookSecret.length < 8 || webhookSecret.length > 100) throw fail(400, 'Enter the Razorpay key secret and the webhook secret.');
    const mode = keyId.startsWith('rzp_live_') ? 'live' : 'test';
    if (mode === 'live' && req.body.confirmLive !== true) throw fail(400, 'Live keys take real money. Confirm that you are authorised to enable live payments.', 'topups.confirm_live');
    const token = randomBytes(24).toString('hex');
    await db.transaction(async tx => {
      const [existing] = await tx.query('SELECT webhook_token FROM payment_settings WHERE org_id=$1', [req.org.id]);
      const values = [keyId, await sealText(tx, req.org.id, keySecret), await sealText(tx, req.org.id, webhookSecret), mode, now()];
      if (existing) await tx.query('UPDATE payment_settings SET key_id=$1, secret_enc=$2, webhook_secret_enc=$3, mode=$4, updated=$5 WHERE org_id=$6', [...values, req.org.id]);
      else await tx.query('INSERT INTO payment_settings (org_id,provider,key_id,secret_enc,webhook_secret_enc,mode,webhook_token,enabled,updated) VALUES ($6,\'razorpay\',$1,$2,$3,$4,$7,1,$5)', [...values, req.org.id, token]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'payments.configured', targetType: 'institution', targetId: req.org.id, data: { keyId, mode } });
    });
    res.json({ ok: true, mode });
  });
  app.delete('/api/v2/edu/payments/settings', need('payments.configure'), async (req, res) => {
    await db.transaction(async tx => {
      await tx.query('UPDATE payment_settings SET enabled=0 WHERE org_id=$1', [req.org.id]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'payments.disabled', targetType: 'institution', targetId: req.org.id });
    });
    res.json({ ok: true });
  });
  app.get('/api/v2/edu/payments/reconciliation', need('wallet.view_any'), async (req, res) => {
    const stale = await db.query("SELECT id,user_id,amount_minor,provider_order_id,created FROM payment_intents WHERE org_id=$1 AND state='created' AND created<$2 ORDER BY created DESC LIMIT 100", [req.org.id, new Date(Date.now() - 3600000).toISOString()]);
    const events = await db.query("SELECT event_id,type,state,detail,created FROM gateway_events WHERE org_id=$1 AND state='orphan' ORDER BY created DESC LIMIT 100", [req.org.id]);
    res.json({ unconfirmed: stale.map(s => ({ ...s, amount_minor: Number(s.amount_minor) })), orphans: events.map(e => ({ ...e, detail: JSON.parse(e.detail || '{}') })) });
  });

  // ---------------- student ----------------
  // Lets the wallet screen decide whether to offer "Add money".
  app.get('/api/v2/edu/wallet/topups/info', need('wallet.topup'), async (req, res) => {
    const { policies } = await policiesOf(db, req.org.id);
    const [row] = await db.query('SELECT key_id, enabled FROM payment_settings WHERE org_id=$1', [req.org.id]);
    res.json({ enabled: Boolean(policies.onlineTopups && row?.enabled), minMinor: policies.minTopupMinor, keyId: row?.enabled ? row.key_id : null });
  });
  app.post('/api/v2/edu/wallet/topups', need('wallet.topup'), async (req, res) => {
    const { policies } = await policiesOf(db, req.org.id);
    if (!policies.onlineTopups) throw fail(403, 'Online top-ups are not enabled for this institution.', 'topups.disabled');
    const amountMinor = Number(req.body.amountMinor);
    if (!Number.isInteger(amountMinor) || amountMinor < policies.minTopupMinor || amountMinor > MAX_TOPUP) throw fail(400, `Choose an amount between ₹${(policies.minTopupMinor / 100).toFixed(2)} and ₹${MAX_TOPUP / 100}.`);
    const key = idem(req), settings = await loadSettings(db, req.org.id);
    // Repeating the request returns the same checkout instead of creating a second order.
    const [again] = await db.query('SELECT * FROM payment_intents WHERE org_id=$1 AND user_id=$2 AND idem_key=$3', [req.org.id, req.user.id, key]);
    if (again?.provider_order_id) return res.json({ intentId: again.id, keyId: settings.key_id, orderId: again.provider_order_id, amount: Number(again.amount_minor), currency: 'INR', replay: true });
    const intentId = again?.id ?? randomUUID();
    if (!again) await db.query("INSERT INTO payment_intents (id,org_id,user_id,provider,amount_minor,state,idem_key,created) VALUES ($1,$2,$3,'razorpay',$4,'created',$5,$6)", [intentId, req.org.id, req.user.id, amountMinor, key, now()]);
    const order = await razorpay(settings, '/v1/orders', { amount: amountMinor, currency: 'INR', receipt: intentId, notes: { org: req.org.id, user: req.user.id } });
    if (typeof order.id !== 'string') throw fail(502, 'The payment provider did not return an order.', 'gateway.error');
    await db.query('UPDATE payment_intents SET provider_order_id=$1 WHERE id=$2', [order.id, intentId]);
    res.status(201).json({ intentId, keyId: settings.key_id, orderId: order.id, amount: amountMinor, currency: 'INR' });
  });
  app.post('/api/v2/edu/wallet/topups/:id/confirm', need('wallet.topup'), async (req, res) => {
    const [intent] = await db.query('SELECT * FROM payment_intents WHERE id=$1 AND org_id=$2 AND user_id=$3', [req.params.id, req.org.id, req.user.id]);
    if (!intent) throw fail(404, 'Top-up not found.');
    const settings = await loadSettings(db, req.org.id, { requireEnabled: false });
    const { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: signature } = req.body;
    if (!paymentId || !orderId || !signature || orderId !== intent.provider_order_id) throw fail(400, 'Missing or mismatched payment details.');
    if (!same(String(signature), sign(settings.secret, `${orderId}|${paymentId}`))) throw fail(400, 'The payment signature is not valid.', 'topups.bad_signature');
    await db.transaction(async tx => {
      await tx.query("INSERT INTO gateway_events (provider,event_id,org_id,type,state,created) VALUES ('razorpay',$1,$2,'confirm','applied',$3) ON CONFLICT(provider, event_id) DO NOTHING", [`confirm:${paymentId}`, req.org.id, now()]);
      await applyCapture(tx, { intent, paymentId, source: 'confirm' });
    });
    const balance = await db.transaction(async tx => balanceOf(tx, await ensureAccount(tx, req.org.id, req.user.id, 'student')));
    res.json({ ok: true, available: balance.available });
  });

  // ---------------- refund to the original payment method ----------------
  app.post('/api/v2/edu/wallets/:userId/refund-to-source', need('refunds.issue'), async (req, res) => {
    const [intent] = await db.query("SELECT * FROM payment_intents WHERE id=$1 AND org_id=$2 AND user_id=$3 AND state='captured'", [String(req.body.intentId ?? ''), req.org.id, req.params.userId]);
    if (!intent) throw fail(404, 'Captured top-up not found.');
    const [{ total }] = await db.query("SELECT COALESCE(SUM(amount_minor),0) AS total FROM refunds_v2 WHERE intent_id=$1 AND state IN ('pending','issued','processed')", [intent.id]);
    const left = Number(intent.amount_minor) - Number(total);
    const amountMinor = req.body.amountMinor === undefined ? left : Number(req.body.amountMinor);
    if (!Number.isInteger(amountMinor) || amountMinor < 100 || amountMinor > left) throw fail(400, `Refund between ₹1.00 and ₹${(left / 100).toFixed(2)} (the part of this top-up not yet refunded).`, 'refund.amount');
    const reason = String(req.body.reason ?? '').trim().slice(0, 200);
    if (!reason) throw fail(400, 'A reason is required.');
    const settings = await loadSettings(db, req.org.id, { requireEnabled: false });
    const refundId = randomUUID();
    // 1. The money leaves the wallet and the refund is recorded, together (so the student cannot spend it meanwhile).
    await db.transaction(async tx => {
      await debitStudent(tx, { orgId: req.org.id, userId: intent.user_id, amountMinor, key: `refund:${refundId}`, actor: req.user.id, note: `Refund to original payment method: ${reason}` });
      await tx.query("INSERT INTO refunds_v2 (id,org_id,user_id,intent_id,amount_minor,state,reason,created) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)", [refundId, req.org.id, intent.user_id, intent.id, amountMinor, reason, now()]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'wallet.refund_to_source', targetType: 'user', targetId: intent.user_id, data: { amountMinor, intent: intent.id } });
    });
    // 2. Razorpay is asked; if it refuses, the debit is reversed.
    try {
      const result = await razorpay(settings, `/v1/payments/${intent.provider_payment_id}/refund`, { amount: amountMinor, notes: { refund: refundId } });
      await db.query("UPDATE refunds_v2 SET state='issued', provider_refund_id=$1 WHERE id=$2", [String(result.id ?? ''), refundId]);
      res.status(201).json({ ok: true, refundId, state: 'issued' });
    } catch (error) {
      await db.transaction(async tx => {
        await creditStudent(tx, { orgId: req.org.id, userId: intent.user_id, amountMinor, key: `refund-undo:${refundId}`, kind: 'refund_reversal', actor: 'system', note: 'The payment provider refused the refund.' });
        await tx.query("UPDATE refunds_v2 SET state='failed' WHERE id=$1", [refundId]);
      });
      throw error;
    }
  });
}
