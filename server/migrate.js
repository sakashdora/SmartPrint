import { openDatabase } from './db.js';
const db = await openDatabase({ url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL });
try { await db.migrate(); console.log(`Schema applied to ${db.kind}`); }
catch (error) { console.error('Migration failed:', error.code || error.name); process.exitCode = 1; }
finally { await db.close(); }
