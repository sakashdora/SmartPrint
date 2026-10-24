import test from 'node:test';
import assert from 'node:assert/strict';
import { cropBounds } from '../public/crop.js';

test('crop selection supports reversed drags, edges and minimum pixel size', () => {
  assert.deepEqual(cropBounds({ x: 80, y: 70 }, { x: 20, y: 10 }, 100, 100), { left: 20, top: 10, width: 60, height: 60 });
  assert.deepEqual(cropBounds({ x: -20, y: -10 }, { x: 200, y: 300 }, 100, 80), { left: 0, top: 0, width: 100, height: 80 });
  assert.deepEqual(cropBounds({ x: 100, y: 80 }, { x: 100, y: 80 }, 100, 80), { left: 99, top: 79, width: 1, height: 1 });
});
