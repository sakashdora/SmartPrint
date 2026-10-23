import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (process.env.MIGRATION_DATABASE_URL && process.env.MIGRATION_DATABASE_URL !== process.env.DATABASE_URL) { console.log('Separate runtime database credentials are already configured.'); process.exit(0); }
const ownerUrl = process.env.DATABASE_URL, runtimeUrl = new URL(ownerUrl);
const role = `smartprint_app_${randomBytes(4).toString('hex')}`, password = randomBytes(32).toString('base64url');
const client = new pg.Client({ connectionString: ownerUrl });
let runtime;
try {
  await client.connect(); await client.query('BEGIN');
  // Identifier and password are generated above from fixed safe alphabets, never user input.
  await client.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await client.query(`GRANT USAGE ON SCHEMA smartprint TO "${role}"`);
  await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA smartprint TO "${role}"`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA smartprint GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO "${role}"`);
  await client.query('COMMIT');
  runtimeUrl.username = role; runtimeUrl.password = password; runtimeUrl.searchParams.set('sslmode', 'verify-full');
  runtime = new pg.Client({ connectionString: runtimeUrl.href }); await runtime.connect();
  const { rows: [access] } = await runtime.query("SELECT has_schema_privilege(current_user,'smartprint','CREATE') AS can_create,has_table_privilege(current_user,'smartprint.orders','SELECT,INSERT,UPDATE,DELETE') AS can_use");
  if (access.can_create || !access.can_use) throw new Error('Runtime privilege verification failed.');
  const source = await readFile('.env', 'utf8');
  const updated = source.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${runtimeUrl.href}`).replace(/^MIGRATION_DATABASE_URL=.*\r?\n?/m, '') + `\nMIGRATION_DATABASE_URL=${ownerUrl}\n`;
  await writeFile('.env.runtime.tmp', updated, { mode: 0o600 }); await rename('.env.runtime.tmp', '.env');
  console.log('Neon runtime role configured and verified: SmartPrint table access only, no schema creation. Owner connection retained locally as MIGRATION_DATABASE_URL.');
} catch (error) { await client.query('ROLLBACK').catch(() => {}); console.error('Runtime database setup failed:', error.code || error.name); process.exitCode = 1; }
finally { await runtime?.end().catch(() => {}); await client.end(); }
