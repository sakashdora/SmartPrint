#!/usr/bin/env node
// Keeps the agent running. Start THIS (not index.js) from the scheduled task:
//   node agent/launcher.js [--portal 17640]
// It runs the current version of the agent, restarts it if it stops (exit code 75 = "an update was installed, start the new
// version"), and rolls back to the previous version if a freshly installed one never reports healthy.
import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { currentEntry, rollbackIfUnconfirmed } from './updater.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(join(process.env.LOCALAPPDATA || '.', 'SmartPrintAgent'));
mkdirSync(dir, { recursive: true });
const log = message => console.log(`[${new Date().toISOString()}] [launcher] ${message}`);
let stopping = false, child = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(); });

let delay = 2000;
while (!stopping) {
  const abandoned = rollbackIfUnconfirmed(dir);
  if (abandoned) log(`Version ${abandoned} never became healthy; went back to the previous version.`);
  const { entry, version } = currentEntry(dir, join(here, 'index.js'));
  log(`Starting the agent${version ? ` (version ${version})` : ''}.`);
  const started = Date.now();
  const code = await new Promise(resolveExit => { child = spawn(process.execPath, [entry, 'run', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true }); child.on('exit', c => resolveExit(c ?? 1)); child.on('error', () => resolveExit(1)); });
  if (stopping) break;
  if (code === 75) { log('An update was installed; starting the new version.'); delay = 1000; continue; }
  delay = Date.now() - started > 60000 ? 2000 : Math.min(60000, delay * 2); // crash loops slow down
  log(`The agent stopped (code ${code}); restarting in ${Math.round(delay / 1000)} s.`);
  await new Promise(r => setTimeout(r, delay));
}
