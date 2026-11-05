import { membershipsOf } from './orgs.js';
import { permissionsOf } from './permissions.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

// Resolves the signed-in user's active organization and checks one permission against their role IN THAT
// organization. Handlers read the organization from `req.org`, never from the request body or URL, so a
// forged id cannot move a request into another tenant. 404 (not 403) is used by handlers for ids that belong to
// somebody else, so existence is not revealed.
export function requirePermission(db, permission, { orgType = 'education' } = {}) {
  return async (req, res, next) => {
    if (!req.user) return next(fail(401, 'Please sign in.'));
    if (req.user.mfaRequired) return next(fail(403, 'Set up your authenticator before using this workspace.'));
    const usable = (await membershipsOf(db, req.user.id)).filter(m => m.org_status === 'active' && (!orgType || m.org_type === orgType));
    const chosen = usable.find(m => m.org_id === req.headers['x-org-id']) || usable[0];
    if (!chosen || !permissionsOf({ memberships: [chosen] }).includes(permission)) return next(fail(403, 'This action is not available for your account.'));
    req.org = { id: chosen.org_id, role: chosen.role, name: chosen.org_name };
    next();
  };
}
