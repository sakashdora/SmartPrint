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

// Calculates optimal destination dimensions preserving document aspect ratio
export function getQuadDimensions(p0, p1, p2, p3) {
  const topW = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const botW = Math.hypot(p2.x - p3.x, p2.y - p3.y);
  const leftH = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const rightH = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const width = Math.max(10, Math.round(Math.max(topW, botW)));
  const height = Math.max(10, Math.round(Math.max(leftH, rightH)));
  return { width, height };
}

// Paul Heckbert closed-form projective mapping from rectangle [0, W] x [0, H] to quad [p0, p1, p2, p3]
export function solveHomography(p0, p1, p2, p3, W, H) {
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

  const a = (p1.x - p0.x + g * p1.x) / W;
  const b = (p3.x - p0.x + h * p3.x) / H;
  const c = p0.x;
  const d = (p1.y - p0.y + g * p1.y) / W;
  const e = (p3.y - p0.y + h * p3.y) / H;
  const f = p0.y;
  const g_step = g / W;
  const h_step = h / H;

  return { a, b, c, d, e, f, g_step, h_step };
}

// Applies high-quality bilinear interpolation perspective warp from sourceCanvas to output
export function warpPerspectiveCanvas(sourceCanvas, corners, outW, outH) {
  const output = document.createElement('canvas');
  output.width = outW;
  output.height = outH;
  const outCtx = output.getContext('2d');
  const srcCtx = sourceCanvas.getContext('2d');

  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
  const dstData = outCtx.createImageData(outW, outH);

  const sData = srcData.data;
  const dData = dstData.data;

  const { p0, p1, p2, p3 } = corners;
  const { a, b, c, d, e, f, g_step, h_step } = solveHomography(p0, p1, p2, p3, outW, outH);

  for (let v = 0; v < outH; v++) {
    let numX = b * v + c;
    let numY = e * v + f;
    let denom = h_step * v + 1;
    const rowOffset = v * outW * 4;

    for (let u = 0; u < outW; u++) {
      const invD = 1 / denom;
      const sxCoord = numX * invD;
      const syCoord = numY * invD;

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
        dData[outIdx] = w00 * sData[idx00] + w10 * sData[idx10] + w01 * sData[idx01] + w11 * sData[idx11];
        dData[outIdx + 1] = w00 * sData[idx00 + 1] + w10 * sData[idx10 + 1] + w01 * sData[idx01 + 1] + w11 * sData[idx11 + 1];
        dData[outIdx + 2] = w00 * sData[idx00 + 2] + w10 * sData[idx10 + 2] + w01 * sData[idx01 + 2] + w11 * sData[idx11 + 2];
        dData[outIdx + 3] = 255;
      }

      numX += a;
      numY += d;
      denom += g_step;
    }
  }

  outCtx.putImageData(dstData, 0, 0);
  return output;
}

