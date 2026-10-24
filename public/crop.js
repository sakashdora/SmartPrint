export function cropBounds(start, end, width, height) {
  const clamp = (n, max) => Math.max(0, Math.min(max, Math.round(n)));
  const left = clamp(Math.min(start.x, end.x), width - 1);
  const top = clamp(Math.min(start.y, end.y), height - 1);
  return { left, top, width: Math.max(1, clamp(Math.max(start.x, end.x), width) - left), height: Math.max(1, clamp(Math.max(start.y, end.y), height) - top) };
}

// Crop the original pixels, not a screenshot of the scaled preview.
export async function cropImage(file) {
  const url = URL.createObjectURL(file), image = new Image();
  try { image.src = url; await image.decode(); } finally { URL.revokeObjectURL(url); }
  const width = image.naturalWidth, height = image.naturalHeight;
  if (width * height > 40000000) throw new Error('This image is too large. Use an image below 40 megapixels.');
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'crop-dialog';
    dialog.setAttribute('aria-labelledby', 'crop-title');
    dialog.innerHTML = `<h2 id="crop-title">Crop your image</h2><p>Drag across the image to select what to keep. You can also enter the crop dimensions below.</p><canvas class="crop-canvas" aria-label="Drag to select the area to keep"></canvas><div class="fields crop-fields">${['Left', 'Top', 'Width', 'Height'].map(name => `<label class="field">${name} (pixels)<input name="${name.toLowerCase()}" type="number" min="${name === 'Left' || name === 'Top' ? 0 : 1}" step="1" required></label>`).join('')}</div><p class="inline-error" role="alert"></p><div class="actions"><button type="button" class="secondary" data-reset>Full image</button><button type="button" class="secondary" data-cancel>Cancel</button><button type="button" class="primary" data-apply>Apply crop</button></div>`;
    document.body.append(dialog);
    const canvas = dialog.querySelector('canvas'), ctx = canvas.getContext('2d');
    const scale = Math.min(1, 1200 / width, 900 / height);
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    let box = { left: 0, top: 0, width, height }, anchor, applying = false;
    const fields = Object.fromEntries([...dialog.querySelectorAll('input')].map(input => [input.name, input]));
    const error = dialog.querySelector('[role=alert]'), apply = dialog.querySelector('[data-apply]');
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const x = box.left / width * canvas.width, y = box.top / height * canvas.height, w = box.width / width * canvas.width, h = box.height / height * canvas.height;
      ctx.fillStyle = '#0008'; ctx.fillRect(0, 0, canvas.width, y); ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h); ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, canvas.width - x - w, h);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
    };
    const sync = () => { for (const key of Object.keys(fields)) fields[key].value = box[key]; error.textContent = ''; apply.disabled = false; draw(); };
    const point = event => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * width, y: (event.clientY - rect.top) / rect.height * height }; };
    canvas.onpointerdown = event => { if (applying) return; event.preventDefault(); anchor = point(event); canvas.setPointerCapture(event.pointerId); };
    canvas.onpointermove = event => { if (!anchor || applying) return; box = cropBounds(anchor, point(event), width, height); sync(); };
    canvas.onpointerup = canvas.onpointercancel = () => { anchor = null; };
    for (const input of Object.values(fields)) input.oninput = () => {
      const next = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, Number(field.value)]));
      const valid = Object.values(fields).every(field => field.value !== '') && Object.values(next).every(Number.isInteger) && next.left >= 0 && next.top >= 0 && next.width > 0 && next.height > 0 && next.left + next.width <= width && next.top + next.height <= height;
      apply.disabled = !valid; error.textContent = valid ? '' : `Keep the selection inside the ${width} × ${height} image.`;
      if (valid) { box = next; draw(); }
    };
    const close = result => { dialog.close(); dialog.remove(); resolve(result); };
    dialog.oncancel = event => { event.preventDefault(); if (!applying) close(null); };
    dialog.querySelector('[data-cancel]').onclick = () => close(null);
    dialog.querySelector('[data-reset]').onclick = () => { box = { left: 0, top: 0, width, height }; sync(); };
    apply.onclick = async () => {
      applying = true; dialog.querySelectorAll('button,input').forEach(control => control.disabled = true);
      try {
        const output = document.createElement('canvas'); output.width = box.width; output.height = box.height;
        output.getContext('2d').drawImage(image, box.left, box.top, box.width, box.height, 0, 0, box.width, box.height);
        const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
        output.width = output.height = 1;
        if (!blob || blob.size > 20 * 1048576) throw new Error('Cropped image is too large. Choose a smaller image or selection.');
        close(new File([blob], file.name.replace(/\.[^.]+$/, '') + '-cropped.png', { type: 'image/png' }));
      } catch (err) { error.textContent = err.message; applying = false; dialog.querySelectorAll('button,input').forEach(control => control.disabled = false); }
    };
    sync(); dialog.showModal();
  });
}
