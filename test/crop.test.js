import test from 'node:test';
import assert from 'node:assert/strict';
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

test('crop selection supports reversed drags, edges and minimum pixel size', () => {
  assert.deepEqual(cropBounds({ x: 80, y: 70 }, { x: 20, y: 10 }, 100, 100), { left: 20, top: 10, width: 60, height: 60 });
  assert.deepEqual(cropBounds({ x: -20, y: -10 }, { x: 200, y: 300 }, 100, 80), { left: 0, top: 0, width: 100, height: 80 });
  assert.deepEqual(cropBounds({ x: 100, y: 80 }, { x: 100, y: 80 }, 100, 80), { left: 99, top: 79, width: 1, height: 1 });
});

test('aspect ratio calculation clamps within container bounds', () => {
  const box = { left: 10, top: 10, width: 100, height: 100 };
  const a4Port = applyAspectRatio(box, 0.707, 200, 200);
  assert.equal(a4Port.width, 100);
  assert.equal(a4Port.height, 141);

  const constrained = applyAspectRatio(box, 2.0, 150, 150);
  assert.equal(constrained.width, 100);
  assert.equal(constrained.height, 50);
});

test('isConvexQuad accepts convex quadrilaterals and rejects inverted/self-intersecting shapes', () => {
  // Regular rectangle
  assert.equal(isConvexQuad({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }), true);
  // Tilted trapezoid / skewed document
  assert.equal(isConvexQuad({ x: 15, y: 20 }, { x: 95, y: 10 }, { x: 88, y: 92 }, { x: 10, y: 85 }), true);
  // Inverted hourglass (self-intersecting edges)
  assert.equal(isConvexQuad({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }), false);
  // Collinear points
  assert.equal(isConvexQuad({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }), false);
});

test('getQuadDimensions computes optimal unskewed dimensions', () => {
  const dims = getQuadDimensions({ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 130, y: 90 }, { x: 0, y: 90 });
  assert.equal(dims.width, 130);
  assert.equal(dims.height, 91);
});

test('solveHomography produces valid Heckbert projective coefficients', () => {
  const W = 100, H = 100;
  const p0 = { x: 10, y: 15 };
  const p1 = { x: 110, y: 20 };
  const p2 = { x: 105, y: 125 };
  const p3 = { x: 15, y: 120 };

  const { a, b, c, d, e, f, g_step, h_step } = solveHomography(p0, p1, p2, p3, W, H);
  assert.equal(typeof a, 'number');
  assert.equal(typeof b, 'number');
  assert.equal(typeof c, 'number');
  assert.equal(c, 10);
  assert.equal(f, 15);
});

test('detectDocumentCorners identifies high-contrast document boundaries and falls back safely', () => {
  const W = 200, H = 200;
  const data = new Uint8ClampedArray(W * H * 4);

  // Background is dark (30), document is bright (240) from (30, 40) to (170, 160)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      if (x >= 30 && x <= 170 && y >= 40 && y <= 160) {
        data[idx] = 240; data[idx + 1] = 240; data[idx + 2] = 240; data[idx + 3] = 255;
      } else {
        data[idx] = 30; data[idx + 1] = 30; data[idx + 2] = 30; data[idx + 3] = 255;
      }
    }
  }

  const detected = detectDocumentCorners({ data }, W, H);
  assert.ok(detected);
  assert.equal(detected.confidence, 'high');
  assert(Math.abs(detected.p0.x - 30) <= 2 && Math.abs(detected.p0.y - 40) <= 2);
  assert(Math.abs(detected.p2.x - 170) <= 2 && Math.abs(detected.p2.y - 160) <= 2);

  // Fallback on uniform blank canvas
  const blankData = new Uint8ClampedArray(100 * 100 * 4);
  const fallback = detectDocumentCorners({ data: blankData }, 100, 100);
  assert.equal(fallback.confidence, 'fallback');
  assert.equal(fallback.p0.x, 5); // 5% inset
  assert.equal(fallback.p0.y, 5);
});

