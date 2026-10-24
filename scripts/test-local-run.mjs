import assert from 'node:assert/strict';

async function test() {
  const base = 'http://127.0.0.1:3000';
  console.log('1. Testing /api/health...');
  const hRes = await fetch(base + '/api/health');
  const health = await hRes.json();
  console.log('Health:', health);
  assert.equal(hRes.status, 200);

  console.log('2. Testing /logo.png...');
  const lRes = await fetch(base + '/logo.png');
  const lBytes = Buffer.from(await lRes.arrayBuffer());
  console.log('Logo status:', lRes.status, 'size:', lBytes.length);
  assert.equal(lRes.status, 200);
  assert.ok(lBytes.length > 50000, 'Logo file size valid');

  console.log('3. Logging in as shop owner...');
  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' })
  });
  const cookie = loginRes.headers.get('set-cookie');
  console.log('Login status:', loginRes.status);
  assert.equal(loginRes.status, 200);

  console.log('4. Scanning Windows printers...');
  const scanRes = await fetch(base + '/api/owner/printers/scan', { headers: { Cookie: cookie } });
  const scanned = await scanRes.json();
  console.log('Scanned printers count:', scanned.length);
  for (const p of scanned) {
    console.log(` - ${p.name} (${p.connectionType}, Port: ${p.portName})`);
  }
  assert.ok(scanned.length > 0, 'Should find installed printers');

  console.log('5. Autoconnecting printer...');
  const targetPrinter = scanned.find(p => p.name.includes('Brother')) || scanned[0];
  console.log('Connecting target printer:', targetPrinter.name);
  const connectRes = await fetch(base + '/api/owner/printers/autoconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: targetPrinter.name, isWifi: targetPrinter.isWifi, isWired: targetPrinter.isWired })
  });
  const connectData = await connectRes.json();
  console.log('Connect response:', connectData);
  assert.equal(connectRes.status, 200);
  assert.ok(connectData.ok);

  console.log('6. Waiting 4 seconds for connector heartbeat...');
  await new Promise(r => setTimeout(r, 4000));

  console.log('7. Verifying /api/owner/devices status...');
  const devRes = await fetch(base + '/api/owner/devices', { headers: { Cookie: cookie } });
  const devices = await devRes.json();
  assert.ok(devices.length > 0);
  for (const d of devices) {
    const isOnline = d.active && d.heartbeat && (Date.now() - new Date(d.heartbeat).getTime() < 90000);
    console.log(`Device: "${d.name}" | Active: ${d.active} | Online: ${isOnline} | Status: "${d.status_note}"`);
    if (d.name === targetPrinter.name) {
      assert.equal(isOnline, true, 'Target printer must be ONLINE');
      console.log('8. Dispatching diagnostic test print...');
      const tpRes = await fetch(base + `/api/owner/devices/${d.id}/test-print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie }
      });
      const tpData = await tpRes.json();
      console.log('Test print result:', tpData);
      assert.equal(tpRes.status, 200);
      assert.ok(tpData.orderId);
    }
  }
  console.log('\n✔ All live local run tests passed!');
}

test().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
