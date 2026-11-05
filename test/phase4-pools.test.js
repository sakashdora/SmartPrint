import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, pdf } from './helpers/edu.js';

// A college with three printer groups: Physics (two mono printers), Chemistry (one colour printer) and an open library printer.
async function college(t, name) {
  const ctx = await boot(t);
  const admin = await ctx.org(name);
  const info = (await ctx.call('/api/v2/edu/institution', { cookie: admin.cookie })).body;
  await ctx.call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: admin.cookie, body: { version: info.version, policies: { studentPrinting: 'free' } } });
  const dept = async n => (await ctx.call('/api/v2/edu/departments', { method: 'POST', cookie: admin.cookie, body: { name: n } })).body.id;
  const [physics, chemistry] = [await dept('Physics'), await dept('Chemistry')];
  const phys = await ctx.agent(admin, [{ name: 'Phys A', color: false, duplex: false }, { name: 'Phys B', color: false, duplex: false }], 'Physics PC');
  const chem = await ctx.agent(admin, [{ name: 'Chem Colour', color: true, duplex: true }], 'Chemistry PC');
  const lib = await ctx.agent(admin, [{ name: 'Library Mono', color: false, duplex: false }], 'Library PC');
  const pools = (await ctx.call('/api/v2/edu/pools', { cookie: admin.cookie })).body;
  const defaultPool = pools.find(p => p.is_default).id;
  const makePool = async (n, printerNames, agent) => {
    const id = (await ctx.call('/api/v2/edu/pools', { method: 'POST', cookie: admin.cookie, body: { name: n } })).body.id;
    await ctx.call(`/api/v2/edu/pools/${id}/members`, { method: 'PUT', cookie: admin.cookie, body: { printerIds: printerNames.map(p => agent.printers[p]) } });
    return id;
  };
  const physicsPool = await makePool('Physics', ['Phys A', 'Phys B'], phys), chemistryPool = await makePool('Chemistry', ['Chem Colour'], chem);
  // Only the library printer stays in the open default pool.
  await ctx.call(`/api/v2/edu/pools/${defaultPool}/members`, { method: 'PUT', cookie: admin.cookie, body: { printerIds: [lib.printers['Library Mono']] } });
  const access = (poolId, departmentIds, who = admin) => ctx.call(`/api/v2/edu/pools/${poolId}/access`, { method: 'PUT', cookie: who.cookie, body: { departmentIds } });
  await access(physicsPool, [physics]); await access(chemistryPool, [chemistry]);
  const person = async (role, departmentId = null) => { const m = await ctx.member(admin.orgId, role); if (departmentId) await ctx.db.query('UPDATE edu_profiles SET department_id=$1 WHERE user_id=$2', [departmentId, m.userId]); return m; };
  const submit = async (who, options = {}, poolId) => {
    const documentId = (await ctx.call('/api/v2/edu/documents', { method: 'POST', cookie: who.cookie, raw: await pdf(1) })).body.documentId;
    return ctx.call('/api/v2/edu/jobs', { method: 'POST', cookie: who.cookie, body: { documentId, fileName: 'a.pdf', options, ...(poolId ? { poolId } : {}) } });
  };
  const poolOf = async jobId => (await ctx.db.query('SELECT pool_id FROM print_jobs WHERE id=$1', [jobId]))[0].pool_id;
  return { ...ctx, admin, physics, chemistry, phys, chem, lib, defaultPool, physicsPool, chemistryPool, access, person, submit, poolOf };
}

test('each department prints on its own printers; the library printer stays open to everyone', async t => {
  const c = await college(t, 'routing');
  const sPhys = await c.person('student', c.physics), sChem = await c.person('student', c.chemistry), sNone = await c.person('student');
  const a = await c.submit(sPhys), b = await c.submit(sChem, { color: 'color' }), d = await c.submit(sNone);
  assert.deepEqual([await c.poolOf(a.body.jobId), await c.poolOf(b.body.jobId), await c.poolOf(d.body.jobId)], [c.physicsPool, c.chemistryPool, c.defaultPool]);
  // Only the owning pool's printers can take each job.
  assert.deepEqual(await c.chem.claim('Chem Colour').then(j => j.map(x => x.jobId)), [b.body.jobId]);
  assert.deepEqual(await c.lib.claim('Library Mono').then(j => j.map(x => x.jobId)), [d.body.jobId]);
  assert.deepEqual((await c.phys.claim('Phys A', 'Phys B')).map(j => j.jobId), [a.body.jobId], 'one job, taken by one of the two Physics printers');
});

test('a department may have several printers; both serve its queue', async t => {
  const c = await college(t, 'multi');
  const s1 = await c.person('student', c.physics), s2 = await c.person('student', c.physics);
  const j1 = await c.submit(s1), j2 = await c.submit(s2);
  const claimed = await c.phys.claim('Phys A', 'Phys B');
  assert.deepEqual(claimed.map(j => j.jobId).sort(), [j1.body.jobId, j2.body.jobId].sort(), 'two printers, two jobs at once');
  assert.equal(new Set(claimed.map(j => j.printerId)).size, 2);
});

