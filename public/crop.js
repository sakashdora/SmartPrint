// SmartPrint Document Scanner & Crop Engine
// High-performance perspective correction, 4-corner homography, auto edge detection,
// adaptive text enhancement, privacy-safe redaction blur, and non-destructive file handling.

export function cropBounds(start, end, width, height) {
  const clamp = (n, max) => Math.max(0, Math.min(max, Math.round(n)));
  const left = clamp(Math.min(start.x, end.x), width - 1);
  const top = clamp(Math.min(start.y, end.y), height - 1);
  return {
    left,
    top,
    width: Math.max(1, clamp(Math.max(start.x, end.x), width) - left),
    height: Math.max(1, clamp(Math.max(start.y, end.y), height) - top)
  };
}

export function applyAspectRatio(box, ratio, maxWidth, maxHeight) {
  if (!ratio || ratio <= 0) return { ...box };
  let w = box.width;
  let h = Math.round(w / ratio);
  if (h > maxHeight) {
    h = maxHeight;
    w = Math.round(h * ratio);
  }
  if (w > maxWidth) {
    w = maxWidth;
    h = Math.round(w / ratio);
  }
  const left = Math.max(0, Math.min(maxWidth - w, box.left));
  const top = Math.max(0, Math.min(maxHeight - h, box.top));
  return { left, top, width: Math.max(1, w), height: Math.max(1, h) };
}

// Strictly validates that p0, p1, p2, p3 form a non-degenerate, non-inverted convex quadrilateral
export function isConvexQuad(p0, p1, p2, p3) {
  if (!p0 || !p1 || !p2 || !p3) return false;
  const pts = [p0, p1, p2, p3];
  if (pts.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cp = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cp) < 1e-4) return false; // collinear or degenerate
    const currentSign = cp > 0 ? 1 : -1;
    if (sign === 0) sign = currentSign;
    else if (sign !== currentSign) return false; // inverted / self-intersecting
  }
  return true;
}

// Strictly orders 4 points into [Top-Left, Top-Right, Bottom-Right, Bottom-Left]
export function orderCorners(pts) {
  const arr = Array.isArray(pts) ? pts : [pts?.p0, pts?.p1, pts?.p2, pts?.p3];
  const safeArr = arr.map((p, idx) => ({
    x: (p && Number.isFinite(p.x)) ? p.x : (idx === 1 || idx === 2 ? 100 : 0),
    y: (p && Number.isFinite(p.y)) ? p.y : (idx >= 2 ? 100 : 0)
  }));

  // Sort by sum of coordinates (x + y):
  // Top-Left (p0) has the smallest sum; Bottom-Right (p2) has the largest sum
  const sumSorted = [...safeArr].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const p0 = sumSorted[0];
  const p2 = sumSorted[3];

  // The remaining two points are Top-Right (p1) and Bottom-Left (p3):
  // Sort remaining by difference (y - x):
  // Top-Right has smaller (y - x) (large x, small y)
  // Bottom-Left has larger (y - x) (small x, large y)
  const remaining = [sumSorted[1], sumSorted[2]];
  remaining.sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const p1 = remaining[0];
  const p3 = remaining[1];

  return { p0, p1, p2, p3 };
}

// Calculates optimal destination dimensions preserving document aspect ratio
export function getQuadDimensions(p0, p1, p2, p3) {
  const safeHypot = (x1, y1, x2, y2) => {
    const dx = (Number.isFinite(x2) ? x2 : 0) - (Number.isFinite(x1) ? x1 : 0);
    const dy = (Number.isFinite(y2) ? y2 : 0) - (Number.isFinite(y1) ? y1 : 0);
    return Math.hypot(dx, dy);
  };
  const topW = safeHypot(p0?.x, p0?.y, p1?.x, p1?.y);
  const botW = safeHypot(p3?.x, p3?.y, p2?.x, p2?.y);
  const leftH = safeHypot(p0?.x, p0?.y, p3?.x, p3?.y);
  const rightH = safeHypot(p1?.x, p1?.y, p2?.x, p2?.y);
  const maxW = Math.max(topW || 0, botW || 0);
  const maxH = Math.max(leftH || 0, rightH || 0);
  const width = Math.max(10, Math.round(Number.isFinite(maxW) ? maxW : 10));
  const height = Math.max(10, Math.round(Number.isFinite(maxH) ? maxH : 10));
  return { width, height };
}

// Paul Heckbert closed-form projective mapping from rectangle [0, W] x [0, H] to quad [p0, p1, p2, p3]
export function solveHomography(p0, p1, p2, p3, W, H) {
  const safeW = Math.max(1, Number.isFinite(W) ? W : 1);
  const safeH = Math.max(1, Number.isFinite(H) ? H : 1);

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sy = p0.y - p1.y + p2.y - p3.y;

  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-6 || Math.abs(sy) > 1e-6) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) > 1e-9) {
      g = (sx * dy2 - sy * dx2) / det;
      h = (dx1 * sy - dy1 * sx) / det;
    }
  }

  const a = (p1.x - p0.x + g * p1.x) / safeW;
  const b = (p3.x - p0.x + h * p3.x) / safeH;
  const c = p0.x;
  const d = (p1.y - p0.y + g * p1.y) / safeW;
  const e = (p3.y - p0.y + h * p3.y) / safeH;
  const f = p0.y;
  const g_step = g / safeW;
  const h_step = h / safeH;

  // Safe fallback to affine projection if any coefficient is NaN or Infinity
  if (![a, b, c, d, e, f, g_step, h_step].every(Number.isFinite)) {
    return {
      a: (p1.x - p0.x) / safeW,
      b: (p3.x - p0.x) / safeH,
      c: p0.x,
      d: (p1.y - p0.y) / safeW,
      e: (p3.y - p0.y) / safeH,
      f: p0.y,
      g_step: 0,
      h_step: 0
    };
  }

  return { a, b, c, d, e, f, g_step, h_step };
}