test('applyFilterToImageData transforms pixels correctly across grayscale, bw, and enhance', () => {
  // Grayscale
  const rgb = new Uint8ClampedArray([255, 0, 0, 255]);
  applyFilterToImageData({ data: rgb }, 'grayscale');
  const expectedGray = Math.round(0.299 * 255);
  assert.equal(rgb[0], expectedGray);
  assert.equal(rgb[1], expectedGray);
  assert.equal(rgb[2], expectedGray);

  // Clean B&W
  const bwData = new Uint8ClampedArray([250, 250, 250, 255, 20, 20, 20, 255]);
  applyFilterToImageData({ data: bwData }, 'bw');
  assert.equal(bwData[0], 255); // paper to white
  assert.equal(bwData[4], 0);   // text to black

  // Enhance
  const enhData = new Uint8ClampedArray([180, 180, 180, 255, 60, 60, 60, 255]);
  applyFilterToImageData({ data: enhData }, 'enhance');
  assert(enhData[0] > 180); // light brightened
  assert(enhData[4] < 60);  // dark deepened
});

test('applyBlurToImageData blurs targeted region and preserves unaffected areas', () => {
  const W = 40, H = 40;
  const d = new Uint8ClampedArray(W * H * 4);
  // Center spike
  d[(20 * W + 20) * 4] = 255;
  d[(20 * W + 20) * 4 + 1] = 255;
  d[(20 * W + 20) * 4 + 2] = 255;

  // Blur with redact box (15, 15) to (25, 25)
  applyBlurToImageData({ width: W, height: H, data: d }, 3, { left: 15, top: 15, width: 10, height: 10 });

  // Center should be diffused
  assert(d[(20 * W + 20) * 4] < 255);
  assert(d[(20 * W + 21) * 4] > 0);

  // Unaffected area outside redact box
  assert.equal(d[(5 * W + 5) * 4], 0);
});

test('orderCorners strictly maps quad corners to [Top-Left, Top-Right, Bottom-Right, Bottom-Left]', async () => {
  const { orderCorners } = await import('../public/crop.js');

  // Scrambled input: [Bottom-Right, Top-Left, Bottom-Left, Top-Right]
  const scrambled = {
    p0: { x: 500, y: 700 }, // BR
    p1: { x: 20, y: 30 },   // TL
    p2: { x: 25, y: 690 },  // BL
    p3: { x: 490, y: 35 }   // TR
  };

  const ordered = orderCorners(scrambled);
  assert.equal(ordered.p0.x, 20);
  assert.equal(ordered.p0.y, 30);
  assert.equal(ordered.p1.x, 490);
  assert.equal(ordered.p1.y, 35);
  assert.equal(ordered.p2.x, 500);
  assert.equal(ordered.p2.y, 700);
  assert.equal(ordered.p3.x, 25);
  assert.equal(ordered.p3.y, 690);

  // Fallback resilience on non-finite coordinates
  const degenerate = orderCorners({ p0: null, p1: { x: NaN, y: Infinity }, p2: undefined, p3: { x: 10, y: 20 } });
  assert.ok(Number.isFinite(degenerate.p0.x) && Number.isFinite(degenerate.p0.y));
  assert.ok(Number.isFinite(degenerate.p1.x) && Number.isFinite(degenerate.p1.y));
  assert.ok(Number.isFinite(degenerate.p2.x) && Number.isFinite(degenerate.p2.y));
  assert.ok(Number.isFinite(degenerate.p3.x) && Number.isFinite(degenerate.p3.y));
});

test('solveHomography and getQuadDimensions resist NaN and zero denominators', () => {
  // Degenerate dimensions
  const dims = getQuadDimensions({ x: NaN, y: 0 }, { x: 0, y: NaN }, null, undefined);
  assert.ok(dims.width >= 10 && Number.isFinite(dims.width));
  assert.ok(dims.height >= 10 && Number.isFinite(dims.height));

  // Zero-width/height homography solve
  const homo = solveHomography({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 0, 0);
  assert.ok(Number.isFinite(homo.a));
  assert.ok(Number.isFinite(homo.b));
  assert.ok(Number.isFinite(homo.c));
  assert.ok(Number.isFinite(homo.d));
  assert.ok(Number.isFinite(homo.e));
  assert.ok(Number.isFinite(homo.f));
  assert.ok(Number.isFinite(homo.g_step));
  assert.ok(Number.isFinite(homo.h_step));
});
