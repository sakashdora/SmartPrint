import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../../server/db.js';
import { createApp } from '../../server/index.js';
import { hashPassword, loadKey, encrypt } from '../../server/security.js';
import { enqueueJob, storeObject } from '../../server/queue.js';

export const PASSWORD = 'a-long-test-password-1';
export const key = loadKey();
export const pdf = async (pages = 1) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage().drawText(`page ${i + 1}`); return Buffer.from(await d.save()); };

// By default every test gets a private in-memory SQLite database. With SMARTPRINT_TEST_DATABASE_URL pointing at a
// disposable PostgreSQL database (its name must contain "test") the same tests run on PostgreSQL. Run such a pass
// with --test-concurrency=1 because every test recreates the schema.
const pgUrl = process.env.SMARTPRINT_TEST_DATABASE_URL;
export async function freshDatabase() {
  if (!pgUrl) return openDatabase({ url: null, path: ':memory:' });
  const name = decodeURIComponent(new URL(pgUrl).pathname.slice(1));
  if (!/test/i.test(name) || [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL].includes(pgUrl)) throw new Error('Refusing to reset a database that is not clearly a test database.');
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect(); await admin.query('DROP SCHEMA IF EXISTS smartprint CASCADE'); await admin.end();
  return openDatabase({ url: pgUrl });
}

export async function boot(t) {
  const db = await freshDatabase();
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, raw, cookie, bearer, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/pdf' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), ...(raw ? { body: raw } : {}) });
    return { status: response.status, body: (response.headers.get('content-type') || '').includes('json') ? await response.json() : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const hash = await hashPassword(PASSWORD);
  const member = async (orgId, role) => {
    const userId = randomUUID(), email = `${role}-${userId.slice(0, 6)}@x.test`;
    await db.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,'customer')", [userId, email, hash]);
    await db.query('INSERT INTO memberships (id,org_id,user_id,role,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), orgId, userId, role, new Date().toISOString()]);
    await db.query("INSERT INTO edu_profiles (user_id,org_id,kind,college_id,name,status,created) VALUES ($1,$2,$3,$4,$5,'active',$6)", [userId, orgId, role === 'student' ? 'student' : 'staff', `T-${userId.slice(0, 8)}`, role, new Date().toISOString()]);
    const session = await call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    return { userId, email, cookie: session.cookie };
  };
  const org = async (name, role = 'institution_admin') => {
    const orgId = randomUUID(), slug = `${name}-${orgId.slice(0, 5)}`;
    await db.query("INSERT INTO organizations (id,type,name,slug,status,created) VALUES ($1,'education',$2,$3,'active',$4)", [orgId, name, slug, new Date().toISOString()]);
    return { orgId, slug, ...(await member(orgId, role)) };
  };
  const agent = async (admin, printers = [{ name: 'Mono', color: false, duplex: false }], name = 'PC') => {
    const created = await call('/api/v2/edu/agents', { method: 'POST', cookie: admin.cookie, body: { name } });
    const enrolled = await call('/api/agent/v2/enroll', { method: 'POST', body: { code: created.body.enrolmentCode, version: '3.0.0' } });
    const report = await call('/api/agent/v2/printers/report', { method: 'POST', bearer: enrolled.body.credential, body: { printers } });
    const printerIds = Object.fromEntries(report.body.printers.map(p => [p.name, p.id]));
    const api = (path, opts = {}) => call(path, { ...opts, bearer: enrolled.body.credential });
    return {
      id: enrolled.body.agentId, credential: enrolled.body.credential, printers: printerIds, call: api,
      claim: async (...names) => (await api('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: (names.length ? names : Object.keys(printerIds)).map(n => printerIds[n]) } })).body.jobs,
      report: (claim, body) => api(`/api/agent/v2/attempts/${claim.attemptId}/events`, { method: 'POST', headers: { 'X-Lease-Token': claim.leaseToken }, body }),
      // claim one job and print it to completion; returns the claimed job or undefined
      printNext: async function (name) {
        const [claimed] = await this.claim(name);
        if (!claimed) return undefined;
        await this.report(claimed, { event: 'submitted' });
        await this.report(claimed, { event: 'completed', pages: claimed.pages });
        return claimed;
      }
    };
  };
  const job = (orgId, options = {}, extra = {}) => db.transaction(async tx => {
    const objectId = await storeObject(tx, orgId, await pdf(), { encrypt, key });
    return enqueueJob(tx, { orgId, objectId, options, pages: 1, ...extra });
  });
  const number = async (sql, params) => Number((await db.query(sql, params))[0].n);
  return { db, service, call, org, member, agent, job, number, base };
}
