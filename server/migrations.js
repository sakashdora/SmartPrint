// Versioned, recorded schema changes.
//
// The baseline schema is still created by `db.migrate()` (CREATE IF NOT EXISTS plus a list of additive
// ALTERs). That step runs with whatever database login the process has and deliberately tolerates
// "permission denied", so on its own it cannot tell an operator that a change did not land. Every change
// is therefore ALSO listed here: `up()` either performs it or *verifies* it, and a row in
// `schema_migrations` records that it did. A migration that cannot run is reported (and, with
// REQUIRE_MIGRATIONS=true, stops the server from starting) instead of being skipped silently.
//
import { backfillBusinessOrgs } from './orgs.js';

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
  ,
  {
    id: '0004_organizations',
    description: 'Organizations, memberships, registrations, invitations; every shop wrapped by a business organization',
    async up(tx) {
      for (const table of ['organizations', 'memberships', 'organization_registrations', 'invitations', 'auth_tokens', 'audit_log_v2', 'email_outbox']) await tx.query(`SELECT 1 FROM ${table} LIMIT 1`);
      await tx.query('SELECT organization_id FROM shops LIMIT 1');
      await backfillBusinessOrgs(tx);
    }
  }
  ,
  {
    id: '0005_agents_printers_queue',
    description: 'Agents, printers, pools, stored objects, print jobs, fenced attempts, queue and health events',
    async up(tx) {
      for (const table of ['agents', 'agent_credentials', 'printers', 'printer_pools', 'pool_members', 'stored_objects', 'print_jobs', 'print_attempts', 'queue_events', 'agent_health_events']) await tx.query(`SELECT 1 FROM ${table} LIMIT 1`);
    }
  }
  ,
  {
    id: '0006_institutions_people',
    description: 'Institution settings, campuses, departments, staff and student profiles',
    async up(tx) {
      for (const table of ['institution_settings', 'campuses', 'departments', 'edu_profiles']) await tx.query(`SELECT 1 FROM ${table} LIMIT 1`);
      await tx.query('SELECT owner_id FROM stored_objects LIMIT 1');
    }
  }
  ,
  {
    id: '0007_users_role_allows_customer',
    description: 'users.role accepts the placeholder role used by institution accounts',
    async up(tx, { postgres }) {
      if (postgres) {
        const rows = await tx.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='smartprint.users'::regclass AND contype='c' AND conname='users_role_check'");
        if (rows.length && !String(rows[0].def).includes("'customer'")) throw new Error("users_role_check does not allow 'customer'; run npm run migrate with the database owner login");
      } else {
        const [table] = await tx.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
        if (table && !String(table.sql).includes("'customer'")) throw new Error("this SQLite file was created by an old version (users.role check without 'customer'); delete it or point SMARTPRINT_SQLITE_PATH at a new file");
      }
    }
  }
  ,
  {
    id: '0008_fair_queue',
    description: 'Fair-queue state: pool scheduler settings, job virtual finish time and sort key, per-class clocks',
    async up(tx) {
      await tx.query('SELECT vtime, weights, aging_rate, max_wait_seconds, user_cap FROM printer_pools LIMIT 1');
      await tx.query('SELECT vft, sort_key FROM print_jobs LIMIT 1');
      await tx.query('SELECT 1 FROM queue_classes LIMIT 1');
    }
  }
  ,
  {
    id: '0009_document_storage',
    description: 'Per-institution document keys and object-store bookkeeping',
    async up(tx) {
      await tx.query('SELECT enc, purged_at FROM stored_objects LIMIT 1');
      await tx.query('SELECT dek_wrapped, dek_destroyed_at FROM organizations LIMIT 1');
    }
  }
  ,
  {
    id: '0010_wallet_ledger',
    description: 'Wallet accounts, balances, holds and an insert-only ledger',
    async up(tx, { postgres }) {
      for (const table of ['wallet_accounts', 'wallet_balances', 'ledger_entries', 'wallet_holds']) await tx.query(`SELECT 1 FROM ${table} LIMIT 1`);
      // The ledger can only be appended to: the database itself refuses to change or remove an entry.
      if (postgres) {
        await tx.query("CREATE OR REPLACE FUNCTION smartprint.ledger_immutable() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'ledger entries are immutable'; END $fn$ LANGUAGE plpgsql");
        await tx.query('DROP TRIGGER IF EXISTS ledger_immutable ON smartprint.ledger_entries');
        await tx.query('CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON smartprint.ledger_entries FOR EACH ROW EXECUTE FUNCTION smartprint.ledger_immutable()');
      } else {
        await tx.query("CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END");
        await tx.query("CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END");
      }
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
