import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
for (const folder of ['server', 'public', 'processor', 'connector', 'api']) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT' && ['processor','connector'].includes(folder)) return []; throw error; });
  for (const entry of entries) {
    if (entry.isFile() && /\.(m?js)$/.test(entry.name)) execFileSync(process.execPath, ['--check', `${folder}/${entry.name}`], { stdio: 'inherit' });
  }
}
console.log('All JavaScript syntax checks passed.');
