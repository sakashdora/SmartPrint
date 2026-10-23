import { randomUUID } from 'node:crypto';
import { token, digest, encrypt, decrypt } from './security.js';
export const CHUNK = 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
export function uploadRoutes(app, db, key) {
  app.post('/api/uploads', async (req, res) => {
    const [shop] = await db.query("SELECT id FROM shops WHERE slug=$1 AND status='active'", [req.body.slug]);
    if (!shop) throw fail(404, 'Shop is unavailable.');
    const size = req.body.size, name = String(req.body.name || 'document').slice(0, 200);
    if (!Number.isInteger(size) || size < 1 || size > 20 * CHUNK) throw fail(400, 'Choose a file up to 20 MiB.');
    const id = randomUUID(), secret = token();
    await db.transaction(async tx => {
      await tx.query('UPDATE shops SET version=version WHERE id=$1 RETURNING id', [shop.id]);
      const [uploads] = await tx.query('SELECT COALESCE(SUM(size),0) AS size FROM uploads WHERE shop_id=$1', [shop.id]);
      const [documents] = await tx.query('SELECT COALESCE(SUM(LENGTH(payload)),0) AS size FROM documents WHERE shop_id=$1', [shop.id]);
      if (Number(uploads.size) + Number(documents.size) + size > 200 * CHUNK) throw fail(429, 'This shop has too many waiting files. Ask the shop to finish or cancel pending orders.');
      await tx.query('INSERT INTO uploads (id,shop_id,token,name,size,expires) VALUES ($1,$2,$3,$4,$5,$6)', [id, shop.id, digest(secret), name, size, new Date(Date.now() + 30 * 60000).toISOString()]);
    });
    res.status(201).json({ id, token: secret, chunkSize: CHUNK });
  });
  app.put('/api/uploads/:id/chunks/:part', async (req, res) => {
    const [upload] = await db.query('SELECT * FROM uploads WHERE id=$1 AND token=$2 AND expires>$3', [req.params.id, digest(req.headers.authorization?.replace(/^Bearer /, '') || ''), new Date().toISOString()]);
    if (!upload) throw fail(404, 'Upload expired. Choose the file again.');
    const part = Number(req.params.part), data = req.body.data;
    if (!Number.isInteger(part) || part < 0 || part >= Math.ceil(upload.size / CHUNK) || typeof data !== 'string' || data.length > 1400000) throw fail(400, 'Invalid upload part.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length !== Math.min(CHUNK, upload.size - part * CHUNK)) throw fail(400, 'Upload part size does not match.');
    const sealed = encrypt(bytes, key);
    await db.query('INSERT INTO upload_chunks (upload_id,part,payload,iv,tag) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(upload_id,part) DO NOTHING', [upload.id, part, sealed.payload, sealed.iv, sealed.tag]);
    res.json({ received: true });
  });
}
export async function resolveUploads(files, shopId, db, key) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) throw fail(400, 'Choose one file or two card images.');
  const result = []; let size = 0;
  for (const file of files) {
    if (!file.uploadId) { if (process.env.NODE_ENV === 'production') throw fail(400, 'Use the chunked upload endpoint.'); result.push(file); continue; }
    const [upload] = await db.query('SELECT * FROM uploads WHERE id=$1 AND token=$2 AND shop_id=$3 AND expires>$4', [file.uploadId, digest(file.token), shopId, new Date().toISOString()]);
    if (!upload) throw fail(404, 'Upload expired. Choose the file again.');
    size += upload.size; if (size > 20 * CHUNK) throw fail(400, 'Files must total 20 MiB or less.');
    const rows = await db.query('SELECT * FROM upload_chunks WHERE upload_id=$1 ORDER BY part', [upload.id]);
    if (rows.length !== Math.ceil(upload.size / CHUNK)) throw fail(409, 'Upload is incomplete. Try again.');
    result.push({ data: Buffer.concat(rows.map(row => decrypt(row, key))).toString('base64'), name: upload.name });
  }
  return result;
}
export function sendPdf(req, res, bytes) {
  res.type('pdf').set({ 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline; filename="smartprint.pdf"' });
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = Number(match?.[1]), end = Math.min(Number(match?.[2]), bytes.length - 1);
    if (!match || start > end || start >= bytes.length || end - start + 1 > CHUNK) return res.status(416).set('Content-Range', `bytes */${bytes.length}`).end();
    return res.status(206).set('Content-Range', `bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start, end + 1));
  }
  if (bytes.length > 3 * CHUNK) return res.status(413).json({ error: 'Download this document in 1 MiB ranges.' });
  return res.send(bytes);
}
