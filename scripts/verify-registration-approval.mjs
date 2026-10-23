import { strict as assert } from 'node:assert';

const BASE = 'http://localhost:3000';

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

console.log('>>> 1. Verifying Logo Endpoint...');
const logoRes = await fetch(`${BASE}/logo.png`);
assert.equal(logoRes.status, 200);
const logoBytes = Buffer.from(await logoRes.arrayBuffer());
assert.ok(logoBytes.length > 50000, 'Logo file must be valid image');
console.log(`✔ Logo endpoint verified: ${logoBytes.length} bytes`);

console.log('>>> 2. Registering New Shop User...');
const ts = Date.now();
const uniqueEmail = `metro_${ts}@testshop.com`;
const uniqueShopName = `Metro Fast Print ${ts}`;
const regRes = await request('/api/auth/register', {
  method: 'POST',
  body: {
    email: uniqueEmail,
    password: 'SecurePassword123!',
    name: uniqueShopName,
    location: 'Gate 2, Metro Station'
  }
});
assert.equal(regRes.status, 201);
console.log('✔ Registration response:', regRes.data.message);
assert.ok(regRes.data.message.toLowerCase().includes('admin approval'), 'Message must inform user that admin approval is required');

console.log('>>> 3. Verifying Shop is NOT Visible to Public Customers While Pending...');
const publicShops = (await request('/api/shops')).data;
const foundPending = publicShops.find(s => s.name === uniqueShopName);
assert.equal(foundPending, undefined, 'Pending shop must not be listed publicly');
console.log('✔ Verified: Pending shop is hidden from public storefront');

console.log('>>> 4. Logging in as Shop Owner to check Pending Status...');
const ownerLogin = await request('/api/auth/login', {
  method: 'POST',
  body: { email: uniqueEmail, password: 'SecurePassword123!' }
});
assert.equal(ownerLogin.status, 200);
const ownerCookie = ownerLogin.headers.get('set-cookie')?.split(';')[0];
const ownerShop = (await request('/api/owner/shop', { headers: { Cookie: ownerCookie } })).data;
assert.equal(ownerShop.status, 'pending', 'Shop status must be pending');
console.log(`✔ Shop owner logged in. Shop status: "${ownerShop.status}" (Awaiting Admin Approval)`);

let adminEmail = process.env.ADMIN_EMAIL || 'sakashdora@gmail.com';
let adminPass = process.env.ADMIN_PASSWORD;
try {
  const { readFile } = await import('node:fs/promises');
  const delivery = await readFile('.data/admin-access.txt', 'utf8');
  adminEmail = delivery.match(/^Email: (.+)$/m)?.[1] || adminEmail;
  adminPass = delivery.match(/^Password: (.+)$/m)?.[1] || adminPass;
} catch {}

const adminLogin = await request('/api/auth/login', {
  method: 'POST',
  body: { email: adminEmail, password: adminPass }
});
assert.equal(adminLogin.status, 200);
const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];

const adminShops = (await request('/api/admin/shops', { headers: { Cookie: adminCookie } })).data;
const pendingApp = adminShops.find(s => s.id === ownerShop.id);
assert.ok(pendingApp, 'Admin must see pending shop application');
assert.equal(pendingApp.status, 'pending');
console.log(`✔ Admin found pending application for "${pendingApp.name}"`);

console.log('>>> 6. Admin Approves the Shop...');
const approveRes = await request(`/api/admin/shops/${ownerShop.id}/status`, {
  method: 'POST',
  headers: { Cookie: adminCookie },
  body: { status: 'active' }
});
assert.equal(approveRes.status, 200);
console.log('✔ Admin approved shop');

console.log('>>> 7. Verifying Shop is Now Active and Available Publicly...');
const recheckOwner = (await request('/api/owner/shop', { headers: { Cookie: ownerCookie } })).data;
assert.equal(recheckOwner.status, 'active');
console.log(`✔ Shop status updated to: "${recheckOwner.status}"`);

const updatedPublicShops = (await request('/api/shops')).data;
const foundActive = updatedPublicShops.find(s => s.slug === ownerShop.slug);
assert.ok(foundActive, 'Approved shop must now appear in public storefront');
console.log(`✔ Approved shop is now active and live on storefront: ${foundActive.name}`);

console.log('\n============================================================');
console.log('  LOGO & ADMIN APPROVAL WORKFLOW VERIFIED 100%!             ');
console.log('============================================================\n');
process.exit(0);
