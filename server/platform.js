import { randomUUID } from 'node:crypto';
import { token, digest, hashPassword, limitRate } from './security.js';
import { sendMail } from './mailer.js';
import { auditV2, membershipsOf } from './orgs.js';
import { permissionsOf, landingFor, can } from './permissions.js';

const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (value, min, max, label) => {
  const v = String(value ?? '').trim();
  if (v.length < min || v.length > max) throw fail(400, `${label} must be ${min}–${max} characters.`);
  return v;
};
const email = (value, label) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (!EMAIL.test(v) || v.length > 254) throw fail(400, `Enter a valid ${label}.`);
  return v;
};
const slugify = value => String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
const bearer = req => req.headers.authorization?.replace(/^Bearer /, '') ?? '';
const DAY = 86400000;

// Registration -> review -> activation, invitations, password reset and the extended /api/v2/me.
// Nothing here changes how existing shops, owners or customers sign in or order.
export function platformRoutes(app, { db, config }) {
  const link = path => new URL(path, config.origin).href;

  // Platform staff (today: users with role 'admin') holding a given permission, MFA satisfied.
  const platform = permission => (req, res, next) => {
    if (!req.user) return next(fail(401, 'Please sign in.'));
    if (req.user.mfaRequired) return next(fail(403, 'Set up your authenticator before using this workspace.'));
    if (!can({ platformRole: req.user.role === 'admin' }, permission)) return next(fail(403, 'This action is not available for your account.'));
    next();
  };

  // ---- Applicant side ---------------------------------------------------------------------------
  app.post('/api/v2/registrations', async (req, res) => {
    await limitRate(db, 'registration', req.ip, 10, 3600);
    const b = req.body;
    const type = b.type;
    if (!['business', 'education'].includes(type)) throw fail(400, 'Choose business or college / university.');
    const orgName = text(b.orgName, 2, 150, 'Organization name');
    const rep = { name: text(b.repName, 2, 100, 'Representative name'), email: email(b.repEmail, 'representative e-mail'), phone: String(b.repPhone ?? '').trim().slice(0, 30) };
    const admin = { name: text(b.adminName ?? b.repName, 2, 100, 'Administrator name'), email: email(b.adminEmail ?? b.repEmail, 'administrator e-mail') };
    const details = type === 'education'
      ? { institutionType: text(b.institutionType, 2, 60, 'Institution type'), registrationNumber: String(b.registrationNumber ?? '').trim().slice(0, 80), address: text(b.address, 5, 300, 'Address'), website: String(b.website ?? '').trim().slice(0, 200), designation: String(b.repDesignation ?? '').trim().slice(0, 100) }
      : { location: text(b.location, 2, 200, 'Shop location') };
    const id = randomUUID(), verify = token(), status = token();
    await db.query(
      'INSERT INTO organization_registrations (id,org_type,org_name,details,rep_name,rep_email,rep_phone,admin_name,admin_email,status,verify_token_hash,status_token_hash,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,\'submitted\',$10,$11,$12)',
      [id, type, orgName, JSON.stringify(details), rep.name, rep.email, rep.phone, admin.name, admin.email, digest(verify), digest(status), now()]
    );
    await sendMail(db, {
      to: rep.email, kind: 'registration.verify', subject: 'Confirm your Smart Print registration',
      text: `Hello ${rep.name},\n\nPlease confirm this e-mail address to submit "${orgName}" for review:\n${link(`/#verify-email/${verify}`)}\n\nThe link is valid for 3 days. If you did not request this, ignore this message.`
    });
    await auditV2(db, { actorType: 'applicant', action: 'registration.submitted', targetType: 'registration', targetId: id, data: { type } });
    res.status(201).json({ id, statusToken: status, message: 'Check the representative e-mail for a confirmation link. Your application is reviewed after it is confirmed.' });
  });

  app.post('/api/v2/registrations/verify-email', async (req, res) => {
    await limitRate(db, 'registration-verify', req.ip, 30, 3600);
    const hash = digest(String(req.body.token ?? ''));
    const changed = await db.query("UPDATE organization_registrations SET status='under_review', email_verified_at=$1 WHERE verify_token_hash=$2 AND status='submitted' AND created>$3 RETURNING id", [now(), hash, new Date(Date.now() - 3 * DAY).toISOString()]);
    if (!changed.length) {
      const [already] = await db.query('SELECT status FROM organization_registrations WHERE verify_token_hash=$1', [hash]);
      if (already && already.status !== 'submitted') return res.json({ ok: true, message: 'This e-mail address is already confirmed.' });
      throw fail(400, 'This confirmation link is invalid or has expired. Register again.');
    }
    await auditV2(db, { actorType: 'applicant', action: 'registration.email_verified', targetType: 'registration', targetId: changed[0].id });
    res.json({ ok: true, message: 'E-mail confirmed. Your application is now waiting for review.' });
  });

  const ownRegistration = async req => {
    const [reg] = await db.query('SELECT * FROM organization_registrations WHERE id=$1 AND status_token_hash=$2', [req.params.id, digest(bearer(req))]);
    if (!reg) throw fail(404, 'Application not found.');
    return reg;
  };
  app.get('/api/v2/registrations/:id/status', async (req, res) => {
    const reg = await ownRegistration(req);
    res.json({ status: reg.status, orgName: reg.org_name, reason: ['rejected', 'needs_info'].includes(reg.status) ? reg.decision_reason : null });
  });
  app.post('/api/v2/registrations/:id/respond', async (req, res) => {
    const reg = await ownRegistration(req);
    const message = text(req.body.message, 2, 1000, 'Message');
    const changed = await db.query("UPDATE organization_registrations SET status='under_review', decision_reason=NULL WHERE id=$1 AND status='needs_info' RETURNING id", [reg.id]);
    if (!changed.length) throw fail(409, 'This application is not waiting for more information.');
    await auditV2(db, { actorType: 'applicant', action: 'registration.responded', targetType: 'registration', targetId: reg.id, data: { message } });
    res.json({ ok: true });
  });

  // ---- Platform review --------------------------------------------------------------------------
  const view = ({ verify_token_hash, status_token_hash, ...row }) => ({ ...row, details: JSON.parse(row.details || '{}') });
  app.get('/api/v2/platform/registrations', platform('registrations.review'), async (req, res) => {
    const status = req.query.status;
    const rows = status
      ? await db.query('SELECT * FROM organization_registrations WHERE status=$1 ORDER BY created DESC LIMIT 200', [String(status)])
      : await db.query('SELECT * FROM organization_registrations ORDER BY created DESC LIMIT 200');
    res.json(rows.map(view));
  });
  app.get('/api/v2/platform/registrations/:id', platform('registrations.review'), async (req, res) => {
    const [row] = await db.query('SELECT * FROM organization_registrations WHERE id=$1', [req.params.id]);
    if (!row) throw fail(404, 'Application not found.');
    res.json(view(row));
  });

  const decide = (action, to, { needsReason }) => app.post(`/api/v2/platform/registrations/:id/${action}`, platform('registrations.review'), async (req, res) => {
    const reason = needsReason ? text(req.body.reason, 5, 1000, 'Reason') : null;
    const from = action === 'approve' ? ['under_review'] : ['under_review', 'needs_info'];
    const [reg] = await db.query('SELECT * FROM organization_registrations WHERE id=$1', [req.params.id]);
    if (!reg) throw fail(404, 'Application not found.');
    if (!from.includes(reg.status)) throw fail(409, `An application that is "${reg.status}" cannot be changed this way.`);
    let invite = null;
    await db.transaction(async tx => {
      const changed = await tx.query('UPDATE organization_registrations SET status=$1, reviewed_by=$2, reviewed_at=$3, decision_reason=$4 WHERE id=$5 AND status=$6 RETURNING id', [to, req.user.id, now(), reason, reg.id, reg.status]);
      if (!changed.length) throw fail(409, 'This application was just changed by someone else. Refresh.');
      if (action === 'approve') {
        const [taken] = await tx.query('SELECT id FROM users WHERE email=$1', [reg.admin_email]);
        if (taken) throw fail(409, 'The administrator e-mail already has a Smart Print account. Ask the applicant for a different e-mail.');
        const orgId = randomUUID(), secret = token();
        await tx.query("INSERT INTO organizations (id,type,name,slug,status,approved_by,approved_at,created) VALUES ($1,$2,$3,$4,'active',$5,$6,$6)", [orgId, reg.org_type, reg.org_name, `${slugify(reg.org_name)}-${orgId.slice(0, 8)}`, req.user.id, now()]);
        await tx.query('INSERT INTO invitations (id,org_id,email,role,registration_id,token_hash,expires,created_by,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), orgId, reg.admin_email, reg.org_type === 'business' ? 'owner' : 'institution_admin', reg.id, digest(secret), new Date(Date.now() + 3 * DAY).toISOString(), req.user.id, now()]);
        await tx.query('UPDATE organization_registrations SET organization_id=$1 WHERE id=$2', [orgId, reg.id]);
        invite = { secret, orgId };
      }
      await auditV2(tx, { orgId: invite?.orgId ?? null, actorType: 'user', actorId: req.user.id, action: `registration.${action}`, targetType: 'registration', targetId: reg.id, data: { reason } });
    });
    if (action === 'approve') {
      await sendMail(db, { to: reg.admin_email, kind: 'registration.approved', subject: 'Your Smart Print organization is approved', text: `Hello ${reg.admin_name},\n\n"${reg.org_name}" was approved. Set your password and sign in:\n${link(`/#invite/${invite.secret}`)}\n\nThe link is valid for 3 days and works once.` });
      return res.json({ ok: true, organizationId: invite.orgId });
    }
    await sendMail(db, {
      to: reg.rep_email, kind: `registration.${action}`,
      subject: action === 'reject' ? 'Your Smart Print application was not approved' : 'More information needed for your Smart Print application',
      text: action === 'reject'
        ? `Hello ${reg.rep_name},\n\nYour application for "${reg.org_name}" was not approved.\nReason: ${reason}`
        : `Hello ${reg.rep_name},\n\nTo continue reviewing "${reg.org_name}" we need: ${reason}\nReply from your application status page.`
    });
    res.json({ ok: true });
  });
  decide('approve', 'approved', { needsReason: false });
  decide('reject', 'rejected', { needsReason: true });
  decide('request-info', 'needs_info', { needsReason: true });

  app.get('/api/v2/platform/organizations', platform('organizations.read_metadata'), async (req, res) => {
    res.json(await db.query('SELECT id,type,name,slug,status,legacy_shop_id,approved_at,created FROM organizations ORDER BY created DESC LIMIT 500'));
  });
  for (const [action, status] of [['activate', 'active'], ['suspend', 'suspended']]) {
    app.post(`/api/v2/platform/organizations/:id/${action}`, platform(`organizations.${action}`), async (req, res) => {
      await db.transaction(async tx => {
        const [org] = await tx.query('UPDATE organizations SET status=$1 WHERE id=$2 AND status IN (\'pending\',\'active\',\'suspended\') RETURNING id, legacy_shop_id', [status, req.params.id]);
        if (!org) throw fail(404, 'Organization not found or closed.');
        if (org.legacy_shop_id) await tx.query('UPDATE shops SET status=$1 WHERE id=$2', [status, org.legacy_shop_id]);
        await auditV2(tx, { orgId: org.id, actorType: 'user', actorId: req.user.id, action: `organization.${action}`, targetType: 'organization', targetId: org.id });
      });
      res.json({ ok: true });
    });
  }
  // No mail provider is required to operate: while none is configured the review team can see queued
  // messages (they contain single-use links) and pass them on. Platform staff only.
  app.get('/api/v2/platform/outbox', platform('platform.outbox.read'), async (req, res) => {
    res.json(await db.query('SELECT id,to_email,subject,body,kind,status,error,created,sent_at FROM email_outbox ORDER BY created DESC LIMIT 100'));
  });

  // ---- Invitations ------------------------------------------------------------------------------
  const invitation = async hash => {
    const [inv] = await db.query('SELECT i.*, o.name AS org_name, o.type AS org_type, o.status AS org_status, o.slug AS org_slug FROM invitations i JOIN organizations o ON o.id=i.org_id WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.expires>$2', [hash, now()]);
    if (!inv || inv.org_status !== 'active') throw fail(404, 'This invitation is invalid, expired or already used.');
    return inv;
  };
  app.get('/api/v2/invitations/:token', async (req, res) => {
    await limitRate(db, 'invitation', req.ip, 30, 900);
    const inv = await invitation(digest(req.params.token));
    res.json({ orgName: inv.org_name, orgType: inv.org_type, role: inv.role, email: inv.email });
  });
  app.post('/api/v2/invitations/:token/accept', async (req, res) => {
    await limitRate(db, 'invitation-accept', req.ip, 10, 900);
    const password = String(req.body.password ?? '');
    if (password.length < 12 || password.length > 128) throw fail(400, 'Use a password of 12–128 characters.');
    const inv = await invitation(digest(req.params.token));
    const hashed = await hashPassword(password);
    await db.transaction(async tx => {
      const used = await tx.query('UPDATE invitations SET used_at=$1 WHERE id=$2 AND used_at IS NULL RETURNING id', [now(), inv.id]);
      if (!used.length) throw fail(404, 'This invitation is invalid, expired or already used.');
      const [taken] = await tx.query('SELECT id FROM users WHERE email=$1', [inv.email]);
      if (taken) throw fail(409, 'This e-mail already has an account. Sign in instead.');
      const userId = randomUUID();
      // Education users carry the placeholder platform role "customer" (it grants nothing); their real role
      // is the membership. Business owners keep the existing "owner" role so every shop route works unchanged.
      await tx.query('INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,$4)', [userId, inv.email, hashed, inv.org_type === 'business' ? 'owner' : 'customer']);
      if (inv.org_type === 'business') {
        const [reg] = await tx.query('SELECT details FROM organization_registrations WHERE id=$1', [inv.registration_id]);
        const details = JSON.parse(reg?.details || '{}');
        const shopId = randomUUID();
        await tx.query("INSERT INTO shops (id,owner_id,slug,name,location,status,organization_id) VALUES ($1,$2,$3,$4,$5,'active',$6)", [shopId, userId, inv.org_slug, inv.org_name, details.location || 'Not provided', inv.org_id]);
        await tx.query('UPDATE organizations SET legacy_shop_id=$1 WHERE id=$2', [shopId, inv.org_id]);
      }
      await tx.query('INSERT INTO memberships (id,org_id,user_id,role,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), inv.org_id, userId, inv.role, now()]);
      await auditV2(tx, { orgId: inv.org_id, actorType: 'user', actorId: userId, action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id, data: { role: inv.role } });
    });
    res.status(201).json({ ok: true, message: 'Account created. Sign in to continue.' });
  });

  // ---- Password reset (shop owners and organization users; platform admins use the operator procedure) ----
  app.post('/api/v2/auth/password/forgot', async (req, res) => {
    const address = String(req.body.email ?? '').trim().toLowerCase();
    await limitRate(db, 'reset-ip', req.ip, 10, 3600);
    if (EMAIL.test(address)) {
      await limitRate(db, 'reset-email', address, 3, 3600);
      const [user] = await db.query("SELECT id, status, role FROM users WHERE email=$1", [address]);
      if (user && user.role !== 'admin' && !['suspended', 'disabled'].includes(user.status)) {
        const secret = token();
        await db.query("INSERT INTO auth_tokens (id,user_id,kind,token_hash,expires,created) VALUES ($1,$2,'reset',$3,$4,$5)", [randomUUID(), user.id, digest(secret), new Date(Date.now() + 30 * 60000).toISOString(), now()]);
        await sendMail(db, { to: address, kind: 'password.reset', subject: 'Reset your Smart Print password', text: `Use this link within 30 minutes to choose a new password:\n${link(`/#reset-password/${secret}`)}\n\nIf you did not ask for this, ignore this message; your password is unchanged.` });
      }
    }
    // Same answer whether or not the account exists.
    res.json({ ok: true, message: 'If that e-mail has an account, a reset link is on its way.' });
  });
  app.post('/api/v2/auth/password/reset', async (req, res) => {
    await limitRate(db, 'reset-use', req.ip, 10, 900);
    const password = String(req.body.password ?? '');
    if (password.length < 12 || password.length > 128) throw fail(400, 'Use a password of 12–128 characters.');
    const hashed = await hashPassword(password);
    await db.transaction(async tx => {
      const [row] = await tx.query("UPDATE auth_tokens SET used_at=$1 WHERE token_hash=$2 AND kind='reset' AND used_at IS NULL AND expires>$1 RETURNING user_id", [now(), digest(String(req.body.token ?? ''))]);
      if (!row) throw fail(400, 'This reset link is invalid, expired or already used.');
      await tx.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, row.user_id]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [row.user_id]);
      await auditV2(tx, { actorType: 'user', actorId: row.user_id, action: 'password.reset', targetType: 'user', targetId: row.user_id });
    });
    res.json({ ok: true, message: 'Password changed. Sign in with the new password.' });
  });

  // ---- Who am I, in which organization, allowed to do what ---------------------------------------------
  app.get('/api/v2/me', async (req, res) => {
    if (!req.user) throw fail(401, 'Please sign in.');
    const memberships = await membershipsOf(db, req.user.id);
    const platformRole = req.user.role === 'admin';
    const active = memberships.find(m => m.org_status === 'active') || memberships[0] || null;
    res.json({
      user: req.user,
      platformRole,
      organization: active ? { id: active.org_id, type: active.org_type, name: active.org_name, status: active.org_status, role: active.role } : null,
      memberships: memberships.map(m => ({ orgId: m.org_id, orgType: m.org_type, orgName: m.org_name, orgStatus: m.org_status, role: m.role })),
      permissions: permissionsOf({ platformRole, memberships }),
      redirect: req.user.mfaRequired ? '#security' : landingFor({ platformRole, memberships })
    });
  });
}
