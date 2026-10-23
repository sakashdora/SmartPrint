import { readFile, writeFile } from 'node:fs/promises';
const base = 'http://localhost:3000';
const health = await (await fetch(base + '/api/health')).json();
if (!health.demo) throw new Error('This fixture is allowed only on the local SQLite demo.');
async function post(path, body, token) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Fixture failed: ${response.status}`); return response.json();
}
const bytes = await readFile('.data/fixtures/sample-document.pdf');
const quote = await post('/api/quotes', { slug: 'campus-print', files: [{ data: bytes.toString('base64') }], options: { color: 'bw', layout: 'two' } });
const order = await post('/api/orders', { quoteId: quote.id, method: 'cash' }, quote.token);
await writeFile('.data/fixtures/browser-receipt.json', JSON.stringify(order), { mode: 0o600 });
console.log('One unpaid synthetic order created in local demo for live-refresh verification. No payment or print submitted.');