// Applies high-quality bilinear interpolation perspective warp from sourceCanvas to output
export function warpPerspectiveCanvas(sourceCanvas, corners, outW, outH) {
  if (!sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) {
    const emptyCanvas = document.createElement('canvas');
    emptyCanvas.width = emptyCanvas.height = 1;
    return emptyCanvas;
  }

  // Ensure output dimensions are valid positive integers
  let safeOutW = Math.max(10, Math.round(Number.isFinite(outW) ? outW : 10));
  let safeOutH = Math.max(10, Math.round(Number.isFinite(outH) ? outH : 10));

  // Cap destination to 1400px (crisp 200-300 DPI print quality) for sub-second perspective warp
  const maxDim = 1400;
  if (safeOutW > maxDim || safeOutH > maxDim) {
    const scale = Math.min(maxDim / safeOutW, maxDim / safeOutH);
    safeOutW = Math.max(10, Math.round(safeOutW * scale));
    safeOutH = Math.max(10, Math.round(safeOutH * scale));
  }

  const output = document.createElement('canvas');
  output.width = safeOutW;
  output.height = safeOutH;
  const outCtx = output.getContext('2d');
  const srcCtx = sourceCanvas.getContext('2d');

  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
  const dstData = outCtx.createImageData(safeOutW, safeOutH);

  const sData = srcData.data;
  const dData = dstData.data;

  // Guarantee corners are strictly ordered [TL, TR, BR, BL]
  const ordered = orderCorners(corners);
  const { p0, p1, p2, p3 } = ordered;
  const { a, b, c, d, e, f, g_step, h_step } = solveHomography(p0, p1, p2, p3, safeOutW, safeOutH);

  for (let v = 0; v < safeOutH; v++) {
    const rowOffset = v * safeOutW * 4;
    const v_term_x = b * v + c;
    const v_term_y = e * v + f;
    const v_term_denom = h_step * v + 1;

    for (let u = 0; u < safeOutW; u++) {
      const denom = v_term_denom + g_step * u;
      if (Math.abs(denom) > 1e-7) {
        const invD = 1 / denom;
        const sxCoord = (v_term_x + a * u) * invD;
        const syCoord = (v_term_y + d * u) * invD;

        if (Number.isFinite(sxCoord) && Number.isFinite(syCoord)) {
          const x0 = Math.floor(sxCoord);
          const y0 = Math.floor(syCoord);

          if (x0 >= 0 && x0 < srcW - 1 && y0 >= 0 && y0 < srcH - 1) {
            const fx = sxCoord - x0;
            const fy = syCoord - y0;
            const idx00 = (y0 * srcW + x0) * 4;
            const idx10 = idx00 + 4;
            const idx01 = idx00 + srcW * 4;
            const idx11 = idx01 + 4;

            const w00 = (1 - fx) * (1 - fy);
            const w10 = fx * (1 - fy);
            const w01 = (1 - fx) * fy;
            const w11 = fx * fy;

            const outIdx = rowOffset + u * 4;
            dData[outIdx] = Math.round(w00 * sData[idx00] + w10 * sData[idx10] + w01 * sData[idx01] + w11 * sData[idx11]);
            dData[outIdx + 1] = Math.round(w00 * sData[idx00 + 1] + w10 * sData[idx10 + 1] + w01 * sData[idx01 + 1] + w11 * sData[idx11 + 1]);
            dData[outIdx + 2] = Math.round(w00 * sData[idx00 + 2] + w10 * sData[idx10 + 2] + w01 * sData[idx01 + 2] + w11 * sData[idx11 + 2]);
            dData[outIdx + 3] = 255;
            continue;
          } else if (x0 >= 0 && x0 < srcW && y0 >= 0 && y0 < srcH) {
            // Nearest-neighbor fallback for single-pixel boundary edge
            const idx = (y0 * srcW + x0) * 4;
            const outIdx = rowOffset + u * 4;
            dData[outIdx] = sData[idx];
            dData[outIdx + 1] = sData[idx + 1];
            dData[outIdx + 2] = sData[idx + 2];
            dData[outIdx + 3] = 255;
            continue;
          }
        }
      }

      // Default background for pixels outside source range: white document paper
      const outIdx = rowOffset + u * 4;
      dData[outIdx] = 255;
      dData[outIdx + 1] = 255;
      dData[outIdx + 2] = 255;
      dData[outIdx + 3] = 255;
    }
  }

  outCtx.putImageData(dstData, 0, 0);
  return output;
}

// Automatic document corner and edge detector
export function detectDocumentCorners(imageData, width, height) {
  if (!imageData || !width || !height) return null;
  const data = imageData.data;

  // 1. Multi-scale grid luminance sampling
  const step = Math.max(1, Math.floor(Math.min(width, height) / 100));
  const sampleW = Math.ceil(width / step);
  const sampleH = Math.ceil(height / step);
  const lums = new Float32Array(sampleW * sampleH);

  let sum = 0, sumSq = 0, count = 0;
  let minLum = 255, maxLum = 0;

  for (let sy = 0; sy < sampleH; sy++) {
    const y = Math.min(height - 1, sy * step);
    for (let sx = 0; sx < sampleW; sx++) {
      const x = Math.min(width - 1, sx * step);
      const idx = (y * width + x) * 4;
      const l = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      lums[sy * sampleW + sx] = l;
      sum += l;
      sumSq += l * l;
      if (l < minLum) minLum = l;
      if (l > maxLum) maxLum = l;
      count++;
    }
  }

  const mean = sum / count;
  const variance = (sumSq / count) - (mean * mean);

  // Fallback for uniform blank or near-zero contrast images
  if (variance < 15 || (maxLum - minLum) < 25) {
    const insetX = Math.round(width * 0.05);
    const insetY = Math.round(height * 0.05);
    return {
      p0: { x: insetX, y: insetY },
      p1: { x: width - insetX, y: insetY },
      p2: { x: width - insetX, y: height - insetY },
      p3: { x: insetX, y: height - insetY },
      confidence: 'fallback'
    };
  }

  // 2. Otsu global threshold on sampled grid
  const hist = new Int32Array(256);
  for (let i = 0; i < count; i++) {
    hist[Math.min(255, Math.max(0, Math.round(lums[i])))]++;
  }

  let total = count, sumB = 0, wB = 0, maximum = 0, otsuThresh = 128;
  let sum1 = 0;
  for (let i = 0; i < 256; i++) sum1 += i * hist[i];

  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum1 - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maximum) {
      maximum = between;
      otsuThresh = Math.round((mB + mF) / 2);
    }
  }

  // 3. Border background sampling
  let borderSum = 0, borderCount = 0;
  for (let sx = 0; sx < sampleW; sx++) {
    borderSum += lums[sx] + lums[(sampleH - 1) * sampleW + sx];
    borderCount += 2;
  }
  for (let sy = 1; sy < sampleH - 1; sy++) {
    borderSum += lums[sy * sampleW] + lums[sy * sampleW + sampleW - 1];
    borderCount += 2;
  }
  const borderMean = borderSum / borderCount;
  const docIsBrighter = borderMean < otsuThresh;

  // 4. Edge gradient magnitude
  const edges = new Float32Array(sampleW * sampleH);
  for (let sy = 1; sy < sampleH - 1; sy++) {
    for (let sx = 1; sx < sampleW - 1; sx++) {
      const dx = lums[sy * sampleW + sx + 1] - lums[sy * sampleW + sx - 1];
      const dy = lums[(sy + 1) * sampleW + sx] - lums[(sy - 1) * sampleW + sx];
      edges[sy * sampleW + sx] = Math.hypot(dx, dy);
    }
  }

  // 5. Gather document candidate points
  const candidates = [];
  const edgeCutoff = Math.max(15, (maxLum - minLum) * 0.25);
  for (let sy = 0; sy < sampleH; sy++) {
    const y = Math.min(height - 1, sy * step);
    for (let sx = 0; sx < sampleW; sx++) {
      const x = Math.min(width - 1, sx * step);
      const lum = lums[sy * sampleW + sx];
      const isDoc = docIsBrighter ? (lum > otsuThresh) : (lum < otsuThresh);
      const edge = edges[sy * sampleW + sx];
      if (isDoc || edge > edgeCutoff) {
        candidates.push({ x, y });
      }
    }
  }

  const docRatio = candidates.length / (sampleW * sampleH);
  if (docRatio > 0.08 && docRatio < 0.98) {
    let p0 = { x: width, y: height, val: Infinity };
    let p1 = { x: 0, y: height, val: -Infinity };
    let p2 = { x: 0, y: 0, val: -Infinity };
    let p3 = { x: width, y: 0, val: Infinity };

    for (const pt of candidates) {
      const sum = pt.x + pt.y;
      const diff = pt.x - pt.y;
      if (sum < p0.val) { p0.val = sum; p0.x = pt.x; p0.y = pt.y; }
      if (diff > p1.val) { p1.val = diff; p1.x = pt.x; p1.y = pt.y; }
      if (sum > p2.val) { p2.val = sum; p2.x = pt.x; p2.y = pt.y; }
      if (diff < p3.val) { p3.val = diff; p3.x = pt.x; p3.y = pt.y; }
    }

    const quad = {
      p0: { x: Math.max(0, Math.min(width, p0.x)), y: Math.max(0, Math.min(height, p0.y)) },
      p1: { x: Math.max(0, Math.min(width, p1.x)), y: Math.max(0, Math.min(height, p1.y)) },
      p2: { x: Math.max(0, Math.min(width, p2.x)), y: Math.max(0, Math.min(height, p2.y)) },
      p3: { x: Math.max(0, Math.min(width, p3.x)), y: Math.max(0, Math.min(height, p3.y)) }
    };

    if (isConvexQuad(quad.p0, quad.p1, quad.p2, quad.p3)) {
      const dims = getQuadDimensions(quad.p0, quad.p1, quad.p2, quad.p3);
      const quadArea = dims.width * dims.height;
      const totalArea = width * height;
      if (quadArea > totalArea * 0.12 && quadArea < totalArea * 0.98) {
        return { ...quad, confidence: 'high' };
      }
    }
  }

  // Safe fallback to 5% inset quadrilateral
  const insetX = Math.round(width * 0.05);
  const insetY = Math.round(height * 0.05);
  return {
    p0: { x: insetX, y: insetY },
    p1: { x: width - insetX, y: insetY },
    p2: { x: width - insetX, y: height - insetY },
    p3: { x: insetX, y: height - insetY },
    confidence: 'fallback'
  };
}

