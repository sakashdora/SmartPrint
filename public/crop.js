export function cropBounds(start, end, width, height) {
  const clamp = (n, max) => Math.max(0, Math.min(max, Math.round(n)));
  const left = clamp(Math.min(start.x, end.x), width - 1);
  const top = clamp(Math.min(start.y, end.y), height - 1);
  return { left, top, width: Math.max(1, clamp(Math.max(start.x, end.x), width) - left), height: Math.max(1, clamp(Math.max(start.y, end.y), height) - top) };
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

export function detectDocumentEdges(imageData, width, height) {
  if (!imageData || !width || !height) return null;
  const data = imageData.data;
  const sample = (x, y) => {
    const idx = (y * width + x) * 4;
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  };
  const cornerAvg = (sample(0, 0) + sample(width - 1, 0) + sample(0, height - 1) + sample(width - 1, height - 1)) / 4;
  const thresh = Math.max(22, Math.abs(cornerAvg - 128) * 0.75);

  let minX = width, maxX = 0, minY = height, maxY = 0;
  const stepX = Math.max(1, Math.floor(width / 120));
  const stepY = Math.max(1, Math.floor(height / 120));

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const lum = sample(x, y);
      if (Math.abs(lum - cornerAvg) > thresh) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const detectedW = maxX - minX;
  const detectedH = maxY - minY;
  if (detectedW > width * 0.2 && detectedH > height * 0.2 && (detectedW * detectedH) < (width * height * 0.99)) {
    const padX = Math.round(width * 0.02);
    const padY = Math.round(height * 0.02);
    const left = Math.max(0, minX - padX);
    const top = Math.max(0, minY - padY);
    const right = Math.min(width, maxX + padX);
    const bottom = Math.min(height, maxY + padY);
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }
  return null;
}

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
    // Clean B&W Document - Adaptive thresholding for crisp text and white paper
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
  }
}

