import { openDatabase } from './db.js';
// `npm start` runs this before the server. On a developer machine a local-operator
// MIGRATION_DATABASE_URL (often the production owner login) must not be migrated silently, so a
// non-production start skips it; `npm run migrate` remains the explicit way to migrate that database.
const hosted = ['RENDER', 'RAILWAY_ENVIRONMENT', 'KOYEB_PUBLIC_DOMAIN', 'VERCEL'].some(name => process.env[name]);
const operatorOnly = process.env.MIGRATION_DATABASE_URL && process.env.MIGRATION_DATABASE_URL !== process.env.DATABASE_URL;
if (process.env.npm_lifecycle_event === 'start' && process.env.NODE_ENV !== 'production' && !hosted && operatorOnly) {
  console.log('Skipping MIGRATION_DATABASE_URL during a local `npm start`. Run `npm run migrate` to migrate that database deliberately.');
} else {
  const db = await openDatabase({ url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL });
  try {
    await db.migrate();
    console.log(`Schema applied to ${db.kind}`);
  } catch (error) {
    console.error('Migration notice:', error.code || error.name || error.message);
    if (!error.message?.includes('already exists')) {
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}
