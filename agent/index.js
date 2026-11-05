#!/usr/bin/env node
// SmartPrint agent v3 command line.
//   node agent/index.js enroll --url https://your-smartprint-server --code ENROLMENT-CODE
//   node agent/index.js run [--portal 17640]     (--portal also serves the outage printing page on the local network)
//   node agent/index.js status
// Settings live in %LOCALAPPDATA%\SmartPrintAgent (separate from the older shop connector, which is not touched).
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { AgentCore, sweepCache } from './core.js';
import { windowsDriver } from './drivers.js';
import { startPortal } from './portal.js';

const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : null).filter(Boolean));
const dir = resolve(args.dir || join(process.env.LOCALAPPDATA || '.', 'SmartPrintAgent'));
mkdirSync(dir, { recursive: true });
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const core = new AgentCore({ dir, driver: windowsDriver(), url: args.url, log });
const command = process.argv[2];

if (command === 'enroll') {
  if (!args.url || !args.code) { console.error('Usage: enroll --url <server> --code <enrolment code>'); process.exit(2); }
  const id = await core.enroll(args.code);
  log(`Enrolled as agent ${id}. Start it with: node agent/index.js run`);
  core.close();
} else if (command === 'status') {
  console.log(JSON.stringify({ enrolled: Boolean(core.settings.agentId), server: core.settings.url, agentId: core.settings.agentId, version: core.version, pendingJobs: core.liveJournal().length }, null, 2));
  core.close();
} else if (command === 'run') {
  if (!core.settings.agentId) { console.error('This PC is not enrolled yet. Run: enroll --url <server> --code <code>'); process.exit(2); }
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop.abort());
  sweepCache(dir, new Set(core.liveJournal().map(e => e.attempt_id)));
  log(`Agent ${core.settings.agentId} running against ${core.settings.url}`);
  if (args.portal) await startPortal(core, { port: Number(args.portal) || 17640, host: args['portal-host'] || '0.0.0.0', log }); // outage printing page for the campus network
  await core.run({ signal: stop.signal });
  core.close();
} else {
  console.error('Commands: enroll, run, status');
  process.exit(2);
}
