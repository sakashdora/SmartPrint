import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { hashPassword } from '../server/security.js';

const PASSWORD = 'a-long-test-password-1';
async function boot(t) {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token, cookie } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  await db.query("INSERT INTO users (id,email,password,role) VALUES ('platform-1','platform@test.invalid',$1,'admin')", [await hashPassword(PASSWORD)]);
  const login = async (email, password = PASSWORD) => (await call('/api/auth/login', { method: 'POST', body: { email, password } }));
  const lastToken = async kind => {
    const [mail] = await db.query('SELECT body FROM email_outbox WHERE kind=$1 ORDER BY created DESC LIMIT 1', [kind]);
    return mail.body.match(/\/#[a-z-]+\/([a-f0-9]{64})/)[1];
  };
  return { db, call, login, lastToken };
}
const college = { type: 'education', orgName: 'Greenfield College', repName: 'Rita Rao', repEmail: 'rita@greenfield.test', adminName: 'Arun Admin', adminEmail: 'arun@greenfield.test', institutionType: 'College', address: '12 College Road, Pune', website: 'https://greenfield.test' };

test('every existing shop is wrapped by a business organization and stays in step with admin decisions', async t => {
  const { db, call, login } = await boot(t);
  const [demo] = await db.query("SELECT o.id, o.type, o.status, o.legacy_shop_id FROM organizations o WHERE o.legacy_shop_id='shop-demo'");
  assert.deepEqual([demo.type, demo.status], ['business', 'active']);
  assert.equal((await db.query("SELECT role FROM memberships WHERE org_id=$1 AND user_id='owner-demo'", [demo.id]))[0].role, 'owner');
  assert.equal((await db.query("SELECT organization_id FROM shops WHERE id='shop-demo'"))[0].organization_id, demo.id);

  // The unchanged v1 registration also creates the organization (pending), and v1 admin approval updates it.
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { email: 'new@shop.test', password: PASSWORD, name: 'New Shop', location: 'Lane 4' } })).status, 201);
  const [shop] = await db.query("SELECT id, organization_id FROM shops WHERE owner_id=(SELECT id FROM users WHERE email='new@shop.test')");
  assert.equal((await db.query('SELECT status FROM organizations WHERE id=$1', [shop.organization_id]))[0].status, 'pending');
  const admin = await login('platform@test.invalid');
  assert.equal((await call(`/api/admin/shops/${shop.id}/status`, { method: 'POST', cookie: admin.cookie, body: { status: 'active' } })).status, 200);
  assert.equal((await db.query('SELECT status FROM organizations WHERE id=$1', [shop.organization_id]))[0].status, 'active');
  assert.equal((await call(`/api/v2/platform/organizations/${shop.organization_id}/suspend`, { method: 'POST', cookie: admin.cookie })).status, 200);
  assert.equal((await db.query('SELECT status FROM shops WHERE id=$1', [shop.id]))[0].status, 'suspended');
});

