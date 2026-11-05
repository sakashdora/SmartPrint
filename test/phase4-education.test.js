import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { hashPassword } from '../server/security.js';

const PASSWORD = 'a-long-test-password-1';
const pdf = async (pages = 1) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage().drawText(`page ${i + 1}`); return Buffer.from(await d.save()); };

async function boot(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, raw, cookie, bearer, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/pdf' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), ...(raw ? { body: raw } : {}) });
    return { status: response.status, body: (response.headers.get('content-type') || '').includes('json') ? await response.json() : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const hash = await hashPassword(PASSWORD);
  const org = async (name, role = 'institution_admin') => {
    const orgId = randomUUID(), slug = `${name}-${orgId.slice(0, 5)}`;
    await db.query("INSERT INTO organizations (id,type,name,slug,status,created) VALUES ($1,'education',$2,$3,'active',$4)", [orgId, name, slug, new Date().toISOString()]);
    return { orgId, slug, ...(await member(orgId, role)) };
  };
  const member = async (orgId, role) => {
    const userId = randomUUID(), email = `${role}-${userId.slice(0, 6)}@x.test`;
    await db.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,'customer')", [userId, email, hash]);
    await db.query('INSERT INTO memberships (id,org_id,user_id,role,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), orgId, userId, role, new Date().toISOString()]);
    await db.query("INSERT INTO edu_profiles (user_id,org_id,kind,college_id,name,status,created) VALUES ($1,$2,$3,$4,$5,'active',$6)", [userId, orgId, role === 'student' ? 'student' : 'staff', `T-${userId.slice(0, 6)}`, role, new Date().toISOString()]);
    const session = await call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    return { userId, email, cookie: session.cookie };
  };
  const agent = async (admin, printers = [{ name: 'Mono', color: false, duplex: false }]) => {
    const created = await call('/api/v2/edu/agents', { method: 'POST', cookie: admin.cookie, body: { name: 'PC' } });
    const enrolled = await call('/api/agent/v2/enroll', { method: 'POST', body: { code: created.body.enrolmentCode, version: '3.0.0' } });
    const report = await call('/api/agent/v2/printers/report', { method: 'POST', bearer: enrolled.body.credential, body: { printers } });
    return { credential: enrolled.body.credential, printers: Object.fromEntries(report.body.printers.map(p => [p.name, p.id])), call: (path, opts = {}) => call(path, { ...opts, bearer: enrolled.body.credential }) };
  };
  const policies = async (admin, changes) => {
    const current = (await call('/api/v2/edu/institution', { cookie: admin.cookie })).body;
    return call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: admin.cookie, body: { version: current.version, policies: changes } });
  };
  const tokenOf = link => link.match(/reset-password\/([a-f0-9]{64})/)[1];
  return { db, call, org, member, agent, policies, tokenOf, service };
}

test('institution settings: defaults, validation, optimistic locking and role checks', async t => {
  const { call, org, member, policies } = await boot(t);
  const admin = await org('college');
  const first = (await call('/api/v2/edu/institution', { cookie: admin.cookie })).body;
  assert.equal(first.policies.studentPrinting, 'disabled');
  assert.equal(first.version, 0);
  assert.deepEqual(first.setup, { agents: 0, printers: 0, people: 1 });
  assert.equal((await policies(admin, { maxPagesPerJob: 50 })).status, 200);
  assert.equal((await call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: admin.cookie, body: { version: 0, policies: { maxCopies: 5 } } })).status, 409, 'stale version');
  assert.equal((await policies(admin, { nonsense: true })).status, 400);
  assert.equal((await policies(admin, { maxPagesPerJob: 100000 })).status, 400);
  assert.equal((await call('/api/v2/edu/institution', { cookie: admin.cookie })).body.policies.maxPagesPerJob, 50);
  const student = await member(admin.orgId, 'student');
  assert.equal((await call('/api/v2/edu/institution', { cookie: student.cookie })).status, 403);
  assert.equal((await call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: student.cookie, body: { version: 1, policies: { maxCopies: 99 } } })).status, 403);
});

