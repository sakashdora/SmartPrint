import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { schema } from './schema.js';
const tableNames = 'users|shops|documents|quotes|orders|transactions|payment_events|audit|sessions|rate_limits|mfa|devices|print_leases|refunds|worker_status|shop_payments|upi_receipts|uploads|upload_chunks|preparations';
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
    return { kind: 'Neon/PostgreSQL', query,
      migrate: async () => { const client = await connect(); try { await client.query('BEGIN'); await client.query('CREATE SCHEMA IF NOT EXISTS smartprint'); await client.query(qualify(schema)); await client.query('COMMIT'); } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }, close: () => pool.end(),
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
    migrate: () => serial(() => sqlite.exec(schema.replaceAll('BYTEA', 'BLOB'))),
    close: () => sqlite.close(),
    transaction: fn => serial(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = await fn({ query: direct }); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    })
  };
}
