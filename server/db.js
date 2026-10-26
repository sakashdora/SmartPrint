import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { schema } from './schema.js';
const tableNames = 'users|shops|documents|quotes|orders|transactions|payment_events|audit|sessions|rate_limits|mfa|passkeys|devices|print_leases|refunds|worker_status|shop_payments|upi_receipts|uploads|upload_chunks|preparations|idempotency_keys|order_history|notifications';
const qualify = sql => sql.replace(new RegExp(`\\b(FROM|JOIN|UPDATE|INTO|TABLE IF NOT EXISTS|REFERENCES|ON)\\s+(${tableNames})\\b`, 'gi'), '$1 smartprint.$2');

export async function openDatabase({ url = process.env.DATABASE_URL, path = '.data/smartprint.sqlite' } = {}) {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 60000 });
    pool.on('error', () => console.error('Idle database connection closed; the next request will reconnect.'));
    const connect = async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await pool.connect(); }
        catch (error) {
          if (!['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT'].includes(error.code) || attempt >= 2) throw Object.assign(error, { status: 503, message: 'Database connection unavailable. Please try again shortly.' });
          await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 200));
        }
      }
    };
    // Only acquisition retries. Once SQL starts, never replay an ambiguous write.
    const query = async (sql, params = []) => { const client = await connect(); try { return (await client.query(qualify(sql), params)).rows; } finally { client.release(); } };
    // In development or preview, probe connection. If remote DB is unreachable, cleanly fall back to SQLite
    if (process.env.NODE_ENV !== 'production') {
      try {
        const client = await connect();
        client.release();
      } catch (err) {
        console.warn(`[SmartPrint DB] Remote database unavailable (${err.code || err.message}). Falling back to local SQLite (.data/smartprint.sqlite) for local preview.`);
        await pool.end().catch(() => {});
        return openDatabase({ url: null, path });
      }
    }
    return { kind: 'Neon/PostgreSQL', query,
      migrate: async () => {
        const client = await connect();
        try {
          // Check if smartprint schema already exists before attempting CREATE SCHEMA.
          // In PostgreSQL, CREATE SCHEMA IF NOT EXISTS requires database-level CREATE privilege
          // even when the schema already exists, which throws 'permission denied for database'
          // when connecting via a scoped application role.
          const schemaCheck = await client.query("SELECT to_regnamespace('smartprint') AS oid").catch(() => ({ rows: [] }));
          if (!schemaCheck.rows?.[0]?.oid) {
            try {
              await client.query('CREATE SCHEMA IF NOT EXISTS smartprint');
            } catch (err) {
              if (!err.message?.includes('permission denied')) throw err;
            }
          }
          await client.query('BEGIN');
          try {
            await client.query('SAVEPOINT sp_schema');
            await client.query(qualify(schema));
            await client.query('RELEASE SAVEPOINT sp_schema');
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT sp_schema').catch(() => {});
            if (!err.message?.includes('permission denied') && !err.message?.includes('must be owner')) throw err;
          }
          for (const [table, column, def] of [
            ['orders', 'file_name', "TEXT DEFAULT 'document.pdf'"],
            ['orders', 'priority', 'INTEGER DEFAULT 0'],
            ['mfa', 'recovery_codes', "TEXT DEFAULT '[]'"],
            ['mfa', 'created', "TEXT"],
            ['users', 'status', "TEXT NOT NULL DEFAULT 'active'"],
            ['shop_payments', 'qr_image', 'TEXT'],
          ]) {
            try {
              await client.query(`SAVEPOINT sp_${table}_${column}`);
              await client.query(`ALTER TABLE smartprint.${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`);
              await client.query(`RELEASE SAVEPOINT sp_${table}_${column}`);
            } catch (err) {
              await client.query(`ROLLBACK TO SAVEPOINT sp_${table}_${column}`).catch(() => {});
              if (!err.message?.includes('permission denied') && !err.message?.includes('must be owner')) throw err;
            }
          }
          try {
            await client.query('SAVEPOINT sp_users_role_check');
            await client.query("ALTER TABLE smartprint.users DROP CONSTRAINT IF EXISTS users_role_check");
            await client.query("ALTER TABLE smartprint.users ADD CONSTRAINT users_role_check CHECK(role IN ('owner','admin','customer'))");
            await client.query('RELEASE SAVEPOINT sp_users_role_check');
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT sp_users_role_check').catch(() => {});
          }
          await client.query('COMMIT');
        } catch(error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally { client.release(); }
      }, close: () => pool.end(),
      transaction: async fn => {
        const client = await connect();
        try { await client.query('BEGIN'); const result = await fn({ query: async (s, p = []) => (await client.query(qualify(s), p)).rows }); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      }
    };
  }
  mkdirSync('.data', { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -64000; PRAGMA temp_store = MEMORY;');
  const direct = async (sql, params = []) => {
    const ordered = [];
    const statement = sqlite.prepare(sql.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n) - 1]); return '?'; }));
    return statement.all(...ordered);
  };
  let tail = Promise.resolve();
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  return { kind: 'SQLite development', query: (sql, params) => serial(() => direct(sql, params)),
    migrate: () => serial(() => {
      sqlite.exec(schema.replaceAll('BYTEA', 'BLOB'));
      try { sqlite.exec("ALTER TABLE orders ADD COLUMN file_name TEXT DEFAULT 'document.pdf';"); } catch {}
      try { sqlite.exec("ALTER TABLE orders ADD COLUMN priority INTEGER DEFAULT 0;"); } catch {}
      try { sqlite.exec("ALTER TABLE mfa ADD COLUMN recovery_codes TEXT DEFAULT '[]';"); } catch {}
      try { sqlite.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';"); } catch {}
      try { sqlite.exec("ALTER TABLE shop_payments ADD COLUMN qr_image TEXT;"); } catch {}
    }),
    close: () => sqlite.close(),
    transaction: fn => serial(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = await fn({ query: direct }); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    })
  };
}