test('a small college needs no departments or campuses; structure can be added later', async t => {
  const { call, org } = await boot(t);
  const admin = await org('small');
  const created = await call('/api/v2/edu/users', { method: 'POST', cookie: admin.cookie, body: { role: 'staff', collegeId: 'EMP-1', name: 'Priya Staff' } });
  assert.equal(created.status, 201, 'a person can be added without any department');
  const dept = await call('/api/v2/edu/departments', { method: 'POST', cookie: admin.cookie, body: { name: 'Physics', code: 'PHY' } });
  assert.equal(dept.status, 201);
  assert.equal((await call('/api/v2/edu/departments', { method: 'POST', cookie: admin.cookie, body: { name: 'Physics' } })).status, 409);
  assert.equal((await call('/api/v2/edu/campuses', { method: 'POST', cookie: admin.cookie, body: { name: 'North' } })).status, 201);
  assert.equal((await call('/api/v2/edu/departments', { method: 'POST', cookie: admin.cookie, body: { name: 'Maths', campusId: randomUUID() } })).status, 404);
  // Later, the same person can be assigned to the new department.
  assert.equal((await call(`/api/v2/edu/users/${created.body.userId}`, { method: 'PATCH', cookie: admin.cookie, body: { departmentId: 'PHY' } })).status, 200);
  assert.equal((await call('/api/v2/edu/users?q=priya', { cookie: admin.cookie })).body[0].department_id, dept.body.id);
});

test('College ID sign-in: no default password, activation link, IDs unique per institution only', async t => {
  const { call, org, tokenOf } = await boot(t);
  const a = await org('alpha'), b = await org('beta');
  const made = await call('/api/v2/edu/users', { method: 'POST', cookie: a.cookie, body: { role: 'student', collegeId: '21CS001', name: 'Asha Student' } });
  assert.equal(made.status, 201);
  const attempt = (body) => call('/api/auth/login', { method: 'POST', body });
  assert.equal((await attempt({ institutionCode: a.slug, collegeId: '21CS001', password: PASSWORD })).status, 401, 'cannot sign in before activation');
  assert.equal((await attempt({ institutionCode: a.slug, collegeId: '21CS001', password: '' })).status, 401);
  assert.equal((await call('/api/v2/auth/password/reset', { method: 'POST', body: { token: tokenOf(made.body.activationLink), password: PASSWORD } })).status, 200);
  const ok = await attempt({ institutionCode: a.slug, collegeId: '21cs001', password: PASSWORD });
  assert.equal(ok.status, 200, 'IDs match regardless of case');
  assert.equal((await call('/api/v2/me', { cookie: ok.cookie })).body.organization.role, 'student');
  assert.equal((await attempt({ institutionCode: b.slug, collegeId: '21CS001', password: PASSWORD })).status, 401, 'another institution has no such person');
  assert.equal((await attempt({ institutionCode: 'no-such-college', collegeId: '21CS001', password: PASSWORD })).status, 401);
  // The same roll number may exist in two institutions; twice in one is refused.
  assert.equal((await call('/api/v2/edu/users', { method: 'POST', cookie: b.cookie, body: { role: 'student', collegeId: '21CS001', name: 'Other Asha' } })).status, 201);
  assert.equal((await call('/api/v2/edu/users', { method: 'POST', cookie: a.cookie, body: { role: 'student', collegeId: '21cs001', name: 'Duplicate' } })).status, 409);
  // Suspending a person signs them out and blocks sign-in.
  assert.equal((await call(`/api/v2/edu/users/${made.body.userId}`, { method: 'PATCH', cookie: a.cookie, body: { status: 'suspended' } })).status, 200);
  assert.equal((await call('/api/v2/me', { cookie: ok.cookie })).status, 401);
  assert.equal((await attempt({ institutionCode: a.slug, collegeId: '21CS001', password: PASSWORD })).status, 403);
});

