import { randomUUID } from 'node:crypto';

// Organization helpers shared by registration, the legacy shop routes and the migration backfill.
// An organization is the tenant root. Every existing shop is wrapped by exactly one business organization
// (organizations.legacy_shop_id = shops.id); the shop and its owner keep working exactly as before.
const now = () => new Date().toISOString();

export async function createBusinessOrg(tx, shop) {
  const orgId = randomUUID();
  await tx.query(
    "INSERT INTO organizations (id,type,name,slug,status,legacy_shop_id,created) VALUES ($1,'business',$2,$3,$4,$5,$6)",
    [orgId, shop.name, shop.slug, shop.status || 'pending', shop.id, now()]
  );
  await tx.query('UPDATE shops SET organization_id=$1 WHERE id=$2', [orgId, shop.id]);
  await tx.query("INSERT INTO memberships (id,org_id,user_id,role,created) VALUES ($1,$2,$3,'owner',$4) ON CONFLICT(user_id, org_id, role) DO NOTHING", [randomUUID(), orgId, shop.owner_id, now()]);
  return orgId;
}

// Idempotent: only shops without an organization are touched, so it is safe to run at every start.
export async function backfillBusinessOrgs(tx) {
  const shops = await tx.query('SELECT id, owner_id, slug, name, status FROM shops WHERE organization_id IS NULL');
  for (const shop of shops) await createBusinessOrg(tx, shop);
  return shops.length;
}

export async function auditV2(tx, { orgId = null, actorType, actorId = null, action, targetType = null, targetId = null, data = {} }) {
  await tx.query(
    'INSERT INTO audit_log_v2 (id,org_id,actor_type,actor_id,action,target_type,target_id,data,created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [randomUUID(), orgId, actorType, actorId, action, targetType, targetId, JSON.stringify(data), now()]
  );
}

// Organizations a user belongs to, with the role in each. Used by sign-in and /api/v2/me.
export async function membershipsOf(db, userId) {
  return db.query(
    "SELECT m.org_id, m.role, o.type AS org_type, o.name AS org_name, o.status AS org_status FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=$1 AND m.status='active' ORDER BY o.created",
    [userId]
  );
}
