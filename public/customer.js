import { showDocument, downloadPdf } from './viewer.js';
import { icon } from './ui.js';
export async function renderCustomer({ api, mount, money, escape, health, notify, onOrder }) {
  let slug = new URLSearchParams(location.search).get('shop');
  if (!slug) {
    mount(`<main class="welcome">
      <div class="welcome-icon">${icon('qr')}</div>
      <span class="eyebrow">SMARTPRINT · CONTACTLESS SCAN & PRINT</span>
      <h1>Scan shop QR code to print</h1>
      <p class="muted">To print your documents, please scan the official SmartPrint QR code placed at your print shop counter. Each shop has its own unique QR code.</p>
      
      <div class="welcome-steps">
        <div class="welcome-step-card">
          <span class="step-badge">Step 1</span>
          <strong>${icon('qr')} Scan at Counter</strong>
          <p class="muted small">Scan the shop's counter QR code with your phone camera.</p>
        </div>
        <div class="welcome-step-card">
          <span class="step-badge">Step 2</span>
          <strong>${icon('file')} Upload & Options</strong>
          <p class="muted small">Upload your PDF or image, pick B&W or Colour and pages.</p>
        </div>
        <div class="welcome-step-card">
          <span class="step-badge">Step 3</span>
          <strong>${icon('printer')} Pay & Collect</strong>
          <p class="muted small">Pay by UPI or cash, then collect your printed document.</p>
        </div>
      </div>

      <div class="landing-portal-actions">
        <a class="primary wide" href="#register">Register Your Shop →</a>
        <a class="secondary wide" href="#login">Shop & Admin Sign In</a>
      </div>

      <div class="welcome-footer">
        <span>Already placed an order?</span>
        <a href="#track">Track order progress ${icon('arrow')}</a>
      </div>
    </main>`);
    return;
  }
  let shop;
  try {
    shop = await api(`/api/shops/${encodeURIComponent(slug)}`);
  } catch (err) {
    mount(`<main class="welcome">
      <div class="welcome-icon">${icon('alert')}</div>
      <span class="eyebrow">SHOP NOT FOUND</span>
      <h1>Unable to open this print shop</h1>
      <p class="muted">${escape(err.message || 'This shop is currently unavailable or pending approval.')}</p>
      <div class="landing-portal-actions">
        <a class="primary" href="/">Return to Home</a>
        <a class="secondary" href="#register">Register Your Shop</a>
      </div>
    </main>`);
    return;
  }
  let files = [], quote, viewer, revision = 0, generating = false, output;
  mount(`<main class="customer-shell">
    <div class="shop-context">${icon('shop')}<strong>${escape(shop.name)}</strong><span class="badge active">Open</span><span class="shop-location">${escape(shop.location)}</span></div>
    <div class="customer-heading"><div><h1>Make it print-perfect.</h1><p class="muted">Preview your file, choose your options, then pay.</p></div>
    <ol class="simple-steps" aria-label="Print progress"><li aria-current="step"><b>1</b> Upload</li><li><b>2</b> Print options</li><li><b>3</b> Payment</li></ol></div>
    <div class="print-layout">
      <section class="preview-panel" aria-labelledby="preview-title">
        <div class="file-bar"><div class="file-description">${icon('file')}<div><strong id="selected-file">Choose your document</strong><p class="muted">PDF, JPG, PNG${health.office ? ', Word, PowerPoint, Excel' : ''} · Up to 20 MB</p></div></div><label class="upload-button" for="files">${icon('upload')}<span id="upload-label">Choose file</span></label><input id="files" class="visually-hidden" type="file" accept=".pdf,.jpg,.jpeg,.png${health.office ? ',.docx,.pptx,.xlsx' : ''}" multiple></div>
        <div class="preview-heading"><h2 id="preview-title">Your preview</h2><span id="preview-status" class="badge">No file yet</span></div>
        <div id="preview-area"><div class="preview-empty"><div class="empty-icon">${icon('file')}</div><strong>A clear view before you print.</strong><p>Choose your file to see it here. You can review every page before placing an order.</p><label class="secondary" for="files">${icon('upload')} Choose file</label></div></div>
        <p class="preview-hint" id="preview-hint">Your prepared preview will show the print settings you choose.</p>
      </section>
      <aside class="settings-panel" aria-label="Print settings and checkout"><form id="print-form"><h2>Print options</h2>
        <fieldset class="option-row"><legend>Colour</legend><div class="choices"><label class="choice"><input type="radio" name="color" value="bw" checked><span>Black & white</span></label><label class="choice"><input type="radio" name="color" value="color"><span>Colour</span></label></div></fieldset>
        <fieldset class="option-row"><legend>Sides</legend><div class="choices"><label class="choice"><input type="radio" name="duplex" value="false" checked><span>One-sided</span></label><label class="choice"><input type="radio" name="duplex" value="true"><span>Both sides</span></label></div></fieldset>
        <fieldset class="option-row"><legend>Layout</legend><div class="choices"><label class="choice"><input type="radio" name="layout" value="single" checked><span>Standard</span></label><label class="choice"><input type="radio" name="layout" value="two"><span>2 on 1</span></label><label class="choice"><input type="radio" name="layout" value="card"><span>ID card</span></label></div></fieldset>
        <div class="option-line"><label for="copies">Copies</label><div class="stepper"><button type="button" data-copy="-1" aria-label="Fewer copies">−</button><input id="copies" name="copies" type="number" min="1" max="100" value="1" required><button type="button" data-copy="1" aria-label="More copies">+</button></div></div>
        <label class="field option-line">Pages<input name="range" placeholder="All pages (or 1-3, 5)" aria-describedby="pages-help"></label><p id="pages-help" class="sr-only">Leave blank to print all pages, or enter page numbers and ranges.</p>
        <div class="option-line paper-size"><span>Paper size</span><span>A4 <small>210 × 297 mm</small></span></div>
        <details id="image-tools"><summary>${icon('sliders')} Image adjustments</summary><p class="muted">For images only. Update the preview to see your changes.</p><div class="fields"><label class="field">Crop edges (%)<input name="crop" type="number" min="0" max="20" value="0"></label><label class="field">Rotate<select name="rotate"><option value="0">No rotation</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label></div><label class="check"><input type="checkbox" name="smartCrop"><span>Smart crop <small>Remove blank borders</small></span></label><label class="check"><input type="checkbox" name="enhance"><span>Enhance <small>Improve contrast & sharpness</small></span></label></details>
        <button class="secondary wide" id="prepare">${icon('refresh')} Update print preview</button><p id="prepare-status" class="muted prepare-status" aria-live="polite">Choose a file to begin.</p>
      </form><section class="checkout-bar" aria-label="Order total"><p id="summary-text">Select a file to see the price</p><div class="checkout-total"><span>Total</span><strong id="total" aria-live="polite">—</strong></div><small>${money(shop.bw)} B&W / ${money(shop.color)} colour per side</small><div class="checkout-actions"><label class="field">Pay with<select id="method"><option value="cash">Cash at the shop</option><option value="upi" ${shop.upi_id ? '' : 'disabled'}>UPI${shop.upi_id ? '' : ' · unavailable'}</option></select></label><button id="place" class="primary wide" disabled>Place order ${icon('arrow')}</button></div><p class="checkout-note">UPI or cash at the shop</p></section><p class="inline-error" id="print-error" role="alert"></p></aside>
    </div><p class="privacy-line">${icon('lock')}<span>Your live file is deleted after the shop confirms printing. Unprinted files expire after 24 hours.</span></p>
  </main>`);
  const form = document.querySelector('#print-form'), area = document.querySelector('#preview-area'), place = document.querySelector('#place'), status = document.querySelector('#prepare-status');
  function readOptions() { const data = new FormData(form); return { color: data.get('color'), duplex: data.get('duplex') === 'true', copies: Number(data.get('copies')), layout: data.get('layout'), range: data.get('range'), crop: Number(data.get('crop')), rotate: Number(data.get('rotate')), enhance: data.has('enhance'), smartCrop: data.has('smartCrop') }; }
  function setStep(step) { document.querySelectorAll('.simple-steps li').forEach((li, index) => { li.classList.toggle('complete', index < step); if (index === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); }); }
  function invalidate() { revision++; quote = null; place.disabled = true; document.querySelector('#total').textContent = '—'; document.querySelector('#summary-text').textContent = 'Update the preview to get your price'; document.querySelector('#preview-status').textContent = 'Update needed'; document.querySelector('#preview-status').className = 'badge pending'; status.textContent = 'Settings changed. Select “Update print preview”.'; setStep(files.length ? 1 : 0); }
  form.oninput = invalidate; form.onchange = invalidate;
  form.querySelectorAll('[data-copy]').forEach(button => button.onclick = () => { const input = form.elements.copies; input.value = Math.max(1, Math.min(100, (Number(input.value) || 1) + Number(button.dataset.copy))); invalidate(); });
  document.querySelector('#files').onchange = async event => {
    files = [...event.target.files]; invalidate(); viewer?.destroy(); viewer = null;
    const selectionRevision = revision;
    const selected = document.querySelector('#selected-file'); selected.textContent = files.map(f => f.name).join(' + ') || 'No file selected';
    const imageTools = document.querySelector('#image-tools');
    imageTools.hidden = files.length > 0 && !files.every(file => file.type.startsWith('image/'));
    if (imageTools.hidden) { imageTools.open = false; form.elements.crop.value = '0'; form.elements.rotate.value = '0'; form.elements.enhance.checked = false; form.elements.smartCrop.checked = false; }
    document.querySelector('#upload-label').textContent = files.length ? 'Replace file' : 'Choose file';
    document.querySelector('#preview-status').textContent = 'Original file';
    document.querySelector('#preview-title').textContent = 'Original preview';
    document.querySelector('#preview-hint').textContent = files.length === 2 ? 'Showing the first image. Update the preview to see both sides of your card together.' : 'Original file shown. Update the preview to apply your print settings.';
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
      document.querySelector('#preview-status').className = 'badge active'; setStep(2);
      document.querySelector('#preview-hint').textContent = `${settings.duplex ? 'Both sides of the paper' : 'One side of the paper'} · ${settings.copies} ${settings.copies === 1 ? 'copy' : 'copies'} · Paper and printer colours may vary slightly.`;
      document.querySelector('#summary-text').textContent = `${result.pages} ${result.pages === 1 ? 'page' : 'pages'} · ${result.sides} printed ${result.sides === 1 ? 'side' : 'sides'} · ${result.sheets} ${result.sheets === 1 ? 'sheet' : 'sheets'}`;
      document.querySelector('#total').textContent = money(result.amount); status.textContent = 'Preview ready. Check every page, then place your order.'; place.disabled = false;
    } catch (error) { quote = null; if (document.contains(area)) { document.querySelector('#print-error').textContent = error.message; status.textContent = 'Preview not ready. Please try again.'; } }
    finally { generating = false; controls.forEach(c => c.disabled = false); }
  };
  place.onclick = async () => {
    if (!quote || Date.parse(quote.expires) <= Date.now()) { invalidate(); notify('The price quote expired. Update your preview.'); return; }
    place.disabled = true;
    try {
      const fileName = files.map(f => f.name).join(' + ') || 'document.pdf';
      const result = await api('/api/orders', { method: 'POST', token: quote.token, body: { quoteId: quote.id, method: document.querySelector('#method').value, fileName } });
      viewer?.destroy();
      onOrder(result);
    }
    catch (error) { document.querySelector('#print-error').textContent = error.message; place.disabled = false; }
  };
  const dropPanel = document.querySelector('.preview-panel');
  if (dropPanel) {
    ['dragenter', 'dragover'].forEach(name => dropPanel.addEventListener(name, e => { e.preventDefault(); dropPanel.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach(name => dropPanel.addEventListener(name, e => { e.preventDefault(); dropPanel.classList.remove('is-dragging'); }));
    dropPanel.addEventListener('drop', e => {
      if (e.dataTransfer?.files?.length) {
        document.querySelector('#files').files = e.dataTransfer.files;
        document.querySelector('#files').dispatchEvent(new Event('change'));
      }
    });
  }
}
