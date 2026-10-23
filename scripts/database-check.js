import { openDatabase } from '../server/db.js';
try { const db = await openDatabase(); const result = await db.query('SELECT 1 AS connected'); console.log(result[0].connected === 1 ? 'Database connection verified over TLS.' : 'Unexpected database response.'); await db.close(); }
catch(error) { console.error('Database connection failed:', error.code || error.name); process.exitCode = 1; }