// Backwards-compatible bounding box edge detector
export function detectDocumentEdges(imageData, width, height) {
  const corners = detectDocumentCorners(imageData, width, height);
  if (!corners || corners.confidence === 'fallback') return null;
  const left = Math.min(corners.p0.x, corners.p3.x);
  const top = Math.min(corners.p0.y, corners.p1.y);
  const right = Math.max(corners.p1.x, corners.p2.x);
  const bottom = Math.max(corners.p2.y, corners.p3.y);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

// Document enhancement and color filters
export function applyFilterToImageData(imageData, filterMode) {
  if (!imageData || filterMode === 'original') return;
  const data = imageData.data;
  const len = data.length;

  if (filterMode === 'grayscale') {
    for (let i = 0; i < len; i += 4) {
      const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      data[i] = data[i + 1] = data[i + 2] = gray;
    }
  } else if (filterMode === 'bw') {
    // Clean B&W Document - Adaptive thresholding for crisp text and pristine white paper
    let sum = 0;
    for (let i = 0; i < len; i += 4) {
      sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
    const mean = (sum / (len / 4)) * 0.92;
    for (let i = 0; i < len; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const val = lum >= mean ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = val;
    }
  } else if (filterMode === 'contrast') {
    const contrast = 45;
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < len; i += 4) {
      data[i] = Math.max(0, Math.min(255, factor * (data[i] - 128) + 128));
      data[i + 1] = Math.max(0, Math.min(255, factor * (data[i + 1] - 128) + 128));
      data[i + 2] = Math.max(0, Math.min(255, factor * (data[i + 2] - 128) + 128));
    }
  } else if (filterMode === 'enhance') {
    // High-performance document text clarity & background whitening curve
    for (let i = 0; i < len; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      let adjLum;
      if (lum >= 130) {
        // Brighten paper background towards pure white
        adjLum = Math.min(255, lum + (255 - lum) * 0.45);
      } else {
        // Darken text/ink/lines for razor-sharp readability
        adjLum = Math.max(0, lum * 0.72);
      }
      const scale = lum > 0 ? adjLum / lum : 1;
      data[i] = Math.max(0, Math.min(255, Math.round(data[i] * scale)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(data[i + 1] * scale)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(data[i + 2] * scale)));
    }
  }
}

// Two-pass box blur with optional region masking for privacy redaction
export function applyBlurToImageData(imageData, radius = 5, redactBox = null) {
  if (!imageData || radius <= 0) return;
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;

  const minX = redactBox ? Math.max(0, Math.floor(redactBox.left)) : 0;
  const minY = redactBox ? Math.max(0, Math.floor(redactBox.top)) : 0;
  const maxX = redactBox ? Math.min(width, Math.ceil(redactBox.left + redactBox.width)) : width;
  const maxY = redactBox ? Math.min(height, Math.ceil(redactBox.top + redactBox.height)) : height;

  const r = Math.min(30, Math.max(1, Math.round(radius)));
  const boxW = maxX - minX;
  const boxH = maxY - minY;
  if (boxW <= 0 || boxH <= 0) return;

  const temp = new Uint8ClampedArray(boxW * boxH * 4);

  // Horizontal blur pass
  for (let y = 0; y < boxH; y++) {
    const srcY = minY + y;
    for (let x = 0; x < boxW; x++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let k = -r; k <= r; k++) {
        const sx = Math.min(width - 1, Math.max(0, minX + x + k));
        const idx = (srcY * width + sx) * 4;
        rSum += data[idx];
        gSum += data[idx + 1];
        bSum += data[idx + 2];
        count++;
      }
      const tIdx = (y * boxW + x) * 4;
      temp[tIdx] = rSum / count;
      temp[tIdx + 1] = gSum / count;
      temp[tIdx + 2] = bSum / count;
    }
  }

  // Vertical blur pass
  for (let x = 0; x < boxW; x++) {
    const srcX = minX + x;
    for (let y = 0; y < boxH; y++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let k = -r; k <= r; k++) {
        const ty = Math.min(boxH - 1, Math.max(0, y + k));
        const tIdx = (ty * boxW + x) * 4;
        rSum += temp[tIdx];
        gSum += temp[tIdx + 1];
        bSum += temp[tIdx + 2];
        count++;
      }
      const dstIdx = ((minY + y) * width + srcX) * 4;
      data[dstIdx] = rSum / count;
      data[dstIdx + 1] = gSum / count;
      data[dstIdx + 2] = bSum / count;
    }
  }
}

