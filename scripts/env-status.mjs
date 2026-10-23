import { existsSync } from 'node:fs';
for (const name of ['DATABASE_URL','FILE_ENCRYPTION_KEY','CRON_SECRET','PROCESSOR_SECRET','ADMIN_EMAIL','ADMIN_PASSWORD','PUBLIC_BASE_URL']) console.log(`${name}: ${process.env[name] ? 'configured' : 'missing'}`);
console.log(`Vercel project link: ${existsSync('.vercel/project.json') ? 'present' : 'not linked'}`);
