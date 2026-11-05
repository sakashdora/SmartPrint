import { randomUUID } from 'node:crypto';
import express from 'express';
import { token, digest, encrypt, decrypt } from './security.js';
import { auditV2 } from './orgs.js';
import { sendMail } from './mailer.js';
import { requirePermission } from './tenant.js';
import { storeObject, enqueueJob, cancelJob } from './queue.js';
import { validateOptions, price } from './print-options.js';
import { prepare } from './printing.js';
import { readObject, markObjectDeleted } from './storage.js';
import { walletRoutes, holdForJob, ensureAccount, balanceOf } from './wallet.js';

const now = () => new Date().toISOString();
const later = ms => new Date(Date.now() + ms).toISOString();
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

// ---- Institution policies (validated; unknown keys are rejected) ----------------------------------------------
export const DEFAULT_POLICIES = Object.freeze({
  studentPrinting: 'disabled',      // 'disabled', 'free' (priced, never charged: pilot) or 'wallet' (held and charged from the student's wallet)
  maxPagesPerJob: 100, maxCopies: 20,
  colourStudents: true, colourStaff: true,
  retentionHoursAfterPrint: 0,      // 0 = delete the document as soon as the job is done
  studentRateBwMinor: 200, studentRateColourMinor: 1000,
  offlineStudentPrinting: false,    // students may reserve money for use while the internet is down
  offlineStaffPrinting: false,
  maxReservationMinor: 20000,       // most a student may keep reserved at once (paise)
  reservationHours: 24,
  offlineStaffDailyPages: 200       // most pages one staff member may print through an agent's offline portal per day
});
const POLICY_RULES = {
  studentPrinting: v => ['disabled', 'free', 'wallet'].includes(v),
  maxPagesPerJob: v => Number.isInteger(v) && v >= 1 && v <= 500,
  maxCopies: v => Number.isInteger(v) && v >= 1 && v <= 100,
  colourStudents: v => typeof v === 'boolean', colourStaff: v => typeof v === 'boolean',
  retentionHoursAfterPrint: v => Number.isInteger(v) && v >= 0 && v <= 720,
  studentRateBwMinor: v => Number.isInteger(v) && v >= 0 && v <= 100000,
  studentRateColourMinor: v => Number.isInteger(v) && v >= 0 && v <= 100000,
  offlineStudentPrinting: v => typeof v === 'boolean', offlineStaffPrinting: v => typeof v === 'boolean',
  maxReservationMinor: v => Number.isInteger(v) && v >= 100 && v <= 1000000,
  reservationHours: v => Number.isInteger(v) && v >= 1 && v <= 168,
  offlineStaffDailyPages: v => Number.isInteger(v) && v >= 1 && v <= 5000
};
export async function policiesOf(db, orgId) {
  const [row] = await db.query('SELECT policies, version FROM institution_settings WHERE org_id=$1', [orgId]);
  return { policies: { ...DEFAULT_POLICIES, ...JSON.parse(row?.policies || '{}') }, version: row?.version ?? 0 };
}

const COLLEGE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$/;
const KIND_OF_ROLE = { student: 'student', staff: 'staff', print_operator: 'staff', department_admin: 'staff' };
const slug = v => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const UPLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const MAX_UPLOAD = 20 * 1024 * 1024;
const IMPORT_LIMIT = 5000;

let preparing = 0; // document preparation is CPU-heavy: at most two at a time per process
async function withPreparationSlot(fn) {
  const deadline = Date.now() + 30000;
  while (preparing >= 2) {
    if (Date.now() > deadline) throw fail(429, 'Document processing is busy. Please try again shortly.');
    await new Promise(r => setTimeout(r, 100));
  }
  preparing++;
  try { return await fn(); } finally { preparing--; }
}