test('bulk import: dry run, row errors, skip-invalid, activation links', async t => {
  const { call, org, db, tokenOf } = await boot(t);
  const admin = await org('importer');
  await call('/api/v2/edu/departments', { method: 'POST', cookie: admin.cookie, body: { name: 'Chemistry', code: 'CHE' } });
  await call('/api/v2/edu/users', { method: 'POST', cookie: admin.cookie, body: { role: 'student', collegeId: 'EXIST-1', name: 'Existing' } });
  const rows = [
    { collegeId: 'S-001', name: 'One', department: 'CHE' },
    { collegeId: 'S-002', name: 'Two', department: 'Chemistry', email: 'two@college.test' },
    { collegeId: 'S-001', name: 'Dup in file' },
    { collegeId: 'EXIST-1', name: 'Already there' },
    { collegeId: 'S-004', name: 'Bad dept', department: 'Astrology' },
    { collegeId: '!', name: 'Bad id' },
    { collegeId: 'S-006', name: '' },
    { collegeId: 'S-007', name: 'Wrong role', role: 'institution_admin' }
  ];
  const dry = await call('/api/v2/edu/users/import', { method: 'POST', cookie: admin.cookie, body: { rows, dryRun: true } });
  assert.deepEqual(dry.body.summary, { total: 8, valid: 2, invalid: 6 });
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM edu_profiles'))[0].n, 2, 'a dry run creates nothing');
  const refused = await call('/api/v2/edu/users/import', { method: 'POST', cookie: admin.cookie, body: { rows } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'import.invalid_rows');
  const done = await call('/api/v2/edu/users/import', { method: 'POST', cookie: admin.cookie, body: { rows, skipInvalid: true } });
  assert.equal(done.status, 201);
  assert.equal(done.body.summary.created, 2);
  assert.equal(done.body.activations.length, 2);
  assert.equal((await call('/api/v2/auth/password/reset', { method: 'POST', body: { token: tokenOf(done.body.activations[0].activationLink), password: PASSWORD } })).status, 200);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { institutionCode: admin.slug, collegeId: 'S-001', password: PASSWORD } })).status, 200);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM email_outbox WHERE kind='user.activation'"))[0].n, 1, 'only people with an e-mail are mailed');
  assert.equal((await call('/api/v2/edu/users/import', { method: 'POST', cookie: admin.cookie, body: { rows: [] } })).status, 400);
  // A larger file imports quickly (no password hashing per row).
  const big = Array.from({ length: 400 }, (_, i) => ({ collegeId: `BIG-${i}`, name: `Student ${i}` }));
  const started = Date.now();
  assert.equal((await call('/api/v2/edu/users/import', { method: 'POST', cookie: admin.cookie, body: { rows: big } })).body.summary.created, 400);
  assert.ok(Date.now() - started < 15000);
});

test('a department admin works inside their own department only', async t => {
  const { call, org, member, db } = await boot(t);
  const admin = await org('depts');
  const phy = (await call('/api/v2/edu/departments', { method: 'POST', cookie: admin.cookie, body: { name: 'Physics' } })).body.id;
  const che = (await call('/api/v2/edu/departments', { method: 'POST', cookie: admin.cookie, body: { name: 'Chemistry' } })).body.id;
  const inPhy = (await call('/api/v2/edu/users', { method: 'POST', cookie: admin.cookie, body: { role: 'student', collegeId: 'P1', name: 'Phy Student', departmentId: phy } })).body;
  const inChe = (await call('/api/v2/edu/users', { method: 'POST', cookie: admin.cookie, body: { role: 'student', collegeId: 'C1', name: 'Che Student', departmentId: che } })).body;
  const hod = await member(admin.orgId, 'department_admin');
  await db.query('UPDATE edu_profiles SET department_id=$1 WHERE user_id=$2', [phy, hod.userId]);
  const visible = (await call('/api/v2/edu/users', { cookie: hod.cookie })).body;
  assert.ok(visible.every(u => u.department_id === phy) && visible.some(u => u.college_id === 'P1'));
  assert.equal((await call('/api/v2/edu/departments', { cookie: hod.cookie })).body.length, 1);
  assert.equal((await call(`/api/v2/edu/users/${inChe.userId}/reset-password`, { method: 'POST', cookie: hod.cookie })).status, 404);
  assert.equal((await call(`/api/v2/edu/users/${inPhy.userId}/reset-password`, { method: 'POST', cookie: hod.cookie })).status, 200);
  assert.equal((await call('/api/v2/edu/users', { method: 'POST', cookie: hod.cookie, body: { role: 'print_operator', collegeId: 'OP1', name: 'Operator' } })).status, 403);
  const added = await call('/api/v2/edu/users', { method: 'POST', cookie: hod.cookie, body: { role: 'student', collegeId: 'P2', name: 'New Phy', departmentId: che } });
  assert.equal(added.status, 201);
  assert.equal((await db.query('SELECT department_id FROM edu_profiles WHERE user_id=$1', [added.body.userId]))[0].department_id, phy, 'forced into their own department');
  // No institution-wide powers.
  for (const path of ['/api/v2/edu/institution', '/api/v2/edu/agents', '/api/v2/edu/reports/usage', '/api/v2/edu/audit']) assert.equal((await call(path, { cookie: hod.cookie })).status, 403, path);
});

