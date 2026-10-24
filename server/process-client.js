import { prepare, validateOptions } from './printing.js';

export async function processDocument(files, options) {
  if (process.env.PROCESSOR_URL) {
    const response = await fetch(new URL('/prepare', process.env.PROCESSOR_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PROCESSOR_SECRET}` },
      body: JSON.stringify({ files, options }),
      signal: AbortSignal.timeout(125000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Document processing is unavailable.');
    return { ...result, bytes: Buffer.from(result.data, 'base64') };
  }
  return prepare(files, validateOptions(options));
}

export function localProcess(files, options) {
  return prepare(files, validateOptions(options));
}
