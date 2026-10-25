import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCustomer } from '../public/customer.js';
import {
  cropBounds,
  applyAspectRatio,
  isConvexQuad,
  getQuadDimensions,
  solveHomography,
  detectDocumentCorners,
  applyFilterToImageData,
  applyBlurToImageData
} from '../public/crop.js';

test('Document Editor Core: geometry, homography, and convex validation', () => {
  // 1. Strict convex quad validation
  const validQuad = { p0: { x: 10, y: 15 }, p1: { x: 190, y: 25 }, p2: { x: 180, y: 190 }, p3: { x: 20, y: 175 } };
  assert.equal(isConvexQuad(validQuad.p0, validQuad.p1, validQuad.p2, validQuad.p3), true);

  // Hourglass / bow-tie (self-intersecting) must be rejected
  const invertedQuad = { p0: { x: 0, y: 0 }, p1: { x: 100, y: 100 }, p2: { x: 100, y: 0 }, p3: { x: 0, y: 100 } };
  assert.equal(isConvexQuad(invertedQuad.p0, invertedQuad.p1, invertedQuad.p2, invertedQuad.p3), false);

  // 2. Heckbert closed-form homography coefficients
  const homo = solveHomography(validQuad.p0, validQuad.p1, validQuad.p2, validQuad.p3, 200, 200);
  assert.ok(homo.a !== 0 && homo.e !== 0);
  assert.equal(homo.c, validQuad.p0.x);
  assert.equal(homo.f, validQuad.p0.y);

  // 3. Quad dimension calculation
  const dims = getQuadDimensions(validQuad.p0, validQuad.p1, validQuad.p2, validQuad.p3);
  assert(dims.width >= 160 && dims.width <= 200);
  assert(dims.height >= 150 && dims.height <= 200);
});

test('Document Editor Filters: enhance, bw, and privacy blur isolation', () => {
  // Enhance improves contrast of text
  const imgData = { data: new Uint8ClampedArray([190, 190, 190, 255, 45, 45, 45, 255]) };
  applyFilterToImageData(imgData, 'enhance');
  assert(imgData.data[0] > 190, 'Bright pixels should brighten');
  assert(imgData.data[4] < 45, 'Dark text pixels should darken');

  // Clean B&W adaptive document thresholding
  const bwData = { data: new Uint8ClampedArray([240, 240, 240, 255, 30, 30, 30, 255]) };
  applyFilterToImageData(bwData, 'bw');
  assert.equal(bwData.data[0], 255);
  assert.equal(bwData.data[4], 0);

  // Privacy Blur: redact region blurring without affecting outside pixels
  const W = 30, H = 30;
  const redactData = new Uint8ClampedArray(W * H * 4);
  // Place sensitive info at (15, 15)
  redactData[(15 * W + 15) * 4] = 255;
  redactData[(15 * W + 15) * 4 + 1] = 255;
  redactData[(15 * W + 15) * 4 + 2] = 255;

  // Redact box from (10, 10) to (20, 20)
  applyBlurToImageData({ width: W, height: H, data: redactData }, 3, { left: 10, top: 10, width: 10, height: 10 });
  assert(redactData[(15 * W + 15) * 4] < 255, 'Sensitive pixel should be diffused');
  assert(redactData[(15 * W + 16) * 4] > 0, 'Neighbor inside redact box receives diffusion');
  assert.equal(redactData[(2 * W + 2) * 4], 0, 'Pixels outside redact box must remain pristine');
});

test('Customer Workflow: upload, Document Editor choices, and authoritative server quote', async t => {
  const saved = { document: globalThis.document, location: globalThis.location, FormData: globalThis.FormData };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });

  class MockElement {
    children = []; isConnected = true; value = ''; disabled = false; hidden = true;
    _classes = new Set();
    classList = {
      add: (...c) => c.forEach(x => this._classes.add(x)),
      remove: (...c) => c.forEach(x => this._classes.delete(x)),
      toggle: (c, val) => { if (val === undefined ? !this._classes.has(c) : val) this._classes.add(c); else this._classes.delete(c); },
      contains: c => this._classes.has(c)
    };
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    remove() {}
    addEventListener() {}
    setAttribute() {}
    querySelectorAll() { return []; }
    querySelector() { return new MockElement(); }
    reportValidity() { return true; }
  }

  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, new MockElement()); return nodes.get(id); };
  node('#print-form').elements = { copies: { value: '1' }, layout: { value: 'single' } };
  node('#method').value = 'cash';
  globalThis.document = { querySelector: node, createElement: tag => Object.assign(new MockElement(), { tag }) };
  globalThis.location = { search: '?shop=fixture' };
  globalThis.FormData = class { get(name) { return { color: 'bw', duplex: 'false', copies: '1', layout: 'single', range: '' }[name]; } };

  let quoteReceived = null, placedOrder = null;
  const requests = [];

  await renderCustomer({
    mount() {},
    money: n => `₹${(n / 100).toFixed(2)}`,
    escape: String,
    health: { office: true, payments: true },
    notify: () => {},
    onOrder: result => { placedOrder = result; },
    api: async (path, options) => {
      requests.push(path);
      if (path.startsWith('/api/shops/')) return { name: 'Fixture Shop', bw: 200, color: 1000 };
      if (path === '/api/uploads') return { id: 'upload-doc', token: 'secret-tok', chunkSize: 1048576 };
      if (path.includes('/chunks/')) return { received: true };
      if (path.includes('/reprice')) return quoteReceived;
      if (path === '/api/quotes') {
        assert.equal(options.body.preferServer, true);
        quoteReceived = { id: 'quote-1', token: 'q-token', pages: 1, sides: 1, sheets: 1, amount: 200, expires: '2099-01-01T00:00:00Z' };
        return quoteReceived;
      }
      if (path === '/api/orders') {
        assert.equal(options.token, 'q-token');
        assert.equal(options.body.quoteId, 'quote-1');
        return { id: 'order-123', token: 'receipt-xyz' };
      }
      assert.fail(`Unexpected API call: ${path}`);
    }
  });

  // 1. Customer uploads document
  const testFile = new File(['mock content'], 'contract.pdf', { type: 'application/pdf' });
  await node('#files').onchange({ target: { files: [testFile] } });

  // 2. Document editor card becomes visible
  assert.equal(node('#document-editor-card').hidden, false);

  // 3. Wait for authoritative server quote
  for (let i = 0; i < 40 && !requests.includes('/api/quotes'); i++) {
    await new Promise(res => setTimeout(res, 20));
  }
  assert.ok(requests.includes('/api/quotes'));
  assert.ok(quoteReceived);

  // 4. Test switching to Original mode explicitly
  node('#btn-choice-original').onclick();
  assert.equal(node('#btn-choice-original').classList.contains('is-active'), true);
  assert.equal(node('#doc-edit-active-banner').hidden, true);

  // Wait for debounced quote calculation to complete
  await new Promise(res => setTimeout(res, 450));

  // 5. Place order and verify idempotency & receipt
  await node('#place-order-btn').onclick();
  assert.ok(placedOrder);
  assert.equal(placedOrder.id, 'order-123');

  // Allow any pending timer to finish cleanly before ending test
  await new Promise(res => setTimeout(res, 400));
});
