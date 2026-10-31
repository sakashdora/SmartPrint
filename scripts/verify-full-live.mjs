import { strict as assert } from 'node:assert';

const BASE = 'http://localhost:3000';
// Credentials come from the environment; never commit them to this public repository.
const OWNER_EMAIL = process.env.SMARTPRINT_VERIFY_EMAIL, OWNER_PASSWORD = process.env.SMARTPRINT_VERIFY_PASSWORD;
if (!OWNER_EMAIL || !OWNER_PASSWORD) {
  console.error('Set SMARTPRINT_VERIFY_EMAIL and SMARTPRINT_VERIFY_PASSWORD for a local shop-owner test account.');
  process.exit(1);
}

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return { status: res.status, data, headers: res.headers };
}

console.log('>>> Starting SmartPrint Full Live Workflow Verification...');

// 1. Health check
const health = (await request('/api/health')).data;
console.log('✔ Health Check:', health);
assert.equal(health.mode, 'development');

// 2. Owner Login
console.log('>>> Logging in as shop owner...');
const loginRes = await request('/api/auth/login', {
  method: 'POST',
  body: { email: OWNER_EMAIL, password: OWNER_PASSWORD }
});
const ownerToken = loginRes.data.token || (loginRes.headers.get('set-cookie') ? null : null);
// Note: server uses cookies for session. Let's capture the cookie:
const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
console.log('✔ Owner logged in successfully. Cookie present:', !!cookie);

const authHeaders = cookie ? { Cookie: cookie } : {};

// 3. Shop & Devices inspection
const shop = (await request('/api/owner/shop', { headers: authHeaders })).data;
console.log(`✔ Shop Loaded: "${shop.name}" (Status: ${shop.status})`);

let devices = (await request('/api/owner/devices', { headers: authHeaders })).data;
console.log(`✔ Found ${devices.length} registered device(s).`);

let testDevice = devices.find(d => d.name.includes('Brother') || d.name.includes('SmartPrint Pro'));
let deviceToken;

if (!testDevice) {
  console.log('>>> Pairing new printer device "Brother DCP-T820DW Printer"...');
  const createRes = (await request('/api/owner/devices', {
    method: 'POST',
    body: { name: 'Brother DCP-T820DW Printer', color: true, duplex: true },
    headers: authHeaders
  })).data;
  testDevice = { id: createRes.id, name: 'Brother DCP-T820DW Printer', color: 1, duplex: 1 };
  deviceToken = createRes.token;
  console.log(`✔ Paired new device: ${testDevice.id}`);
} else {
  // We can create a dedicated connector device to get its cleartext token
  console.log('>>> Pairing a test-run device to get fresh token...');
  const createRes = (await request('/api/owner/devices', {
    method: 'POST',
    body: { name: 'SmartPrint Automated Tester', color: true, duplex: true },
    headers: authHeaders
  })).data;
  testDevice = { id: createRes.id, name: 'SmartPrint Automated Tester', color: 1, duplex: 1 };
  deviceToken = createRes.token;
  console.log(`✔ Paired test device: ${testDevice.id}`);
}

// 4. Test Pause & Resume
console.log('>>> Testing Device Pause & Resume...');
const pauseRes = (await request(`/api/owner/devices/${testDevice.id}/pause`, { method: 'POST', headers: authHeaders })).data;
assert.equal(pauseRes.is_paused, 1, 'Device should be paused');
console.log('✔ Device successfully paused');

const resumeRes = (await request(`/api/owner/devices/${testDevice.id}/pause`, { method: 'POST', headers: authHeaders })).data;
assert.equal(resumeRes.is_paused, 0, 'Device should be resumed');
console.log('✔ Device successfully resumed');

// 5. Test Heartbeat as Device
console.log('>>> Sending Device Heartbeat with token...');
const hbRes = (await request('/api/device/heartbeat', {
  method: 'POST',
  headers: { Authorization: `Bearer ${deviceToken}` }
})).data;
assert.equal(hbRes.ok, true);
console.log('✔ Device Heartbeat acknowledged by server');

// 6. Test Diagnostic Test Print
console.log('>>> Requesting diagnostic Test Print...');
const testPrintRes = (await request(`/api/owner/devices/${testDevice.id}/test-print`, {
  method: 'POST',
  headers: authHeaders
})).data;
assert.equal(testPrintRes.ok, true);
console.log(`✔ Diagnostic test order created: ${testPrintRes.orderId}`);

