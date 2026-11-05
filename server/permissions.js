// Named capabilities per role. Handlers check permissions, never role names, so a role can be added or
// reshaped here without touching route code. The matrix is documented in docs/architecture-v2/06 and
// covered by test/permissions.test.js.
const P = {
  platform_owner: [
    'registrations.review', 'organizations.activate', 'organizations.suspend', 'organizations.read_metadata',
    'platform.outbox.read', 'platform.audit.read'
  ],
  owner: ['shop.manage'],
  institution_admin: [
    'institution.profile.edit', 'campuses.manage', 'departments.manage', 'users.read', 'users.create', 'users.import',
    'users.reset_password', 'policies.edit', 'pricing.edit', 'retention.edit', 'audit.read', 'reports.view_org',
    'agents.manage', 'printers.manage', 'pools.manage', 'jobs.submit', 'jobs.view_own', 'jobs.view_queue', 'jobs.cancel_any',
    'jobs.retry', 'jobs.resolve_uncertain', 'wallet.view_any', 'wallet.adjust', 'refunds.issue', 'support_access.approve'
  ],
  department_admin: ['users.read', 'users.create', 'users.reset_password', 'reports.view_dept', 'jobs.submit', 'jobs.view_own', 'jobs.view_queue', 'printers.pause'],
  staff: ['jobs.submit', 'jobs.view_own', 'print.unlimited_official', 'documents.open_own'],
  student: ['jobs.submit', 'jobs.view_own', 'documents.open_own', 'wallet.view_own', 'wallet.topup', 'wallet.reserve_offline'],
  print_operator: ['jobs.submit', 'jobs.view_own', 'jobs.view_queue', 'jobs.cancel_any', 'jobs.retry', 'jobs.resolve_uncertain', 'printers.pause', 'agents.view_health']
};

export const ROLE_PERMISSIONS = Object.fromEntries(Object.entries(P).map(([role, list]) => [role, Object.freeze([...list])]));
export const EDUCATION_ROLES = ['institution_admin', 'department_admin', 'staff', 'student', 'print_operator'];

export function permissionsOf({ platformRole = false, memberships = [] } = {}) {
  const set = new Set(platformRole ? P.platform_owner : []);
  for (const membership of memberships) for (const permission of P[membership.role] || []) set.add(permission);
  return [...set].sort();
}

export const can = (user, permission) => permissionsOf(user).includes(permission);

// Where a signed-in user should land. One function so the rules live in one place.
export function landingFor({ platformRole, memberships = [] }) {
  if (platformRole) return '#admin';
  if (memberships.some(m => m.role === 'owner')) return '#owner';
  if (memberships.some(m => EDUCATION_ROLES.includes(m.role))) return '#edu';
  return '#print';
}
