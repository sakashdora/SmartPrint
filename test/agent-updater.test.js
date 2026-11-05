import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { boot } from './helpers/edu.js';
import { AgentCore } from '../agent/core.js';
import { simulatedDriver } from '../agent/drivers.js';
import { canonical, verifyRelease, isNewer, stageRelease, activate, confirm, rollbackIfUnconfirmed, currentEntry, readState } from '../agent/updater.js';

const keys = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) }; };
const closers = []; // agents are closed before their folder is deleted (Windows cannot delete an open database)
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'upd-')); t.after(() => { closers.splice(0).forEach(close => close()); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }); return dir; };
function packageOf(dir, version) {
  const src = join(dir, `src-${version}`); mkdirSync(join(src, 'agent'), { recursive: true });
  writeFileSync(join(src, 'agent', 'index.js'), `console.log('agent ${version}');\n`);
  execFileSync('tar', ['-czf', `pkg-${version}.tgz`, 'agent'], { cwd: src });
  return readFileSync(join(src, `pkg-${version}.tgz`));
}
function release({ privateKey }, bytes, version = '3.1.0', extra = {}) {
  const manifest = { version, url: `https://updates.example/agent-${version}.tgz`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, channel: 'stable', notes: '', publishedAt: '2026-11-05T00:00:00.000Z', ...extra };
  return { manifest, signature: sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64') };
}
const serving = bytes => async (url, init) => String(url).startsWith('https://updates.example/') ? new Response(bytes) : fetch(url, init);

test('only a release signed with the trusted key is accepted; any tampering is refused', () => {
  const trusted = keys(), stranger = keys(), bytes = Buffer.from('package');
  const good = release(trusted, bytes);
  assert.equal(verifyRelease(good, trusted.publicPem).version, '3.1.0');
  const refuses = (rel, key = trusted.publicPem) => assert.throws(() => verifyRelease(rel, key), error => error.code === 'update.refused');
  refuses(good, stranger.publicPem);                                                     // signed by somebody else
  refuses({ ...good, manifest: { ...good.manifest, url: 'https://evil.example/x.tgz' } }); // address changed after signing
  refuses({ ...good, manifest: { ...good.manifest, sha256: 'a'.repeat(64) } });           // checksum changed
  refuses({ ...good, manifest: { ...good.manifest, version: '9.9.9' } });                 // version changed
  refuses({ manifest: good.manifest });                                                   // unsigned
  refuses({ ...good, signature: 'AAAA' });
  refuses(release(trusted, bytes, '3.1.0', { url: 'http://insecure.example/x.tgz' }));    // must be https
  refuses(release(trusted, bytes, '3.1.0', { size: 10 ** 9 }));                           // absurd size
  refuses(null);
  assert.deepEqual([isNewer('3.1.0', '3.0.0'), isNewer('3.0.0', '3.0.0'), isNewer('3.0.0', '3.1.0'), isNewer('3.10.0', '3.9.0')], [true, false, false, true]);
});

test('staging checks the package against the signed checksum and never downgrades', async t => {
  const trusted = keys(), dir = temp(t), bytes = packageOf(dir, '3.1.0');
  const stage = (rel, opts = {}) => stageRelease({ dir, release: rel, publicKeyPem: trusted.publicPem, currentVersion: '3.0.0', fetchImpl: serving(opts.bytes ?? bytes), ...opts.rest });
  assert.equal(await stage(release(trusted, bytes)), '3.1.0');
  assert.ok(existsSync(join(dir, 'versions', '3.1.0', 'agent', 'index.js')), 'unpacked with the real tar');
  assert.deepEqual(readdirSync(join(dir, 'versions')).filter(n => n.endsWith('.tgz')), [], 'the archive is not kept');
  const refused = async (promise) => assert.rejects(promise, error => error.code === 'update.refused');
  await refused(stage(release(trusted, bytes), { bytes: Buffer.concat([bytes, Buffer.from('x')]) })); // different bytes than signed
  await refused(stage(release(trusted, bytes, '3.0.0')));                                              // not newer
  await refused(stage(release(trusted, bytes, '2.9.0')));                                              // downgrade
  const broken = release(trusted, bytes, '3.2.0');
  await assert.rejects(() => stageRelease({ dir, release: broken, publicKeyPem: trusted.publicPem, currentVersion: '3.0.0', fetchImpl: serving(bytes), extract: () => { throw new Error('disk full'); } }), /disk full/);
  assert.ok(!existsSync(join(dir, 'versions', '3.2.0')), 'a failed unpack leaves nothing behind');
});

test('a new version is unconfirmed until it reaches the server; an unhealthy one is rolled back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upd-')); mkdirSync(join(dir, 'versions', '3.1.0', 'agent'), { recursive: true }); writeFileSync(join(dir, 'versions', '3.1.0', 'agent', 'index.js'), '');
  try {
    const fallback = join(dir, 'installed-index.js');
    assert.deepEqual(currentEntry(dir, fallback), { entry: fallback, version: null, confirmed: true }, 'nothing staged: the installed agent runs');
    activate(dir, '3.1.0');
    assert.equal(currentEntry(dir, fallback).version, '3.1.0');
    assert.equal(readState(dir).confirmed, false);
    assert.equal(rollbackIfUnconfirmed(dir, { now: Date.now() + 30000 }), null, 'give it time to start');
    assert.equal(rollbackIfUnconfirmed(dir, { now: Date.now() + 600000 }), '3.1.0', 'never became healthy: abandoned');
    assert.equal(currentEntry(dir, fallback).entry, fallback, 'back to the installed version');
    assert.ok(!existsSync(join(dir, 'versions', '3.1.0')), 'the bad version is removed');
    // A healthy one is kept and becomes the rollback target for the next.
    mkdirSync(join(dir, 'versions', '3.2.0', 'agent'), { recursive: true }); writeFileSync(join(dir, 'versions', '3.2.0', 'agent', 'index.js'), '');
    activate(dir, '3.2.0'); confirm(dir, '3.2.0');
    assert.equal(rollbackIfUnconfirmed(dir, { now: Date.now() + 600000 }), null);
    mkdirSync(join(dir, 'versions', '3.3.0', 'agent'), { recursive: true }); writeFileSync(join(dir, 'versions', '3.3.0', 'agent', 'index.js'), '');
    activate(dir, '3.3.0');
    assert.equal(readState(dir).previous, '3.2.0');
    assert.equal(rollbackIfUnconfirmed(dir, { now: Date.now() + 600000 }), '3.3.0');
    assert.equal(readState(dir).version, '3.2.0', 'back to the last version that worked');
    confirm(dir, '9.9.9'); // confirming a version that is not current changes nothing
    assert.equal(readState(dir).version, '3.2.0');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('an agent installs a newer signed release from the server, restarts into it, and ignores bad ones', async t => {
  const ctx = await boot(t), admin = await ctx.org('updates');
  const trusted = keys(), stranger = keys(), dir = temp(t), bytes = packageOf(dir, '3.1.0');
  const releaseFile = join(dir, 'agent-release.json'), previous = process.env.AGENT_RELEASE_FILE;
  t.after(() => { previous === undefined ? delete process.env.AGENT_RELEASE_FILE : (process.env.AGENT_RELEASE_FILE = previous); });
  process.env.AGENT_RELEASE_FILE = releaseFile;
  const agentDir = join(dir, 'agent-home'); mkdirSync(agentDir);
  const logs = [];
  const core = new AgentCore({ dir: agentDir, driver: simulatedDriver(), url: ctx.base, vaultMode: 'file', updatePublicKey: trusted.publicPem, fetchImpl: serving(bytes), log: m => logs.push(m) });
  closers.push(() => core.close());
  const created = await ctx.call('/api/v2/edu/agents', { method: 'POST', cookie: admin.cookie, body: { name: 'Update PC' } });
  await core.enroll(created.body.enrolmentCode);
  assert.deepEqual(await core.cycle(), { jobs: 0 }, 'no release published: business as usual');

  // A release signed by somebody else is refused and the agent carries on.
  writeFileSync(releaseFile, JSON.stringify(release(stranger, bytes)));
  core.lastUpdateCheck = 0;
  assert.deepEqual(await core.cycle(), { jobs: 0 });
  assert.ok(logs.some(m => /signature is not valid/.test(m)));
  assert.equal(readState(agentDir), null);

  // The agent is busy: an update waits until it is idle.
  writeFileSync(releaseFile, JSON.stringify(release(trusted, bytes)));
  core.db.prepare("INSERT INTO outbox (attempt_id,lease_token,body,created) VALUES ('x','y','{}','2026-01-01')").run();
  core.lastUpdateCheck = 0;
  assert.equal(await core.checkForUpdate(), null, 'results are still waiting to be delivered');
  core.db.prepare('DELETE FROM outbox').run();

  // Idle: install and ask the launcher for a restart.
  core.lastUpdateCheck = 0;
  assert.deepEqual(await core.cycle(), { update: '3.1.0' });
  assert.equal(readState(agentDir).version, '3.1.0');
  assert.equal(readState(agentDir).confirmed, false);
  assert.ok(existsSync(join(agentDir, 'versions', '3.1.0', 'agent', 'index.js')));
  // The new version proves itself by reaching the server.
  const next = new AgentCore({ dir: agentDir, driver: simulatedDriver(), url: ctx.base, vaultMode: 'file', version: '3.1.0', updatePublicKey: trusted.publicPem });
  closers.push(() => next.close());
  await next.cycle();
  assert.equal(readState(agentDir).confirmed, true);
  assert.deepEqual(await next.cycle(), { jobs: 0 }, 'and it does not install itself again');
});

test('the signing script creates a key pair and signs a package the agent accepts', async t => {
  const dir = temp(t), bytes = packageOf(dir, '3.1.0');
  writeFileSync(join(dir, 'pkg.tgz'), bytes);
  const run = args => execFileSync(process.execPath, ['scripts/sign-agent-release.mjs', ...args], { encoding: 'utf8' });
  run(['--init', '--key', join(dir, 'private.pem'), '--public', join(dir, 'public.pem')]);
  assert.ok(existsSync(join(dir, 'private.pem')) && existsSync(join(dir, 'public.pem')));
  assert.throws(() => run(['--init', '--key', join(dir, 'private.pem'), '--public', join(dir, 'public.pem')]), /refusing to overwrite|exit|Command failed/i, 'never overwrites an existing private key');
  run(['--package', join(dir, 'pkg.tgz'), '--version', '3.1.0', '--url', 'https://updates.example/agent-3.1.0.tgz', '--key', join(dir, 'private.pem'), '--public', join(dir, 'public.pem'), '--out', join(dir, 'release.json')]);
  const signed = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
  assert.equal(verifyRelease(signed, readFileSync(join(dir, 'public.pem'), 'utf8')).sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => verifyRelease(signed, keys().publicPem), error => error.code === 'update.refused');
});