test('staff print end to end: upload, quote, job, agent prints, history, usage report, document removed', async t => {
  const { call, org, member, agent, db } = await boot(t);
  const admin = await org('printing'), staff = await member(admin.orgId, 'staff');
  const a = await agent(admin);
  const upload = await call('/api/v2/edu/documents', { method: 'POST', cookie: staff.cookie, raw: await pdf(3) });
  assert.equal(upload.status, 201);
  assert.equal((await call('/api/v2/edu/documents', { method: 'POST', cookie: staff.cookie, raw: Buffer.from('not a pdf') })).status, 400);
  const quote = await call('/api/v2/edu/jobs/quote', { method: 'POST', cookie: staff.cookie, body: { documentId: upload.body.documentId, options: { copies: 2 } } });
  assert.deepEqual([quote.body.pages, quote.body.costMinor, quote.body.payer], [3, 0, 'institution'], 'staff are not charged');
  // Another person in the same institution cannot use this upload.
  const colleague = await member(admin.orgId, 'staff');
  assert.equal((await call('/api/v2/edu/jobs', { method: 'POST', cookie: colleague.cookie, body: { documentId: upload.body.documentId, options: {} } })).status, 404);
  const job = await call('/api/v2/edu/jobs', { method: 'POST', cookie: staff.cookie, body: { documentId: upload.body.documentId, fileName: 'notice.pdf', options: { copies: 2 } } });
  assert.equal(job.status, 201);
  assert.equal((await db.query('SELECT deleted_at FROM stored_objects WHERE id=$1', [upload.body.documentId]))[0].deleted_at !== null, true, 'the raw upload is not kept');
  const claim = (await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono] } })).body.jobs[0];
  assert.equal(claim.jobId, job.body.jobId);
  const events = body => a.call(`/api/agent/v2/attempts/${claim.attemptId}/events`, { method: 'POST', headers: { 'X-Lease-Token': claim.leaseToken }, body });
  await events({ event: 'submitted' }); await events({ event: 'completed', pages: 6 });
  const mine = (await call('/api/v2/edu/jobs', { cookie: staff.cookie })).body;
  assert.deepEqual([mine.length, mine[0].status, mine[0].fileName, mine[0].pages_printed], [1, 'completed', 'notice.pdf', 6]);
  assert.equal((await call('/api/v2/edu/jobs', { cookie: colleague.cookie })).body.length, 0, 'history is private');
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM stored_objects WHERE deleted_at IS NULL'))[0].n, 0, 'no document is left after printing');
  const report = (await call('/api/v2/edu/reports/usage', { cookie: admin.cookie })).body;
  assert.deepEqual([report.total.jobs, report.total.pagesPrinted, report.byClass.staff.jobs], [1, 6, 1]);
  assert.equal(report.topUsers[0].userId, staff.userId);
  assert.ok((await call('/api/v2/edu/audit', { cookie: admin.cookie })).body.length >= 1);
});

test('student printing is off until enabled, then priced but not charged; policies are enforced', async t => {
  const { call, org, member, agent, policies } = await boot(t);
  const admin = await org('students'), student = await member(admin.orgId, 'student');
  await agent(admin, [{ name: 'Mono', color: false, duplex: false }, { name: 'Colour', color: true, duplex: false }]);
  const up = async (cookie, pages = 1) => (await call('/api/v2/edu/documents', { method: 'POST', cookie, raw: await pdf(pages) })).body.documentId;
  const quote = (cookie, documentId, options = {}) => call('/api/v2/edu/jobs/quote', { method: 'POST', cookie, body: { documentId, options } });
  const blocked = await quote(student.cookie, await up(student.cookie));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'student.printing_disabled');
  assert.equal((await policies(admin, { studentPrinting: 'free', studentRateBwMinor: 300, studentRateColourMinor: 900, maxPagesPerJob: 4 })).status, 200);
  const priced = (await quote(student.cookie, await up(student.cookie, 2), { copies: 2 })).body;
  assert.deepEqual([priced.pages, priced.costMinor, priced.charged, priced.payer], [2, 1200, false, 'student']);
  const coloured = (await quote(student.cookie, await up(student.cookie), { color: 'color' })).body;
  assert.equal(coloured.costMinor, 900);
  assert.equal((await quote(student.cookie, await up(student.cookie, 5))).status, 400, 'page limit');
  assert.equal((await policies(admin, { colourStudents: false, maxCopies: 3 })).status, 200);
  assert.equal((await quote(student.cookie, await up(student.cookie), { color: 'color' })).status, 400, 'colour not allowed for students');
  assert.equal((await quote(student.cookie, await up(student.cookie), { copies: 5 })).status, 400, 'copy limit');
  const submitted = await call('/api/v2/edu/jobs', { method: 'POST', cookie: student.cookie, body: { documentId: await up(student.cookie), options: {} } });
  assert.equal(submitted.status, 201);
  // Own queued job can be cancelled; somebody else's cannot.
  const other = await member(admin.orgId, 'student');
  assert.equal((await call(`/api/v2/edu/my-jobs/${submitted.body.jobId}/cancel`, { method: 'POST', cookie: other.cookie })).status, 404);
  assert.equal((await call(`/api/v2/edu/my-jobs/${submitted.body.jobId}/cancel`, { method: 'POST', cookie: student.cookie })).status, 200);
  assert.equal((await call('/api/v2/edu/queue', { cookie: student.cookie })).status, 403, 'students cannot see the queue');
});

