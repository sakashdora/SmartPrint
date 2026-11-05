import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';

// An unordered quote used to keep its prepared document for 24 hours, so anonymous quotes could fill a
// shop's storage quota. The document must now go once its quotes have expired, unless an order uses it.
test('documents of expired, unordered quotes are deleted; ordered documents are kept', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('quota test');
  const data = Buffer.from(await pdf.save()).toString('base64');
  const quote = async () => (await call('/api/quotes', { method: 'POST', body: { slug: 'campus-print', files: [{ data }], options: {} } })).body;
  const abandoned = await quote(), ordered = await quote();
  assert.equal((await call('/api/orders', { method: 'POST', token: ordered.token, body: { quoteId: ordered.id, method: 'cash' } })).status, 201);
  assert.equal((await db.query('SELECT id FROM documents')).length, 2);

  // Still inside the quote lifetime: nothing is removed.
  await service.cleanup();
  assert.equal((await db.query('SELECT id FROM documents')).length, 2);

  // Quotes expired more than the grace period ago.
  await db.query('UPDATE quotes SET expires=$1', [new Date(Date.now() - 3600000).toISOString()]);
  await service.cleanup();
  const left = await db.query('SELECT d.id, (SELECT COUNT(*) FROM orders o WHERE o.document_id=d.id) AS orders FROM documents d');
  assert.equal(left.length, 1, 'only the document of the ordered quote remains');
  assert.equal(Number(left[0].orders), 1);
  assert.ok(abandoned.id);

  // Old quote rows are purged after a week; the order and its receipt are untouched.
  await db.query('UPDATE quotes SET expires=$1', [new Date(Date.now() - 8 * 86400000).toISOString()]);
  await service.cleanup();
  assert.equal((await db.query('SELECT id FROM quotes')).length, 0);
  assert.equal((await db.query('SELECT id FROM orders')).length, 1);
});
