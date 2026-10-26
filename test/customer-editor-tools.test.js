import test from 'node:test';
import assert from 'node:assert/strict';
import { openDocumentEditor } from '../public/crop.js';

function setupMockEnvironment(onModalShow) {
  globalThis.Image = class {
    constructor() {
      this.complete = true;
      this.naturalWidth = 800;
      this.naturalHeight = 600;
    }
    set src(v) { this._src = v; }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  };

  const mockCtx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    clearRect() {},
    drawImage() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    arc() {},
    rect() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    setLineDash() {},
    fillText() {},
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    putImageData() {}
  };

  const mockCanvas = {
    width: 800,
    height: 600,
    style: {},
    getContext() { return mockCtx; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    toBlob(cb, type) { cb(new Blob(['fake-img'], { type })); }
  };

  const elementsMap = new Map();

  const createMockElement = (tag = 'div') => {
    const children = [];
    const listeners = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      classList: {
        add() {},
        remove() {},
        toggle() {}
      },
      dataset: {},
      append(...ch) { children.push(...ch); },
      appendChild(ch) { children.push(ch); return ch; },
      setAttribute() {},
      getAttribute() { return null; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      querySelector(sel) {
        if (sel === 'canvas' || sel === '#editor-interactive-canvas') return mockCanvas;
        if (!elementsMap.has(sel)) {
          elementsMap.set(sel, createMockElement());
        }
        return elementsMap.get(sel);
      },
      querySelectorAll() {
        return [createMockElement()];
      },
      close() {},
      remove() {},
      showModal() {
        if (onModalShow) onModalShow(elementsMap);
      }
    };
    return el;
  };

  const origDoc = globalThis.document;
  const origUrl = globalThis.URL;

  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return mockCanvas;
      return createMockElement(tag);
    },
    body: { append() {} }
  };

  globalThis.URL.createObjectURL = () => 'blob:mock-img';
  globalThis.URL.revokeObjectURL = () => {};

  return () => {
    delete globalThis.Image;
    globalThis.document = origDoc;
    globalThis.URL = origUrl;
  };
}

test('openDocumentEditor initializes and closes cleanly across all modes without TDZ error', async () => {
  const modes = ['auto', 'perspective', 'rect', 'enhance', 'filter', 'rotate', 'blur'];

  for (const mode of modes) {
    const cleanup = setupMockEnvironment((elementsMap) => {
      const closeBtn = elementsMap.get('#btn-dialog-close');
      if (closeBtn && typeof closeBtn.onclick === 'function') {
        closeBtn.onclick();
      }
    });

    try {
      const fakeFile = new File(['mock content'], 'test-page.jpg', { type: 'image/jpeg' });
      const result = await openDocumentEditor({
        file: fakeFile,
        initialMode: mode
      });
      assert.equal(result, null);
    } finally {
      cleanup();
    }
  }
});

test('openDocumentEditor applies edits and returns processed file', async () => {
  let appliedFile = null;
  const cleanup = setupMockEnvironment((elementsMap) => {
    const applyBtn = elementsMap.get('#btn-editor-apply');
    if (applyBtn && typeof applyBtn.onclick === 'function') {
      applyBtn.onclick();
    }
  });

  try {
    const fakeFile = new File(['mock content'], 'my-document.jpg', { type: 'image/jpeg' });
    const result = await openDocumentEditor({
      file: fakeFile,
      initialMode: 'enhance',
      onApply: (f) => { appliedFile = f; }
    });

    assert.equal(result?.action, 'edited');
    assert.ok(result?.file);
    assert.ok(result.file.name.includes('-enhance') || result.file.name.includes('-scanned'));
    assert.equal(appliedFile?.name, result.file.name);
  } finally {
    cleanup();
  }
});

test('openDocumentEditor print original triggers callback and resolves action original', async () => {
  let originalDispatched = false;
  const cleanup = setupMockEnvironment((elementsMap) => {
    const origBtn = elementsMap.get('#btn-dialog-print-original');
    if (origBtn && typeof origBtn.onclick === 'function') {
      origBtn.onclick();
    }
  });

  try {
    const fakeFile = new File(['mock content'], 'my-contract.jpg', { type: 'image/jpeg' });
    const result = await openDocumentEditor({
      file: fakeFile,
      initialMode: 'auto',
      onPrintOriginal: () => { originalDispatched = true; }
    });

    assert.equal(result?.action, 'original');
    assert.equal(originalDispatched, true);
    assert.equal(result.file.name, 'my-contract.jpg');
  } finally {
    cleanup();
  }
});
