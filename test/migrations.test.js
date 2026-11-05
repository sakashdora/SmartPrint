import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { migrations, applyMigrations, pendingMigrations } from '../server/migrations.js';

test('versioned migrations apply once, are recorded and are idempotent', async () => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();
  assert.equal((await pendingMigrations(db)).length, migrations.length);
  const first = await applyMigrations(db, { log() {} });
  assert.equal(first.failed, null);
  assert.deepEqual(first.applied, migrations.map(m => m.id));
  assert.equal((await pendingMigrations(db)).length, 0);
  const second = await applyMigrations(db, { log() {} });
  assert.deepEqual(second.applied, []);
  assert.equal((await db.query('SELECT id FROM schema_migrations')).length, migrations.length);
  await db.close();
});

test('a migration that cannot be verified is reported, not skipped silently', async () => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();
  // Simulate a database whose runtime login could not add the pause columns.
  await db.query('DROP TABLE print_leases');
  await db.query('DROP TABLE devices');
  await db.query('CREATE TABLE devices (id TEXT PRIMARY KEY, shop_id TEXT, name TEXT, token TEXT, active INTEGER, heartbeat TEXT, color INTEGER, duplex INTEGER)');
  await db.query('CREATE TABLE print_leases (order_id TEXT PRIMARY KEY)');
  const result = await applyMigrations(db, { log() {} });
  assert.equal(result.failed?.id, '0002_device_pause');
  assert.deepEqual(result.applied, ['0001_baseline']);
  await db.close();
});