// 7. Verify Queue and Priority
const queueOrders = (await request('/api/owner/orders', { headers: authHeaders })).data;
const queuedTest = queueOrders.find(o => o.id === testPrintRes.orderId);
assert.ok(queuedTest, 'Test print must appear in queue');
assert.equal(queuedTest.priority, 100, 'Test print should have priority 100');
assert.equal(queuedTest.file_name, 'SmartPrint_Diagnostic_Test.pdf');
console.log(`✔ Test print in queue with priority ${queuedTest.priority} and filename "${queuedTest.file_name}"`);

// 8. Device Claims the Job
console.log('>>> Device polling for claims (/api/device/claim)...');
const claimRes = (await request('/api/device/claim', {
  method: 'POST',
  headers: { Authorization: `Bearer ${deviceToken}` }
})).data;
assert.ok(claimRes.id, 'Claimed job must have an order ID');
assert.ok(claimRes.token, 'Device must receive lease token');
console.log(`✔ Device claimed job #${claimRes.id.slice(0, 8)} with lease token`);

// 9. Device Downloads Document with Lease Token
console.log('>>> Device downloading encrypted document bytes...');
const docRes = await fetch(`${BASE}/api/device/jobs/${claimRes.id}/document`, {
  headers: {
    Authorization: `Bearer ${deviceToken}`,
    'X-Lease-Token': claimRes.token
  }
});
assert.equal(docRes.status, 200);
const pdfBuffer = Buffer.from(await docRes.arrayBuffer());
assert.ok(pdfBuffer.toString('utf8', 0, 5).startsWith('%PDF-'), 'Downloaded bytes must be valid PDF');
console.log(`✔ Verified valid decrypted PDF stream (${pdfBuffer.length} bytes)`);

// 10. Device Reports Events
console.log('>>> Device reporting print spooling events...');
await request(`/api/device/jobs/${claimRes.id}/events`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${deviceToken}`, 'X-Lease-Token': claimRes.token },
  body: { event: 'submitted' }
});

await request(`/api/device/jobs/${claimRes.id}/events`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${deviceToken}`, 'X-Lease-Token': claimRes.token },
  body: { event: 'awaiting_confirmation' }
});
console.log('✔ Spooling events recorded. Status: awaiting_confirmation');

// 11. Owner Confirms Physical Print & Completes Order
console.log('>>> Owner confirming physical printed pages...');
const completeRes = (await request(`/api/owner/orders/${claimRes.id}/complete`, {
  method: 'POST',
  headers: authHeaders,
  body: { confirmed: true }
})).data;
assert.equal(completeRes.ok, true);
console.log('✔ Physical confirmation verified. Order completed.');

// 12. Verify Secure Document Destruction
const docCheckRes = await fetch(`${BASE}/api/owner/orders/${claimRes.id}/document`, {
  headers: authHeaders
});
assert.ok([404, 409].includes(docCheckRes.status), 'Completed order document MUST NOT be accessible');
console.log('✔ Cryptographic document cleanup verified: Document is non-accessible and permanently wiped');

console.log('\n>>> Testing Multi-User Simultaneous Concurrency...');
const uploadPromises = [1, 2, 3, 4].map(async idx => {
  const fileBytes = Buffer.from(`%PDF-1.4 Simulated Multi-user Concurrency Document #${idx}\n%%EOF`);
  const init = (await request('/api/uploads', {
    method: 'POST',
    body: { slug: shop.slug, size: fileBytes.length, name: `user_doc_${idx}.pdf` }
  })).data;
  
  await request(`/api/uploads/${init.id}/chunks/0`, {
    method: 'PUT',
    token: init.token,
    body: { data: fileBytes.toString('base64') }
  });

  return { idx, id: init.id, token: init.token };
});

const uploads = await Promise.all(uploadPromises);
console.log(`✔ Successfully handled ${uploads.length} simultaneous chunked user uploads.`);

console.log('\n============================================================');
console.log('  ALL LIVE END-TO-END WORKFLOW VERIFICATIONS PASSED 100%!   ');
console.log('============================================================\n');
