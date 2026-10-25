import { randomUUID } from 'node:crypto';

// Map of shopId -> Set of active SSE response objects
const shopClients = new Map();

export function addShopClient(shopId, res) {
  if (!shopClients.has(shopId)) {
    shopClients.set(shopId, new Set());
  }
  shopClients.get(shopId).add(res);
}

export function removeShopClient(shopId, res) {
  const clients = shopClients.get(shopId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) shopClients.delete(shopId);
  }
}

export async function createNotification(db, {
  shopId,
  userId = null,
  orderId = null,
  eventType,
  title,
  body,
  data = {}
}) {
  const id = randomUUID();
  const created = new Date().toISOString();
  const payload = {
    id,
    shop_id: shopId,
    user_id: userId,
    order_id: orderId,
    event_type: eventType,
    title,
    body,
    data,
    is_read: 0,
    created
  };

  try {
    await db.query(
      'INSERT INTO notifications (id, shop_id, user_id, order_id, event_type, title, body, data, is_read, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, shopId, userId, orderId, eventType, title, body, JSON.stringify(data), 0, created]
    );
  } catch (err) {
    console.warn('[SmartPrint Notifications] Could not persist notification to DB:', err.message);
  }

  // Push SSE event to all connected shop clients
  if (shopId && shopClients.has(shopId)) {
    const clients = shopClients.get(shopId);
    const sseMessage = `event: notification\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.write(sseMessage);
      } catch (clientErr) {
        clients.delete(client);
      }
    }
  }

  return payload;
}

export function notificationRoutes(app, { db, ownerShop, requireRole }) {
  const owner = requireRole('owner');

  // SSE stream endpoint
  app.get('/api/owner/notifications/stream', owner, async (req, res) => {
    const shop = await ownerShop(req);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    addShopClient(shop.id, res);

    // Initial greeting and unread count
    const [unread] = await db.query(
      'SELECT COUNT(*) as count FROM notifications WHERE shop_id=$1 AND is_read=0',
      [shop.id]
    );
    res.write(`event: connected\ndata: ${JSON.stringify({ unread: Number(unread?.count || 0) })}\n\n`);

    // Keep-alive heartbeat every 20 seconds
    const interval = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(interval);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(interval);
      removeShopClient(shop.id, res);
    });
  });

  // REST list endpoint
  app.get('/api/owner/notifications', owner, async (req, res) => {
    const shop = await ownerShop(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
    const rows = await db.query(
      'SELECT * FROM notifications WHERE shop_id=$1 ORDER BY created DESC LIMIT $2',
      [shop.id, limit]
    );
    const [unread] = await db.query(
      'SELECT COUNT(*) as count FROM notifications WHERE shop_id=$1 AND is_read=0',
      [shop.id]
    );
    res.json({
      unread: Number(unread?.count || 0),
      notifications: rows.map(r => ({
        ...r,
        data: typeof r.data === 'string' ? JSON.parse(r.data || '{}') : (r.data || {})
      }))
    });
  });

  // Mark single as read
  app.post('/api/owner/notifications/:id/read', owner, async (req, res) => {
    const shop = await ownerShop(req);
    await db.query(
      'UPDATE notifications SET is_read=1 WHERE id=$1 AND shop_id=$2',
      [req.params.id, shop.id]
    );
    res.json({ ok: true });
  });

  // Mark all as read
  app.post('/api/owner/notifications/mark-all-read', owner, async (req, res) => {
    const shop = await ownerShop(req);
    await db.query(
      'UPDATE notifications SET is_read=1 WHERE shop_id=$1',
      [shop.id]
    );
    res.json({ ok: true });
  });
}
