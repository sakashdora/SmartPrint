import { digest } from './security.js';

const now = () => new Date().toISOString();

export async function getIdempotentResult(db, key, actor, operation) {
  if (!key) return null;
  const hashedKey = digest(`${actor}:${operation}:${key}`);
  try {
    const [row] = await db.query(
      'SELECT * FROM idempotency_keys WHERE key=$1 AND expires>$2',
      [hashedKey, now()]
    );
    if (!row) return null;
    return {
      status: row.response_status,
      body: JSON.parse(row.response_body),
      replayed: true
    };
  } catch (err) {
    console.warn('[Idempotency] Read failed, proceeding without cache:', err.message);
    return null;
  }
}

export async function saveIdempotentResult(db, key, actor, operation, resourceId, status, body, ttlMinutes = 60) {
  if (!key) return;
  const hashedKey = digest(`${actor}:${operation}:${key}`);
  const expires = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  try {
    await db.query('SAVEPOINT idemp_save_sp');
    await db.query(
      'INSERT INTO idempotency_keys (key,actor,operation,resource_id,response_status,response_body,expires,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(key) DO UPDATE SET response_status=$5, response_body=$6, expires=$7',
      [
        hashedKey,
        String(actor || 'anonymous').slice(0, 100),
        String(operation).slice(0, 50),
        resourceId ? String(resourceId).slice(0, 100) : null,
        status,
        typeof body === 'string' ? body : JSON.stringify(body),
        expires,
        now()
      ]
    );
    await db.query('RELEASE SAVEPOINT idemp_save_sp');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT idemp_save_sp').catch(() => {});
    console.warn('[Idempotency] Save failed:', err.message);
  }
}

export async function withIdempotency(db, { key, actor, operation, resourceId, handler }) {
  if (!key) {
    return handler();
  }

  const existing = await getIdempotentResult(db, key, actor, operation);
  if (existing) {
    return existing;
  }

  const result = await handler();
  const status = result.status || 200;
  const body = result.body !== undefined ? result.body : result;

  await saveIdempotentResult(db, key, actor, operation, resourceId, status, body);
  return { status, body, replayed: false };
}
