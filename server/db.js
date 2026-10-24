import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { schema } from './schema.js';
const tableNames = 'users|shops|documents|quotes|orders|transactions|payment_events|audit|sessions|rate_limits|mfa|devices|print_leases|refunds|worker_status|shop_payments|upi_receipts|uploads|upload_chunks|preparations|idempotency_keys|order_history';
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
          await client.query('BEGIN');
          await client.query('CREATE SCHEMA IF NOT EXISTS smartprint');
          await client.query(qualify(schema));
          await client.query(`
            ALTER TABLE smartprint.orders ADD COLUMN IF NOT EXISTS file_name TEXT DEFAULT 'document.pdf';
            ALTER TABLE smartprint.orders ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
            ALTER TABLE smartprint.devices ADD COLUMN IF NOT EXISTS status_note TEXT DEFAULT 'Ready';
            ALTER TABLE smartprint.devices ADD COLUMN IF NOT EXISTS is_paused INTEGER DEFAULT 0;
          `);
          await client.query('COMMIT');
        } catch(error) {
          await client.query('ROLLBACK');
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
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
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
      try { sqlite.exec("ALTER TABLE devices ADD COLUMN status_note TEXT DEFAULT 'Ready';"); } catch {}
      try { sqlite.exec("ALTER TABLE devices ADD COLUMN is_paused INTEGER DEFAULT 0;"); } catch {}
    }),
    close: () => sqlite.close(),
    transaction: fn => serial(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = await fn({ query: direct }); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    })
  };
}
