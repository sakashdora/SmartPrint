import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForQuote } from '../public/preparation.js';

const pending = { pending: true, id: 'preparation', token: 'private' };
const ready = { id: 'quote', token: 'private', amount: 200, expires: '2099-01-01T00:00:00Z' };
test('unfinished preparation cannot become a checkout quote after timeout', async () => {
  let time = 0;
  await assert.rejects(waitForQuote(pending, async () => pending, {
    timeout: 10, interval: 5, now: () => time, sleep: async ms => { time += ms; }
  }), /still preparing/);
});
test('preparation polls with its private token and returns a valid ready quote', async () => {
  let calls = 0;
  const result = await waitForQuote(pending, async (path, options) => {
    assert.equal(path, '/api/preparations/preparation');
    assert.equal(options.token, 'private');
    return ++calls === 1 ? pending : ready;
  }, { sleep: async () => {} });
  assert.deepEqual(result, ready);
  assert.equal(calls, 2);
});
test('failed and malformed preparations cannot enable checkout', async () => {
  await assert.rejects(waitForQuote({ pending: false, error: 'Conversion failed' }, null), { message: 'Conversion failed', preparationFailed: true });
  await assert.rejects(waitForQuote({ id: 'unfinished' }, null), /not ready/);
});
