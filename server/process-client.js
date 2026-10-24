import { prepare, validateOptions } from './printing.js';

export function supportsLocalPreparation(files) {
  return Array.isArray(files) && files.length > 0 && files.every(file => {
    if (typeof file.data !== 'string') return false;
    const header = Buffer.from(file.data.slice(0, 16), 'base64');
    return header.subarray(0, 5).toString() === '%PDF-' ||
      header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (header[0] === 255 && header[1] === 216 && header[2] === 255);
  });
}

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