test('college registration: verify e-mail, platform review, invitation, sign-in and tenant boundaries', async t => {
  const { db, call, login, lastToken } = await boot(t);
  const submitted = await call('/api/v2/registrations', { method: 'POST', body: college });
  assert.equal(submitted.status, 201);
  const { id, statusToken } = submitted.body;
  assert.equal((await call(`/api/v2/registrations/${id}/status`, { token: statusToken })).body.status, 'submitted');
  assert.equal((await call(`/api/v2/registrations/${id}/status`, { token: 'wrong' })).status, 404);
  assert.equal((await db.query('SELECT id FROM organizations WHERE name=$1', ['Greenfield College'])).length, 0, 'no organization before approval');

  // Unverified applications cannot be approved; a forged confirmation token does nothing.
  const admin = await login('platform@test.invalid');
  assert.equal((await call(`/api/v2/platform/registrations/${id}/approve`, { method: 'POST', cookie: admin.cookie })).status, 409);
  assert.equal((await call('/api/v2/registrations/verify-email', { method: 'POST', body: { token: 'f'.repeat(64) } })).status, 400);
  assert.equal((await call('/api/v2/registrations/verify-email', { method: 'POST', body: { token: await lastToken('registration.verify') } })).status, 200);
  assert.equal((await call(`/api/v2/registrations/${id}/status`, { token: statusToken })).body.status, 'under_review');

  // Review is a platform-only capability.
  assert.equal((await call('/api/v2/platform/registrations')).status, 401);
  const ownerSession = await login('owner@smartprint.local', 'SmartPrintDemo!2026');
  assert.equal((await call('/api/v2/platform/registrations', { cookie: ownerSession.cookie })).status, 403);
  assert.equal((await call(`/api/v2/platform/registrations/${id}/approve`, { method: 'POST', cookie: ownerSession.cookie })).status, 403);
  assert.equal((await call('/api/v2/platform/registrations?status=under_review', { cookie: admin.cookie })).body.length, 1);

  assert.equal((await call(`/api/v2/platform/registrations/${id}/approve`, { method: 'POST', cookie: admin.cookie })).status, 200);
  assert.equal((await call(`/api/v2/platform/registrations/${id}/approve`, { method: 'POST', cookie: admin.cookie })).status, 409, 'cannot approve twice');
  const [org] = await db.query("SELECT id, type, status FROM organizations WHERE name='Greenfield College'");
  assert.deepEqual([org.type, org.status], ['education', 'active']);

  // Invitation: single use, strong password, creates the account with the right membership.
  const invite = await lastToken('registration.approved');
  assert.equal((await call(`/api/v2/invitations/${invite}`)).body.role, 'institution_admin');
  assert.equal((await call(`/api/v2/invitations/${invite}/accept`, { method: 'POST', body: { password: 'short' } })).status, 400);
  assert.equal((await call(`/api/v2/invitations/${invite}/accept`, { method: 'POST', body: { password: PASSWORD } })).status, 201);
  assert.equal((await call(`/api/v2/invitations/${invite}/accept`, { method: 'POST', body: { password: PASSWORD } })).status, 404, 'invitation works once');

  const principal = await login('arun@greenfield.test');
  assert.equal(principal.status, 200);
  const me = (await call('/api/v2/me', { cookie: principal.cookie })).body;
  assert.equal(me.organization.type, 'education');
  assert.equal(me.organization.role, 'institution_admin');
  assert.equal(me.redirect, '#edu');
  assert.ok(me.permissions.includes('users.import') && !me.permissions.includes('registrations.review'));
  // An institution admin is not a platform user and not a shop owner.
  assert.equal((await call('/api/v2/platform/registrations', { cookie: principal.cookie })).status, 403);
  assert.equal((await call('/api/owner/shop', { cookie: principal.cookie })).status, 403);
  assert.equal((await call('/api/admin/shops', { cookie: principal.cookie })).status, 403);
  const platformMe = (await call('/api/v2/me', { cookie: admin.cookie })).body;
  assert.equal(platformMe.redirect, '#admin');
  assert.ok(platformMe.permissions.includes('registrations.review'));
  assert.ok((await db.query("SELECT action FROM audit_log_v2 WHERE org_id=$1", [org.id])).some(row => row.action === 'registration.approve'));
});

