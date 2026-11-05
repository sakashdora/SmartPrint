import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { boot, pdf } from './helpers/edu.js';
import { signV4, s3Client, configureStorage, putObject, readObject, destroyOrgKey, sweepObjectStore, orgKey } from '../server/storage.js';
import { loadKey, encrypt } from '../server/security.js';

const sha = data => createHash('sha256').update(data).digest('hex');

test('request signing matches the published AWS Signature V4 test vector', () => {
  // "get-vanilla" from the AWS SigV4 test suite.
  const authorization = signV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, payloadHash: sha(''), region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z' });
  assert.equal(authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

// A private "bucket": verifies every signature the way S3 does, keeps the bytes, can be told to fail.
async function fakeBucket(t, { accessKeyId = 'AK', secretAccessKey = 'SECRET', region = 'auto' } = {}) {
  const objects = new Map(), calls = [];
  const state = { failDelete: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c)).on('end', () => {
      const body = Buffer.concat(chunks), url = `http://${req.headers.host}${req.url}`;
      const signed = (req.headers.authorization.match(/SignedHeaders=([^,]+)/)?.[1] || '').split(';');
      const headers = Object.fromEntries(signed.filter(n => n !== 'host' && n !== 'x-amz-date').map(n => [n, req.headers[n]]));
      const expected = signV4({ method: req.method, url, headers, payloadHash: req.headers['x-amz-content-sha256'], region, accessKeyId, secretAccessKey, amzDate: req.headers['x-amz-date'] });
      calls.push(`${req.method} ${req.url}`);
      if (expected !== req.headers.authorization || sha(body) !== req.headers['x-amz-content-sha256']) { res.writeHead(403).end('bad signature'); return; }
      const key = decodeURIComponent(req.url.split('?')[0]);
      if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200).end(); }
      else if (req.method === 'GET') { objects.has(key) ? res.writeHead(200).end(objects.get(key)) : res.writeHead(404).end(); }
      else if (req.method === 'DELETE') { if (state.failDelete-- > 0) { res.writeHead(500).end(); return; } objects.delete(key); res.writeHead(204).end(); }
      else res.writeHead(405).end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { objects, calls, state, endpoint, client: (overrides = {}) => s3Client({ endpoint, bucket: 'docs', region, accessKeyId, secretAccessKey, ...overrides }) };
}

test('documents live in a private bucket as ciphertext, are served to the agent, and are removed after printing', async t => {
  const { org, member, agent, call, db, number } = await boot(t);
  const bucket = await fakeBucket(t);
  configureStorage({ client: bucket.client() });
  t.after(() => configureStorage());
  const admin = await org('bucketed'), staff = await member(admin.orgId, 'staff');
  const a = await agent(admin);
  const upload = await call('/api/v2/edu/documents', { method: 'POST', cookie: staff.cookie, raw: await pdf(2) });
  assert.equal(upload.status, 201);
  const job = await call('/api/v2/edu/jobs', { method: 'POST', cookie: staff.cookie, body: { documentId: upload.body.documentId, fileName: 'a.pdf', options: {} } });
  assert.equal(job.status, 201);
  // Only ciphertext is outside the database; the database copy is empty.
  const stored = [...bucket.objects.values()];
  assert.ok(stored.length >= 1 && stored.every(bytes => bytes.subarray(0, 5).toString() !== '%PDF-'), 'the bucket never holds readable documents');
  const [row] = await db.query("SELECT driver, payload, enc FROM stored_objects WHERE deleted_at IS NULL");
  assert.deepEqual([row.driver, Buffer.from(row.payload).length, row.enc], ['s3', 0, 'org']);
  assert.ok([...bucket.objects.keys()].every(k => k.startsWith(`/docs/org/${admin.orgId}/`)), 'objects are filed under their institution');
  // The agent receives the decrypted document through the normal protocol.
  const [claim] = await a.claim('Mono');
  const file = await a.call(`/api/agent/v2/attempts/${claim.attemptId}/document`, { headers: { 'X-Lease-Token': claim.leaseToken, Range: 'bytes=0-1048575' } });
  assert.ok([200, 206].includes(file.status));
  await a.report(claim, { event: 'submitted' });
  await a.report(claim, { event: 'completed', pages: 2 });
  assert.equal(await number("SELECT COUNT(*) AS n FROM stored_objects WHERE deleted_at IS NULL"), 0, 'marked deleted inside the completion transaction');
  assert.ok(bucket.objects.size >= 1, 'the bucket copy is removed by the sweep, not inside the print transaction');
  assert.ok(await sweepObjectStore(db) >= 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal(await number('SELECT COUNT(*) AS n FROM stored_objects WHERE purged_at IS NULL AND driver=$1', ['s3']), 0);
});

test('a failed bucket delete is retried and never blocks a print job from completing', async t => {
  const { org, member, agent, call, db, number } = await boot(t);
  const bucket = await fakeBucket(t);
  configureStorage({ client: bucket.client() });
  t.after(() => configureStorage());
  const admin = await org('retry'), staff = await member(admin.orgId, 'staff');
  const a = await agent(admin);
  const documentId = (await call('/api/v2/edu/documents', { method: 'POST', cookie: staff.cookie, raw: await pdf() })).body.documentId;
  await call('/api/v2/edu/jobs', { method: 'POST', cookie: staff.cookie, body: { documentId, options: {} } });
  const done = await a.printNext('Mono');
  assert.ok(done, 'the job completed although the bucket is slow or broken');
  bucket.state.failDelete = 1;
  const before = bucket.objects.size;
  assert.equal(await sweepObjectStore(db), 0, 'delete failed');
  assert.equal(bucket.objects.size, before);
  assert.ok(await number('SELECT COUNT(*) AS n FROM stored_objects WHERE purged_at IS NULL AND deleted_at IS NOT NULL') >= 1);
  assert.ok(await sweepObjectStore(db) >= 1, 'retried and succeeded');
  assert.equal(bucket.objects.size, 0);
});

test('a bucket that rejects the signature fails the upload cleanly', async t => {
  const { org, member, call, db, number } = await boot(t);
  const bucket = await fakeBucket(t);
  configureStorage({ client: bucket.client({ secretAccessKey: 'WRONG' }) });
  t.after(() => configureStorage());
  const admin = await org('badkey'), staff = await member(admin.orgId, 'staff');
  const upload = await call('/api/v2/edu/documents', { method: 'POST', cookie: staff.cookie, raw: await pdf() });
  assert.equal(upload.status, 500);
  assert.equal(await number('SELECT COUNT(*) AS n FROM stored_objects'), 0, 'no row without its object');
  assert.equal(bucket.objects.size, 0);
  void db;
});

test('every institution has its own key; destroying it makes its documents unreadable everywhere', async t => {
  const { org, db, number } = await boot(t);
  configureStorage();
  const a = await org('keyed-a'), b = await org('keyed-b');
  const bytes = await pdf(1);
  const ida = await db.transaction(tx => putObject(tx, a.orgId, bytes, {}));
  const idb = await db.transaction(tx => putObject(tx, b.orgId, bytes, {}));
  const rowOf = async id => (await db.query('SELECT * FROM stored_objects WHERE id=$1', [id]))[0];
  const [ra, rb] = [await rowOf(ida), await rowOf(idb)];
  assert.notDeepEqual(Buffer.from(ra.payload), Buffer.from(rb.payload), 'the same document is sealed differently per institution');
  assert.notDeepEqual(await orgKey(db, a.orgId), await orgKey(db, b.orgId));
  assert.deepEqual(await readObject(db, ra), bytes);
  // Another institution's key cannot open it.
  await assert.rejects(() => readObject(db, { ...ra, org_id: b.orgId }));
  // Crypto-shred institution A.
  const wrapped = (await db.query('SELECT dek_wrapped FROM organizations WHERE id=$1', [a.orgId]))[0].dek_wrapped;
  assert.ok(wrapped && !wrapped.includes(Buffer.from(await orgKey(db, a.orgId)).toString('hex')), 'only a wrapped key is stored');
  await destroyOrgKey(db, a.orgId);
  assert.equal(await number('SELECT COUNT(*) AS n FROM organizations WHERE id=$1 AND dek_wrapped IS NULL AND dek_destroyed_at IS NOT NULL', [a.orgId]), 1);
  await assert.rejects(() => readObject(db, ra), error => error.status === 410);
  await assert.rejects(() => db.transaction(tx => putObject(tx, a.orgId, bytes, {})), error => error.status === 410, 'a destroyed institution cannot store new documents');
  assert.deepEqual(await readObject(db, rb), bytes, 'other institutions are unaffected');
});

test('documents stored before per-institution keys remain readable', async t => {
  const { org, db } = await boot(t);
  configureStorage();
  const admin = await org('legacy');
  const bytes = await pdf(1), sealed = encrypt(bytes, loadKey());
  await db.query("INSERT INTO stored_objects (id,org_id,size,sha256,iv,tag,payload,expires,created) VALUES ('old-1',$1,$2,'x',$3,$4,$5,'2099-01-01','2026-01-01')", [admin.orgId, bytes.length, sealed.iv, sealed.tag, sealed.payload]);
  const [row] = await db.query("SELECT * FROM stored_objects WHERE id='old-1'");
  assert.equal(row.enc, 'global');
  assert.deepEqual(await readObject(db, row), bytes);
});
