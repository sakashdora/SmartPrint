import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';

// A software authenticator (ES256 / P-256) so the real @simplewebauthn verification runs end to end.
// It proves the server-side checks; it is not evidence that a hardware passkey works in a browser.
const b64url = buf => Buffer.from(buf).toString('base64url');
const sha256 = data => createHash('sha256').update(data).digest();
function cbor(value) {
  const head = (major, n) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error('unsupported');
}
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(16);
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  let counter = 0;
  const authData = (rpId, extra = Buffer.alloc(0), flags = 0x05) => {
    const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, extra]);
  };
  return {
    id: b64url(credentialId),
    register({ challenge, origin, rpId }) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const idLength = Buffer.alloc(2); idLength.writeUInt16BE(credentialId.length);
      const data = authData(rpId, Buffer.concat([Buffer.alloc(16), idLength, credentialId, cose]), 0x45);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]));
      return { id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] } };
    },
    assert({ challenge, origin, rpId, tamper = false }) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      const data = authData(rpId);
      const signature = sign('sha256', Buffer.concat([data, sha256(clientDataJSON)]), privateKey);
      if (tamper) signature[signature.length - 1] ^= 0xff;
      return { id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(data), signature: b64url(signature) } };
    }
  };
}

async function start(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const request = (path, { body, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      let text = ''; res.on('data', d => text += d); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
    });
    req.on('error', reject); req.end(payload);
  });
  const owner = (await request('/api/auth/login', { body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } })).cookie;
  const key = authenticator();
  const options = await request('/api/auth/webauthn/register-options', { cookie: owner });
  assert.equal(options.status, 200);
  const rpId = options.body.rp.id;
  const registered = await request('/api/auth/webauthn/register-verify', { cookie: owner, body: key.register({ challenge: options.body.challenge, origin, rpId }) });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const authOptions = async (body = {}) => (await request('/api/auth/webauthn/auth-options', { body })).body;
  const verify = (assertion, challengeKey, headers) => request('/api/auth/webauthn/auth-verify', { body: { response: assertion, challengeKey }, headers });
  return { db, request, owner, key, rpId, origin, authOptions, verify };
}

test('a valid passkey assertion signs in, and the challenge is single-use', async t => {
  const { request, key, rpId, origin, authOptions, verify } = await start(t);
  const options = await authOptions();
  assert.match(options.challengeKey, /^auth:[a-f0-9]{64}$/, 'challenge keys are random, not derived from a user id');
  const assertion = key.assert({ challenge: options.challenge, origin, rpId });
  const ok = await verify(assertion, options.challengeKey);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.email, 'owner@smartprint.local');
  assert.ok(ok.cookie);
  assert.equal((await request('/api/auth/logout', { cookie: ok.cookie })).status, 200);

  const replay = await verify(assertion, options.challengeKey);
  assert.equal(replay.status, 400, 'the same challenge cannot be used twice');
  const fresh = await authOptions();
  assert.equal((await verify(assertion, fresh.challengeKey)).status, 401, 'an old assertion does not match a new challenge');
});

test('passkey verification rejects bad signatures, origins, RP IDs and unknown challenges safely', async t => {
  const { key, rpId, origin, authOptions, verify, request, owner } = await start(t);
  let options = await authOptions();
  const bad = await verify(key.assert({ challenge: options.challenge, origin, rpId, tamper: true }), options.challengeKey);
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'Passkey verification failed.', 'no internal verification detail is disclosed');
  assert.equal((await verify(key.assert({ challenge: options.challenge, origin, rpId }), options.challengeKey)).status, 400, 'a failed attempt still consumes the challenge');

  options = await authOptions();
  assert.equal((await verify(key.assert({ challenge: options.challenge, origin: 'https://evil.example', rpId }), options.challengeKey)).status, 401);

  options = await authOptions();
  assert.equal((await verify(key.assert({ challenge: options.challenge, origin, rpId: 'evil.example' }), options.challengeKey)).status, 401);

  // Spoofed request headers must not make a foreign origin acceptable.
  options = await authOptions();
  const spoofed = await verify(key.assert({ challenge: options.challenge, origin: 'http://evil.example', rpId }), options.challengeKey, { Host: 'evil.example', Origin: 'http://evil.example' });
  assert.equal(spoofed.status, 401);

  options = await authOptions();
  const assertion = key.assert({ challenge: options.challenge, origin, rpId });
  assert.equal((await verify(assertion, 'auth:' + 'f'.repeat(64))).status, 400);
  assert.equal((await verify(assertion, undefined)).status, 400);
  assert.equal((await verify(assertion, `auth:${'0'.repeat(8)}`)).status, 400);

  // Registration with a foreign origin is rejected as a client error, not a server crash.
  const other = authenticator();
  const reg = await request('/api/auth/webauthn/register-options', { cookie: owner });
  const rejected = await request('/api/auth/webauthn/register-verify', { cookie: owner, body: other.register({ challenge: reg.body.challenge, origin: 'https://evil.example', rpId }) });
  assert.equal(rejected.status, 400);
});

test('an expired challenge is refused', async t => {
  const { key, rpId, origin, authOptions, verify } = await start(t);
  const options = await authOptions();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(6 * 60 * 1000);
  const result = await verify(key.assert({ challenge: options.challenge, origin, rpId }), options.challengeKey);
  t.mock.timers.reset();
  assert.equal(result.status, 400);
});

test("a challenge issued for one account cannot sign in another account's passkey", async t => {
  const { key, rpId, origin, authOptions, verify, request, db } = await start(t);
  const options = await authOptions({ email: 'admin@smartprint.local' });
  const result = await verify(key.assert({ challenge: options.challenge, origin, rpId }), options.challengeKey);
  assert.equal(result.status, 401);

  const admin = (await request('/api/auth/login', { body: { email: 'admin@smartprint.local', password: 'SmartPrintDemo!2026' } })).cookie;
  const removal = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(new URL(origin).port), path: `/api/auth/webauthn/passkeys/${encodeURIComponent(key.id)}`, method: 'DELETE', headers: { Cookie: admin } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(removal, 404, 'another account cannot delete this passkey');
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM passkeys')).at(0).n, 1);
});