export function eduRoutes(app, { db, key, config }) {
  walletRoutes(app, { db });
  const need = permission => requirePermission(db, permission);
  const link = path => new URL(path, config.origin).href;

  // A department admin only sees and manages their own department.
  const callerDepartment = async req => {
    if (req.org.role !== 'department_admin') return null;
    const [profile] = await db.query('SELECT department_id FROM edu_profiles WHERE user_id=$1 AND org_id=$2', [req.user.id, req.org.id]);
    return profile?.department_id ?? '__none__';
  };

  // ======================= institution profile and policies =======================
  app.get('/api/v2/edu/institution', need('institution.profile.edit'), async (req, res) => {
    const [org] = await db.query('SELECT id,name,slug,status FROM organizations WHERE id=$1', [req.org.id]);
    const { policies, version } = await policiesOf(db, req.org.id);
    const count = async sql => Number((await db.query(sql, [req.org.id]))[0].n);
    res.json({
      ...org, loginCode: org.slug, policies, version,
      setup: {
        agents: await count("SELECT COUNT(*) AS n FROM agents WHERE org_id=$1 AND status='active'"),
        printers: await count("SELECT COUNT(*) AS n FROM printers WHERE org_id=$1 AND status='active'"),
        people: await count('SELECT COUNT(*) AS n FROM edu_profiles WHERE org_id=$1')
      }
    });
  });
  app.put('/api/v2/edu/institution/policies', need('policies.edit'), async (req, res) => {
    const changes = req.body.policies && typeof req.body.policies === 'object' ? req.body.policies : {};
    for (const [name, value] of Object.entries(changes)) {
      if (!POLICY_RULES[name]) throw fail(400, `Unknown policy "${name}".`);
      if (!POLICY_RULES[name](value)) throw fail(400, `Invalid value for "${name}".`);
    }
    const current = await policiesOf(db, req.org.id);
    // Optimistic lock: two admins editing at once cannot silently overwrite each other.
    if (Number(req.body.version) !== current.version) throw fail(409, 'Settings changed since you opened them. Reload and try again.', 'settings.conflict');
    const next = { ...current.policies, ...changes };
    await db.transaction(async tx => {
      if (current.version === 0) await tx.query('INSERT INTO institution_settings (org_id,policies,version,updated) VALUES ($1,$2,1,$3)', [req.org.id, JSON.stringify(next), now()]);
      else {
        const ok = await tx.query('UPDATE institution_settings SET policies=$1, version=version+1, updated=$2 WHERE org_id=$3 AND version=$4 RETURNING org_id', [JSON.stringify(next), now(), req.org.id, current.version]);
        if (!ok.length) throw fail(409, 'Settings changed since you opened them. Reload and try again.', 'settings.conflict');
      }
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'policies.updated', targetType: 'institution', targetId: req.org.id, data: { before: current.policies, after: next } });
    });
    res.json({ ok: true, policies: next, version: current.version + 1 });
  });

  // ======================= optional structure =======================
  app.get('/api/v2/edu/campuses', need('campuses.manage'), async (req, res) => res.json(await db.query('SELECT id,name,status FROM campuses WHERE org_id=$1 ORDER BY name', [req.org.id])));
  app.post('/api/v2/edu/campuses', need('campuses.manage'), async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (name.length < 2 || name.length > 100) throw fail(400, 'Enter a campus name.');
    const id = randomUUID();
    try { await db.query('INSERT INTO campuses (id,org_id,name,created) VALUES ($1,$2,$3,$4)', [id, req.org.id, name, now()]); }
    catch (e) { if (/unique/i.test(e.message)) throw fail(409, 'A campus with this name exists.'); throw e; }
    res.status(201).json({ id });
  });
  app.get('/api/v2/edu/departments', need('users.read'), async (req, res) => {
    const own = await callerDepartment(req);
    const rows = await db.query('SELECT id,name,code,campus_id,status FROM departments WHERE org_id=$1 ORDER BY name', [req.org.id]);
    res.json(own ? rows.filter(r => r.id === own) : rows);
  });
  app.post('/api/v2/edu/departments', need('departments.manage'), async (req, res) => {
    const name = String(req.body.name ?? '').trim(), code = String(req.body.code ?? '').trim().slice(0, 20) || null;
    if (name.length < 2 || name.length > 100) throw fail(400, 'Enter a department name.');
    let campusId = null;
    if (req.body.campusId) {
      const [c] = await db.query('SELECT id FROM campuses WHERE id=$1 AND org_id=$2', [String(req.body.campusId), req.org.id]);
      if (!c) throw fail(404, 'Campus not found.');
      campusId = c.id;
    }
    const id = randomUUID();
    try { await db.query('INSERT INTO departments (id,org_id,campus_id,name,code,created) VALUES ($1,$2,$3,$4,$5,$6)', [id, req.org.id, campusId, name, code, now()]); }
    catch (e) { if (/unique/i.test(e.message)) throw fail(409, 'A department with this name exists.'); throw e; }
    res.status(201).json({ id });
  });
  app.patch('/api/v2/edu/departments/:id', need('departments.manage'), async (req, res) => {
    const [d] = await db.query('SELECT * FROM departments WHERE id=$1 AND org_id=$2', [req.params.id, req.org.id]);
    if (!d) throw fail(404, 'Department not found.');
    const name = req.body.name === undefined ? d.name : String(req.body.name).trim();
    if (name.length < 2 || name.length > 100) throw fail(400, 'Enter a department name.');
    await db.query('UPDATE departments SET name=$1, status=$2 WHERE id=$3 AND org_id=$4', [name, ['active', 'inactive'].includes(req.body.status) ? req.body.status : d.status, d.id, req.org.id]);
    res.json({ ok: true });
  });

  // ======================= people =======================
  // Department by id, name or code, inside this organization only. null = none given, false = not found.
  const departmentByRef = async (queryable, orgId, ref) => {
    if (ref === undefined || ref === null || ref === '') return null;
    const [d] = await queryable.query("SELECT id FROM departments WHERE org_id=$1 AND (id=$2 OR LOWER(name)=LOWER($2) OR LOWER(code)=LOWER($2)) AND status='active'", [orgId, String(ref)]);
    return d?.id ?? false;
  };
  const orgRow = async orgId => (await db.query('SELECT id,slug,name FROM organizations WHERE id=$1', [orgId]))[0];

  // Creates the account WITHOUT a usable password and returns a single-use activation link (7 days). No default
  // password exists, so nothing can be guessed from a roll number list.
  async function createPerson(tx, organization, person, actorId) {
    const role = person.role || (person.kind === 'staff' ? 'staff' : 'student');
    if (!KIND_OF_ROLE[role]) throw fail(400, `Role "${role}" cannot be created here.`);
    const collegeId = String(person.collegeId ?? '').trim(), name = String(person.name ?? '').trim();
    if (!COLLEGE_ID.test(collegeId)) throw fail(400, 'College / staff ID may use letters, digits and . _ / - (2–40 characters).');
    if (name.length < 2 || name.length > 100) throw fail(400, 'Enter the name (2–100 characters).');
    const real = String(person.email ?? '').trim().toLowerCase();
    if (real && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(real)) throw fail(400, 'Enter a valid e-mail or leave it empty.');
    const email = real || `${slug(collegeId)}.${organization.slug}@users.smartprint.invalid`;
    const userId = randomUUID(), secret = token();
    const [duplicate] = await tx.query('SELECT user_id FROM edu_profiles WHERE org_id=$1 AND LOWER(college_id)=LOWER($2)', [organization.id, collegeId]);
    if (duplicate) throw fail(409, `ID "${collegeId}" already exists in this institution.`);
    const [taken] = await tx.query('SELECT id FROM users WHERE email=$1', [email]);
    if (taken) throw fail(409, real ? 'This e-mail already has an account.' : `ID "${collegeId}" already exists.`);
    await tx.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,'customer')", [userId, email, `!unusable:${token()}`]);
    await tx.query("INSERT INTO edu_profiles (user_id,org_id,kind,college_id,name,department_id,campus_id,status,created) VALUES ($1,$2,$3,$4,$5,$6,$7,'invited',$8)", [userId, organization.id, KIND_OF_ROLE[role], collegeId, name, person.departmentId ?? null, person.campusId ?? null, now()]);
    await tx.query('INSERT INTO memberships (id,org_id,user_id,role,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), organization.id, userId, role, now()]);
    await tx.query("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires,created) VALUES ($1,$2,'reset',$3,$4,$5)", [randomUUID(), userId, digest(secret), later(7 * 86400000), now()]);
    await auditV2(tx, { orgId: organization.id, actorType: 'user', actorId, action: 'user.created', targetType: 'user', targetId: userId, data: { role } });
    return { userId, email: real || null, activationLink: link(`/#reset-password/${secret}`), role, collegeId, name };
  }
  const mailActivation = (organization, person) => person.email && sendMail(db, { to: person.email, kind: 'user.activation', subject: `Activate your ${organization.name} printing account`, text: `Hello ${person.name},\n\nSet your password to start printing at ${organization.name}:\n${person.activationLink}\n\nThe link works once and expires in 7 days.\nYour sign-in: institution code "${organization.slug}" and ID "${person.collegeId}".` });

  app.get('/api/v2/edu/users', need('users.read'), async (req, res) => {
    const own = await callerDepartment(req);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const rows = await db.query('SELECT p.user_id, p.kind, p.college_id, p.name, p.department_id, p.status, m.role FROM edu_profiles p JOIN memberships m ON m.user_id=p.user_id AND m.org_id=p.org_id WHERE p.org_id=$1 ORDER BY p.name LIMIT 1000', [req.org.id]);
    res.json(rows.filter(r => (!own || r.department_id === own) && (!req.query.kind || r.kind === req.query.kind) && (!q || r.name.toLowerCase().includes(q) || r.college_id.toLowerCase().includes(q))));
  });

  app.post('/api/v2/edu/users', need('users.create'), async (req, res) => {
    const own = await callerDepartment(req);
    if (own && ['department_admin', 'print_operator'].includes(req.body.role)) throw fail(403, 'A department admin can add staff and students only.');
    const departmentId = own ? (own === '__none__' ? null : own) : await departmentByRef(db, req.org.id, req.body.departmentId);
    if (departmentId === false) throw fail(404, 'Department not found.');
    const organization = await orgRow(req.org.id);
    const person = await db.transaction(tx => createPerson(tx, organization, { ...req.body, departmentId }, req.user.id));
    await mailActivation(organization, person);
    res.status(201).json(person);
  });

  // Bulk import: rows = [{collegeId, name, email?, department?, role?/kind?}]. dryRun validates everything and
  // creates nothing. A real run refuses to start while rows are invalid unless skipInvalid is true.
  app.post('/api/v2/edu/users/import', need('users.import'), async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
    if (!rows || !rows.length) throw fail(400, 'Provide the rows to import.');
    if (rows.length > IMPORT_LIMIT) throw fail(400, `Import at most ${IMPORT_LIMIT} rows at a time.`);
    const own = await callerDepartment(req);
    const organization = await orgRow(req.org.id);
    const seen = new Set(), results = [];
    for (const [index, row] of rows.entries()) {
      const result = { row: index + 1, collegeId: String(row?.collegeId ?? '').trim(), ok: false };
      try {
        if (own && ['department_admin', 'print_operator'].includes(row.role)) throw fail(403, 'A department admin can add staff and students only.');
        const departmentId = own ? (own === '__none__' ? null : own) : await departmentByRef(db, req.org.id, row.department);
        if (departmentId === false) throw fail(400, `Unknown department "${row.department}".`);
        if (!COLLEGE_ID.test(result.collegeId)) throw fail(400, 'Invalid ID.');
        if (seen.has(result.collegeId.toLowerCase())) throw fail(400, 'Duplicate ID in this file.');
        seen.add(result.collegeId.toLowerCase());
        if (String(row.name ?? '').trim().length < 2) throw fail(400, 'Name is missing.');
        if (!KIND_OF_ROLE[row.role || (row.kind === 'staff' ? 'staff' : 'student')]) throw fail(400, `Role "${row.role}" is not allowed.`);
        const [dup] = await db.query('SELECT user_id FROM edu_profiles WHERE org_id=$1 AND LOWER(college_id)=LOWER($2)', [req.org.id, result.collegeId]);
        if (dup) throw fail(409, 'ID already exists.');
        result.ok = true; result.departmentId = departmentId;
      } catch (e) { result.error = e.message; }
      results.push(result);
    }
    const invalid = results.filter(r => !r.ok).length;
    const summary = { total: rows.length, valid: rows.length - invalid, invalid };
    if (req.body.dryRun === true) return res.json({ dryRun: true, summary, results: results.map(({ departmentId, ...r }) => r) });
    if (invalid && req.body.skipInvalid !== true) throw fail(400, `${invalid} row(s) are invalid. Fix them, or import the valid rows only.`, 'import.invalid_rows');
    const created = [];
    await db.transaction(async tx => {
      for (const result of results.filter(r => r.ok)) {
        const row = rows[result.row - 1];
        created.push(await createPerson(tx, organization, { ...row, departmentId: result.departmentId }, req.user.id));
      }
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'users.imported', targetType: 'institution', targetId: req.org.id, data: summary });
    });
    for (const person of created) await mailActivation(organization, person);
    res.status(201).json({ summary: { ...summary, created: created.length }, activations: created.map(c => ({ collegeId: c.collegeId, name: c.name, activationLink: c.activationLink })), results: results.map(({ departmentId, ...r }) => r) });
  });

  const person = async req => {
    const own = await callerDepartment(req);
    const [p] = await db.query('SELECT p.*, u.email FROM edu_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND p.org_id=$2', [req.params.id, req.org.id]);
    if (!p || (own && p.department_id !== own)) throw fail(404, 'Person not found.');
    return p;
  };
  app.patch('/api/v2/edu/users/:id', need('users.create'), async (req, res) => {
    const p = await person(req), own = await callerDepartment(req);
    let departmentId = p.department_id;
    if (req.body.departmentId !== undefined && !own) {
      departmentId = await departmentByRef(db, req.org.id, req.body.departmentId);
      if (departmentId === false) throw fail(404, 'Department not found.');
    }
    const status = ['active', 'suspended', 'graduated'].includes(req.body.status) ? req.body.status : p.status;
    const name = req.body.name === undefined ? p.name : String(req.body.name).trim();
    if (name.length < 2 || name.length > 100) throw fail(400, 'Enter the name.');
    await db.transaction(async tx => {
      await tx.query('UPDATE edu_profiles SET name=$1, department_id=$2, status=$3 WHERE user_id=$4 AND org_id=$5', [name, departmentId, status, p.user_id, req.org.id]);
      // A suspended or graduated person is signed out and cannot sign in.
      if (status !== p.status) {
        await tx.query('UPDATE users SET status=$1 WHERE id=$2', [status === 'active' || status === 'invited' ? 'active' : 'suspended', p.user_id]);
        if (status !== 'active') await tx.query('DELETE FROM sessions WHERE user_id=$1', [p.user_id]);
      }
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'user.updated', targetType: 'user', targetId: p.user_id, data: { status } });
    });
    res.json({ ok: true });
  });
  app.post('/api/v2/edu/users/:id/reset-password', need('users.reset_password'), async (req, res) => {
    const p = await person(req), secret = token();
    await db.transaction(async tx => {
      await tx.query("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires,created) VALUES ($1,$2,'reset',$3,$4,$5)", [randomUUID(), p.user_id, digest(secret), later(24 * 3600000), now()]);
      await auditV2(tx, { orgId: req.org.id, actorType: 'user', actorId: req.user.id, action: 'user.password_reset_issued', targetType: 'user', targetId: p.user_id });
    });
    res.json({ activationLink: link(`/#reset-password/${secret}`), expiresInHours: 24 });
  });

  // ======================= printing =======================
  const printerOf = async req => {
    const [membership] = await db.query("SELECT m.role, p.kind, p.department_id FROM memberships m LEFT JOIN edu_profiles p ON p.user_id=m.user_id AND p.org_id=m.org_id WHERE m.user_id=$1 AND m.org_id=$2 AND m.status='active' LIMIT 1", [req.user.id, req.org.id]);
    return membership;
  };

  // Raw document upload (no base64): the bytes are checked, encrypted and kept 30 minutes until a job uses them.
  app.post('/api/v2/edu/documents', need('jobs.submit'), express.raw({ type: UPLOAD_TYPES, limit: MAX_UPLOAD }), async (req, res) => {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw fail(400, 'Send the file as PDF, PNG or JPEG.');
    const isPdf = bytes.subarray(0, 5).toString() === '%PDF-', isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), isJpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!isPdf && !isPng && !isJpg) throw fail(400, 'Supported files are PDF, PNG and JPEG.');
    const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM stored_objects WHERE org_id=$1 AND deleted_at IS NULL AND created>$2", [req.org.id, later(-3600000)]);
    if (Number(n) > 2000) throw fail(429, 'Too many uploads in the last hour for this institution.');
    const id = await db.transaction(tx => storeObject(tx, req.org.id, bytes, { encrypt, key, expiresMs: 30 * 60000, ownerId: req.user.id }));
    res.status(201).json({ documentId: id, size: bytes.length, expiresInMinutes: 30 });
  });

  // Validates, normalises (A4, ranges, 2-up) and prices a stored upload. Staff cost nothing; students are priced
  // from the institution rates but not charged until the wallet exists.
  async function buildJob(req, body) {
    const [raw] = await db.query('SELECT * FROM stored_objects WHERE id=$1 AND org_id=$2 AND owner_id=$3 AND deleted_at IS NULL AND expires>$4', [String(body.documentId ?? ''), req.org.id, req.user.id, now()]);
    if (!raw) throw fail(404, 'The uploaded file expired. Upload it again.');
    const { policies } = await policiesOf(db, req.org.id);
    const who = await printerOf(req), student = who?.role === 'student';
    if (student && policies.studentPrinting === 'disabled') throw fail(403, 'Student printing is not enabled for this institution yet.', 'student.printing_disabled');
    let options;
    try { options = validateOptions(body.options); } catch (e) { throw fail(400, e.message); }
    if (options.layout === 'card') throw fail(400, 'Card layout is not available here.');
    if (options.copies > policies.maxCopies) throw fail(400, `At most ${policies.maxCopies} copies per job.`);
    if (options.color === 'color' && !(student ? policies.colourStudents : policies.colourStaff)) throw fail(400, 'Colour printing is not allowed for your account.');
    const prepared = await withPreparationSlot(async () => {
      try { return await prepare([{ data: (await readObject(db, raw)).toString('base64') }], options); } catch (e) { throw fail(400, `Unable to prepare the file: ${e.message}`); }
    });
    if (prepared.pages > policies.maxPagesPerJob) throw fail(400, `At most ${policies.maxPagesPerJob} pages per job.`);
    const rates = { bw: policies.studentRateBwMinor, color: policies.studentRateColourMinor };
    const cost = price(prepared.pages, options, rates);
    return { raw, options, prepared, student, jobClass: student ? 'student' : 'staff', quote: { pages: prepared.pages, sheets: cost.sheets, sides: cost.sides, costMinor: student ? cost.amount : 0, charged: student && policies.studentPrinting === 'wallet', payer: student ? 'student' : 'institution' } };
  }
  app.post('/api/v2/edu/jobs/quote', need('jobs.submit'), async (req, res) => {
    const { quote } = await buildJob(req, req.body);
    if (quote.charged) {
      const balance = await db.transaction(async tx => balanceOf(tx, await ensureAccount(tx, req.org.id, req.user.id, 'student')));
      return res.json({ ...quote, balanceMinor: balance.available, shortfallMinor: Math.max(0, quote.costMinor - balance.available) });
    }
    res.json(quote);
  });
  app.post('/api/v2/edu/jobs', need('jobs.submit'), async (req, res) => {
    const built = await buildJob(req, req.body);
    const jobId = await db.transaction(async tx => {
      const objectId = await storeObject(tx, req.org.id, Buffer.from(built.prepared.bytes), { encrypt, key });
      const id = await enqueueJob(tx, { orgId: req.org.id, submitterId: req.user.id, jobClass: built.jobClass, objectId, options: { ...built.options, file_name: String(req.body.fileName ?? 'document').slice(0, 150) }, pages: built.quote.pages, sheets: built.quote.sheets, payer: built.quote.charged ? 'wallet' : 'institution', costMinor: built.quote.costMinor });
      // Wallet mode: the price is held now; if the balance is not enough the whole transaction (and the job) is rolled back.
      if (built.quote.charged) await holdForJob(tx, { orgId: req.org.id, userId: req.user.id, jobId: id, amountMinor: built.quote.costMinor });
      await markObjectDeleted(tx, req.org.id, built.raw.id); // the raw upload is not kept
      return id;
    });
    res.status(201).json({ jobId, ...built.quote });
  });

  app.get('/api/v2/edu/jobs', need('jobs.view_own'), async (req, res) => {
    res.json(await db.query('SELECT id,status,class,pages,pages_printed,sheets,cost_minor,options,enqueued_at,finished_at FROM print_jobs WHERE org_id=$1 AND submitter_id=$2 ORDER BY enqueued_at DESC LIMIT 200', [req.org.id, req.user.id])
      .then(rows => rows.map(r => ({ ...r, options: undefined, fileName: JSON.parse(r.options || '{}').file_name || null }))));
  });
  app.post('/api/v2/edu/my-jobs/:id/cancel', need('jobs.cancel_own'), async (req, res) => {
    const [job] = await db.query('SELECT id FROM print_jobs WHERE id=$1 AND org_id=$2 AND submitter_id=$3', [req.params.id, req.org.id, req.user.id]);
    if (!job) throw fail(404, 'Job not found.');
    await db.transaction(tx => cancelJob(tx, req.org.id, job.id, req.user.id));
    res.json({ ok: true });
  });

  // ======================= reports and audit =======================
  app.get('/api/v2/edu/reports/usage', need('reports.view_org'), async (req, res) => {
    const from = String(req.query.from ?? '1970-01-01'), to = String(req.query.to ?? '9999-12-31');
    const rows = await db.query("SELECT j.class, j.status, j.pages, j.pages_printed, j.sheets, j.requires_color, p.department_id, j.submitter_id FROM print_jobs j LEFT JOIN edu_profiles p ON p.user_id=j.submitter_id AND p.org_id=j.org_id WHERE j.org_id=$1 AND j.enqueued_at>=$2 AND j.enqueued_at<=$3", [req.org.id, from, to + (to.length === 10 ? 'T23:59:59.999Z' : '')]);
    const sum = list => ({ jobs: list.length, completed: list.filter(r => r.status === 'completed').length, pagesPrinted: list.reduce((n, r) => n + (r.status === 'completed' || r.pages_printed ? Number(r.pages_printed ?? r.pages) : 0), 0), colourJobs: list.filter(r => Number(r.requires_color)).length });
    const group = key => Object.fromEntries([...new Set(rows.map(r => r[key] ?? 'none'))].map(k => [k, sum(rows.filter(r => (r[key] ?? 'none') === k))]));
    const top = Object.entries(group('submitter_id')).sort((a, b) => b[1].pagesPrinted - a[1].pagesPrinted).slice(0, 20).map(([userId, s]) => ({ userId, ...s }));
    res.json({ total: sum(rows), byClass: group('class'), byDepartment: group('department_id'), topUsers: top });
  });
  app.get('/api/v2/edu/audit', need('audit.read'), async (req, res) => {
    res.json((await db.query('SELECT id,actor_type,actor_id,action,target_type,target_id,created FROM audit_log_v2 WHERE org_id=$1 ORDER BY created DESC LIMIT 200', [req.org.id])));
  });
}