test('rejection and request-for-information need a reason and are visible to the applicant', async t => {
  const { call, login, lastToken } = await boot(t);
  const { id, statusToken } = (await call('/api/v2/registrations', { method: 'POST', body: college })).body;
  await call('/api/v2/registrations/verify-email', { method: 'POST', body: { token: await lastToken('registration.verify') } });
  const admin = await login('platform@test.invalid');
  assert.equal((await call(`/api/v2/platform/registrations/${id}/request-info`, { method: 'POST', cookie: admin.cookie, body: {} })).status, 400);
  assert.equal((await call(`/api/v2/platform/registrations/${id}/request-info`, { method: 'POST', cookie: admin.cookie, body: { reason: 'Send the affiliation certificate number' } })).status, 200);
  const waiting = (await call(`/api/v2/registrations/${id}/status`, { token: statusToken })).body;
  assert.deepEqual([waiting.status, waiting.reason], ['needs_info', 'Send the affiliation certificate number']);
  assert.equal((await call(`/api/v2/registrations/${id}/respond`, { method: 'POST', token: statusToken, body: { message: 'Certificate 4411/2019' } })).status, 200);
  assert.equal((await call(`/api/v2/platform/registrations/${id}/reject`, { method: 'POST', cookie: admin.cookie, body: { reason: 'Unable to verify the institution' } })).status, 200);
  assert.equal((await call(`/api/v2/platform/registrations/${id}/approve`, { method: 'POST', cookie: admin.cookie })).status, 409);
  assert.equal((await call(`/api/v2/registrations/${id}/status`, { token: statusToken })).body.status, 'rejected');
});

test('a business registered through the common page gets a working shop after approval', async t => {
  const { db, call, login, lastToken } = await boot(t);
  const business = { type: 'business', orgName: 'Quick Prints', repName: 'Sam Shah', repEmail: 'sam@quick.test', location: 'MG Road' };
  const { id } = (await call('/api/v2/registrations', { method: 'POST', body: business })).body;
  await call('/api/v2/registrations/verify-email', { method: 'POST', body: { token: await lastToken('registration.verify') } });
  const admin = await login('platform@test.invalid');
  await call(`/api/v2/platform/registrations/${id}/approve`, { method: 'POST', cookie: admin.cookie });
  assert.equal((await call(`/api/v2/invitations/${await lastToken('registration.approved')}/accept`, { method: 'POST', body: { password: PASSWORD } })).status, 201);
  const owner = await login('sam@quick.test');
  assert.equal(owner.body.role, 'owner');
  const shop = (await call('/api/owner/shop', { cookie: owner.cookie })).body;
  assert.deepEqual([shop.name, shop.status], ['Quick Prints', 'active']);
  const [org] = await db.query("SELECT legacy_shop_id, status FROM organizations WHERE name='Quick Prints'");
  assert.equal(org.legacy_shop_id, shop.id);
  assert.equal((await call('/api/v2/me', { cookie: owner.cookie })).body.redirect, '#owner');
  assert.equal((await call(`/api/shops/${shop.slug}`)).status, 200, 'the approved shop is open to customers');
});

test('password reset by e-mail: no account enumeration, single use, sessions revoked', async t => {
  const { db, call, login, lastToken } = await boot(t);
  const unknown = await call('/api/v2/auth/password/forgot', { method: 'POST', body: { email: 'nobody@nowhere.test' } });
  const known = await call('/api/v2/auth/password/forgot', { method: 'POST', body: { email: 'owner@smartprint.local' } });
  assert.deepEqual(unknown.body, known.body);
  assert.equal((await db.query("SELECT id FROM email_outbox WHERE kind='password.reset'")).length, 1);
  const session = await login('owner@smartprint.local', 'SmartPrintDemo!2026');
  const reset = await lastToken('password.reset');
  assert.equal((await call('/api/v2/auth/password/reset', { method: 'POST', body: { token: reset, password: 'short' } })).status, 400);
  assert.equal((await call('/api/v2/auth/password/reset', { method: 'POST', body: { token: reset, password: 'brand-new-password-9' } })).status, 200);
  assert.equal((await call('/api/v2/auth/password/reset', { method: 'POST', body: { token: reset, password: 'another-password-77' } })).status, 400, 'link works once');
  assert.equal((await call('/api/owner/shop', { cookie: session.cookie })).status, 401, 'old sessions are revoked');
  assert.equal((await login('owner@smartprint.local', 'brand-new-password-9')).status, 200);
  // Platform administrators are excluded from e-mail reset.
  await call('/api/v2/auth/password/forgot', { method: 'POST', body: { email: 'platform@test.invalid' } });
  assert.equal((await db.query("SELECT id FROM email_outbox WHERE to_email='platform@test.invalid'")).length, 0);
});
