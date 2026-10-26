import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadQrPoster } from '../public/qr-poster.js';

test('downloadQrPoster throws if qr or qr.image is missing', async () => {
  await assert.rejects(downloadQrPoster({ slug: 'test' }, null), /QR image data is missing/);
  await assert.rejects(downloadQrPoster({ slug: 'test' }, {}), /QR image data is missing/);
});

test('downloadQrPoster generates canvas and triggers download', async () => {
  let createdBlobType = null;
  let clickedDownload = null;

  globalThis.Image = class {
    constructor() {
      this.complete = true;
      this.naturalWidth = 200;
      this.naturalHeight = 200;
    }
    set src(val) {
      this._src = val;
      setTimeout(() => {
        if (this.onload) this.onload();
      }, 0);
    }
    get src() {
      return this._src;
    }
  };

  const mockCtx = {
    fillStyle: '',
    font: '',
    textAlign: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    fillRect() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    beginPath() {},
    roundRect() {},
    rect() {},
    fill() {},
    stroke() {},
    measureText() {
      return { width: 100 };
    },
    fillText() {},
    moveTo() {},
    lineTo() {},
    drawImage() {}
  };

  const mockCanvas = {
    width: 0,
    height: 0,
    getContext() {
      return mockCtx;
    },
    toBlob(callback, type) {
      createdBlobType = type;
      callback(new Blob(['fake-png'], { type }));
    }
  };

  const mockLink = {
    href: '',
    download: '',
    click() {
      clickedDownload = this.download;
    },
    remove() {}
  };

  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return mockCanvas;
      if (tag === 'a') return mockLink;
      return {};
    },
    body: {
      append() {}
    }
  };

  const origCreate = globalThis.URL.createObjectURL;
  const origRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => 'blob:mock-poster-url';
  globalThis.URL.revokeObjectURL = () => {};

  try {
    const shop = { name: 'Super Print Shop', slug: 'super-print', location: 'Main Counter' };
    const qr = { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', url: 'https://smartprint.local/?shop=super-print' };

    await downloadQrPoster(shop, qr);

    assert.equal(mockCanvas.width, 1600);
    assert.equal(mockCanvas.height, 2200);
    assert.equal(createdBlobType, 'image/png');
    assert.equal(clickedDownload, 'super-print-counter-poster.png');
  } finally {
    delete globalThis.Image;
    delete globalThis.document;
    globalThis.URL.createObjectURL = origCreate;
    globalThis.URL.revokeObjectURL = origRevoke;
  }
});
