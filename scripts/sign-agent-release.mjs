#!/usr/bin/env node
// Signs agent releases. The private key must NEVER be committed or uploaded anywhere; only the public key ships with the agent.
//
//   node scripts/sign-agent-release.mjs --init --key C:\secure\agent-signing.pem
//       creates the key pair: the private key at --key, the public key at agent/update-public-key.pem (commit that file)
//   node scripts/sign-agent-release.mjs --package agent-3.1.0.tgz --version 3.1.0 --url https://.../agent-3.1.0.tgz --key C:\secure\agent-signing.pem --out agent-release.json
//       writes the signed release file the server publishes (AGENT_RELEASE_FILE)
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonical } from '../agent/updater.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : null).filter(Boolean));
const publicPath = args.public && args.public !== true ? args.public : fileURLToPath(new URL('../agent/update-public-key.pem', import.meta.url));
if (args.init) {
  if (!args.key || args.key === true) { console.error('Give --key <path for the PRIVATE key>'); process.exit(2); }
  if (existsSync(args.key)) { console.error('That key file already exists; refusing to overwrite it.'); process.exit(2); }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(args.key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Private key written to ${args.key} (keep it secret and backed up). Public key written to ${publicPath}: commit it if it is agent/update-public-key.pem.`);
} else if (args.package && args.version && args.url && args.key) {
  const bytes = readFileSync(args.package);
  const manifest = { version: args.version, url: args.url, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, channel: args.channel || 'stable', notes: args.notes || '', publishedAt: new Date().toISOString() };
  const signature = sign(null, Buffer.from(canonical(manifest)), createPrivateKey(readFileSync(args.key))).toString('base64');
  const pub = createPublicKey(createPrivateKey(readFileSync(args.key))).export({ type: 'spki', format: 'pem' });
  if (existsSync(publicPath) && readFileSync(publicPath, 'utf8') !== pub) console.warn(`WARNING: this key does not match ${publicPath}; agents will refuse this release.`);
  writeFileSync(args.out || 'agent-release.json', JSON.stringify({ manifest, signature }, null, 2));
  console.log(`Signed ${args.version}; wrote ${args.out || 'agent-release.json'}`);
} else { console.error('Usage: --init --key <file>   or   --package <tgz> --version <x.y.z> --url <https url> --key <file> [--out file]'); process.exit(2); }
