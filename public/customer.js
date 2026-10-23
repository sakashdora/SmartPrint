import { showDocument, downloadPdf } from './viewer.js';
export async function renderCustomer({ api, mount, money, escape, health, notify, onOrder }) {
  const slug = new URLSearchParams(location.search).get('shop') || (health.demo ? 'campus-print' : '');
  if (!slug) { mount('<main class="container"><section class="panel"><h1>Print at your local shop</h1><p>Scan the shop’s SmartPrint QR code to upload a file and see its prices.</p><a href="#register">Register your shop</a></section></main>'); return; }
  const shop = await api(`/api/shops/${encodeURIComponent(slug)}`);
  let files = [], quote, viewer, revision = 0, generating = false, output;
  mount(`<main class="customer-shell"><div class="shop-line"><div><h1>Print your file</h1><p>${escape(shop.name)} <span>· ${escape(shop.location)}</span></p></div><span class="pill">A4 printing</span></div><ol class="simple-steps"><li class="current"><b>1</b> Choose file</li><li><b>2</b> Check preview</li><li><b>3</b> Pay & collect</li></ol><section class="file-bar"><label class="upload-button" for="files">＋ Choose file</label><input id="files" class="visually-hidden" type="file" accept=".pdf,.jpg,.jpeg,.png${health.office ? ',.docx,.pptx,.xlsx' : ''}" multiple><div><strong id="selected-file">No file selected</strong><p class="muted">PDF, JPG, PNG${health.office ? ', Word, PowerPoint, Excel' : ''} · Up to 20 MB</p></div></section><div class="print-layout"><form id="print-form" class="settings-panel"><h2>Print settings</h2><fieldset><legend>Colour</legend><div class="choices"><label class="choice"><input type="radio" name="color" value="bw" checked>Black & white</label><label class="choice"><input type="radio" name="color" value="color">Colour</label></div></fieldset><fieldset><legend>Sides</legend><div class="choices"><label class="choice"><input type="radio" name="duplex" value="false" checked>One side</label><label class="choice"><input type="radio" name="duplex" value="true">Both sides</label></div></fieldset><div class="fields"><label class="field">Copies<input name="copies" type="number" min="1" max="100" value="1" required></label><label class="field">Layout<select name="layout"><option value="single">1 page per side</option><option value="two">2 pages per side</option><option value="card">ID card front + back</option></select></label></div><label class="field">Pages<input name="range" placeholder="All pages (or 1-3, 5)"></label><details id="image-tools"><summary>Crop, rotate & improve image</summary><p class="muted">Image files only. Check that cropping keeps all important information.</p><div class="fields"><label class="field">Crop edges (%)<input name="crop" type="number" min="0" max="20" value="0"></label><label class="field">Rotate<select name="rotate"><option value="0">No rotation</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label></div><label class="check"><input type="checkbox" name="smartCrop">Remove blank borders</label><label class="check"><input type="checkbox" name="enhance">Improve contrast & sharpness</label></details><button class="primary wide" id="prepare">Update print preview</button><p id="prepare-status" class="muted" aria-live="polite">Choose a file to begin.</p></form><section class="preview-panel"><div class="row"><h2 id="preview-title">Your preview</h2><span id="preview-status" class="badge">No file yet</span></div><div id="preview-area"><div class="preview-empty"><span>▤</span><strong>Your document will appear here</strong><p>Choose a file. We’ll show how it looks before you pay.</p></div></div><p class="preview-hint" id="preview-hint">Review every page before placing your order.</p></section></div><section class="checkout-bar"><div><span id="summary-text">Select a file to see the price</span><strong id="total">—</strong><small>${money(shop.bw)} B&W / ${money(shop.color)} colour per printed side</small></div><div class="checkout-actions"><label class="field">Pay with<select id="method"><option value="cash">Cash at the shop</option><option value="upi" ${shop.upi_id ? '' : 'disabled'}>UPI${shop.upi_id ? '' : ' · not set up by shop'}</option></select></label><button id="place" class="primary" disabled>Place order →</button></div></section><p class="privacy-line">Your live file is deleted after the shop confirms printing. Unprinted files expire after 24 hours.</p><p class="inline-error" id="print-error" role="alert"></p></main>`);
  const form = document.querySelector('#print-form'), area = document.querySelector('#preview-area'), place = document.querySelector('#place'), status = document.querySelector('#prepare-status');
  function readOptions() { const data = new FormData(form); return { color: data.get('color'), duplex: data.get('duplex') === 'true', copies: Number(data.get('copies')), layout: data.get('layout'), range: data.get('range'), crop: Number(data.get('crop')), rotate: Number(data.get('rotate')), enhance: data.has('enhance'), smartCrop: data.has('smartCrop') }; }
  function invalidate() { revision++; quote = null; place.disabled = true; document.querySelector('#total').textContent = '—'; document.querySelector('#summary-text').textContent = 'Update the preview to get your price'; document.querySelector('#preview-status').textContent = 'Update needed'; status.textContent = 'Settings changed. Select “Update print preview”.'; }
  form.oninput = invalidate; form.onchange = invalidate;
  document.querySelector('#files').onchange = async event => {
    files = [...event.target.files]; invalidate(); viewer?.destroy(); viewer = null;
    const selectionRevision = revision;
    const selected = document.querySelector('#selected-file'); selected.textContent = files.map(f => f.name).join(' + ') || 'No file selected';
    document.querySelector('#preview-status').textContent = 'Original file';
    if (files.length === 2) { form.elements.layout.value = 'card'; form.querySelector('[name=duplex][value=false]').checked = true; }
    try { if (files[0]?.type.startsWith('image/') || files[0]?.type === 'application/pdf') { const result = await showDocument(area, files[0], { title: 'Original file before print settings' }); if (selectionRevision !== revision || !document.contains(area)) { result.destroy(); return; } viewer = result; } else area.innerHTML = '<div class="preview-empty"><strong>Ready to prepare</strong><p>Click “Update print preview” to see the converted document.</p></div>'; status.textContent = 'Check your settings, then update the print preview.'; }
    catch { area.innerHTML = '<p>Choose “Update print preview” to prepare this file.</p>'; }
  };
  async function upload(file) {
    const info = await api('/api/uploads', { method: 'POST', body: { slug, name: file.name, size: file.size } });
    for (let start = 0, part = 0; start < file.size; start += info.chunkSize, part++) {
      const bytes = new Uint8Array(await file.slice(start, start + info.chunkSize).arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await api(`/api/uploads/${info.id}/chunks/${part}`, { method: 'PUT', token: info.token, body: { data: btoa(binary) } });
      status.textContent = `Uploading… ${Math.round(Math.min(start + info.chunkSize, file.size) / file.size * 100)}%`;
    }
    return { uploadId: info.id, token: info.token };
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (generating) return; const requestRevision = revision; generating = true;
    const controls = [...form.elements, document.querySelector('#files')]; const settings = readOptions(); controls.forEach(c => c.disabled = true); place.disabled = true;
    document.querySelector('#print-error').textContent = '';
    try {
      if (!files.length || files.length > 2 || files.reduce((sum, f) => sum + f.size, 0) > 20 * 1048576) throw new Error('Choose one document or two card images, up to 20 MB in total.');
      const uploads = []; for (const file of files) uploads.push(await upload(file));
      status.textContent = 'Preparing your print preview…';
      let result = await api('/api/quotes', { method: 'POST', body: { slug, files: uploads, options: settings } });
      if (result.pending) {
        const pending = result;
        const deadline = Date.now() + 180000;
        while (result.pending && Date.now() < deadline && document.contains(area)) { status.textContent = 'The shop computer is preparing your preview…'; await new Promise(resolve => setTimeout(resolve, 2000)); result = await api(`/api/preparations/${pending.id}`, { token: pending.token }); }
        if (result.error) throw new Error(result.error);
        if (result.pending) throw new Error('Preparation is taking longer than expected. Ask the shop to check its connector.');
      }
      if (revision !== requestRevision || !document.contains(area)) return;
      output = await downloadPdf(`/api/quotes/${result.id}/preview`, result.token);
      viewer?.destroy(); viewer = await showDocument(area, output, { title: 'Prepared print output' }); quote = result;
      document.querySelector('#preview-status').textContent = 'Ready to print'; document.querySelector('#preview-title').textContent = 'This is how it will print';
      document.querySelector('#preview-hint').textContent = `${settings.duplex ? 'Both sides of the paper' : 'One side of the paper'} · ${settings.copies} ${settings.copies === 1 ? 'copy' : 'copies'} · Paper and printer colours may vary slightly.`;
      document.querySelector('#summary-text').textContent = `${result.pages} ${result.pages === 1 ? 'page' : 'pages'} · ${result.sides} printed ${result.sides === 1 ? 'side' : 'sides'} · ${result.sheets} ${result.sheets === 1 ? 'sheet' : 'sheets'}`;
      document.querySelector('#total').textContent = money(result.amount); status.textContent = 'Preview ready. Check every page, then place your order.'; place.disabled = false;
    } catch (error) { quote = null; if (document.contains(area)) { document.querySelector('#print-error').textContent = error.message; status.textContent = 'Preview not ready. Please try again.'; } }
    finally { generating = false; controls.forEach(c => c.disabled = false); }
  };
  place.onclick = async () => {
    if (!quote || Date.parse(quote.expires) <= Date.now()) { invalidate(); notify('The price quote expired. Update your preview.'); return; }
    place.disabled = true;
    try { const result = await api('/api/orders', { method: 'POST', token: quote.token, body: { quoteId: quote.id, method: document.querySelector('#method').value } }); viewer?.destroy(); onOrder(result); }
    catch (error) { document.querySelector('#print-error').textContent = error.message; place.disabled = false; }
  };
}
