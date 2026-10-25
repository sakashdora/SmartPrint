import express from 'express';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import { openDatabase } from './db.js';
import { token, digest, hashPassword, checkPassword, loadKey, encrypt, decrypt } from './security.js';
import { price, validateOptions } from './print-options.js';
import { configuration } from './config.js';
import { authRoutes } from './auth.js';
import { limitRate } from './security.js';
import { processDocument, localProcess, supportsLocalPreparation } from './process-client.js';
import { deviceRoutes, sweepLeases, queuePreparation } from './devices.js';
import { paymentRoutes } from './payments.js';
import { notificationRoutes, createNotification } from './notifications.js';
import { uploadRoutes, resolveUploads, sendPdf } from './uploads.js';
import { getIdempotentResult, saveIdempotentResult } from './idempotency.js';
import { transitionOrder } from './state-machine.js';
import { requestLogger, logEvent } from './logger.js';

const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });
export async function createApp({ database, seed = true } = {}) {
  const config = configuration();
  const db = database ?? await openDatabase();
  try {
    await db.migrate();
    console.log(`[SmartPrint DB] Database schema verified and up to date (${db.kind}).`);
  } catch (migrationError) {
    console.warn('[SmartPrint DB] Automatic startup migration warning:', migrationError.message);
  }
  const key = loadKey();
  if (seed && !process.env.DATABASE_URL && !config.production) {
    for (const [id, email, role] of [['owner-demo', 'owner@smartprint.local', 'owner'], ['admin-demo', 'admin@smartprint.local', 'admin']]) {
      await db.query('INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [id, email, await hashPassword('SmartPrintDemo!2026'), role]);
    }
    await db.query("INSERT INTO shops (id,owner_id,slug,name,location,status) VALUES ('shop-demo','owner-demo','campus-print','Campus Print Studio','Ground floor · Near the main gate','active') ON CONFLICT(id) DO NOTHING");
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger);
  if (config.production) app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(async (req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; frame-src 'self' blob: https://api.razorpay.com; connect-src 'self' https://api.razorpay.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.path !== '/api/payments/webhook' && !req.path.startsWith('/api/device/')) {
      const allowed = [config.origin, req.headers.host ? `https://${req.headers.host}` : null].filter(Boolean);
      if ((config.production && !req.headers.origin) || (req.headers.origin && !allowed.includes(req.headers.origin))) return next(fail(403, 'Request origin is not allowed.'));
    }
    const sessionId = req.headers.cookie?.split('; ').find(v => v.startsWith('sp_session='))?.slice(11);
    if (sessionId) {
      req.sessionId = digest(sessionId);
      const [user] = await db.query('SELECT u.id,u.email,u.role,u.status,s.mfa FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires>$2', [req.sessionId, now()]);
      if (user) {
        if (user.status === 'suspended' || user.status === 'disabled') {
          req.user = null;
        } else {
          const adminMustMfa = user.role === 'admin' && (config.production || process.env.ENFORCE_MFA === 'true');
          const enforceMfa = process.env.ENFORCE_MFA === 'true' || adminMustMfa;
          const [shop] = user.role === 'owner' ? await db.query('SELECT status FROM shops WHERE owner_id=$1', [user.id]) : [];
          req.user = { id: user.id, email: user.email, role: user.role, status: user.status || 'active', shopStatus: shop?.status || null, mfaRequired: Boolean(enforceMfa && !user.mfa) };
        }
      }
    }
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !req.path.startsWith('/api/device/') && req.path !== '/api/payments/webhook' && !req.path.includes('/chunks/')) await limitRate(db, 'mutations', req.ip, 120);
    if (req.path === '/api/quotes' || req.path === '/api/uploads') await limitRate(db, 'uploads', req.ip, 60, 900);
    if (req.path.startsWith('/api/auth/')) await limitRate(db, 'auth', req.ip, 40, 900);
    next();
  });
  const requireRole = role => (req, res, next) => !req.user ? next(fail(401, 'Please sign in.')) : req.user.mfaRequired ? next(fail(403, 'Set up your authenticator before using this workspace.')) : req.user.role !== role ? next(fail(403, 'This action is not available for your account.')) : next();
  const audit = (tx, actor, action, target) => tx.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), actor, action, target, now()]);
  const ownerShop = async req => { const [shop] = await db.query('SELECT * FROM shops WHERE owner_id=$1', [req.user.id]); if (!shop) throw fail(404, 'Shop not found.'); return shop; };
  const ownerOrder = async req => { const shop = await ownerShop(req); const [order] = await db.query('SELECT * FROM orders WHERE id=$1 AND shop_id=$2', [req.params.id, shop.id]); if (!order) throw fail(404, 'Order not found.'); return order; };
  const bearer = req => req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const publicOrder = row => {
    const { token: secret, document_id, provider_order, ...safe } = row;
    const parsedOptions = typeof row.options === 'string' ? JSON.parse(row.options) : (row.options || {});
    return {
      ...safe,
      file_name: parsedOptions.file_name || row.file_name || 'document.pdf',
      priority: parsedOptions.priority ?? row.priority ?? 0,
      options: parsedOptions
    };
  };
  const collect = async (tx, order, reference) => {
    const changed = await tx.query("UPDATE orders SET payment='paid', status=CASE WHEN status='awaiting_payment' AND EXISTS (SELECT id FROM documents WHERE id=orders.document_id AND expires>$2) THEN 'queued' ELSE 'payment_review' END WHERE id=$1 AND payment='pending' RETURNING id, status", [order.id, now()]);
    if (!changed.length) return;
    const targetStatus = changed[0].status;
    await tx.query('INSERT INTO transactions (id,order_id,shop_id,amount,method,reference,created) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), order.id, order.shop_id, order.amount, order.method, reference, now()]);
    try {
      await tx.query('SAVEPOINT collect_hist_sp');
      await tx.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), order.id, order.status, targetStatus, 'system', 'payment.collected', reference, now()]);
      await tx.query('RELEASE SAVEPOINT collect_hist_sp');
    } catch (histErr) {
      await tx.query('ROLLBACK TO SAVEPOINT collect_hist_sp').catch(() => {});
      console.warn('[SmartPrint] Non-critical order_history audit insert failed in collect:', histErr.message);
    }
  };
  app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
    if (!secret) throw fail(503, 'Online payments are not configured.');
    const expected = createHmac('sha256', secret).update(req.body).digest('hex');
    const signature = req.headers['x-razorpay-signature'] ?? '';
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw fail(401, 'Invalid signature.');
    const event = JSON.parse(req.body.toString());
    const eventId = req.headers['x-razorpay-event-id'];
    if (!eventId) throw fail(400, 'Missing event id.');
    if (event.event !== 'payment.captured') return res.json({ received: true });
    const payment = event.payload?.payment?.entity;
    await db.transaction(async tx => {
      const inserted = await tx.query('INSERT INTO payment_events (id,created) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id', [eventId, now()]);
      if (!inserted.length) return;
      const [order] = await tx.query('SELECT * FROM orders WHERE provider_order=$1', [payment?.order_id ?? '']);
      if (!order || payment.status !== 'captured' || payment.currency !== 'INR' || payment.amount !== order.amount || order.method !== 'online') throw fail(409, 'Payment does not match order.');
      await collect(tx, order, payment.id);
      await audit(tx, 'gateway', 'payment.captured', order.id);
    });
    res.json({ received: true });
  });
  app.use(express.json({ limit: config.production ? '2mb' : '29mb' }));
  app.use((req, res, next) => { req.body ??= {}; next(); });
  app.get('/api/health', (req, res) => res.json({
    mode: config.production ? 'production' : 'development',
    payments: config.payments,
    paymentMode: config.paymentMode || (config.payments ? 'test' : 'disabled'),
    automaticPrinting: true,
    office: config.production || process.env.CONNECTOR_PROCESSING === 'true' || Boolean(process.env.PROCESSOR_URL),
    demo: !process.env.DATABASE_URL && !config.production,
    commit: process.env.RENDER_GIT_COMMIT || '0bf8e4f',
    version: '1.0.1',
    timestamp: new Date().toISOString()
  }));
  authRoutes(app, db, key, config);
  uploadRoutes(app, db, key);
  deviceRoutes(app, { db, key, ownerShop, requireRole, audit, maintenance: () => maintain() });
  paymentRoutes(app, { db, ownerOrder, requireRole, collect, audit });
  notificationRoutes(app, { db, ownerShop, requireRole });
  app.post('/api/auth/register', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase(), password = String(req.body.password ?? ''), name = String(req.body.name ?? '').trim(), location = String(req.body.location ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 128 || name.length < 2 || name.length > 100 || !location || location.length > 200) throw fail(400, 'Use a valid email, 12–128 character password, shop name and location.');
    const id = randomUUID(), shopId = randomUUID();
    try { await db.transaction(async tx => {
      await tx.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,'owner')", [id, email, await hashPassword(password)]);
      await tx.query('INSERT INTO shops (id,owner_id,slug,name,location) VALUES ($1,$2,$3,$4,$5)', [shopId, id, `shop-${shopId.slice(0, 8)}`, name, location]);
      await audit(tx, id, 'shop.registered', shopId);
    }); } catch (error) { if (String(error.message).toLowerCase().includes('unique')) throw fail(409, 'This email is already registered.'); throw error; }
    res.status(201).json({ message: 'Shop registered successfully! Platform admin approval is required before your shop can accept customer orders. Sign in to configure prices and connect printers.' });
  });
  app.get('/api/shops', async (req, res) => {
    res.json(await db.query("SELECT s.slug, s.name, s.location, s.bw, s.color FROM shops s WHERE s.status='active' ORDER BY s.name LIMIT 10"));
  });
  app.get('/api/shops/:slug', async (req, res) => {
    const [shop] = await db.query("SELECT s.id,s.slug,s.name,s.location,s.bw,s.color,s.version,s.status,p.upi_id FROM shops s LEFT JOIN shop_payments p ON p.shop_id=s.id WHERE s.slug=$1 AND s.status='active'", [req.params.slug]);
    if (!shop) throw fail(404, 'This shop is not accepting new orders.'); res.json(shop);
  });
  class ConcurrencyQueue {
    constructor(maxConcurrent = 8, timeoutMs = 30000) {
      this.maxConcurrent = maxConcurrent;
      this.timeoutMs = timeoutMs;
      this.active = 0;
      this.waiting = [];
    }
    async acquire() {
      if (this.active < this.maxConcurrent) {
        this.active++;
        return;
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = this.waiting.findIndex(item => item.resolve === resolve);
          if (idx !== -1) this.waiting.splice(idx, 1);
          reject(fail(429, 'Document processing is busy with several concurrent files. Please try again shortly.'));
        }, this.timeoutMs);
        this.waiting.push({ resolve, timer });
      });
    }
    release() {
      this.active--;
      if (this.waiting.length > 0) {
        const next = this.waiting.shift();
        clearTimeout(next.timer);
        this.active++;
        next.resolve();
      }
    }
  }
  const documentQueue = new ConcurrencyQueue(8, 30000);
  app.post('/api/quotes', async (req, res) => {
    const [shop] = await db.query("SELECT * FROM shops WHERE slug=$1 AND status='active'", [req.body.slug]);
    if (!shop) throw fail(404, 'This shop is not accepting orders.');
    let files;
    try { files = await resolveUploads(req.body.files, shop.id, db, key); }
    catch (error) { throw fail(400, error.message); }
    const local = supportsLocalPreparation(files) && (process.env.CONNECTOR_PROCESSING !== 'true' || req.body.preferServer === true);
    if (!local && (config.production || process.env.CONNECTOR_PROCESSING === 'true')) {
      const [onlineDevice] = await db.query('SELECT id FROM devices WHERE shop_id=$1 AND active=1 AND heartbeat>$2', [shop.id, new Date(Date.now() - 180000).toISOString()]);
      if (onlineDevice) return res.status(202).json(await queuePreparation(req, db, shop));
    }
    await documentQueue.acquire();
    let options, prepared;
    try {
      options = validateOptions(req.body.options);
      prepared = await (local ? localProcess(files, options) : processDocument(files, options));
    } catch (error) {
      throw fail(400, `Unable to prepare file: ${error.message}`);
    } finally {
      documentQueue.release();
    }
    const quote = { id: randomUUID(), token: token(), ...price(prepared.pages, options, shop), pages: prepared.pages, options, expires: new Date(Date.now() + 15 * 60000).toISOString() };
    const documentId = randomUUID(), sealed = encrypt(prepared.bytes, key);
    await db.transaction(async tx => {
      await tx.query('INSERT INTO documents (id,shop_id,payload,iv,tag,expires) VALUES ($1,$2,$3,$4,$5,$6)', [documentId, shop.id, sealed.payload, sealed.iv, sealed.tag, new Date(Date.now() + 86400000).toISOString()]);
      await tx.query('INSERT INTO quotes (id,shop_id,document_id,token,options,pages,sides,sheets,amount,version,expires) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [quote.id, shop.id, documentId, digest(quote.token), JSON.stringify(options), quote.pages, quote.sides, quote.sheets, quote.amount, shop.version, quote.expires]);
      // Keep encrypted source uploads until their short expiry so option edits do not re-upload them.
    });
    res.status(201).json(quote);
  });
  app.post('/api/quotes/:id/reprice', async (req, res) => {
    const result = await db.transaction(async tx => {
      const [previous] = await tx.query('SELECT * FROM quotes WHERE id=$1 AND token=$2 AND used=0 AND expires>$3', [req.params.id, digest(bearer(req)), now()]);
      if (!previous) throw fail(409, 'Quote expired or already ordered. Prepare a new quote.');
      const [shop] = await tx.query("SELECT * FROM shops WHERE id=$1 AND status='active'", [previous.shop_id]);
      const [document] = await tx.query('SELECT id FROM documents WHERE id=$1 AND expires>$2', [previous.document_id, now()]);
      if (!shop || !document) throw fail(409, 'Shop or print file is unavailable.');
      let options;
      try { options = validateOptions({ ...JSON.parse(previous.options), copies: req.body.copies, duplex: req.body.duplex }); }
      catch (error) { throw fail(400, error.message); }
      const changed = await tx.query('UPDATE quotes SET used=1 WHERE id=$1 AND used=0 RETURNING id', [previous.id]);
      if (!changed.length) throw fail(409, 'Quote already ordered or updated.');
      const quote = { id: randomUUID(), token: token(), ...price(previous.pages, options, shop), pages: previous.pages, options, expires: new Date(Date.now() + 15 * 60000).toISOString() };
      await tx.query('INSERT INTO quotes (id,shop_id,document_id,token,options,pages,sides,sheets,amount,version,expires) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [quote.id, shop.id, previous.document_id, digest(quote.token), JSON.stringify(options), quote.pages, quote.sides, quote.sheets, quote.amount, shop.version, quote.expires]);
      return quote;
    });
    res.status(201).json(result);
  });
  app.get('/api/quotes/:id/preview', async (req, res) => {
    const [quote] = await db.query('SELECT * FROM quotes WHERE id=$1 AND token=$2 AND expires>$3 AND used=0', [req.params.id, digest(bearer(req)), now()]);
    if (!quote) throw fail(404, 'Preview expired. Prepare it again.');
    const [doc] = await db.query('SELECT * FROM documents WHERE id=$1', [quote.document_id]);
    if (!doc) throw fail(404, 'File has expired.'); sendPdf(req, res, decrypt(doc, key));
  });
  app.post('/api/orders', async (req, res) => {
    if (!['cash', 'upi', 'online'].includes(req.body.method)) throw fail(400, 'Choose UPI or cash payment.');
    if (req.body.method === 'online' && !config.payments) throw fail(503, 'Online payments are not configured. Please pay at the counter.');
    const quoteId = req.body.quoteId;
    if (!quoteId) throw fail(400, 'Missing quote identifier. Prepare a preview first.');
    const idempKey = req.headers['idempotency-key'];
    if (idempKey) {
      const cached = await getIdempotentResult(db, idempKey, bearer(req) || req.ip, 'order.create');
      if (cached) return res.status(cached.status).json(cached.body);
    }
    const receipt = token(), id = randomUUID();
    const fileName = String(req.body.fileName || 'document.pdf').slice(0, 150);
    const result = await db.transaction(async tx => {
      const [quote] = await tx.query(
        'SELECT q.* FROM quotes q JOIN shops s ON s.id=q.shop_id JOIN documents d ON d.id=q.document_id WHERE q.id=$1 AND q.token=$2 AND q.expires>$3 AND s.status=\'active\' AND d.expires>$3',
        [quoteId, digest(bearer(req)), now()]
      );
      if (!quote) throw fail(409, 'Quote expired or already used. Prepare a new preview.');
      if (quote.used === 1) {
        if (idempKey) {
          const cached = await getIdempotentResult(tx, idempKey, bearer(req) || req.ip, 'order.create');
          if (cached) return cached.body;
        }
        throw fail(409, 'This quote has already been ordered.');
      }
      const claimed = await tx.query('UPDATE quotes SET used=1 WHERE id=$1 AND used=0 RETURNING id', [quote.id]);
      if (!claimed.length) throw fail(409, 'This quote has already been ordered.');
      const opts = JSON.parse(quote.options);
      opts.file_name = fileName;
      opts.priority = 0;
      await tx.query('INSERT INTO orders (id,shop_id,document_id,token,options,pages,sides,sheets,amount,method,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, quote.shop_id, quote.document_id, digest(receipt), JSON.stringify(opts), quote.pages, quote.sides, quote.sheets, quote.amount, req.body.method, now()]);
      try {
        await tx.query('SAVEPOINT order_history_sp');
        await tx.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), id, 'created', 'awaiting_payment', 'customer', 'order.created', req.body.method, now()]);
        await tx.query('RELEASE SAVEPOINT order_history_sp');
      } catch (histErr) {
        await tx.query('ROLLBACK TO SAVEPOINT order_history_sp').catch(() => {});
        console.warn('[SmartPrint] Non-critical order_history audit insert failed:', histErr.message);
      }
      if (req.body.method === 'upi') {
        const [payee] = await tx.query('SELECT * FROM shop_payments WHERE shop_id=$1', [quote.shop_id]);
        if (!payee) throw fail(409, 'This shop has not set up UPI. Choose cash.');
        await tx.query('INSERT INTO upi_receipts (order_id,upi_id,payee) VALUES ($1,$2,$3)', [id, payee.upi_id, payee.payee]);
      }
      const orderPayload = { id, token: receipt };
      if (idempKey) {
        await saveIdempotentResult(tx, idempKey, bearer(req) || req.ip, 'order.create', id, 201, orderPayload);
      }
      createNotification(db, {
        shopId: quote.shop_id,
        orderId: id,
        eventType: 'order.created',
        title: 'New Print Order Placed',
        body: `Order #${id.slice(0, 8).toUpperCase()}: ${quote.pages} pages (${req.body.method.toUpperCase()} - ₹${(quote.amount / 100).toFixed(2)})`,
        data: { orderId: id, pages: quote.pages, amount: quote.amount, method: req.body.method, fileName }
      }).catch(() => {});
      return orderPayload;
    });
    res.status(201).json(result);
  });
  app.get('/api/orders/:id', async (req, res) => {
    const [order] = await db.query('SELECT * FROM orders WHERE id=$1 AND token=$2', [req.params.id, digest(bearer(req))]);
    if (!order) throw fail(404, 'Order not found. Use your private receipt.');
    const activeOrders = await db.query("SELECT id, options, created FROM orders WHERE shop_id=$1 AND status IN ('queued','printing')", [order.shop_id]);
    const currentPriority = JSON.parse(order.options).priority || 0;
    const queueAhead = (activeOrders || []).filter(o => {
      const p = JSON.parse(o.options).priority || 0;
      return p > currentPriority || (p === currentPriority && o.created <= order.created);
    }).length;
    res.json({ ...publicOrder(order), queue_position: Math.max(1, queueAhead) });
  });
  app.post('/api/orders/:id/payment', async (req, res) => {
    let [order] = await db.query("SELECT * FROM orders WHERE id=$1 AND token=$2 AND payment='pending' AND status='awaiting_payment'", [req.params.id, digest(bearer(req))]);
    if (!order) throw fail(404, 'Payable order not found.');
    if (order.method !== 'online') {
      await db.query("UPDATE orders SET method='online' WHERE id=$1", [order.id]);
      order.method = 'online';
    }
    const keyId = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
    if (!config.payments || !keyId || !secret) throw fail(503, 'Online payments are unavailable.');
    const [document] = await db.query('SELECT id FROM documents WHERE id=$1 AND expires>$2', [order.document_id, now()]);
    if (!document) throw fail(409, 'The print file expired. Upload it again before paying.');
    if (!order.provider_order) {
      // Ambiguous provider failures require reconciliation, not a blind retry.
      const marker = `creating:${randomUUID()}`;
      const claimed = await db.query('UPDATE orders SET provider_order=$1 WHERE id=$2 AND provider_order IS NULL RETURNING id', [marker, order.id]);
      if (!claimed.length) throw fail(409, 'Payment setup is in progress. Refresh shortly.');
      const response = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: order.amount, currency: 'INR', receipt: order.id }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw fail(503, 'Payment setup needs reconciliation. Contact the shop; do not pay twice.');
      const provider = await response.json();
      if (typeof provider.id !== 'string' || !provider.id.startsWith('order_')) throw fail(503, 'Payment setup could not be verified.');
      await db.query('UPDATE orders SET provider_order=$1 WHERE id=$2 AND provider_order=$3', [provider.id, order.id, marker]); order.provider_order = provider.id;
    }
    if (order.provider_order.startsWith('creating:')) throw fail(409, 'Payment setup needs reconciliation. Contact the shop.');
    res.json({ key: keyId, order_id: order.provider_order, amount: order.amount, currency: 'INR' });
  });
  app.post('/api/orders/:id/payment/verify', async (req, res) => {
    let [order] = await db.query("SELECT * FROM orders WHERE id=$1 AND token=$2", [req.params.id, digest(bearer(req))]);
    if (!order) throw fail(404, 'Order not found.');
    if (order.method !== 'online') {
      await db.query("UPDATE orders SET method='online' WHERE id=$1", [order.id]);
      order.method = 'online';
    }
    if (order.payment === 'paid') return res.json({ verified: true, status: order.status });
    if (order.status !== 'awaiting_payment') throw fail(409, 'Order is not awaiting payment.');

    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      throw fail(400, 'Missing payment verification credentials.');
    }

    if (order.provider_order !== razorpay_order_id) {
      throw fail(400, 'Payment order identifier mismatch.');
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) throw fail(503, 'Online payment verification unavailable.');

    const expected = createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (razorpay_signature.length !== expected.length || !timingSafeEqual(Buffer.from(razorpay_signature), Buffer.from(expected))) {
      throw fail(400, 'Invalid payment signature verification.');
    }

    await db.transaction(async tx => {
      const inserted = await tx.query('INSERT INTO payment_events (id,created) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id', [razorpay_payment_id, now()]);
      if (!inserted.length) return;
      await collect(tx, order, razorpay_payment_id);
      await audit(tx, 'gateway.verify', 'payment.verified', order.id);
    });

    const [updated] = await db.query('SELECT status, payment FROM orders WHERE id=$1', [order.id]);
    res.json({ verified: true, status: updated?.status || 'queued' });
  });
  app.use('/api/owner', requireRole('owner'));
  app.get('/api/owner/shop', async (req, res) => res.json(await ownerShop(req)));
  app.get('/api/owner/orders', async (req, res) => {
    const shop = await ownerShop(req);
    const rows = await db.query('SELECT o.*, CASE WHEN EXISTS (SELECT order_id FROM print_leases WHERE order_id=o.id) THEN 1 ELSE 0 END AS automatic, (SELECT name FROM devices d JOIN print_leases pl ON pl.device_id=d.id WHERE pl.order_id=o.id LIMIT 1) AS printer_name FROM orders o WHERE o.shop_id=$1 ORDER BY o.created DESC LIMIT 200', [shop.id]);
    const formatted = rows.map(publicOrder);
    const statusTier = status => {
      if (['awaiting_payment', 'payment_review'].includes(status)) return 1;
      if (status === 'queued') return 2;
      if (['printing', 'awaiting_confirmation'].includes(status)) return 3;
      if (['needs_review', 'failed'].includes(status)) return 4;
      return 5;
    };
    formatted.sort((a, b) => {
      const tierA = statusTier(a.status);
      const tierB = statusTier(b.status);
      if (tierA !== tierB) return tierA - tierB;
      if (tierA === 2) {
        if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
        return a.created.localeCompare(b.created);
      }
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      return b.created.localeCompare(a.created);
    });
    res.json(formatted);
  });
  app.get('/api/owner/transactions', async (req, res) => {
    const shop = await ownerShop(req), limit = Number(req.query.limit || 100), offset = Number(req.query.offset || 0);
    const until = String(req.query.until || now());
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw fail(400, 'Invalid transaction page.');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until) || !Number.isFinite(Date.parse(until))) throw fail(400, 'Invalid ledger snapshot.');
    res.set('X-Snapshot-At', until);
    res.json(await db.query('SELECT t.*,r.amount AS refund_amount,r.reference AS refund_reference FROM transactions t LEFT JOIN refunds r ON r.order_id=t.order_id WHERE t.shop_id=$1 AND t.created<=$4 ORDER BY t.created DESC,t.id DESC LIMIT $2 OFFSET $3', [shop.id, limit, offset, until]));
  });
  app.get('/api/owner/summary', async (req, res) => {
    const shop = await ownerShop(req);
    const [[collections], [refunds], [orders]] = await Promise.all([
      db.query('SELECT COUNT(*) AS count,COALESCE(SUM(amount),0) AS amount FROM transactions WHERE shop_id=$1', [shop.id]),
      db.query('SELECT COALESCE(SUM(amount),0) AS amount FROM refunds WHERE shop_id=$1', [shop.id]),
      db.query("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status='awaiting_payment' THEN 1 ELSE 0 END),0) AS awaiting_payment,COALESCE(SUM(CASE WHEN status IN ('queued','printing','awaiting_confirmation','needs_review') THEN 1 ELSE 0 END),0) AS active,COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed FROM orders WHERE shop_id=$1", [shop.id])
    ]);
    res.json({ collected: Number(collections.amount), refunded: Number(refunds.amount), net: Number(collections.amount) - Number(refunds.amount), transactions: Number(collections.count), ...Object.fromEntries(Object.entries(orders).map(([k,v]) => [k, Number(v)])) });
  });
  app.post('/api/owner/orders/:id/cash', async (req, res) => {
    const idempKey = req.headers['idempotency-key'];
    if (idempKey) {
      const cached = await getIdempotentResult(db, idempKey, req.user.id, 'order.cash');
      if (cached) return res.status(cached.status).json(cached.body);
    }
    const order = await ownerOrder(req);
    if (order.method !== 'cash' || order.status !== 'awaiting_payment') {
      if (idempKey && order.payment === 'paid') return res.json({ ok: true });
      throw fail(409, 'This order is not awaiting cash payment.');
    }
    await db.transaction(async tx => {
      const [doc] = await tx.query('SELECT id FROM documents WHERE id=$1 AND expires>$2', [order.document_id, now()]);
      if (!doc) throw fail(409, 'The file has expired. Do not collect payment. Ask for a new upload.');
      await collect(tx, order, 'counter');
      await audit(tx, req.user.id, 'cash.collected', order.id);
    });
    createNotification(db, {
      shopId: order.shop_id,
      orderId: order.id,
      eventType: 'payment.confirmed',
      title: 'Cash Payment Confirmed',
      body: `Order #${order.id.slice(0, 8).toUpperCase()} (₹${(order.amount / 100).toFixed(2)}) cash payment received. Moved to print queue.`,
      data: { orderId: order.id, method: 'cash' }
    }).catch(() => {});
    const result = { ok: true };
    if (idempKey) await saveIdempotentResult(db, idempKey, req.user.id, 'order.cash', order.id, 200, result);
    res.json(result);
  });
  app.post('/api/owner/orders/:id/start', async (req, res) => {
    const idempKey = req.headers['idempotency-key'];
    if (idempKey) {
      const cached = await getIdempotentResult(db, idempKey, req.user.id, 'order.start');
      if (cached) return res.status(cached.status).json(cached.body);
    }
    const order = await ownerOrder(req);
    const changed = await db.query("UPDATE orders SET status='printing' WHERE id=$1 AND payment='paid' AND status='queued' AND EXISTS (SELECT id FROM documents WHERE id=orders.document_id AND expires>$2) RETURNING id", [order.id, now()]);
    if (!changed.length) {
      if (idempKey && order.status === 'printing') return res.json({ ok: true });
      throw fail(409, 'Only a paid queued order with an available file can start.');
    }
    try {
      await db.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), order.id, 'queued', 'printing', req.user.id, 'print.started', 'manual', now()]);
    } catch (histErr) {
      console.warn('[SmartPrint] Non-critical order_history audit insert failed:', histErr.message);
    }
    await audit(db, req.user.id, 'print.started', order.id);
    createNotification(db, {
      shopId: order.shop_id,
      orderId: order.id,
      eventType: 'print.started',
      title: 'Print Started',
      body: `Order #${order.id.slice(0, 8).toUpperCase()} print started.`,
      data: { orderId: order.id }
    }).catch(() => {});
    const result = { ok: true };
    if (idempKey) await saveIdempotentResult(db, idempKey, req.user.id, 'order.start', order.id, 200, result);
    res.json(result);
  });
  app.get('/api/owner/orders/:id/document', async (req, res) => {
    const order = await ownerOrder(req);
    if (order.payment !== 'paid' || !['printing', 'queued'].includes(order.status)) throw fail(409, 'Start a paid order before opening its print file.');
    if (order.status === 'queued') {
      await db.query("UPDATE orders SET status='printing' WHERE id=$1", [order.id]);
      try {
        await db.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), order.id, 'queued', 'printing', req.user.id, 'print.started', 'download', now()]);
      } catch (histErr) {
        console.warn('[SmartPrint] Non-critical order_history audit insert failed:', histErr.message);
      }
    }
    if ((await db.query('SELECT order_id FROM print_leases WHERE order_id=$1', [order.id])).length) throw fail(409, 'The connector is handling this print. Check its physical output before taking further action.');
    const [doc] = await db.query('SELECT * FROM documents WHERE id=$1 AND expires>$2', [order.document_id, now()]);
    if (!doc) throw fail(404, 'File no longer available.');
    sendPdf(req, res, decrypt(doc, key));
  });
  app.post('/api/owner/orders/:id/complete', async (req, res) => {
    const idempKey = req.headers['idempotency-key'];
    if (idempKey) {
      const cached = await getIdempotentResult(db, idempKey, req.user.id, 'order.complete');
      if (cached) return res.status(cached.status).json(cached.body);
    }
    const order = await ownerOrder(req);
    if (req.body.confirmed !== true) throw fail(400, 'Confirm that the physical print is successful.');
    await db.transaction(async tx => {
      const changed = await tx.query("UPDATE orders SET status='completed',deleted_at=$1 WHERE id=$2 AND status IN ('printing','awaiting_confirmation','needs_review') AND payment='paid' RETURNING id", [now(), order.id]);
      if (!changed.length) {
        if (idempKey && order.status === 'completed') return;
        throw fail(409, 'Only a printing order can be completed.');
      }
      try {
        await tx.query('SAVEPOINT complete_hist_sp');
        await tx.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), order.id, order.status, 'completed', req.user.id, 'print.confirmed.file_deleted', 'physical_output_verified', now()]);
        await tx.query('RELEASE SAVEPOINT complete_hist_sp');
      } catch (histErr) {
        await tx.query('ROLLBACK TO SAVEPOINT complete_hist_sp').catch(() => {});
        console.warn('[SmartPrint] Non-critical order_history audit insert failed in complete:', histErr.message);
      }
      await tx.query('DELETE FROM documents WHERE id=$1', [order.document_id]);
      await tx.query('DELETE FROM print_leases WHERE order_id=$1', [order.id]);
      await audit(tx, req.user.id, 'print.confirmed.file_deleted', order.id);
    });
    createNotification(db, {
      shopId: order.shop_id,
      orderId: order.id,
      eventType: 'print.completed',
      title: 'Print Confirmed & Completed',
      body: `Order #${order.id.slice(0, 8).toUpperCase()} physical output verified. Live file securely deleted.`,
      data: { orderId: order.id }
    }).catch(() => {});
    const result = { ok: true };
    if (idempKey) await saveIdempotentResult(db, idempKey, req.user.id, 'order.complete', order.id, 200, result);
    res.json(result);
  });
  app.put('/api/owner/prices', async (req, res) => {
    const shop = await ownerShop(req), { bw, color } = req.body;
    if (![bw, color].every(n => Number.isInteger(n) && n >= 1 && n <= 100000)) throw fail(400, 'Prices must be ₹0.01–₹1,000 per side.');
    await db.transaction(async tx => { await tx.query('UPDATE shops SET bw=$1,color=$2,version=version+1 WHERE id=$3', [bw, color, shop.id]); await audit(tx, req.user.id, 'prices.updated', shop.id); }); res.json({ ok: true });
  });
  app.get('/api/owner/qr', async (req, res) => {
    const shop = await ownerShop(req);
    const base = config.production ? config.origin : `${req.protocol}://${req.headers.host}`;
    const url = new URL(`/?shop=${encodeURIComponent(shop.slug)}`, base).href;
    res.json({ url, image: await QRCode.toDataURL(url, { width: 1200, margin: 4, errorCorrectionLevel: 'H' }) });
  });
  app.use('/api/admin', requireRole('admin'));
  app.get('/api/admin/shops', async (req, res) => res.json(await db.query('SELECT s.*,u.email FROM shops s JOIN users u ON u.id=s.owner_id ORDER BY s.name')));
  app.get('/api/admin/audit', async (req, res) => res.json(await db.query('SELECT id,actor,action,target,created FROM audit ORDER BY created DESC LIMIT 100')));
  app.post('/api/admin/shops/:id/status', async (req, res) => {
    if (!['active', 'suspended'].includes(req.body.status)) throw fail(400, 'Choose active or suspended.');
    await db.transaction(async tx => { const changed = await tx.query('UPDATE shops SET status=$1 WHERE id=$2 RETURNING id', [req.body.status, req.params.id]); if (!changed.length) throw fail(404, 'Shop not found.'); await audit(tx, req.user.id, `shop.${req.body.status}`, req.params.id); }); res.json({ ok: true });
  });
  app.get('/api/admin/orders', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await db.query('SELECT o.*, s.name as shop_name, s.slug as shop_slug FROM orders o JOIN shops s ON s.id=o.shop_id ORDER BY o.created DESC LIMIT $1', [limit]);
    res.json(rows.map(publicOrder));
  });
  app.get('/api/admin/devices', async (req, res) => {
    const rows = await db.query('SELECT d.id, d.shop_id, d.name, d.active, d.heartbeat, d.color, d.duplex, s.name as shop_name FROM devices d JOIN shops s ON s.id=d.shop_id ORDER BY d.active DESC, d.heartbeat DESC');
    res.json(rows);
  });
  app.get('/api/admin/payments', async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await db.query('SELECT t.*, s.name as shop_name, r.amount as refund_amount FROM transactions t JOIN shops s ON s.id=t.shop_id LEFT JOIN refunds r ON r.order_id=t.order_id ORDER BY t.created DESC LIMIT $1', [limit]);
    res.json(rows);
  });
  app.get('/api/admin/stats', async (req, res) => {
    const [[shopCounts], [orderCounts], [transCounts]] = await Promise.all([
      db.query("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active, COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending, COALESCE(SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END),0) AS suspended FROM shops"),
      db.query("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed, COALESCE(SUM(CASE WHEN status IN ('queued','printing') THEN 1 ELSE 0 END),0) AS active_jobs FROM orders"),
      db.query("SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total_collected FROM transactions")
    ]);
    res.json({
      shops: { total: Number(shopCounts.total), active: Number(shopCounts.active), pending: Number(shopCounts.pending), suspended: Number(shopCounts.suspended) },
      orders: { total: Number(orderCounts.total), completed: Number(orderCounts.completed), active: Number(orderCounts.active_jobs) },
      transactions: { count: Number(transCounts.count), volume: Number(transCounts.total_collected) }
    });
  });
  app.use('/api', (req, res, next) => next(fail(404, 'API route not found.')));
  app.use('/vendor/pdfjs', express.static('node_modules/pdfjs-dist/build', { index: false }));
  app.use('/vendor/pdfjs-fonts', express.static('node_modules/pdfjs-dist/standard_fonts', { index: false }));
  app.use('/vendor/pdfjs-wasm', express.static('node_modules/pdfjs-dist/wasm', { index: false }));
  app.use(express.static('public', {
    setHeaders: (res, path) => {
      if (/\.(html|js|css)$/.test(path)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    }
  }));
  const publicIndex = resolve(fileURLToPath(new URL('../public/index.html', import.meta.url)));
  app.get(/^\/(workspace|login)(\/.*)?$/, (req, res) => res.sendFile(publicIndex));
  const cleanup = async () => db.transaction(async tx => {
    await tx.query('DELETE FROM uploads WHERE expires<=$1', [now()]);
    await tx.query('DELETE FROM preparations WHERE expires<=$1', [now()]);
    const expired = await tx.query('SELECT id FROM documents WHERE expires<=$1', [now()]);
    for (const doc of expired) {
      await tx.query("UPDATE orders SET status='expired',deleted_at=$1 WHERE document_id=$2 AND status<>'completed'", [now(), doc.id]);
      await tx.query('DELETE FROM documents WHERE id=$1', [doc.id]); await audit(tx, 'cleanup', 'file.expired.deleted', doc.id);
    }
  });
  const maintain = async () => { await cleanup(); await sweepLeases(db); await db.query('DELETE FROM sessions WHERE expires<=$1', [now()]); await db.query('DELETE FROM rate_limits WHERE expires<=$1', [now()]); await db.query("INSERT INTO worker_status (id,last_success) VALUES ('cleanup',$1) ON CONFLICT(id) DO UPDATE SET last_success=$1", [now()]); };
  app.get('/maintenance', async (req, res) => { if (!process.env.CRON_SECRET || digest(req.headers.authorization || '') !== digest(`Bearer ${process.env.CRON_SECRET}`)) return res.sendStatus(401); await maintain(); res.json({ ok: true }); });
  app.get('/readyz', async (req, res) => { const [row] = await db.query("SELECT last_success FROM worker_status WHERE id='cleanup'"); const ready = row && Date.now() - Date.parse(row.last_success) < 180000; res.status(ready ? 200 : 503).json({ ready: Boolean(ready) }); });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status ?? (error.type === 'entity.too.large' ? 413 : 500);
    if (status === 500) console.error('Request failed:', error);
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : error.message });
  });
  const timer = setInterval(() => { maintain().catch(() => console.error('Maintenance failed; check database and cleanup alerts.')); }, 60000);
  timer.unref(); await maintain();
  return { app, db, cleanup, close: async () => { clearInterval(timer); await db.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app } = await createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  app.listen(port, host, () => console.log(`SmartPrint listening on ${host}:${port}`));
}
