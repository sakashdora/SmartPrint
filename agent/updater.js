import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Signed agent updates.
//
//  * A release is a manifest {version, url, sha256, size, channel, notes} plus an Ed25519 signature over its canonical
//    form. The agent trusts ONLY the public key shipped with it (agent/update-public-key.pem), so a hijacked server,
//    bucket or download link cannot make an agent run foreign code.
//  * Before anything is unpacked the package must match the signed SHA-256 and size. Equal or older versions are
//    refused (no downgrades).
//  * A new version is unpacked beside the old one (versions/<version>/) and only then made current. It is "unconfirmed"
//    until it has talked to the server successfully; the launcher rolls back to the previous version if it never confirms.
const sha256 = data => createHash('sha256').update(data).digest('hex');
const MAX_PACKAGE = 80 * 1024 * 1024;

export const canonical = manifest => JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map(k => [k, manifest[k]])));

export function verifyRelease(release, publicKeyPem) {
  const fail = reason => { throw Object.assign(new Error(`Update refused: ${reason}`), { code: 'update.refused' }); };
  if (!release?.manifest || typeof release.signature !== 'string') fail('no signed manifest');
  const m = release.manifest;
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version)) || !/^https:\/\//.test(String(m.url)) || !/^[a-f0-9]{64}$/.test(String(m.sha256)) || !Number.isInteger(m.size) || m.size < 1 || m.size > MAX_PACKAGE) fail('the manifest is malformed');
  let ok = false;
  try { ok = cryptoVerify(null, Buffer.from(canonical(m)), createPublicKey(publicKeyPem), Buffer.from(release.signature, 'base64')); } catch { ok = false; }
  if (!ok) fail('the signature is not valid for the trusted key');
  return m;
}
export const isNewer = (candidate, current) => candidate.localeCompare(current, undefined, { numeric: true }) > 0;

const statePath = dir => join(dir, 'versions', 'current.json');
export const readState = dir => existsSync(statePath(dir)) ? JSON.parse(readFileSync(statePath(dir), 'utf8')) : null;
const writeState = (dir, state) => { mkdirSync(join(dir, 'versions'), { recursive: true }); writeFileSync(statePath(dir), JSON.stringify(state, null, 2)); };

// tar handles .tgz on Windows 10+ (bsdtar), Linux and macOS.
// Relative names from the versions folder: GNU tar reads "C:\..." as a remote host, bsdtar does not care.
const defaultExtract = (archive, target) => execFileSync('tar', ['-xzf', basename(archive), '-C', basename(target)], { cwd: dirname(archive), windowsHide: true, timeout: 120000 });

// Downloads, verifies and unpacks a release beside the running version. Returns the version name; does not switch to it.
export async function stageRelease({ dir, release, publicKeyPem, currentVersion, fetchImpl = fetch, extract = defaultExtract }) {
  const m = verifyRelease(release, publicKeyPem);
  if (!isNewer(m.version, currentVersion)) throw Object.assign(new Error(`Update refused: ${m.version} is not newer than ${currentVersion}`), { code: 'update.refused' });
  const response = await fetchImpl(m.url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Update download answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== m.size || sha256(bytes) !== m.sha256) throw Object.assign(new Error('Update refused: the package does not match the signed checksum'), { code: 'update.refused' });
  const target = join(dir, 'versions', m.version), archive = join(dir, 'versions', `${m.version}.tgz`);
  mkdirSync(target, { recursive: true });
  try { writeFileSync(archive, bytes); extract(archive, target); }
  catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
  finally { rmSync(archive, { force: true }); }
  return m.version;
}

// Makes a staged version current (unconfirmed) and remembers what to go back to.
export function activate(dir, version, previousEntry = null) {
  const state = readState(dir);
  writeState(dir, { version, previous: state?.version ?? null, previousEntry: state ? null : previousEntry, activatedAt: new Date().toISOString(), confirmed: false });
}
// Called by the new version after its first successful conversation with the server.
export function confirm(dir, version) {
  const state = readState(dir);
  if (state && state.version === version && !state.confirmed) writeState(dir, { ...state, confirmed: true, confirmedAt: new Date().toISOString() });
}
// Run by the launcher before starting: a version that never confirmed within `maxAgeMs` is abandoned for the previous one.
export function rollbackIfUnconfirmed(dir, { maxAgeMs = 120000, now = Date.now() } = {}) {
  const state = readState(dir);
  if (!state || state.confirmed || now - Date.parse(state.activatedAt) < maxAgeMs) return null;
  const abandoned = state.version;
  if (state.previous) writeState(dir, { version: state.previous, previous: null, activatedAt: new Date().toISOString(), confirmed: true, rolledBackFrom: abandoned });
  else rmSync(statePath(dir), { force: true }); // back to the version the launcher started with
  rmSync(join(dir, 'versions', abandoned), { recursive: true, force: true });
  return abandoned;
}
// Which entry point the launcher runs: the current staged version, or the installed one.
export function currentEntry(dir, fallbackEntry) {
  const state = readState(dir);
  const entry = state ? join(dir, 'versions', state.version, 'agent', 'index.js') : null;
  return entry && existsSync(entry) ? { entry, version: state.version, confirmed: state.confirmed } : { entry: fallbackEntry, version: null, confirmed: true };
}
export const stagedVersions = dir => existsSync(join(dir, 'versions')) ? readdirSync(join(dir, 'versions'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