// Automatic document corner and edge detector
export function detectDocumentCorners(imageData, width, height) {
  if (!imageData || !width || !height) return null;
  const data = imageData.data;

  const getLum = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };

  const bgAvg = (getLum(0, 0) + getLum(width - 1, 0) + getLum(0, height - 1) + getLum(width - 1, height - 1)) / 4;
  const thresh = Math.max(20, Math.abs(bgAvg - 128) * 0.7);

  let p0 = { x: width, y: height, val: Infinity };      // min (x + y)
  let p1 = { x: 0, y: height, val: -Infinity };          // max (x - y)
  let p2 = { x: 0, y: 0, val: -Infinity };               // max (x + y)
  let p3 = { x: width, y: 0, val: Infinity };           // min (x - y)
  let docPixelCount = 0;

  const step = Math.max(1, Math.floor(Math.min(width, height) / 100));

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const lum = getLum(x, y);
      if (Math.abs(lum - bgAvg) > thresh) {
        docPixelCount++;
        const sum = x + y;
        const diff = x - y;
        if (sum < p0.val) { p0.val = sum; p0.x = x; p0.y = y; }
        if (diff > p1.val) { p1.val = diff; p1.x = x; p1.y = y; }
        if (sum > p2.val) { p2.val = sum; p2.x = x; p2.y = y; }
        if (diff < p3.val) { p3.val = diff; p3.x = x; p3.y = y; }
      }
    }
  }

  const totalSamples = Math.ceil(height / step) * Math.ceil(width / step);
  const docRatio = docPixelCount / totalSamples;

  const quad = {
    p0: { x: p0.x, y: p0.y },
    p1: { x: p1.x, y: p1.y },
    p2: { x: p2.x, y: p2.y },
    p3: { x: p3.x, y: p3.y }
  };

  if (docRatio > 0.1 && docRatio < 0.98 && isConvexQuad(quad.p0, quad.p1, quad.p2, quad.p3)) {
    return { ...quad, confidence: 'high' };
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
    // Document text clarity & contrast boost (unsharp mask + dynamic range expansion)
    for (let i = 0; i < len; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      let adjLum = lum > 140 ? lum + (255 - lum) * 0.4 : lum * 0.75;
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
    let rotation = 0; // 0, 90, 180, 270
    let activeFilter = 'original'; // original, enhance, bw, grayscale, contrast
    let activeRatio = null; // null (free), 0.707 (A4 port), 1.414 (A4 land), 1.586 (ID Card)
    let activeTool = initialMode === 'blur' ? 'blur' : initialMode === 'rect' ? 'rect' : 'perspective';
    let blurStrength = 10;
    let redactBox = null;
    let isDraggingHandle = -1;
    let dragAnchor = null;
    let applying = false;

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
        <div id="subtoolbar-filters" style="display:none;align-items:center;gap:6px;font-size:12px;background:#f1f5f9;padding:6px 10px;border-radius:8px;">
          <span style="font-weight:600;color:#475569;">Document Filter:</span>
          <button type="button" class="secondary small crop-filter-btn is-active" data-filter="original">Original</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="enhance">✨ Enhanced</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="bw">Clean B&W</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="grayscale">Grayscale</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="contrast">High Contrast</button>
        </div>
      </div>

      <!-- Canvas container with responsive viewport -->
      <div class="editor-canvas-wrapper" style="position:relative;background:#0f172a;border-radius:10px;overflow:hidden;display:flex;justify-content:center;align-items:center;padding:8px;min-height:280px;max-height:55dvh;">
        <canvas class="crop-canvas" id="editor-interactive-canvas" aria-label="Interactive document scanner canvas"></canvas>
        <div id="canvas-loading-spinner" style="display:none;position:absolute;inset:0;background:rgba(15,23,42,0.7);color:white;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;font-size:13px;font-weight:600;">
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

    const updateHistoryButtons = () => {
      undoBtn.disabled = historyStack.length === 0 || applying;
      redoBtn.disabled = redoStack.length === 0 || applying;
    };

    // Calculate display canvas scale
    const updateDisplayScale = () => {
      curDims = getTransformedDimensions();
      const maxDisplayW = Math.min(1000, window.innerWidth - 60);
      const maxDisplayH = Math.min(650, window.innerHeight * 0.52);
      const scale = Math.min(1, maxDisplayW / curDims.width, maxDisplayH / curDims.height);
      canvas.width = Math.max(1, Math.round(curDims.width * scale));
      canvas.height = Math.max(1, Math.round(curDims.height * scale));
    };

    updateDisplayScale();

    // Map coordinates between display canvas and full-res image space
    const toCanvasPoint = pt => ({
      x: (pt.x / curDims.width) * canvas.width,
      y: (pt.y / curDims.height) * canvas.height
    });

    const toImagePoint = (cx, cy) => ({
      x: Math.max(0, Math.min(curDims.width, (cx / canvas.width) * curDims.width)),
      y: Math.max(0, Math.min(curDims.height, (cy / canvas.height) * curDims.height))
    });

    // Draw main interactive canvas
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw base rotated image
      ctx.drawImage(currentSourceCanvas, 0, 0, canvas.width, canvas.height);

      // Apply filter on display preview
      if (activeFilter !== 'original') {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        applyFilterToImageData(imgData, activeFilter);
        ctx.putImageData(imgData, 0, 0);
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

        // 4 corner draggable handles
        const drawHandle = (pt, label) => {
          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
          ctx.fillStyle = '#2563eb';
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
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
        // Redact box outline
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
      subFilters.style.display = activeTool === 'filter' ? 'flex' : 'none';
      dialog.querySelectorAll('.editor-tab-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.tool === activeTool);
      });
      draw();
    };

    // Pointer events on canvas for 4-corner, rect, and redact box dragging
    const getPointerPos = event => {
      const rect = canvas.getBoundingClientRect();
      const cx = (event.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (event.clientY - rect.top) * (canvas.height / rect.height);
      return { cx, cy, imgPt: toImagePoint(cx, cy) };
    };

    canvas.onpointerdown = event => {
      if (applying) return;
      event.preventDefault();
      const { cx, cy, imgPt } = getPointerPos(event);
      canvas.setPointerCapture(event.pointerId);

      if (activeTool === 'perspective' || activeTool === 'auto') {
        // Check corner handles (hit radius 28px)
        const hitRadius = 28;
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
    };

    // Tool tab buttons
    dialog.querySelectorAll('.editor-tab-btn').forEach(btn => {
      btn.onclick = () => {
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
            corners = autoCorners;
            errorMsg.textContent = 'Auto crop detected document edges.';
          } else {
            errorMsg.textContent = 'Could not reliably detect document edges. Manual selection active.';
          }
          activeTool = 'perspective';
          updateToolVisibility();
          return;
        }
        if (tool === 'enhance') {
          pushState();
          activeFilter = activeFilter === 'enhance' ? 'original' : 'enhance';
          activeTool = 'filter';
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
      applying = true;
      spinner.style.display = 'flex';
      dialog.querySelectorAll('button, input').forEach(el => el.disabled = true);

      try {
        let finalCanvas;

        if (activeTool === 'rect') {
          // Rectangular crop from rotated canvas
          finalCanvas = document.createElement('canvas');
          finalCanvas.width = rectBox.width;
          finalCanvas.height = rectBox.height;
          const fCtx = finalCanvas.getContext('2d');
          fCtx.drawImage(
            currentSourceCanvas,
            rectBox.left, rectBox.top, rectBox.width, rectBox.height,
            0, 0, rectBox.width, rectBox.height
          );
        } else {
          // Perspective crop using projective homography
          const isFullQuad = corners.p0.x === 0 && corners.p0.y === 0 &&
            corners.p1.x === curDims.width && corners.p1.y === 0 &&
            corners.p2.x === curDims.width && corners.p2.y === curDims.height &&
            corners.p3.x === 0 && corners.p3.y === curDims.height;

          if (isFullQuad) {
            finalCanvas = document.createElement('canvas');
            finalCanvas.width = curDims.width;
            finalCanvas.height = curDims.height;
            finalCanvas.getContext('2d').drawImage(currentSourceCanvas, 0, 0);
          } else {
            const quadDims = getQuadDimensions(corners.p0, corners.p1, corners.p2, corners.p3);
            finalCanvas = warpPerspectiveCanvas(currentSourceCanvas, corners, quadDims.width, quadDims.height);
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

        const blob = await new Promise(res => finalCanvas.toBlob(res, 'image/png'));
        finalCanvas.width = finalCanvas.height = 1;

        if (!blob || blob.size > 25 * 1048576) {
          throw new Error('Processed document image is too large. Please use a smaller selection.');
        }

        const suffix = activeFilter !== 'original' ? `-${activeFilter}` : '-scanned';
        const cleanName = file.name.replace(/\.[^.]+$/, '') + `${suffix}.png`;
        const processedFile = new File([blob], cleanName, { type: 'image/png' });

        if (onApply) onApply(processedFile);
        closeDialog({ action: 'edited', file: processedFile });
      } catch (err) {
        errorMsg.textContent = err.message;
        applying = false;
        spinner.style.display = 'none';
        dialog.querySelectorAll('button, input').forEach(el => el.disabled = false);
        updateHistoryButtons();
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
