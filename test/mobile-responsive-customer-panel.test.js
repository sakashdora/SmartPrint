import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectDocumentCorners,
  isConvexQuad,
  getQuadDimensions,
  cropBounds,
  applyAspectRatio,
  applyFilterToImageData,
  applyBlurToImageData,
  solveHomography
} from '../public/crop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssContent = fs.readFileSync(path.join(__dirname, '../public/premium.css'), 'utf-8');

test('A. Responsive CSS Audit: Viewport metadata and horizontal overflow protection', () => {
  const htmlContent = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf-8');
  assert.ok(htmlContent.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">'), 'Viewport meta tag must be mobile-friendly');

  // Verify overflow-x and max-width protections
  assert.ok(cssContent.includes('overflow-x: hidden'), 'CSS must prevent horizontal blowout on body');
  assert.ok(cssContent.includes('.preview-item-panel'), 'CSS must define .preview-item-panel');
  assert.ok(cssContent.includes('.source-preview-container'), 'CSS must define .source-preview-container');
});

test('A. Responsive CSS Audit: Mobile breakpoints (320px, 360px, 375px, 390px, 414px, 430px)', () => {
  // Check that media queries exist for mobile devices
  assert.ok(cssContent.includes('@media (max-width: 600px)'), 'Should have rules for viewports <= 600px');
  assert.ok(cssContent.includes('@media (max-width: 480px)'), 'Should have rules for viewports <= 480px');
  assert.ok(cssContent.includes('@media (max-width: 360px)'), 'Should have rules for ultra-compact viewports <= 360px');

  // Check document preview constraints
  assert.ok(cssContent.includes('.document-preview-pane .image-preview'), 'Document preview image must be styled');
  assert.ok(cssContent.includes('object-fit: contain'), 'Preview image must use object-fit contain');
  assert.ok(cssContent.includes('max-width: 100%'), 'Preview image must not exceed 100% width');

  // Check Document Editor Dialog responsiveness
  assert.ok(cssContent.includes('.document-editor-dialog'), 'Editor dialog must be styled');
  assert.ok(cssContent.includes('width: 98vw'), 'Editor dialog must adapt to mobile viewport width');
});

test('B. Document Processing: High-contrast document photograph boundary detection', () => {
  const W = 300, H = 400;
  const data = new Uint8ClampedArray(W * H * 4);

  // Dark table (40), bright white document (230) from (40, 50) to (260, 350)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      if (x >= 40 && x <= 260 && y >= 50 && y <= 350) {
        data[idx] = 230; data[idx + 1] = 230; data[idx + 2] = 230; data[idx + 3] = 255;
      } else {
        data[idx] = 40; data[idx + 1] = 40; data[idx + 2] = 40; data[idx + 3] = 255;
      }
    }
  }

  const detected = detectDocumentCorners({ data }, W, H);
  assert.ok(detected, 'Should detect document boundaries');
  assert.equal(detected.confidence, 'high');
  assert.ok(Math.abs(detected.p0.x - 40) <= 4);
  assert.ok(Math.abs(detected.p0.y - 50) <= 4);
  assert.ok(Math.abs(detected.p2.x - 260) <= 4);
  assert.ok(Math.abs(detected.p2.y - 350) <= 4);
});

test('B. Document Processing: Fallback for low-contrast or borderless documents', () => {
  const W = 200, H = 200;
  // Uniform gray surface with no distinct boundary
  const data = new Uint8ClampedArray(W * H * 4).fill(128);

  const fallback = detectDocumentCorners({ data }, W, H);
  assert.ok(fallback);
  assert.equal(fallback.confidence, 'fallback', 'Must gracefully fall back without throwing');
  assert.equal(fallback.p0.x, 10); // 5% inset of 200
  assert.equal(fallback.p0.y, 10);
  assert.equal(fallback.p2.x, 190);
  assert.equal(fallback.p2.y, 190);
});

test('B. Document Processing: Real image processing in Enhance filter', () => {
  // Test paper background whitening and text ink darkening
  const pixels = new Uint8ClampedArray([
    // Light gray paper background (lum ~160)
    160, 160, 160, 255,
    // Dark ink text (lum ~60)
    60, 60, 60, 255
  ]);

  applyFilterToImageData({ data: pixels }, 'enhance');

  // Background should be brightened towards white (> 160)
  assert.ok(pixels[0] > 180, 'Paper background must be lightened');
  assert.ok(pixels[1] > 180);
  assert.ok(pixels[2] > 180);

  // Ink should be darkened for razor-sharp printing (< 60)
  assert.ok(pixels[4] < 50, 'Text ink must be darkened for contrast');
  assert.ok(pixels[5] < 50);
  assert.ok(pixels[6] < 50);
});

test('B. Document Processing: Geometry and Aspect Ratio Constraints', () => {
  // Standard A4 portrait ratio: 0.707
  const box = { left: 10, top: 10, width: 200, height: 200 };
  const a4Box = applyAspectRatio(box, 0.707, 1000, 1000);
  const ratio = a4Box.width / a4Box.height;
  assert.ok(Math.abs(ratio - 0.707) < 0.05, `Ratio should be ~0.707, got ${ratio}`);

  // Test Heckbert Homography coefficients calculation
  const p0 = { x: 20, y: 30 };
  const p1 = { x: 380, y: 25 };
  const p2 = { x: 390, y: 490 };
  const p3 = { x: 15, y: 480 };
  assert.ok(isConvexQuad(p0, p1, p2, p3), 'Quadrilateral must be convex');
  const h = solveHomography(p0, p1, p2, p3, 400, 500);
  assert.ok(typeof h.a === 'number' && typeof h.d === 'number', 'Homography must produce valid coefficients');
  assert.ok(typeof h.g_step === 'number' && typeof h.h_step === 'number');
});
