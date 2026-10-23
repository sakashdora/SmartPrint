import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
let source = readFileSync('.env', 'utf8');
for (const key of ['FILE_ENCRYPTION_KEY', 'PROCESSOR_SECRET', 'CRON_SECRET']) if (!new RegExp(`^${key}=.+`, 'm').test(source)) source += `\n${key}=${randomBytes(32).toString('hex')}`;
if (!/^ADMIN_EMAIL=/m.test(source)) source += '\nADMIN_EMAIL=sakashdora@gmail.com';
if (!/^ADMIN_PASSWORD=/m.test(source)) source += '\nADMIN_PASSWORD=';
writeFileSync('.env', source + '\n', { mode: 0o600 });
console.log('Local secret configuration initialized. Values were not printed.');