// Crop the original pixels at full resolution with rotation, aspect ratio & document scanner enhancement
export async function cropImage(file) {
  const url = URL.createObjectURL(file), rawImage = new Image();
  try {
    rawImage.src = url;
    await rawImage.decode();
  } finally {
    URL.revokeObjectURL(url);
  }

  const origWidth = rawImage.naturalWidth, origHeight = rawImage.naturalHeight;
  if (origWidth * origHeight > 40000000) {
    throw new Error('This image is too large. Use an image below 40 megapixels.');
  }

  return new Promise(resolve => {
    let rotation = 0; // 0, 90, 180, 270
    let activeFilter = 'original'; // original, bw, grayscale, contrast
    let activeRatio = null; // null (free), 1.414 (A4 port), 0.707 (A4 land), 1.586 (ID Card), 1 (Square)
    let applying = false;
    let anchor = null;

    const dialog = document.createElement('dialog');
    dialog.className = 'crop-dialog';
    dialog.setAttribute('aria-labelledby', 'crop-title');

    dialog.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h2 id="crop-title" style="margin:0;font-size:18px;font-weight:700;">Document Scanner & Crop</h2>
        <span style="font-size:12px;color:#64748b;font-weight:600;" id="crop-res-label">${origWidth} × ${origHeight} px</span>
      </div>
      <p style="margin:0 0 12px 0;font-size:13px;color:#64748b;">
        Drag to crop, rotate, or apply clean document filters before printing. Original resolution is preserved.
      </p>

      <!-- Toolbar: Aspect Ratio, Rotation, Smart Detect & Filter -->
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:12px;">
        <div style="display:flex;gap:4px;align-items:center;">
          <span style="font-size:12px;font-weight:600;color:#475569;margin-right:4px;">Ratio:</span>
          <button type="button" class="secondary small crop-ratio-btn is-active" data-ratio="free" style="padding:4px 8px;font-size:11px;">Free</button>
          <button type="button" class="secondary small crop-ratio-btn" data-ratio="0.707" style="padding:4px 8px;font-size:11px;">A4 Portrait</button>
          <button type="button" class="secondary small crop-ratio-btn" data-ratio="1.414" style="padding:4px 8px;font-size:11px;">A4 Land</button>
          <button type="button" class="secondary small crop-ratio-btn" data-ratio="1.586" style="padding:4px 8px;font-size:11px;">ID Card</button>
        </div>

        <div style="width:1px;height:20px;background:#cbd5e1;margin:0 4px;"></div>

        <div style="display:flex;gap:4px;align-items:center;">
          <button type="button" class="secondary small" id="crop-rotate-btn" style="padding:4px 9px;font-size:11px;">
            ↻ Rotate 90°
          </button>
          <button type="button" class="secondary small" id="crop-smart-btn" style="padding:4px 9px;font-size:11px;color:#2563eb;font-weight:600;">
            ✨ Smart Detect
          </button>
        </div>

        <div style="width:1px;height:20px;background:#cbd5e1;margin:0 4px;"></div>

        <div style="display:flex;gap:4px;align-items:center;">
          <span style="font-size:12px;font-weight:600;color:#475569;margin-right:4px;">Filter:</span>
          <button type="button" class="secondary small crop-filter-btn is-active" data-filter="original" style="padding:4px 8px;font-size:11px;">Original</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="bw" style="padding:4px 8px;font-size:11px;">Clean B&W</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="grayscale" style="padding:4px 8px;font-size:11px;">Grayscale</button>
          <button type="button" class="secondary small crop-filter-btn" data-filter="contrast" style="padding:4px 8px;font-size:11px;">High Contrast</button>
        </div>
      </div>

      <canvas class="crop-canvas" aria-label="Drag to select the area to keep"></canvas>

      <div class="fields crop-fields" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
        ${['Left', 'Top', 'Width', 'Height'].map(name => `
          <label class="field" style="margin:0;font-size:12px;">
            ${name} (px)
            <input name="${name.toLowerCase()}" type="number" min="${name === 'Left' || name === 'Top' ? 0 : 1}" step="1" required style="font-size:12px;padding:6px;">
          </label>
        `).join('')}
      </div>

      <p class="inline-error" role="alert" style="margin:6px 0 0 0;font-size:12px;color:#dc2626;"></p>

      <div class="actions" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
        <button type="button" class="secondary" data-reset>Reset selection</button>
        <button type="button" class="secondary" data-cancel>Cancel</button>
        <button type="button" class="primary" data-apply>Apply & Use Document</button>
      </div>
    `;

    document.body.append(dialog);

    const canvas = dialog.querySelector('canvas'), ctx = canvas.getContext('2d');
    const fields = Object.fromEntries([...dialog.querySelectorAll('input')].map(input => [input.name, input]));
    const error = dialog.querySelector('[role=alert]'), apply = dialog.querySelector('[data-apply]');
    const resLabel = dialog.querySelector('#crop-res-label');

    // Helper to get current transformed dimensions (taking rotation into account)
    const getTransformedDimensions = () => {
      const isSwapped = rotation === 90 || rotation === 270;
      return {
        width: isSwapped ? origHeight : origWidth,
        height: isSwapped ? origWidth : origHeight
      };
    };

    let curDims = getTransformedDimensions();
    let box = { left: 0, top: 0, width: curDims.width, height: curDims.height };

    // Offscreen canvas for rotated source
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

    const updateDisplayScale = () => {
      curDims = getTransformedDimensions();
      const scale = Math.min(1, 1100 / curDims.width, 700 / curDims.height);
      canvas.width = Math.max(1, Math.round(curDims.width * scale));
      canvas.height = Math.max(1, Math.round(curDims.height * scale));
      if (resLabel) resLabel.textContent = `${curDims.width} × ${curDims.height} px`;
    };

    updateDisplayScale();

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Draw base rotated image
      ctx.drawImage(currentSourceCanvas, 0, 0, canvas.width, canvas.height);

      // Apply preview filter on the display canvas
      if (activeFilter !== 'original') {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        applyFilterToImageData(imgData, activeFilter);
        ctx.putImageData(imgData, 0, 0);
      }

      // Draw dark overlay outside selection
      const x = (box.left / curDims.width) * canvas.width;
      const y = (box.top / curDims.height) * canvas.height;
      const w = (box.width / curDims.width) * canvas.width;
      const h = (box.height / curDims.height) * canvas.height;

      ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
      ctx.fillRect(0, 0, canvas.width, y);
      ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, canvas.width - x - w, h);

      // Draw boundary rectangle
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, w, h);

      // Draw corner grips
      const gripSize = 8;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#1d4ed8';
      ctx.lineWidth = 2;
      const drawGrip = (gx, gy) => {
        ctx.fillRect(gx - gripSize / 2, gy - gripSize / 2, gripSize, gripSize);
        ctx.strokeRect(gx - gripSize / 2, gy - gripSize / 2, gripSize, gripSize);
      };
      drawGrip(x, y);
      drawGrip(x + w, y);
      drawGrip(x, y + h);
      drawGrip(x + w, y + h);
    };

    const sync = () => {
      for (const key of Object.keys(fields)) fields[key].value = box[key];
      error.textContent = '';
      apply.disabled = false;
      draw();
    };

    const point = event => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * curDims.width,
        y: ((event.clientY - rect.top) / rect.height) * curDims.height
      };
    };

    canvas.onpointerdown = event => {
      if (applying) return;
      event.preventDefault();
      anchor = point(event);
      canvas.setPointerCapture(event.pointerId);
    };

    canvas.onpointermove = event => {
      if (!anchor || applying) return;
      let newBox = cropBounds(anchor, point(event), curDims.width, curDims.height);
      if (activeRatio) {
        newBox = applyAspectRatio(newBox, activeRatio, curDims.width, curDims.height);
      }
      box = newBox;
      sync();
    };

    canvas.onpointerup = canvas.onpointercancel = () => {
      anchor = null;
    };

    for (const input of Object.values(fields)) {
      input.oninput = () => {
        const next = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, Number(field.value)]));
        const valid = Object.values(fields).every(field => field.value !== '') &&
          Object.values(next).every(Number.isInteger) &&
          next.left >= 0 && next.top >= 0 && next.width > 0 && next.height > 0 &&
          next.left + next.width <= curDims.width && next.top + next.height <= curDims.height;
        apply.disabled = !valid;
        error.textContent = valid ? '' : `Keep the selection inside the ${curDims.width} × ${curDims.height} image.`;
        if (valid) {
          box = next;
          draw();
        }
      };
    }

    // Ratio buttons
    dialog.querySelectorAll('.crop-ratio-btn').forEach(btn => {
      btn.onclick = () => {
        dialog.querySelectorAll('.crop-ratio-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const r = btn.dataset.ratio;
        activeRatio = r === 'free' ? null : Number(r);
        if (activeRatio) {
          box = applyAspectRatio(box, activeRatio, curDims.width, curDims.height);
          sync();
        }
      };
    });

    // Rotation button
    const rotateBtn = dialog.querySelector('#crop-rotate-btn');
    if (rotateBtn) {
      rotateBtn.onclick = () => {
        rotation = (rotation + 90) % 360;
        currentSourceCanvas = getRotatedSourceCanvas();
        updateDisplayScale();
        box = { left: 0, top: 0, width: curDims.width, height: curDims.height };
        if (activeRatio) {
          box = applyAspectRatio(box, activeRatio, curDims.width, curDims.height);
        }
        sync();
      };
    }

    // Smart detect button
    const smartBtn = dialog.querySelector('#crop-smart-btn');
    if (smartBtn) {
      smartBtn.onclick = () => {
        try {
          const sampleCanvas = document.createElement('canvas');
          const sampleW = Math.min(600, curDims.width);
          const sampleH = Math.round((sampleW / curDims.width) * curDims.height);
          sampleCanvas.width = sampleW;
          sampleCanvas.height = sampleH;
          const sCtx = sampleCanvas.getContext('2d');
          sCtx.drawImage(currentSourceCanvas, 0, 0, sampleW, sampleH);
          const imgData = sCtx.getImageData(0, 0, sampleW, sampleH);
          const detected = detectDocumentEdges(imgData, sampleW, sampleH);
          if (detected) {
            const scaleX = curDims.width / sampleW;
            const scaleY = curDims.height / sampleH;
            let smartBox = {
              left: Math.round(detected.left * scaleX),
              top: Math.round(detected.top * scaleY),
              width: Math.round(detected.width * scaleX),
              height: Math.round(detected.height * scaleY)
            };
            if (activeRatio) {
              smartBox = applyAspectRatio(smartBox, activeRatio, curDims.width, curDims.height);
            }
            box = smartBox;
            sync();
          } else {
            error.textContent = 'Could not reliably detect document edges. Manual selection is active.';
          }
        } catch (err) {
          error.textContent = 'Smart edge detection unavailable: ' + err.message;
        }
      };
    }

    // Filter buttons
    dialog.querySelectorAll('.crop-filter-btn').forEach(btn => {
      btn.onclick = () => {
        dialog.querySelectorAll('.crop-filter-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        activeFilter = btn.dataset.filter;
        draw();
      };
    });

    const close = result => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    dialog.oncancel = event => {
      event.preventDefault();
      if (!applying) close(null);
    };

    dialog.querySelector('[data-cancel]').onclick = () => close(null);
    dialog.querySelector('[data-reset]').onclick = () => {
      box = { left: 0, top: 0, width: curDims.width, height: curDims.height };
      if (activeRatio) {
        box = applyAspectRatio(box, activeRatio, curDims.width, curDims.height);
      }
      sync();
    };

    apply.onclick = async () => {
      applying = true;
      dialog.querySelectorAll('button,input').forEach(control => control.disabled = true);
      try {
        // Output at FULL original resolution of the crop region!
        const output = document.createElement('canvas');
        output.width = box.width;
        output.height = box.height;
        const outCtx = output.getContext('2d');

        // Draw from the full-resolution rotated canvas
        outCtx.drawImage(
          currentSourceCanvas,
          box.left, box.top, box.width, box.height,
          0, 0, box.width, box.height
        );

        // Apply chosen filter to full-resolution pixels
        if (activeFilter !== 'original') {
          const fullImgData = outCtx.getImageData(0, 0, box.width, box.height);
          applyFilterToImageData(fullImgData, activeFilter);
          outCtx.putImageData(fullImgData, 0, 0);
        }

        const blob = await new Promise(res => output.toBlob(res, 'image/png'));
        output.width = output.height = 1;
        if (!blob || blob.size > 25 * 1048576) {
          throw new Error('Processed image is too large. Choose a smaller image or selection.');
        }

        const suffix = activeFilter !== 'original' ? `-${activeFilter}` : '-cropped';
        const cleanName = file.name.replace(/\.[^.]+$/, '') + `${suffix}.png`;
        close(new File([blob], cleanName, { type: 'image/png' }));
      } catch (err) {
        error.textContent = err.message;
        applying = false;
        dialog.querySelectorAll('button,input').forEach(control => control.disabled = false);
      }
    };

    sync();
    dialog.showModal();
  });
}