// Opens the professional Document Scanner & Editor
export async function openDocumentEditor({
  file,
  pageIndex = 0,
  totalPages = 1,
  initialMode = 'auto',
  onApply,
  onCancel,
  onPrintOriginal
} = {}) {
  const url = URL.createObjectURL(file);
  const rawImage = new Image();
  try {
    rawImage.src = url;
    await rawImage.decode();
  } finally {
    URL.revokeObjectURL(url);
  }

  const origWidth = rawImage.naturalWidth;
  const origHeight = rawImage.naturalHeight;
  if (origWidth * origHeight > 40000000) {
    throw new Error('This image is too large. Use an image below 40 megapixels.');
  }

  return new Promise(resolve => {
    let rotation = initialMode === 'rotate' ? 90 : 0; // 0, 90, 180, 270
    let activeFilter = initialMode === 'enhance' ? 'enhance' : (initialMode === 'filter' ? 'bw' : 'original');
    let activeRatio = null; // null (free), 0.707 (A4 port), 1.414 (A4 land), 1.586 (ID Card)
    let activeTool = (initialMode === 'enhance')
      ? 'enhance'
      : (initialMode === 'filter'
        ? 'filter'
        : (initialMode === 'blur' ? 'blur' : initialMode === 'rect' ? 'rect' : 'perspective'));
    let blurStrength = 10;
    let redactBox = null;
    let isDraggingHandle = -1;
    let dragAnchor = null;
    let applying = false;
    let isComparing = false;

    // History stacks for undo/redo
    const historyStack = [];
    const redoStack = [];

    const getTransformedDimensions = () => {
      const isSwapped = rotation === 90 || rotation === 270;
      return {
        width: isSwapped ? origHeight : origWidth,
        height: isSwapped ? origWidth : origHeight
      };
    };

    let curDims = getTransformedDimensions();

    const getRotatedSourceCanvas = () => {
      const off = document.createElement('canvas');
      off.width = curDims.width;
      off.height = curDims.height;
      const offCtx = off.getContext('2d');
      offCtx.save();
      offCtx.translate(off.width / 2, off.height / 2);
      offCtx.rotate((rotation * Math.PI) / 180);
      offCtx.drawImage(rawImage, -origWidth / 2, -origHeight / 2);
      offCtx.restore();
      return off;
    };

    let currentSourceCanvas = getRotatedSourceCanvas();

    // 4 Corner coordinates in full-resolution image space
    let corners = {
      p0: { x: 0, y: 0 },
      p1: { x: curDims.width, y: 0 },
      p2: { x: curDims.width, y: curDims.height },
      p3: { x: 0, y: curDims.height }
    };

    // Rectangular crop box
    let rectBox = { left: 0, top: 0, width: curDims.width, height: curDims.height };

    // Initialize Auto-detection if requested
    const detectCornersOnCanvas = () => {
      const sampleW = Math.min(600, curDims.width);
      const sampleH = Math.round((sampleW / curDims.width) * curDims.height);
      const sc = document.createElement('canvas');
      sc.width = sampleW;
      sc.height = sampleH;
      const sCtx = sc.getContext('2d');
      sCtx.drawImage(currentSourceCanvas, 0, 0, sampleW, sampleH);
      const sImgData = sCtx.getImageData(0, 0, sampleW, sampleH);
      const det = detectDocumentCorners(sImgData, sampleW, sampleH);
      if (det) {
        const sx = curDims.width / sampleW;
        const sy = curDims.height / sampleH;
        return {
          p0: { x: Math.round(det.p0.x * sx), y: Math.round(det.p0.y * sy) },
          p1: { x: Math.round(det.p1.x * sx), y: Math.round(det.p1.y * sy) },
          p2: { x: Math.round(det.p2.x * sx), y: Math.round(det.p2.y * sy) },
          p3: { x: Math.round(det.p3.x * sx), y: Math.round(det.p3.y * sy) }
        };
      }
      return null;
    };

    if (initialMode === 'auto') {
      const autoCorners = detectCornersOnCanvas();
      if (autoCorners && isConvexQuad(autoCorners.p0, autoCorners.p1, autoCorners.p2, autoCorners.p3)) {
        corners = autoCorners;
      }
    }

    const dialog = document.createElement('dialog');
    dialog.className = 'crop-dialog document-editor-dialog';
    dialog.setAttribute('aria-labelledby', 'doc-editor-title');

    dialog.innerHTML = `
      <div class="doc-editor-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #e2e8f0;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;background:#eff6ff;color:#2563eb;border-radius:8px;font-size:18px;">✂️</span>
          <div>
            <h2 id="doc-editor-title" style="margin:0;font-size:17px;font-weight:700;color:#0f172a;">Document Editor</h2>
            <span style="font-size:12px;color:#64748b;" id="editor-page-indicator">
              ${totalPages > 1 ? `Page ${pageIndex + 1} of ${totalPages} · ` : ''}${origWidth} × ${origHeight} px
            </span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button type="button" class="secondary small btn-print-original" id="btn-dialog-print-original" style="font-weight:600;color:#1e293b;" title="Discard edits and print untouched original file">
            📄 Print Original
          </button>
          <button type="button" class="icon-button" id="btn-dialog-close" aria-label="Close" style="width:36px;height:36px;border-radius:6px;">✕</button>
        </div>
      </div>

      <!-- Mode Tabs: Original, Auto Crop, Manual Crop, Enhance, Blur, Rotate, Filters -->
      <div class="editor-tabs-bar" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:12px;">
        <button type="button" class="editor-tab-btn is-active" data-tool="perspective" title="Drag 4 corners to straighten tilted document">
          📐 4-Corner Crop
        </button>
        <button type="button" class="editor-tab-btn" data-tool="auto" id="btn-trigger-autocrop" title="Automatically detect document edges">
          ✨ Auto Crop
        </button>
        <button type="button" class="editor-tab-btn" data-tool="rect" title="Crop rectangular selection with standard paper ratios">
          ✂️ Rectangular
        </button>
        <button type="button" class="editor-tab-btn" data-tool="enhance" id="btn-trigger-enhance" title="Boost text contrast and readability">
          🪄 Enhance
        </button>
        <button type="button" class="editor-tab-btn" data-tool="blur" id="btn-trigger-blur" title="Redact private details with adjustable blur">
          🔒 Redact / Blur
        </button>
        <button type="button" class="editor-tab-btn" data-tool="rotate" id="btn-trigger-rotate" title="Rotate document 90° clockwise">
          ↻ Rotate 90°
        </button>
        <button type="button" class="editor-tab-btn" data-tool="filter" id="btn-trigger-filter" title="Original, Grayscale, or Clean Black & White">
          🎨 Filters
        </button>
      </div>

      <!-- Sub-toolbars for specific tools -->
      <div class="editor-subtoolbars" style="margin-bottom:10px;">
        <!-- Ratio subtoolbar for Rectangular mode -->
        <div id="subtoolbar-rect" style="display:none;align-items:center;gap:6px;font-size:12px;background:#f1f5f9;padding:6px 10px;border-radius:8px;">
          <span style="font-weight:600;color:#475569;">Ratio:</span>
          <button type="button" class="secondary small crop-ratio-btn is-active" data-ratio="free">Free</button>
          <button type="button" class="secondary small crop-ratio-btn" data-ratio="0.707">A4 Portrait</button>
          <button type="button" class="secondary small crop-ratio-btn" data-ratio="1.414">A4 Landscape</button>
          <button type="button" class="secondary small crop-ratio-btn" data-ratio="1.586">ID Card</button>
        </div>

        <!-- Privacy Redact / Blur subtoolbar -->
        <div id="subtoolbar-blur" style="display:none;flex-direction:column;gap:8px;background:#fffbeb;border:1px solid #fde68a;padding:10px 12px;border-radius:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-weight:700;color:#92400e;font-size:12px;">Blur Strength:</span>
              <input type="range" id="blur-slider" min="3" max="25" value="10" style="width:130px;accent-color:#d97706;">
              <span id="blur-val-label" style="font-size:12px;font-weight:600;color:#92400e;">10 px</span>
            </div>
            <div style="display:flex;gap:6px;">
              <button type="button" class="secondary small" id="btn-blur-full" style="font-size:11px;padding:3px 8px;">Blur Entire Page</button>
              <button type="button" class="secondary small" id="btn-blur-clear" style="font-size:11px;padding:3px 8px;">Clear Redaction</button>
            </div>
          </div>
          <p style="margin:0;font-size:11.5px;color:#78350f;line-height:1.4;">
            <strong>Privacy Notice:</strong> Blur reduces text readability and cannot be reversed once printed. Drag on the image to redact only sensitive details (ID numbers, signatures, or photos). Blur is never applied automatically.
          </p>
        </div>

        <!-- Filters subtoolbar -->
        <div id="subtoolbar-filters" style="display:none;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;background:#f1f5f9;padding:6px 10px;border-radius:8px;">
          <span style="font-weight:600;color:#475569;">Document Filter:</span>
          <button type="button" class="secondary small crop-filter-btn is-active" data-filter="original">Original</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="enhance">✨ Enhanced</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="bw">Clean B&W</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="grayscale">Grayscale</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="contrast">High Contrast</button>
          <button type="button" class="secondary small btn-toggle-compare" id="btn-toggle-compare" style="margin-left:auto;font-weight:600;background:#e0e7ff;color:#3730a3;border-color:#c7d2fe;" title="Hold or click to compare with unenhanced original">👁️ Compare Original</button>
        </div>
      </div>

      <!-- Canvas container with responsive viewport -->
      <div class="editor-canvas-wrapper" style="position:relative;background:#0f172a;border-radius:10px;overflow:hidden;display:flex;justify-content:center;align-items:center;padding:8px;min-height:280px;max-height:55dvh;">
        <canvas class="crop-canvas" id="editor-interactive-canvas" aria-label="Interactive document scanner canvas"></canvas>
        <div id="canvas-loading-spinner" style="display:none;position:absolute;inset:0;background:rgba(15,23,42,0.75);color:white;flex-direction:column;align-items:center;justify-content:center;gap:8px;font-size:13px;font-weight:600;z-index:30;">
          <div class="spinner" style="width:28px;height:28px;border:3px solid rgba(255,255,255,0.3);border-top-color:#2563eb;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
          <span>Processing document...</span>
        </div>
      </div>

      <p class="inline-error" id="editor-error-msg" role="alert" style="margin:8px 0 0 0;font-size:12px;color:#dc2626;"></p>

      <!-- Bottom action bar -->
      <div class="editor-actions-bar" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid #e2e8f0;">
        <div style="display:flex;gap:6px;align-items:center;">
          <button type="button" class="secondary small" id="btn-editor-undo" title="Undo last adjustment" disabled>↶ Undo</button>
          <button type="button" class="secondary small" id="btn-editor-redo" title="Redo last adjustment" disabled>↷ Redo</button>
          <button type="button" class="secondary small" id="btn-editor-reset" title="Reset all crops and filters">↺ Reset</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button type="button" class="secondary" id="btn-editor-cancel">Cancel</button>
          <button type="button" class="primary" id="btn-editor-apply" style="font-weight:600;">✓ Apply & Continue</button>
        </div>
      </div>
    `;

    document.body.append(dialog);

    const canvas = dialog.querySelector('#editor-interactive-canvas');
    canvas.style.touchAction = 'none';
    const ctx = canvas.getContext('2d');
    const errorMsg = dialog.querySelector('#editor-error-msg');
    const undoBtn = dialog.querySelector('#btn-editor-undo');
    const redoBtn = dialog.querySelector('#btn-editor-redo');
    const applyBtn = dialog.querySelector('#btn-editor-apply');
    const blurSlider = dialog.querySelector('#blur-slider');
    const blurLabel = dialog.querySelector('#blur-val-label');
    const spinner = dialog.querySelector('#canvas-loading-spinner');

    const subRect = dialog.querySelector('#subtoolbar-rect');
    const subBlur = dialog.querySelector('#subtoolbar-blur');
    const subFilters = dialog.querySelector('#subtoolbar-filters');

    const updateHistoryButtons = () => {
      if (undoBtn) undoBtn.disabled = historyStack.length === 0 || applying;
      if (redoBtn) redoBtn.disabled = redoStack.length === 0 || applying;
    };

    // Centralized processing state controller with safe UI release
    const setProcessing = (isProcessing, message = 'Processing document...') => {
      applying = isProcessing;
      if (spinner) {
        spinner.style.display = isProcessing ? 'flex' : 'none';
        const msgEl = spinner.querySelector('span');
        if (msgEl && message) msgEl.textContent = message;
      }
      dialog.querySelectorAll('button, input').forEach(el => {
        el.disabled = isProcessing;
      });
      if (!isProcessing) {
        updateHistoryButtons();
      }
    };

    // Guarantee that spinner is never left visible on initial mount
    setProcessing(false);

    // Wire Compare Original button
    const compareBtn = dialog.querySelector('#btn-toggle-compare');
    if (compareBtn) {
      compareBtn.onclick = e => {
        e.preventDefault();
        isComparing = !isComparing;
        compareBtn.classList.toggle('is-active', isComparing);
        compareBtn.style.background = isComparing ? '#c7d2fe' : '#e0e7ff';
        draw();
      };
    }

    // Push state for Undo
    const pushState = () => {
      historyStack.push({
        corners: {
          p0: { ...corners.p0 },
          p1: { ...corners.p1 },
          p2: { ...corners.p2 },
          p3: { ...corners.p3 }
        },
        rectBox: { ...rectBox },
        rotation,
        activeFilter,
        activeTool,
        blurStrength,
        redactBox: redactBox ? { ...redactBox } : null
      });
      redoStack.length = 0;
      updateHistoryButtons();
    };

    // Calculate display canvas scale
    const updateDisplayScale = () => {
      curDims = getTransformedDimensions();
      const safeW = Math.max(1, curDims.width || 1);
      const safeH = Math.max(1, curDims.height || 1);
      const winW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1024;
      const winH = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 768;
      const maxDisplayW = Math.max(200, Math.min(1000, winW - 60));
      const maxDisplayH = Math.max(200, Math.min(650, winH * 0.52));
      const scale = Math.min(1, maxDisplayW / safeW, maxDisplayH / safeH);
      canvas.width = Math.max(1, Math.round(safeW * scale));
      canvas.height = Math.max(1, Math.round(safeH * scale));
    };

    updateDisplayScale();

    // Map coordinates between display canvas and full-res image space
    const toCanvasPoint = pt => {
      const w = Math.max(1, curDims.width || 1);
      const h = Math.max(1, curDims.height || 1);
      const x = (pt && Number.isFinite(pt.x)) ? pt.x : 0;
      const y = (pt && Number.isFinite(pt.y)) ? pt.y : 0;
      return {
        x: (x / w) * canvas.width,
        y: (y / h) * canvas.height
      };
    };

    const toImagePoint = (cx, cy) => {
      const cw = Math.max(1, canvas.width || 1);
      const ch = Math.max(1, canvas.height || 1);
      const safeX = Number.isFinite(cx) ? cx : 0;
      const safeY = Number.isFinite(cy) ? cy : 0;
      return {
        x: Math.max(0, Math.min(curDims.width, (safeX / cw) * curDims.width)),
        y: Math.max(0, Math.min(curDims.height, (safeY / ch) * curDims.height))
      };
    };

    // Draw main interactive canvas
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw base rotated image
      ctx.drawImage(currentSourceCanvas, 0, 0, canvas.width, canvas.height);

      // Apply filter on display preview (skipped while actively comparing original)
      if (activeFilter !== 'original' && !isComparing) {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        applyFilterToImageData(imgData, activeFilter);
        ctx.putImageData(imgData, 0, 0);
      }

      if (isComparing) {
        ctx.save();
        ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
        ctx.fillRect(8, 8, 165, 24);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 11.5px sans-serif';
        ctx.fillText('👁️ Original Document', 16, 24);
        ctx.restore();
      }

      // Apply blur on display preview if requested
      if (activeTool === 'blur' || redactBox) {
        const displayRedactBox = redactBox ? {
          left: (redactBox.left / curDims.width) * canvas.width,
          top: (redactBox.top / curDims.height) * canvas.height,
          width: (redactBox.width / curDims.width) * canvas.width,
          height: (redactBox.height / curDims.height) * canvas.height
        } : null;

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const displayRadius = Math.max(1, Math.round((blurStrength / curDims.width) * canvas.width * 2));
        applyBlurToImageData(imgData, displayRadius, displayRedactBox);
        ctx.putImageData(imgData, 0, 0);
      }

      if (activeTool === 'perspective' || activeTool === 'auto') {
        // Draw 4-corner perspective overlay
        const cp0 = toCanvasPoint(corners.p0);
        const cp1 = toCanvasPoint(corners.p1);
        const cp2 = toCanvasPoint(corners.p2);
        const cp3 = toCanvasPoint(corners.p3);

        // Dark dimming mask outside the selected quadrilateral
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.beginPath();
        ctx.rect(0, 0, canvas.width, canvas.height);
        ctx.moveTo(cp0.x, cp0.y);
        ctx.lineTo(cp3.x, cp3.y);
        ctx.lineTo(cp2.x, cp2.y);
        ctx.lineTo(cp1.x, cp1.y);
        ctx.closePath();
        ctx.fill('evenodd');
        ctx.restore();

        // Quadrilateral bounding stroke
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(cp0.x, cp0.y);
        ctx.lineTo(cp1.x, cp1.y);
        ctx.lineTo(cp2.x, cp2.y);
        ctx.lineTo(cp3.x, cp3.y);
        ctx.closePath();
        ctx.stroke();

        // 4 corner draggable handles with enhanced touch visibility
        const drawHandle = (pt, label) => {
          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
          ctx.fillStyle = '#2563eb';
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.restore();
        };

        drawHandle(cp0, 'TL');
        drawHandle(cp1, 'TR');
        drawHandle(cp2, 'BR');
        drawHandle(cp3, 'BL');
      } else if (activeTool === 'rect') {
        // Rectangular crop overlay
        const rx = (rectBox.left / curDims.width) * canvas.width;
        const ry = (rectBox.top / curDims.height) * canvas.height;
        const rw = (rectBox.width / curDims.width) * canvas.width;
        const rh = (rectBox.height / curDims.height) * canvas.height;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.fillRect(0, 0, canvas.width, ry);
        ctx.fillRect(0, ry + rh, canvas.width, canvas.height - ry - rh);
        ctx.fillRect(0, ry, rx, rh);
        ctx.fillRect(rx + rw, ry, canvas.width - rx - rw, rh);

        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(rx, ry, rw, rh);

        // Rect grips
        const grip = 8;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2;
        const drawGrip = (gx, gy) => {
          ctx.fillRect(gx - grip / 2, gy - grip / 2, grip, grip);
          ctx.strokeRect(gx - grip / 2, gy - grip / 2, grip, grip);
        };
        drawGrip(rx, ry);
        drawGrip(rx + rw, ry);
        drawGrip(rx + rw, ry + rh);
        drawGrip(rx, ry + rh);
      } else if (activeTool === 'blur' && redactBox) {
        // Redaction box preview
        const rx = (redactBox.left / curDims.width) * canvas.width;
        const ry = (redactBox.top / curDims.height) * canvas.height;
        const rw = (redactBox.width / curDims.width) * canvas.width;
        const rh = (redactBox.height / curDims.height) * canvas.height;

        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
      }
    };

    const updateToolVisibility = () => {
      subRect.style.display = activeTool === 'rect' ? 'flex' : 'none';
      subBlur.style.display = activeTool === 'blur' ? 'flex' : 'none';
      subFilters.style.display = (activeTool === 'filter' || activeTool === 'enhance') ? 'flex' : 'none';
      dialog.querySelectorAll('.editor-tab-btn').forEach(btn => {
        const t = btn.dataset.tool;
        btn.classList.toggle('is-active', t === activeTool || (activeTool === 'enhance' && t === 'enhance'));
      });
      dialog.querySelectorAll('.crop-filter-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.filter === activeFilter);
      });
      draw();
    };

    // Pointer events on canvas for 4-corner, rect, and redact box dragging
    const getPointerPos = event => {
      const rect = canvas.getBoundingClientRect();
      const rw = Math.max(1, rect.width || canvas.width || 1);
      const rh = Math.max(1, rect.height || canvas.height || 1);
      const cx = (event.clientX - rect.left) * (canvas.width / rw);
      const cy = (event.clientY - rect.top) * (canvas.height / rh);
      return { cx, cy, imgPt: toImagePoint(cx, cy) };
    };

    canvas.onpointerdown = event => {
      if (applying) return;
      event.preventDefault();
      const { cx, cy, imgPt } = getPointerPos(event);
      canvas.setPointerCapture(event.pointerId);

      if (activeTool === 'perspective' || activeTool === 'auto') {
        // Check corner handles (touch-friendly radius 34px minimum)
        const hitRadius = Math.max(34, Math.round(canvas.width * 0.08));
        const pts = [
          toCanvasPoint(corners.p0),
          toCanvasPoint(corners.p1),
          toCanvasPoint(corners.p2),
          toCanvasPoint(corners.p3)
        ];
        const idx = pts.findIndex(p => Math.hypot(p.x - cx, p.y - cy) <= hitRadius);
        if (idx !== -1) {
          pushState();
          isDraggingHandle = idx;
        }
      } else if (activeTool === 'rect') {
        pushState();
        dragAnchor = imgPt;
      } else if (activeTool === 'blur') {
        pushState();
        dragAnchor = imgPt;
      }
    };

    canvas.onpointermove = event => {
      if (applying) return;
      const { imgPt } = getPointerPos(event);

      if (isDraggingHandle !== -1) {
        // Validate that candidate corner retains convex quadrilateral
        const nextCorners = {
          p0: isDraggingHandle === 0 ? imgPt : corners.p0,
          p1: isDraggingHandle === 1 ? imgPt : corners.p1,
          p2: isDraggingHandle === 2 ? imgPt : corners.p2,
          p3: isDraggingHandle === 3 ? imgPt : corners.p3
        };

        if (isConvexQuad(nextCorners.p0, nextCorners.p1, nextCorners.p2, nextCorners.p3)) {
          corners = nextCorners;
          errorMsg.textContent = '';
          applyBtn.disabled = false;
        } else {
          errorMsg.textContent = 'Keep quadrilateral convex and corners properly ordered.';
          errorMsg.style.color = '#dc2626';
        }
        draw();
      } else if (dragAnchor && activeTool === 'rect') {
        let nextBox = cropBounds(dragAnchor, imgPt, curDims.width, curDims.height);
        if (activeRatio) {
          nextBox = applyAspectRatio(nextBox, activeRatio, curDims.width, curDims.height);
        }
        rectBox = nextBox;
        draw();
      } else if (dragAnchor && activeTool === 'blur') {
        redactBox = cropBounds(dragAnchor, imgPt, curDims.width, curDims.height);
        draw();
      }
    };

    canvas.onpointerup = canvas.onpointercancel = () => {
      isDraggingHandle = -1;
      dragAnchor = null;
      if (activeTool === 'perspective' || activeTool === 'auto') {
        if (!isConvexQuad(corners.p0, corners.p1, corners.p2, corners.p3)) {
          corners = orderCorners(corners);
          errorMsg.textContent = '';
          applyBtn.disabled = false;
          draw();
        }
      }
    };

    // Tool tab buttons
    dialog.querySelectorAll('.editor-tab-btn').forEach(btn => {
      btn.onclick = () => {
        if (applying) return;
        setProcessing(false);
        const tool = btn.dataset.tool;
        if (tool === 'rotate') {
          pushState();
          rotation = (rotation + 90) % 360;
          currentSourceCanvas = getRotatedSourceCanvas();
          updateDisplayScale();
          corners = {
            p0: { x: 0, y: 0 },
            p1: { x: curDims.width, y: 0 },
            p2: { x: curDims.width, y: curDims.height },
            p3: { x: 0, y: curDims.height }
          };
          rectBox = { left: 0, top: 0, width: curDims.width, height: curDims.height };
          draw();
          return;
        }
        if (tool === 'auto') {
          pushState();
          const autoCorners = detectCornersOnCanvas();
          if (autoCorners && isConvexQuad(autoCorners.p0, autoCorners.p1, autoCorners.p2, autoCorners.p3)) {
            corners = orderCorners(autoCorners);
            errorMsg.textContent = 'Auto crop detected document edges.';
            errorMsg.style.color = '#15803d';
          } else {
            errorMsg.textContent = 'Could not reliably detect document edges. Manual selection active.';
            errorMsg.style.color = '#475569';
          }
          activeTool = 'perspective';
          updateToolVisibility();
          return;
        }
        if (tool === 'perspective') {
          pushState();
          corners = orderCorners(corners);
          activeTool = 'perspective';
          errorMsg.textContent = '';
          updateToolVisibility();
          return;
        }
        if (tool === 'enhance') {
          pushState();
          activeFilter = 'enhance';
          activeTool = 'enhance';
          updateToolVisibility();
          return;
        }
        activeTool = tool;
        updateToolVisibility();
      };
    });

    // Rect ratio buttons
    dialog.querySelectorAll('.crop-ratio-btn').forEach(btn => {
      btn.onclick = () => {
        dialog.querySelectorAll('.crop-ratio-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const r = btn.dataset.ratio;
        activeRatio = r === 'free' ? null : Number(r);
        if (activeRatio) {
          pushState();
          rectBox = applyAspectRatio(rectBox, activeRatio, curDims.width, curDims.height);
          draw();
        }
      };
    });

    // Blur slider & buttons
    blurSlider.oninput = () => {
      blurStrength = Number(blurSlider.value);
      blurLabel.textContent = `${blurStrength} px`;
      draw();
    };

    dialog.querySelector('#btn-blur-full').onclick = () => {
      pushState();
      redactBox = null;
      draw();
    };

    dialog.querySelector('#btn-blur-clear').onclick = () => {
      pushState();
      redactBox = null;
      activeTool = 'perspective';
      updateToolVisibility();
    };

    // Filter buttons
    dialog.querySelectorAll('.crop-filter-btn').forEach(btn => {
      btn.onclick = () => {
        pushState();
        dialog.querySelectorAll('.crop-filter-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        activeFilter = btn.dataset.filter;
        draw();
      };
    });

    // Undo / Redo
    undoBtn.onclick = () => {
      if (!historyStack.length) return;
      const currentSnapshot = {
        corners: { p0: { ...corners.p0 }, p1: { ...corners.p1 }, p2: { ...corners.p2 }, p3: { ...corners.p3 } },
        rectBox: { ...rectBox },
        rotation,
        activeFilter,
        activeTool,
        blurStrength,
        redactBox: redactBox ? { ...redactBox } : null
      };
      redoStack.push(currentSnapshot);
      const prev = historyStack.pop();
      corners = prev.corners;
      rectBox = prev.rectBox;
      if (rotation !== prev.rotation) {
        rotation = prev.rotation;
        currentSourceCanvas = getRotatedSourceCanvas();
        updateDisplayScale();
      }
      activeFilter = prev.activeFilter;
      activeTool = prev.activeTool;
      blurStrength = prev.blurStrength;
      redactBox = prev.redactBox;
      updateHistoryButtons();
      updateToolVisibility();
    };

    redoBtn.onclick = () => {
      if (!redoStack.length) return;
      const next = redoStack.pop();
      historyStack.push({
        corners: { p0: { ...corners.p0 }, p1: { ...corners.p1 }, p2: { ...corners.p2 }, p3: { ...corners.p3 } },
        rectBox: { ...rectBox },
        rotation,
        activeFilter,
        activeTool,
        blurStrength,
        redactBox: redactBox ? { ...redactBox } : null
      });
      corners = next.corners;
      rectBox = next.rectBox;
      if (rotation !== next.rotation) {
        rotation = next.rotation;
        currentSourceCanvas = getRotatedSourceCanvas();
        updateDisplayScale();
      }
      activeFilter = next.activeFilter;
      activeTool = next.activeTool;
      blurStrength = next.blurStrength;
      redactBox = next.redactBox;
      updateHistoryButtons();
      updateToolVisibility();
    };

    // Reset button
    dialog.querySelector('#btn-editor-reset').onclick = () => {
      pushState();
      rotation = 0;
      currentSourceCanvas = getRotatedSourceCanvas();
      updateDisplayScale();
      corners = {
        p0: { x: 0, y: 0 },
        p1: { x: curDims.width, y: 0 },
        p2: { x: curDims.width, y: curDims.height },
        p3: { x: 0, y: curDims.height }
      };
      rectBox = { left: 0, top: 0, width: curDims.width, height: curDims.height };
      activeFilter = 'original';
      activeTool = 'perspective';
      redactBox = null;
      updateToolVisibility();
    };

    const closeDialog = result => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    // "Print Original" button
    dialog.querySelector('#btn-dialog-print-original').onclick = () => {
      if (onPrintOriginal) onPrintOriginal();
      closeDialog({ action: 'original', file });
    };

    dialog.querySelector('#btn-dialog-close').onclick = () => {
      if (onCancel) onCancel();
      closeDialog(null);
    };

    dialog.querySelector('#btn-editor-cancel').onclick = () => {
      if (onCancel) onCancel();
      closeDialog(null);
    };

    dialog.oncancel = event => {
      event.preventDefault();
      if (!applying) closeDialog(null);
    };

    // Apply & Continue button
    applyBtn.onclick = async () => {
      if (applying) return;
      errorMsg.textContent = '';
      setProcessing(true, 'Processing document...');
      // Allow browser to render the loading indicator before heavy canvas operations
      await new Promise(r => setTimeout(r, 25));

      try {
        let finalCanvas;

        if (activeTool === 'rect') {
          // Rectangular crop from rotated canvas
          const safeW = Math.max(10, Math.round(rectBox.width || 10));
          const safeH = Math.max(10, Math.round(rectBox.height || 10));
          const safeLeft = Math.max(0, Math.min(curDims.width - safeW, Math.round(rectBox.left || 0)));
          const safeTop = Math.max(0, Math.min(curDims.height - safeH, Math.round(rectBox.top || 0)));

          finalCanvas = document.createElement('canvas');
          finalCanvas.width = safeW;
          finalCanvas.height = safeH;
          const fCtx = finalCanvas.getContext('2d');
          fCtx.drawImage(
            currentSourceCanvas,
            safeLeft, safeTop, safeW, safeH,
            0, 0, safeW, safeH
          );
        } else {
          // Perspective crop using projective homography
          const ordered = orderCorners(corners);
          const isFullQuad = ordered.p0.x <= 2 && ordered.p0.y <= 2 &&
            Math.abs(ordered.p1.x - curDims.width) <= 2 && ordered.p1.y <= 2 &&
            Math.abs(ordered.p2.x - curDims.width) <= 2 && Math.abs(ordered.p2.y - curDims.height) <= 2 &&
            ordered.p3.x <= 2 && Math.abs(ordered.p3.y - curDims.height) <= 2;

          if (isFullQuad) {
            finalCanvas = document.createElement('canvas');
            finalCanvas.width = curDims.width;
            finalCanvas.height = curDims.height;
            finalCanvas.getContext('2d').drawImage(currentSourceCanvas, 0, 0);
          } else {
            const quadDims = getQuadDimensions(ordered.p0, ordered.p1, ordered.p2, ordered.p3);
            const isNearRect = Math.abs(ordered.p0.y - ordered.p1.y) <= 4 &&
              Math.abs(ordered.p3.y - ordered.p2.y) <= 4 &&
              Math.abs(ordered.p0.x - ordered.p3.x) <= 4 &&
              Math.abs(ordered.p1.x - ordered.p2.x) <= 4;

            if (isNearRect) {
              const sx = Math.max(0, Math.min(ordered.p0.x, ordered.p3.x));
              const sy = Math.max(0, Math.min(ordered.p0.y, ordered.p1.y));
              const sw = Math.max(10, Math.min(currentSourceCanvas.width - sx, Math.max(ordered.p1.x, ordered.p2.x) - sx));
              const sh = Math.max(10, Math.min(currentSourceCanvas.height - sy, Math.max(ordered.p3.y, ordered.p2.y) - sy));
              finalCanvas = document.createElement('canvas');
              finalCanvas.width = quadDims.width;
              finalCanvas.height = quadDims.height;
              finalCanvas.getContext('2d').drawImage(currentSourceCanvas, sx, sy, sw, sh, 0, 0, quadDims.width, quadDims.height);
            } else {
              finalCanvas = warpPerspectiveCanvas(currentSourceCanvas, ordered, quadDims.width, quadDims.height);
            }
          }
        }

        // Apply filters to full-resolution pixels
        if (activeFilter !== 'original') {
          const fullCtx = finalCanvas.getContext('2d');
          const fullData = fullCtx.getImageData(0, 0, finalCanvas.width, finalCanvas.height);
          applyFilterToImageData(fullData, activeFilter);
          fullCtx.putImageData(fullData, 0, 0);
        }

        // Apply blur / redaction to full-resolution pixels if specified
        if (redactBox || activeTool === 'blur') {
          const fullCtx = finalCanvas.getContext('2d');
          const fullData = fullCtx.getImageData(0, 0, finalCanvas.width, finalCanvas.height);
          applyBlurToImageData(fullData, blurStrength, redactBox);
          fullCtx.putImageData(fullData, 0, 0);
        }

        const mime = 'image/jpeg';
        const blob = await new Promise((res, rej) => {
          const timer = setTimeout(() => {
            rej(new Error('Image encoding timed out. Please try again.'));
          }, 8000);
          try {
            finalCanvas.toBlob(b => {
              clearTimeout(timer);
              if (b) res(b);
              else rej(new Error('Failed to encode cropped image.'));
            }, mime, 0.90);
          } catch (encodeErr) {
            clearTimeout(timer);
            rej(encodeErr);
          }
        });

        finalCanvas.width = finalCanvas.height = 1;

        if (!blob || blob.size > 25 * 1048576) {
          throw new Error('Processed document image is too large. Please use a smaller selection.');
        }

        const ext = '.jpg';
        const suffix = activeFilter !== 'original' ? `-${activeFilter}` : '-scanned';
        const cleanName = file.name.replace(/\.[^.]+$/, '') + `${suffix}${ext}`;
        const processedFile = new File([blob], cleanName, { type: mime });

        if (onApply) onApply(processedFile);
        closeDialog({ action: 'edited', file: processedFile });
      } catch (err) {
        console.error('[DocumentEditor] Error applying edits:', err);
        errorMsg.textContent = err.message || 'An error occurred while processing the document.';
      } finally {
        setProcessing(false);
      }
    };

    updateToolVisibility();
    dialog.showModal();
  });
}

// Backwards-compatible async wrapper
export async function cropImage(file, options = {}) {
  const result = await openDocumentEditor({ file, ...options });
  return result?.file || null;
}
