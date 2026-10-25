import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { digest } from './security.js';
import { getIdempotentResult, saveIdempotentResult } from './idempotency.js';
const fail = (status, message) => Object.assign(new Error(message), { status });
export function paymentRoutes(app, { db, ownerOrder, requireRole, collect, audit }) {
  const owner = requireRole('owner');
  app.get('/api/owner/payments', owner, async (req, res) => { const [row] = await db.query('SELECT p.* FROM shop_payments p JOIN shops s ON s.id=p.shop_id WHERE s.owner_id=$1', [req.user.id]); res.json(row ?? null); });
  app.put('/api/owner/payments', owner, async (req, res) => {
    const upi = String(req.body.upi_id || '').trim(), payee = String(req.body.payee || '').trim();
    if (!/^[a-zA-Z0-9._-]{2,200}@[a-zA-Z0-9.-]{2,64}$/.test(upi) || payee.length < 2 || payee.length > 100) throw fail(400, 'Enter a valid UPI ID and the account holder’s name.');
    let qrImage = null;
    if (req.body.qr_image) {
      const raw = String(req.body.qr_image).trim();
      if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(raw) || raw.length > 2800000) {
        throw fail(400, 'Custom QR image must be a valid PNG or JPEG under 2 MB.');
      }
      qrImage = raw;
    }
    const [shop] = await db.query('SELECT id FROM shops WHERE owner_id=$1', [req.user.id]);
    await db.transaction(async tx => {
      await tx.query('INSERT INTO shop_payments (shop_id,upi_id,payee,qr_image) VALUES ($1,$2,$3,$4) ON CONFLICT(shop_id) DO UPDATE SET upi_id=$2,payee=$3,qr_image=COALESCE($4,shop_payments.qr_image)', [shop.id, upi, payee, qrImage]);
      await audit(tx, req.user.id, 'upi.updated', shop.id);
    });
    res.json({ ok: true });
  });
  app.get('/api/orders/:id/upi', async (req, res) => {
    const [order] = await db.query("SELECT o.*,u.upi_id,u.payee,u.reference,sp.qr_image FROM orders o JOIN upi_receipts u ON u.order_id=o.id LEFT JOIN shop_payments sp ON sp.shop_id=o.shop_id WHERE o.id=$1 AND o.token=$2 AND o.method='upi'", [req.params.id, digest(req.headers.authorization?.replace(/^Bearer /, '') || '')]);
    if (!order) throw fail(404, 'UPI order not found.');
    if (order.status !== 'awaiting_payment') return res.json({ upi_id: order.upi_id, payee: order.payee, reference: order.reference, qr_image: order.qr_image });
    const amountStr = (order.amount / 100).toFixed(2);
    const upiParams = new URLSearchParams({
      pa: order.upi_id,
      pn: order.payee,
      am: amountStr,
      cu: 'INR',
      tn: `SmartPrint ${order.id.slice(0, 8)}`,
      tr: order.id
    }).toString();
    const uri = `upi://pay?${upiParams}`;
    const apps = {
      gpay: `intent://pay?${upiParams}#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end`,
      phonepe: `phonepe://pay?${upiParams}`,
      phonepe_intent: `intent://pay?${upiParams}#Intent;scheme=upi;package=com.phonepe.app;end`,
      paytm: `paytmmp://pay?${upiParams}`,
      paytm_intent: `intent://pay?${upiParams}#Intent;scheme=upi;package=net.one97.paytm;end`,
      bhim: `intent://pay?${upiParams}#Intent;scheme=upi;package=in.org.npci.upiapp;end`
    };
    res.json({
      upi_id: order.upi_id,
      payee: order.payee,
      amount: order.amount,
      amount_formatted: amountStr,
      uri,
      apps,
      image: await QRCode.toDataURL(uri, { width: 512, margin: 2, errorCorrectionLevel: 'M' }),
      qr_image: order.qr_image || null,
      reference: order.reference
    });
  });
  app.post('/api/orders/:id/upi', async (req, res) => {
    const [order] = await db.query("SELECT id, shop_id, amount FROM orders WHERE id=$1 AND token=$2 AND method='upi' AND payment='pending' AND status='awaiting_payment'", [req.params.id, digest(req.headers.authorization?.replace(/^Bearer /, '') || '')]);
    if (!order) throw fail(404, 'Pending UPI order not found.');
    const reference = String(req.body.reference || '').trim();
    if (!/^\d{12}$/.test(reference)) throw fail(400, 'Enter the 12-digit UPI reference from your payment app.');
    await db.query('UPDATE upi_receipts SET reference=$1,reported_at=$2 WHERE order_id=$3', [reference, new Date().toISOString(), order.id]);
    import('./notifications.js').then(({ createNotification }) => {
      createNotification(db, {
        shopId: order.shop_id,
        orderId: order.id,
        eventType: 'payment.awaiting_verification',
        title: 'UPI Payment Reference Submitted',
        body: `Order #${order.id.slice(0, 8).toUpperCase()}: Customer submitted Ref #${reference} (₹${(order.amount / 100).toFixed(2)})`,
        data: { orderId: order.id, reference, amount: order.amount }
      }).catch(() => {});
    });
    res.json({ message: 'Reference shared. The shop will check its bank or UPI app before printing.' });
  });
  app.post('/api/owner/orders/:id/upi-confirm', owner, async (req, res) => {
    const idempKey = req.headers['idempotency-key'];
    if (idempKey) {
      const cached = await getIdempotentResult(db, idempKey, req.user.id, 'order.upi_confirm');
      if (cached) return res.status(cached.status).json(cached.body);
    }
    const order = await ownerOrder(req);
    if (req.body.confirmed !== true || order.method !== 'upi' || (order.status !== 'awaiting_payment' && order.payment !== 'paid')) {
      throw fail(409, 'Verify the credit in your own UPI or bank app first.');
    }
    if (order.payment === 'paid') {
      const result = { ok: true };
      if (idempKey) await saveIdempotentResult(db, idempKey, req.user.id, 'order.upi_confirm', order.id, 200, result);
      return res.json(result);
    }
    const reference = String(req.body.reference || '').trim();
    if (!/^\d{12}$/.test(reference)) throw fail(400, 'Enter the verified 12-digit UPI reference.');
    try {
      await db.transaction(async tx => {
        await collect(tx, order, reference);
        await audit(tx, req.user.id, 'upi.manually_verified', order.id);
      });
      import('./notifications.js').then(({ createNotification }) => {
        createNotification(db, {
          shopId: order.shop_id,
          orderId: order.id,
          eventType: 'payment.confirmed',
          title: 'UPI Payment Confirmed',
          body: `Order #${order.id.slice(0, 8).toUpperCase()} (₹${(order.amount / 100).toFixed(2)}) confirmed with Ref #${reference}. Moved to print queue.`,
          data: { orderId: order.id, reference, method: 'upi' }
        }).catch(() => {});
      });
    } catch (error) {
      if (error.code === '23505' || String(error.message).includes('UNIQUE constraint')) throw fail(409, 'This UPI reference has already been used for another order at your shop. Check the bank credit.');
      throw error;
    }
    const result = { ok: true };
    if (idempKey) await saveIdempotentResult(db, idempKey, req.user.id, 'order.upi_confirm', order.id, 200, result);
    res.json(result);
  });
  app.post('/api/owner/orders/:id/refund', owner, async (req, res) => {
    const idempKey = req.headers['idempotency-key'];
    if (idempKey) {
      const cached = await getIdempotentResult(db, idempKey, req.user.id, 'order.refund');
      if (cached) return res.status(cached.status).json(cached.body);
    }
    const order = await ownerOrder(req), reference = String(req.body.reference || '').trim();
    if (order.payment !== 'paid' || !['cancelled', 'failed', 'expired', 'payment_review'].includes(order.status)) {
      if (idempKey && order.payment === 'refunded') return res.json({ ok: true });
      throw fail(409, 'Only stopped or expired paid orders can be refunded.');
    }
    if (!['cash', 'upi'].includes(order.method)) throw fail(409, 'Use the payment provider dashboard for gateway refunds.');
    if (req.body.confirmed !== true || reference.length < 3 || reference.length > 100) throw fail(400, 'Confirm money was returned and enter the refund reference.');
    await db.transaction(async tx => {
      const changed = await tx.query("UPDATE orders SET payment='refunded',deleted_at=$2 WHERE id=$1 AND payment='paid' AND status IN ('cancelled','failed','expired','payment_review') RETURNING id", [order.id, new Date().toISOString()]);
      if (!changed.length) {
        if (idempKey && order.payment === 'refunded') return;
        throw fail(409, 'Refund already recorded.');
      }
      await tx.query("INSERT INTO refunds (order_id,shop_id,amount,method,state,reference,reason,created) VALUES ($1,$2,$3,$4,'completed',$5,$6,$7)", [order.id, order.shop_id, order.amount, order.method, reference, 'Order not fulfilled', new Date().toISOString()]);
      try {
        await tx.query('SAVEPOINT refund_hist_sp');
        await tx.query('INSERT INTO order_history (id,order_id,from_status,to_status,actor,action,detail,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [randomUUID(), order.id, order.status, 'refunded', req.user.id, 'refund.manually_confirmed', reference, new Date().toISOString()]);
        await tx.query('RELEASE SAVEPOINT refund_hist_sp');
      } catch (histErr) {
        await tx.query('ROLLBACK TO SAVEPOINT refund_hist_sp').catch(() => {});
        console.warn('[SmartPrint Payments] Non-critical order_history audit insert failed in refund:', histErr.message);
      }
      await tx.query('DELETE FROM documents WHERE id=$1', [order.document_id]);
      await tx.query('DELETE FROM print_leases WHERE order_id=$1', [order.id]);
      await audit(tx, req.user.id, 'refund.manually_confirmed', order.id);
    });
    const result = { ok: true };
    if (idempKey) await saveIdempotentResult(db, idempKey, req.user.id, 'order.refund', order.id, 200, result);
    res.json(result);
  });
  app.get('/api/owner/refunds', owner, async (req, res) => res.json(await db.query('SELECT r.* FROM refunds r JOIN shops s ON s.id=r.shop_id WHERE s.owner_id=$1 ORDER BY r.created DESC', [req.user.id])));
}
