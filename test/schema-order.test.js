import test from 'node:test';
import assert from 'node:assert/strict';
import { schema } from '../server/schema.js';

// SQLite accepts a foreign key to a table that is created later; PostgreSQL does not. Keep the schema script in an order
// that works on both, so a mistake shows up here instead of only in the PostgreSQL job.
test('every table is created after the tables it references', () => {
  const created = new Set(), problems = [];
  for (const statement of schema.split(';')) {
    const match = statement.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/i);
    if (!match) continue;
    for (const [, target] of statement.matchAll(/REFERENCES\s+(\w+)/gi)) if (target !== match[1] && !created.has(target)) problems.push(`${match[1]} references ${target} before it is created`);
    created.add(match[1]);
  }
  assert.deepEqual(problems, []);
});
