import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mfaPolicy } from '../server/security.js';
import { ORDER_STATUSES, PERMITTED_TRANSITIONS } from '../server/state-machine.js';

function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
}

test('MFA policy: admins in production, owners only from the configured date, everybody with ENFORCE_MFA', () => {
  withEnv({ ENFORCE_MFA: undefined, OWNER_MFA_REQUIRED_FROM: undefined }, () => {
    assert.equal(mfaPolicy({ role: 'admin' }, false, true).mfaRequired, true);
    assert.equal(mfaPolicy({ role: 'admin' }, true, true).mfaRequired, false);
    assert.equal(mfaPolicy({ role: 'admin' }, false, false).mfaRequired, false);
    // Unset = today's behaviour: owners are not forced.
    assert.deepEqual(mfaPolicy({ role: 'owner' }, false, true), { required: false, mfaRequired: false, graceEnds: null });
  });
  const future = new Date(Date.now() + 14 * 86400000).toISOString(), past = new Date(Date.now() - 1000).toISOString();
  withEnv({ OWNER_MFA_REQUIRED_FROM: future, ENFORCE_MFA: undefined }, () => {
    const policy = mfaPolicy({ role: 'owner' }, false, true);
    assert.equal(policy.mfaRequired, false);
    assert.equal(policy.graceEnds, future);
    assert.equal(mfaPolicy({ role: 'owner' }, true, true).graceEnds, null, 'no reminder once enrolled');
  });
  withEnv({ OWNER_MFA_REQUIRED_FROM: past, ENFORCE_MFA: undefined }, () => {
    assert.equal(mfaPolicy({ role: 'owner' }, false, true).mfaRequired, true);
    assert.equal(mfaPolicy({ role: 'owner' }, true, true).mfaRequired, false);
    assert.equal(mfaPolicy({ role: 'customer' }, false, true).mfaRequired, false);
  });
  withEnv({ ENFORCE_MFA: 'true', OWNER_MFA_REQUIRED_FROM: undefined }, () => assert.equal(mfaPolicy({ role: 'owner' }, false, false).mfaRequired, true));
  withEnv({ OWNER_MFA_REQUIRED_FROM: 'not-a-date', ENFORCE_MFA: undefined }, () => assert.equal(mfaPolicy({ role: 'owner' }, false, true).mfaRequired, false));
});

// The route handlers change order status with hand-written conditional UPDATEs. This guard fails when one of
// them uses a status the documented lifecycle does not know, or moves an order to a status nothing may reach.
test('every literal order status written by the server is part of the documented lifecycle', () => {
  const sources = readdirSync(new URL('../server/', import.meta.url)).filter(f => f.endsWith('.js') && f !== 'state-machine.js');
  const written = new Set();
  for (const file of sources) {
    const code = readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8');
    for (const match of code.matchAll(/UPDATE orders SET status\s*=\s*'(\w+)'/g)) written.add(match[1]);
  }
  assert.ok(written.size >= 6, `expected to find several status updates, found ${[...written]}`);
  const reachable = new Set(Object.values(PERMITTED_TRANSITIONS).flat());
  for (const status of written) {
    assert.ok(ORDER_STATUSES.includes(status), `unknown order status written: ${status}`);
    assert.ok(reachable.has(status) || status === 'created', `status ${status} is written by the server but no documented transition leads to it`);
  }
  // Every documented target is a known status, and terminal states have no exits.
  for (const [from, targets] of Object.entries(PERMITTED_TRANSITIONS)) {
    assert.ok(ORDER_STATUSES.includes(from));
    for (const to of targets) assert.ok(ORDER_STATUSES.includes(to), `${from} -> ${to}`);
  }
  for (const terminal of ['completed', 'cancelled', 'expired']) assert.deepEqual(PERMITTED_TRANSITIONS[terminal], []);
});
