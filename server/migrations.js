// Versioned, recorded schema changes.
//
// The baseline schema is still created by `db.migrate()` (CREATE IF NOT EXISTS plus a list of additive
// ALTERs). That step runs with whatever database login the process has and deliberately tolerates
// "permission denied", so on its own it cannot tell an operator that a change did not land. Every change
// is therefore ALSO listed here: `up()` either performs it or *verifies* it, and a row in
// `schema_migrations` records that it did. A migration that cannot run is reported (and, with
// REQUIRE_MIGRATIONS=true, stops the server from starting) instead of being skipped silently.
//
// Rules for new migrations: additive only (expand, backfill, contract in later releases), idempotent, no
// Business column drops or renames, and valid on both PostgreSQL (`postgres` true) and SQLite.
export const migrations = [
  {
    id: '0001_baseline',
    description: 'Original schema is present',
    async up(tx) {
      for (const table of ['users', 'shops', 'orders', 'devices', 'print_leases', 'transactions']) await tx.query(`SELECT 1 FROM ${table} LIMIT 1`);
    }
  },
  {
    id: '0002_device_pause',
    description: 'Printer pause state is stored in the database (devices.paused, devices.paused_note)',
    async up(tx) { await tx.query('SELECT paused, paused_note FROM devices LIMIT 1'); }
  },
  {
    id: '0003_housekeeping_indexes',
    description: 'Indexes used by admin lists, quote expiry and lease sweeps',
    async up(tx) {
      for (const sql of [
        'CREATE INDEX IF NOT EXISTS audit_created ON audit(created)',
        'CREATE INDEX IF NOT EXISTS orders_created ON orders(created)',
        'CREATE INDEX IF NOT EXISTS quotes_expires ON quotes(expires)',
        'CREATE INDEX IF NOT EXISTS leases_expires ON print_leases(expires, state)'
      ]) await tx.query(sql);
    }
  }
];

const now = () => new Date().toISOString();

export async function appliedMigrations(db) {
  try { return new Set((await db.query('SELECT id FROM schema_migrations')).map(row => row.id)); }
  catch { return new Set(); }
}

export async function pendingMigrations(db) {
  const applied = await appliedMigrations(db);
  return migrations.filter(migration => !applied.has(migration.id));
}

// Runs every pending migration in order, each in its own transaction together with its bookkeeping row.
// Returns { applied: [ids], failed: { id, error } | null }. Stops at the first failure.
export async function applyMigrations(db, { log = console.log } = {}) {
  const postgres = Boolean(db.kind?.includes('PostgreSQL'));
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied TEXT NOT NULL)').catch(() => {});
  const applied = [];
  for (const migration of await pendingMigrations(db)) {
    try {
      await db.transaction(async tx => {
        await migration.up(tx, { postgres });
        await tx.query('INSERT INTO schema_migrations (id, applied) VALUES ($1, $2) ON CONFLICT(id) DO NOTHING', [migration.id, now()]);
      });
      applied.push(migration.id);
      log(`[Migrations] Applied ${migration.id}: ${migration.description}`);
    } catch (error) {
      return { applied, failed: { id: migration.id, error: error.message } };
    }
  }
  return { applied, failed: null };
}
