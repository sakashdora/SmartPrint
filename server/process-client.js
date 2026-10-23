import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export async function processDocument(files, options) {
  if (process.env.PROCESSOR_URL) {
    const response = await fetch(new URL('/prepare', process.env.PROCESSOR_URL), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PROCESSOR_SECRET}` }, body: JSON.stringify({ files, options }), signal: AbortSignal.timeout(125000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Document processing is unavailable.');
    return { ...result, bytes: Buffer.from(result.data, 'base64') };
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Isolated document processor required.');
  return localProcess(files, options);
}
export function localProcess(files, options) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./process-worker.js', import.meta.url)), [], { execArgv: ['--max-old-space-size=512'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Document processing took too long. Try a smaller file.')); }, 120000);
    child.once('message', result => { clearTimeout(timer); child.kill(); result.error ? reject(new Error(result.error)) : resolve(result); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Document processing stopped. Try a simpler file.')); });
    child.send({ files, options });
  });
}
