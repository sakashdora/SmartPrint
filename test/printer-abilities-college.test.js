import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers/edu.js';

test("a college administrator states what each printer can do; the agent's detection never overrides it", async t => {
  const ctx = await boot(t), admin = await ctx.org('abilities');
  const agent = await ctx.agent(admin, [{ name: 'Lab Laser', color: true, duplex: true }, { name: 'Unknown Model' }], 'Lab PC');
  const list = async () => Object.fromEntries((await ctx.call('/api/v2/edu/printers', { cookie: admin.cookie })).body.map(p => [p.display_name, p]));
  const patch = (name, body) => ctx.call(`/api/v2/edu/printers/${agent.printers[name]}`, { method: 'PATCH', cookie: admin.cookie, body });
  const state = p => [p.cap_color, p.cap_duplex, p.cap_source];
  let printers = await list();
  assert.deepEqual(state(printers['Lab Laser']), [1, 1, 'driver']);
  assert.equal(printers['Unknown Model'].cap_color, null, 'not detected: the administrator must choose');

  // The administrator says the lab laser is really black & white only, one-sided.
  assert.equal((await patch('Lab Laser', { capColor: false, capDuplex: false })).status, 200);
  await agent.call('/api/agent/v2/printers/report', { method: 'POST', body: { printers: [{ name: 'Lab Laser', color: true, duplex: true }] } });
  printers = await list();
  assert.deepEqual(state(printers['Lab Laser']), [0, 0, 'admin']);

  // A colour job has nowhere to go until the administrator declares a colour printer.
  assert.ok(await ctx.job(admin.orgId, { color: 'bw' }));
  await assert.rejects(() => ctx.job(admin.orgId, { color: 'color' }), /No online printer/);
  assert.equal((await patch('Unknown Model', { capColor: true, capDuplex: false })).status, 200);
  assert.ok(await ctx.job(admin.orgId, { color: 'color' }), 'colour works once a colour printer is declared');

  // Hand the Lab Laser back to detection.
  assert.equal((await patch('Lab Laser', { useDetected: true })).status, 200);
  await agent.call('/api/agent/v2/printers/report', { method: 'POST', body: { printers: [{ name: 'Lab Laser', color: true, duplex: true }] } });
  printers = await list();
  assert.deepEqual(state(printers['Lab Laser']), [1, 1, 'driver']);
});