test('retention policy: the printed document is kept for the configured hours, then wiped', async t => {
  const { call, org, member, agent, policies, db, service } = await boot(t);
  const admin = await org('keeper'), staff = await member(admin.orgId, 'staff');
  const a = await agent(admin);
  assert.equal((await policies(admin, { retentionHoursAfterPrint: 2 })).status, 200);
  const documentId = (await call('/api/v2/edu/documents', { method: 'POST', cookie: staff.cookie, raw: await pdf() })).body.documentId;
  await call('/api/v2/edu/jobs', { method: 'POST', cookie: staff.cookie, body: { documentId, options: {} } });
  const claim = (await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono] } })).body.jobs[0];
  const events = body => a.call(`/api/agent/v2/attempts/${claim.attemptId}/events`, { method: 'POST', headers: { 'X-Lease-Token': claim.leaseToken }, body });
  await events({ event: 'submitted' }); await events({ event: 'completed', pages: 1 });
  const [kept] = await db.query('SELECT deleted_at, expires FROM stored_objects WHERE deleted_at IS NULL');
  assert.ok(kept, 'kept for the retention period');
  assert.ok(Date.parse(kept.expires) - Date.now() > 3600000 && Date.parse(kept.expires) - Date.now() < 7300000);
  await db.query("UPDATE stored_objects SET expires='2020-01-01T00:00:00.000Z' WHERE deleted_at IS NULL");
  await service.cleanup(); // the real expiry sweep
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM stored_objects WHERE deleted_at IS NULL'))[0].n, 0);
});

test('institutions cannot see or touch each other', async t => {
  const { call, org, member, db } = await boot(t);
  const a = await org('orgone'), b = await org('orgtwo');
  const dept = (await call('/api/v2/edu/departments', { method: 'POST', cookie: a.cookie, body: { name: 'Secret Dept' } })).body.id;
  const person = (await call('/api/v2/edu/users', { method: 'POST', cookie: a.cookie, body: { role: 'student', collegeId: 'A-1', name: 'A Student', departmentId: dept } })).body;
  assert.equal((await call('/api/v2/edu/users', { cookie: b.cookie })).body.some(u => u.college_id === 'A-1'), false);
  assert.equal((await call('/api/v2/edu/departments', { cookie: b.cookie })).body.length, 0);
  assert.equal((await call(`/api/v2/edu/users/${person.userId}`, { method: 'PATCH', cookie: b.cookie, body: { status: 'suspended' } })).status, 404);
  assert.equal((await call(`/api/v2/edu/users/${person.userId}/reset-password`, { method: 'POST', cookie: b.cookie })).status, 404);
  assert.equal((await call(`/api/v2/edu/departments/${dept}`, { method: 'PATCH', cookie: b.cookie, body: { name: 'Hijacked' } })).status, 404);
  // A forged department id from another institution is not accepted when creating a person.
  assert.equal((await call('/api/v2/edu/users', { method: 'POST', cookie: b.cookie, body: { role: 'student', collegeId: 'B-1', name: 'B Student', departmentId: dept } })).status, 404);
  assert.equal((await db.query("SELECT status FROM edu_profiles WHERE user_id=$1", [person.userId]))[0].status, 'invited');
  assert.equal((await call('/api/v2/edu/audit', { cookie: b.cookie })).body.every(e => e.target_id !== person.userId), true);
  // An uploaded document of one institution is invisible to the other.
  const staffA = await member(a.orgId, 'staff'), staffB = await member(b.orgId, 'staff');
  const documentId = (await call('/api/v2/edu/documents', { method: 'POST', cookie: staffA.cookie, raw: await pdf() })).body.documentId;
  assert.equal((await call('/api/v2/edu/jobs/quote', { method: 'POST', cookie: staffB.cookie, body: { documentId, options: {} } })).status, 404);
});