test('nobody prints on another department\'s printers, and capability rules still apply', async t => {
  const c = await college(t, 'forbidden');
  const sPhys = await c.person('student', c.physics), sNone = await c.person('student');
  assert.deepEqual([(await c.submit(sNone, {}, c.physicsPool)).status, (await c.submit(sNone, {}, c.physicsPool)).body.code], [403, 'pool.not_allowed']);
  assert.equal((await c.submit(sPhys, {}, c.chemistryPool)).status, 403, 'Physics cannot use the Chemistry group');
  // A Physics student needs colour: Physics has none and the open library printer is mono, and Chemistry's colour printer is not theirs.
  const colour = await c.submit(sPhys, { color: 'color' });
  assert.deepEqual([colour.status, colour.body.code], [409, 'job.no_compatible_printer']);
  assert.equal(await c.number('SELECT COUNT(*) AS n FROM print_jobs'), 0);
  // The administrator and operators can use every group.
  const operator = await c.person('print_operator');
  assert.equal((await c.submit(operator, { color: 'color' }, c.chemistryPool)).status, 201);
});

test('departments can share one printer group, and a group can be opened or closed later', async t => {
  const c = await college(t, 'sharing');
  const sPhys = await c.person('student', c.physics), sNone = await c.person('student');
  assert.equal((await c.submit(sPhys, { color: 'color' })).status, 409);
  // Share the Chemistry colour printer with Physics.
  assert.equal((await c.access(c.chemistryPool, [c.chemistry, c.physics])).status, 200);
  const shared = await c.submit(sPhys, { color: 'color' });
  assert.equal(shared.status, 201);
  assert.equal(await c.poolOf(shared.body.jobId), c.chemistryPool, 'routed to the shared group with a colour printer');
  assert.equal((await c.submit(sNone, { color: 'color' })).status, 409, 'still closed to people outside those departments');
  // Open it to everybody (no departments listed).
  assert.deepEqual((await c.access(c.chemistryPool, [])).body, { ok: true, open: true });
  assert.equal((await c.submit(sNone, { color: 'color' })).status, 201);
  // Close it again.
  await c.access(c.chemistryPool, [c.chemistry]);
  assert.equal((await c.submit(sNone, { color: 'color' })).status, 409);
});

test('people see only the printer groups they may use', async t => {
  const c = await college(t, 'visible');
  const sPhys = await c.person('student', c.physics), sNone = await c.person('student'), staff = await c.person('staff', c.chemistry);
  const names = async who => (await c.call('/api/v2/edu/pools/available', { cookie: who.cookie })).body.map(p => p.name);
  assert.deepEqual(await names(sPhys), ['Physics', 'Default'], 'their own group first, then the open one');
  assert.deepEqual(await names(sNone), ['Default']);
  assert.deepEqual(await names(staff), ['Chemistry', 'Default']);
  assert.deepEqual((await names(c.admin)).sort(), ['Chemistry', 'Default', 'Physics']);
  const listing = (await c.call('/api/v2/edu/pools', { cookie: c.admin.cookie })).body;
  assert.deepEqual(listing.find(p => p.id === c.physicsPool).departmentIds, [c.physics]);
  assert.deepEqual(listing.find(p => p.is_default).departmentIds, []);
});

test('pool access is validated, audited and limited to the institution administrator of that institution', async t => {
  const c = await college(t, 'guarded');
  const other = await c.org('guarded-b');
  await c.agent(other);
  const otherDept = (await c.call('/api/v2/edu/departments', { method: 'POST', cookie: other.cookie, body: { name: 'Biology' } })).body.id;
  const student = await c.person('student', c.physics), hod = await c.person('department_admin', c.physics);
  assert.equal((await c.access(c.physicsPool, [c.physics], student)).status, 403);
  assert.equal((await c.access(c.physicsPool, [c.physics], hod)).status, 403, 'a department admin cannot grant access');
  assert.equal((await c.access(c.physicsPool, [otherDept])).status, 404, "another institution's department is not accepted");
  assert.equal((await c.access(c.physicsPool, ['00000000-0000-0000-0000-000000000000'])).status, 404);
  assert.equal((await c.access(c.physicsPool, [c.physics], other)).status, 404, "another institution cannot touch this institution's group");
  assert.equal(await c.number("SELECT COUNT(*) AS n FROM pool_departments WHERE pool_id=$1", [c.physicsPool]), 1, 'failed attempts changed nothing');
  assert.ok((await c.db.query("SELECT action FROM audit_log_v2 WHERE org_id=$1", [c.admin.orgId])).some(r => r.action === 'pool.access_set'));
});
