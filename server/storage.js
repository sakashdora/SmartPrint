import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { encrypt, decrypt, loadKey } from './security.js';

// Document storage for Education.
//
//  * Every institution has its own 256-bit data key (DEK), stored wrapped by the master key. Documents are
//    encrypted with the DEK of their institution. Destroying the DEK ("crypto-shredding") makes every stored copy
//    of that institution's documents unreadable, including copies that survive in backups or in the bucket.
//  * Ciphertext lives either in the database (driver "db", the default and what Business Mode uses) or in an
//    S3-compatible bucket (driver "s3": AWS S3, Cloudflare R2, MinIO, ...). The bucket must be private.
//  * Deleting is two-step: the row is marked deleted (and its database copy wiped) inside the caller's
//    transaction, and the bucket object is removed by `sweepObjectStore`, so a slow or failing bucket can never
//    make a print job fail to complete, and a failed delete is retried.
const now = () => new Date().toISOString();
const later = ms => new Date(Date.now() + ms).toISOString();
const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// ---- AWS Signature Version 4 (checked against AWS's published test vector in test/storage.test.js) -------------------
export function signV4({ method, url, headers = {}, payloadHash, region, service = 's3', accessKeyId, secretAccessKey, amzDate }) {
  const target = new URL(url);
  const lower = Object.fromEntries(Object.entries({ host: target.host, 'x-amz-date': amzDate, ...headers }).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(lower).sort();
  const path = target.pathname.split('/').map(segment => encode(decodeURIComponent(segment))).join('/') || '/';
  const query = [...target.searchParams.entries()].map(([k, v]) => [encode(k), encode(v)]).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = names.map(n => `${n}:${lower[n]}\n`).join('');
  const canonical = [method, path, query, canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const day = amzDate.slice(0, 8), scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

// ---- S3-compatible client (path-style addressing; works with AWS, R2, MinIO) ---------------------------------------
export function s3Client({ endpoint, bucket, region = 'auto', accessKeyId, secretAccessKey, fetchImpl = fetch }) {
  const objectUrl = key => `${endpoint.replace(/\/+$/, '')}/${bucket}/${key.split('/').map(encode).join('/')}`;
  const send = async (method, key, body) => {
    const url = objectUrl(key), amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), payloadHash = sha256(body ?? '');
    const headers = { 'x-amz-content-sha256': payloadHash };
    const authorization = signV4({ method, url, headers, payloadHash, region, accessKeyId, secretAccessKey, amzDate });
    const response = await fetchImpl(url, { method, headers: { ...headers, 'x-amz-date': amzDate, Authorization: authorization }, ...(body ? { body } : {}), signal: AbortSignal.timeout(30000) });
    return response;
  };
  return {
    async put(key, bytes) { const r = await send('PUT', key, bytes); if (!r.ok) throw new Error(`object store PUT answered ${r.status}`); },
    async get(key) { const r = await send('GET', key); if (!r.ok) throw new Error(`object store GET answered ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
    async delete(key) { const r = await send('DELETE', key); if (!r.ok && r.status !== 404) throw new Error(`object store DELETE answered ${r.status}`); }
  };
}

// ---- configuration ----------------------------------------------------------------------------------------------------
let config = { driver: 'db', client: null, master: null };
export function configureStorage({ env = process.env, master = loadKey(), client = null } = {}) {
  if (client) config = { driver: 's3', client, master };
  else if (env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    config = { driver: 's3', master, client: s3Client({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, region: env.S3_REGION || 'auto', accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }) };
  } else config = { driver: 'db', client: null, master };
  return config.driver;
}
export const storageDriver = () => config.driver;
const master = () => config.master ?? (config.master = loadKey());

// ---- per-institution data keys -----------------------------------------------------------------------------------------
export async function orgKey(q, orgId) {
  const read = async () => (await q.query('SELECT dek_wrapped, dek_destroyed_at FROM organizations WHERE id=$1', [orgId]))[0];
  let row = await read();
  if (!row) throw Object.assign(new Error('Organization not found.'), { status: 404 });
  if (row.dek_destroyed_at) throw Object.assign(new Error('This institution\'s documents were destroyed.'), { status: 410, code: 'storage.key_destroyed' });
  if (!row.dek_wrapped) {
    const sealed = encrypt(randomBytes(32), master());
    await q.query('UPDATE organizations SET dek_wrapped=$1 WHERE id=$2 AND dek_wrapped IS NULL', [JSON.stringify({ payload: sealed.payload.toString('hex'), iv: sealed.iv, tag: sealed.tag }), orgId]);
    row = await read(); // another request may have won the race: always use the stored key
  }
  const wrapped = JSON.parse(row.dek_wrapped);
  return decrypt({ payload: Buffer.from(wrapped.payload, 'hex'), iv: wrapped.iv, tag: wrapped.tag }, master());
}
// Irreversible: no copy of the key exists, so no copy of the documents can be read again.
export async function destroyOrgKey(q, orgId) {
  await q.query('UPDATE organizations SET dek_wrapped=NULL, dek_destroyed_at=$1 WHERE id=$2', [now(), orgId]);
}

// ---- objects ------------------------------------------------------------------------------------------------------------
export async function putObject(tx, orgId, bytes, { expiresMs = 24 * 3600000, ownerId = null } = {}) {
  const id = randomUUID(), sealed = encrypt(bytes, await orgKey(tx, orgId)), external = config.driver === 's3';
  if (external) await config.client.put(`org/${orgId}/${id}`, sealed.payload);
  await tx.query('INSERT INTO stored_objects (id,org_id,driver,size,sha256,iv,tag,payload,expires,created,owner_id,enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,\'org\')',
    [id, orgId, config.driver, bytes.length, sha256(bytes), sealed.iv, sealed.tag, external ? Buffer.alloc(0) : sealed.payload, later(expiresMs), now(), ownerId]);
  return id;
}

// `row` is a stored_objects row (SELECT *). Rows written before per-institution keys (enc = 'global') still open.
export async function readObject(q, row) {
  if (row.enc === 'org') {
    const dek = await orgKey(q, row.org_id);
    const payload = row.driver === 's3' ? await config.client.get(`org/${row.org_id}/${row.id}`) : Buffer.from(row.payload);
    return decrypt({ payload, iv: row.iv, tag: row.tag }, dek);
  }
  return decrypt(row, master());
}

// Inside the caller's transaction: the object stops being readable and its database copy is wiped. A bucket copy is
// removed by sweepObjectStore.
export async function markObjectDeleted(tx, orgId, objectId) {
  if (objectId) await tx.query('UPDATE stored_objects SET payload=$1, deleted_at=$2 WHERE id=$3 AND org_id=$4 AND deleted_at IS NULL', [Buffer.alloc(0), now(), objectId, orgId]);
}

// Physically removes bucket copies of deleted or expired objects; a failure leaves the row for the next sweep.
export async function sweepObjectStore(db, limit = 100) {
  await db.query("UPDATE stored_objects SET payload=$1, deleted_at=$2 WHERE expires<=$2 AND deleted_at IS NULL", [Buffer.alloc(0), now()]);
  if (config.driver !== 's3') return 0;
  const rows = await db.query("SELECT id, org_id FROM stored_objects WHERE driver='s3' AND deleted_at IS NOT NULL AND purged_at IS NULL LIMIT $1", [limit]);
  let purged = 0;
  for (const row of rows) {
    try {
      await config.client.delete(`org/${row.org_id}/${row.id}`);
      await db.query('UPDATE stored_objects SET purged_at=$1 WHERE id=$2', [now(), row.id]);
      purged++;
    } catch (error) { console.warn('[Storage] Could not delete an object yet; it will be retried:', error.message); break; }
  }
  return purged;
}
