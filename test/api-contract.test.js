import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';

// The /api/* surface is a frozen contract for existing Business shops, their customers and their
// connectors. This test fails when a route is removed or renamed. Adding a route is allowed but must be
// recorded on purpose: regenerate with `UPDATE_API_CONTRACT=1 node --test test/api-contract.test.js`
// and review the diff.
const snapshotPath = new URL('./fixtures/api-contract.json', import.meta.url);

function routesOf(app) {
  const found = new Set();
  const walk = stack => {
    for (const layer of stack) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) found.add(`${method.toUpperCase()} ${layer.route.path}`);
      else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk(app.router.stack);
  return [...found].sort();
}

test('the existing API surface has not lost or renamed any route', async () => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const current = routesOf(service.app);
  await service.close();
  if (process.env.UPDATE_API_CONTRACT === '1') {
    writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + '\n');
    return;
  }
  const frozen = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.ok(frozen.length >= 80, 'snapshot looks empty');
  const missing = frozen.filter(route => !current.includes(route));
  assert.deepEqual(missing, [], `Routes removed or renamed (breaking change for shops, customers or connectors): ${missing.join(', ')}`);
  const added = current.filter(route => !frozen.includes(route));
  assert.deepEqual(added, [], `New routes must be added to test/fixtures/api-contract.json on purpose: ${added.join(', ')}`);
});
