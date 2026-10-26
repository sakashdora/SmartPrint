let pdfjs;
const active = new WeakMap();
export async function showDocument(container, blob, { title = 'Print preview' } = {}) {
  const generation = {}; active.set(container, generation);
  container.replaceChildren();
  const state = document.createElement('p'); state.className = 'muted'; state.textContent = 'Loading preview…'; container.append(state);
  if (blob.type.startsWith('image/')) {
    const image = document.createElement('img'); image.className = 'image-preview'; image.alt = title;
    const url = URL.createObjectURL(blob); image.src = url; image.onload = () => URL.revokeObjectURL(url); image.onerror = () => URL.revokeObjectURL(url);
    container.replaceChildren(image); return { destroy() { image.remove(); URL.revokeObjectURL(url); }, numPages: 1 };
  }
  pdfjs ??= await import('/vendor/pdfjs/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, maxImageSize: 20_000_000, standardFontDataUrl: '/vendor/pdfjs-fonts/', wasmUrl: '/vendor/pdfjs-wasm/' });
  const pdf = await task.promise;
  if (active.get(container) !== generation) { await task.destroy(); return { destroy() {}, numPages: pdf.numPages }; }
  let number = 1, rendering, destroyed = false;
  const tools = document.createElement('div'); tools.className = 'preview-toolbar';
  const previous = document.createElement('button'), next = document.createElement('button'), label = document.createElement('span');
  previous.textContent = '← Previous'; next.textContent = 'Next →'; previous.type = next.type = 'button'; previous.className = next.className = 'secondary';
  label.setAttribute('aria-live', 'polite'); tools.append(previous, label, next);
  const frame = document.createElement('div'); frame.className = 'paper-frame';
  const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', title); canvas.setAttribute('role', 'img'); frame.append(canvas);
  container.replaceChildren(frame, tools);
  async function draw() {
    previous.disabled = next.disabled = true;
    if (rendering) { rendering.cancel(); try { await rendering.promise; } catch {} }
    const page = await pdf.getPage(number), base = page.getViewport({ scale: 1 });
    const width = Math.min(1100, Math.max(140, (frame.clientWidth || 300) - 16)), scale = Math.min(2, (width / base.width) * Math.min(devicePixelRatio, 2));
    const viewport = page.getViewport({ scale }); canvas.width = viewport.width; canvas.height = viewport.height;
    rendering = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    try { await rendering.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
    if (destroyed) return;
    label.textContent = `Page ${number} of ${pdf.numPages}`; previous.disabled = number === 1; next.disabled = number === pdf.numPages;
  }
  previous.onclick = () => { number--; draw().catch(() => { label.textContent = 'Preview failed. Reload the document.'; }); };
  next.onclick = () => { number++; draw().catch(() => { label.textContent = 'Preview failed. Reload the document.'; }); };
  await draw();
  return { destroy() { destroyed = true; rendering?.cancel(); task.destroy(); if (active.get(container) === generation) { active.delete(container); container.replaceChildren(); } }, pdf, numPages: pdf.numPages };
}
export async function getDocPageCount(blob) {
  if (!blob) return 1;
  if (blob.type && blob.type.startsWith('image/')) return 1;
  if (blob.type === 'application/pdf' || /\.pdf$/i.test(blob.name || '')) {
    try {
      pdfjs ??= await import('/vendor/pdfjs/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
      const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, maxImageSize: 20_000_000, standardFontDataUrl: '/vendor/pdfjs-fonts/', wasmUrl: '/vendor/pdfjs-wasm/' });
      const pdf = await task.promise;
      const count = pdf.numPages;
      task.destroy();
      return count;
    } catch {
      return 1;
    }
  }
  return 1;
}
export async function downloadPdf(path, token) {
  const chunks = []; let start = 0, total;
  do {
    const response = await fetch(path, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Range: `bytes=${start}-${start + 1048575}` } });
    if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || 'Unable to load the prepared document.'); }
    const bytes = await response.arrayBuffer(); chunks.push(bytes);
    const match = response.headers.get('Content-Range')?.match(/\/(\d+)$/); total = match ? Number(match[1]) : bytes.byteLength;
    if (!bytes.byteLength || total > 40 * 1048576) throw new Error('Invalid document size.'); start += bytes.byteLength;
  } while (start < total);
  return new Blob(chunks, { type: 'application/pdf' });
}
