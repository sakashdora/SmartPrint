import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_PERMISSIONS, EDUCATION_ROLES, permissionsOf, can, landingFor } from '../server/permissions.js';

test('permissions follow the documented role matrix', () => {
  const as = role => ({ memberships: [{ role }] });
  assert.ok(can({ platformRole: true }, 'registrations.review'));
  // Nobody but platform staff reviews registrations or reads the outbox.
  for (const role of Object.keys(ROLE_PERMISSIONS)) {
    if (role === 'platform_owner') continue;
    assert.equal(can(as(role), 'registrations.review'), false, role);
    assert.equal(can(as(role), 'platform.outbox.read'), false, role);
  }
  // Students never manage printers, users or other people's wallets; staff never pay or hold a wallet.
  for (const denied of ['printers.manage', 'users.import', 'wallet.adjust', 'wallet.view_any', 'jobs.view_queue']) assert.equal(can(as('student'), denied), false, denied);
  for (const denied of ['wallet.topup', 'wallet.view_own', 'users.create']) assert.equal(can(as('staff'), denied), false, denied);
  assert.ok(can(as('staff'), 'print.unlimited_official'));
  assert.ok(can(as('student'), 'wallet.topup'));
  // Operators run the queue but cannot configure the institution.
  assert.ok(can(as('print_operator'), 'jobs.resolve_uncertain'));
  for (const denied of ['agents.manage', 'policies.edit', 'wallet.adjust', 'refunds.issue']) assert.equal(can(as('print_operator'), denied), false, denied);
  // Department admins stay inside their department scope: no institution-wide settings.
  for (const denied of ['policies.edit', 'printers.manage', 'agents.manage', 'reports.view_org']) assert.equal(can(as('department_admin'), denied), false, denied);
  assert.deepEqual(permissionsOf({ memberships: [{ role: 'unknown-role' }] }), []);
});

test('landing page is decided in one place', () => {
  assert.equal(landingFor({ platformRole: true }), '#admin');
  assert.equal(landingFor({ memberships: [{ role: 'owner' }] }), '#owner');
  for (const role of EDUCATION_ROLES) assert.equal(landingFor({ memberships: [{ role }] }), '#edu');
  assert.equal(landingFor({ memberships: [] }), '#print');
});
