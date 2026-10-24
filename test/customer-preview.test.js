import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCustomer } from '../public/customer.js';

test('local image preview appears while upload is blocked and checkout does not download a preview', async t => {
  const saved = { document: globalThis.document, location: globalThis.location, FormData: globalThis.FormData };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  class Element {
    children = []; isConnected = true; value = ''; disabled = false;
    classList = { add() {}, remove() {} };
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    remove() {}
    addEventListener() {}
    setAttribute() {}
    querySelectorAll() { return []; }
    querySelector() { return new Element(); }
    reportValidity() { return true; }
  }
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  node('#print-form').elements = { copies: { value: '1' }, layout: { value: 'single' } };
  node('#method').value = 'cash';
  globalThis.document = { querySelector: node, createElement: tag => Object.assign(new Element(), { tag }) };
  globalThis.location = { search: '?shop=fixture' };
  globalThis.FormData = class { get(name) { return { color: 'bw', duplex: 'false', copies: '1', layout: 'single', range: '' }[name]; } };
  let release, uploaded = false, placed;
  const uploadGate = new Promise(resolve => { release = resolve; });
  const requests = [];
  await renderCustomer({
    mount() {}, money: n => String(n), escape: String, health: {}, notify: assert.fail, onOrder: result => { placed = result; },
    api: async (path, options) => {
      requests.push(path);
      if (path.startsWith('/api/shops/')) return { name: 'Fixture', bw: 200, color: 1000 };
      if (path === '/api/uploads') { await uploadGate; uploaded = true; return { id: 'upload', token: 'secret', chunkSize: 1048576 }; }
      if (path.includes('/chunks/')) return { received: true };
      if (path === '/api/quotes') {
        assert.equal(options.body.preferServer, true);
        return { id: 'quote', token: 'secret', pages: 1, sides: 1, sheets: 1, amount: 200, expires: '2099-01-01T00:00:00Z' };
      }
      if (path === '/api/quotes/quote/reprice') return { id: 'revised', token: 'secret', pages: 1, sides: 1, sheets: 1, amount: 200, expires: '2099-01-01T00:00:00Z' };
      if (path === '/api/orders') return { id: 'order', token: 'receipt' };
      assert.fail(`Unexpected request: ${path}`);
    }
  });
  await node('#files').onchange({ target: { files: [new File(['fixture'], 'photo.png', { type: 'image/png' })] } });
  assert.equal(uploaded, false);
  assert.equal(node('#source-preview').children[0].children[0].tag, 'img');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(requests.includes('/api/uploads'));
  assert.equal(uploaded, false, 'Preview must not wait for upload');
  release();
  for (let i = 0; i < 30 && !requests.includes('/api/quotes'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  node('#print-form').oninput();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(requests.includes('/api/quotes/quote/reprice'));
  assert.equal(requests.filter(path => path === '/api/uploads').length, 1);
  assert.equal(requests.filter(path => path === '/api/quotes').length, 1, 'Copy changes must not repeat file preparation');
  await node('#place-order-btn').onclick();
  assert.equal(placed.id, 'order');
  assert.equal(requests.some(path => path.includes('/preview')), false);
});
