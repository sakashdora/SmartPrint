import { icon } from './ui.js';
import { downloadPdf, showDocument } from './viewer.js';
import { waitForQuote } from './preparation.js';

export async function renderCustomer({ api, mount, money, escape, health, notify, onOrder }) {
  let slug = new URLSearchParams(location.search).get('shop');
  if (!slug) {
    mount(`<main class="home-page-shell">
      <div class="home-hero-container">
        <div class="home-hero-grid">
          <!-- Left Content Column -->
          <div class="home-hero-content">
            <div class="home-eyebrow">
              CONTACTLESS &bull; FAST &bull; SECURE &mdash;
            </div>

            <h1 class="home-hero-heading">
              Scan your shop<br>
              <span class="qr-word">QR</span> <span class="code-word">code</span> to print
            </h1>

            <p class="home-hero-desc">
              Print your documents easily and securely. Scan the official SmartPrint QR code placed at your print shop counter. Each shop has its own unique QR code.
            </p>

            <div class="home-steps-grid">
              <div class="home-step-card">
                <div class="home-step-header">
                  <span class="home-step-badge badge-blue">01</span>
                  <span class="home-step-icon">${icon('qr')}</span>
                </div>
                <strong class="home-step-title">Scan at Counter</strong>
                <p class="home-step-desc">Scan the shop’s QR code with your phone camera.</p>
              </div>

              <div class="home-step-card">
                <div class="home-step-header">
                  <span class="home-step-badge badge-purple">02</span>
                  <span class="home-step-icon">${icon('file')}</span>
                </div>
                <strong class="home-step-title">Upload & Options</strong>
                <p class="home-step-desc">Upload your PDF or document, pick B&W or Colour and copies.</p>
              </div>

              <div class="home-step-card">
                <div class="home-step-header">
                  <span class="home-step-badge badge-orange">03</span>
                  <span class="home-step-icon">${icon('printer')}</span>
                </div>
                <strong class="home-step-title">Pay & Collect</strong>
                <p class="home-step-desc">Pay by UPI or cash, then collect your printed document.</p>
              </div>
            </div>

            <div class="home-cta-group">
              <a class="home-primary-btn" href="#register">
                ${icon('shop')} <span>Register Your Shop &rarr;</span>
              </a>
              <a class="home-secondary-btn" href="#login">
                ${icon('user')} <span>Shop owner sign in</span>
              </a>
            </div>

            <div class="home-footer-nav">
              <a href="#admin-login" class="home-link-admin">Administrator sign in</a>
              <span class="home-footer-sep">|</span>
              <span class="home-footer-muted">Already placed an order?</span>
              <a href="#track" class="home-link-track">Track order progress &rarr;</a>
            </div>
          </div>

          <!-- Right Visual Mockup Column -->
          <div class="home-hero-visual">
            <div class="home-ambient-glow"></div>
            <div class="home-mockup-frame">
              <img class="home-mockup-img" src="/hero-scanner.jpg" alt="SmartPrint Counter QR Scanner" width="1280" height="720">
            </div>
          </div>
        </div>
      </div>

      <!-- Organic Wave Footer Accent -->
      <div class="home-organic-wave" aria-hidden="true">
        <svg viewBox="0 0 1440 96" fill="none" preserveAspectRatio="none">
          <path d="M0,32 C360,85 720,12 1080,55 C1260,78 1380,40 1440,48 L1440,96 L0,96 Z" fill="#e8f3fe" opacity="0.8"></path>
          <path d="M0,58 C420,18 780,82 1140,38 C1300,18 1390,56 1440,60 L1440,96 L0,96 Z" fill="#f1f7ff"></path>
        </svg>
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

  const isImage = file => /\.(png|jpe?g)$/i.test(file.name);
  let files = [], quote = null, isCalculating = false, isOrdering = false;
  let revision = 0, calculateTimer, preview, pendingPreparation, sourceRevision = 0;
  let localPreviews = [];
  let preparedQuote;
  const uploadsByFile = new WeakMap();

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  mount(`<main class="customer-shell">
    <div class="shop-context">
      ${icon('shop')}
      <strong>${escape(shop.name)}</strong>
      <span class="badge active">Open</span>
      <span class="shop-location">${escape(shop.location)}</span>
      <span class="shop-rates-badge">${money(shop.bw)} B&W · ${money(shop.color)} Colour / page</span>
    </div>

    <div class="customer-heading">
      <div>
        <h1>Upload document to print</h1>
        <p class="muted">Select your file, choose print options, and submit your order directly to the shop printer.</p>
      </div>
      <ol class="simple-steps" aria-label="Print progress">
        <li id="step-1" class="complete"><b>1</b> Upload file</li>
        <li id="step-2"><b>2</b> Print options</li>
        <li id="step-3"><b>3</b> Pay & Print</li>
      </ol>
    </div>

    <div class="customer-direct-layout">
      <div class="customer-main-col">
        <!-- 1. Document Upload Area -->
        <section class="panel direct-upload-card" id="drop-panel">
          <div class="panel-heading">
            <h2>1. Select Document</h2>
            <span class="badge" id="file-count-badge">No file chosen</span>
          </div>
          
          <div class="direct-dropzone" id="direct-dropzone">
            <div class="dropzone-icon">${icon('upload')}</div>
            <strong class="dropzone-title">Drag & drop your document here</strong>
            <p class="muted small">PDF, JPG, PNG${health.office ? ', Word, PowerPoint, Excel' : ''} · Up to 20 MB</p>
            <label class="primary upload-cta-btn" for="files">
              ${icon('file')} Browse files
            </label>
            <input id="files" class="visually-hidden" type="file" accept=".pdf,.jpg,.jpeg,.png${health.office ? ',.docx,.pptx,.xlsx' : ''}" multiple>
          </div>

          <div class="selected-files-display" id="selected-files-display" hidden>
            <div class="selected-file-item">
              <div class="file-icon-wrap">${icon('file')}</div>
              <div class="file-meta-wrap">
                <strong id="display-file-name">filename.pdf</strong>
                <span class="muted small" id="display-file-size">0 KB</span>
              </div>
              <label class="secondary small change-file-btn" for="files">
                ${icon('refresh')} Change
              </label>
            </div>
          </div>
        </section>

        <section class="panel preview-panel">
          <div class="row"><h2>Document preview</h2><button type="button" class="secondary" id="show-preview" disabled>View print layout</button></div>
          <p class="muted" id="preview-help">PDFs and photos preview directly from your device while the upload runs.</p>
          <div id="source-preview"></div>
          <div id="document-preview"></div>
        </section>

        <!-- 2. Print Settings Form -->
        <form id="print-form" class="panel direct-settings-card">
          <h2>2. Print Options</h2>

          <fieldset class="option-row">
            <legend>Colour</legend>
            <div class="choices">
              <label class="choice">
                <input type="radio" name="color" value="bw" checked>
                <span>Black & White (${money(shop.bw)})</span>
              </label>
              <label class="choice">
                <input type="radio" name="color" value="color">
                <span>Colour (${money(shop.color)})</span>
              </label>
            </div>
          </fieldset>

          <fieldset class="option-row">
            <legend>Sides</legend>
            <div class="choices">
              <label class="choice">
                <input type="radio" name="duplex" value="false" checked>
                <span>One-sided</span>
              </label>
              <label class="choice">
                <input type="radio" name="duplex" value="true">
                <span>Both sides (Duplex)</span>
              </label>
            </div>
          </fieldset>

          <fieldset class="option-row">
            <legend>Layout</legend>
            <div class="choices">
              <label class="choice">
                <input type="radio" name="layout" value="single" checked>
                <span>Standard</span>
              </label>
              <label class="choice">
                <input type="radio" name="layout" value="two">
                <span>2 pages on 1</span>
              </label>
              <label class="choice">
                <input type="radio" name="layout" value="card">
                <span>ID Card (Fit)</span>
              </label>
            </div>
          </fieldset>

          <div class="option-line">
            <label for="copies">Copies</label>
            <div class="stepper">
              <button type="button" data-copy="-1" aria-label="Fewer copies">−</button>
              <input id="copies" name="copies" type="number" min="1" max="100" value="1" required>
              <button type="button" data-copy="1" aria-label="More copies">+</button>
            </div>
          </div>

          <label class="field option-line">
            Pages to print
            <input name="range" placeholder="All pages (or e.g. 1-3, 5)">
          </label>

          <div class="option-line paper-size">
            <span>Paper format</span>
            <span>A4 standard <small>(210 × 297 mm)</small></span>
          </div>
        </form>

      </div>

      <!-- 3. Checkout & Summary Sidebar -->
      <aside class="customer-sidebar-col">
        <section class="panel checkout-summary-card">
          <h2>Order Summary</h2>
          
          <div class="summary-specs" id="summary-specs">
            <div class="spec-row">
              <span>Status</span>
            <strong id="order-status-text" class="badge" aria-live="polite">Awaiting document</strong>
            </div>
            <div class="spec-row">
              <span>Pages</span>
              <strong id="spec-pages">—</strong>
            </div>
            <div class="spec-row">
              <span>Paper sheets</span>
              <strong id="spec-sheets">—</strong>
            </div>
            <div class="spec-row">
              <span>Copies</span>
              <strong id="spec-copies">1</strong>
            </div>
          </div>

          <div class="checkout-total-block">
            <span>Total Amount</span>
            <strong id="total-amount" class="total-price-tag">—</strong>
            <small class="muted" id="price-subnote">Select a document to calculate price</small>
          </div>

          <div class="payment-method-block">
            <label class="field">
              Payment Method
              <select id="method">
                ${health.payments ? '<option value="online">Online Payment (UPI, Cards, Netbanking)</option>' : ''}
                <option value="upi" ${shop.upi_id ? 'selected' : 'disabled'}>Direct UPI · Shop verifies${shop.upi_id ? '' : ' (unavailable)'}</option>
                <option value="cash" ${!shop.upi_id && !health.payments ? 'selected' : ''}>Cash at counter</option>
              </select>
            </label>
            <p class="muted small" id="payment-note">Pay cash to shopkeeper when collecting your printed paper.</p>
          </div>

          <button id="place-order-btn" class="primary wide place-order-btn" disabled>
            ${icon('printer')} Place Print Order →
          </button>

          <p class="inline-error" id="order-error" role="alert"></p>
          <button type="button" class="secondary wide" id="retry-quote" hidden>Retry preparation</button>

          <div class="privacy-guarantee">
            ${icon('lock')}
            <span>Your files are encrypted. Print files are deleted after printing; temporary uploads expire automatically.</span>
          </div>
        </section>
      </aside>
    </div>
  </main>`);

  const form = document.querySelector('#print-form');
  const dropPanel = document.querySelector('#drop-panel');
  const fileInput = document.querySelector('#files');
  const dropzone = document.querySelector('#direct-dropzone');
  const fileDisplay = document.querySelector('#selected-files-display');
  const placeBtn = document.querySelector('#place-order-btn');
  const methodSelect = document.querySelector('#method');
  const errorEl = document.querySelector('#order-error');
  const statusBadge = document.querySelector('#file-count-badge');
  const orderStatusText = document.querySelector('#order-status-text');
  const previewButton = document.querySelector('#show-preview');
  const retryButton = document.querySelector('#retry-quote');
  async function previewSources(selected) {
    const generation = ++sourceRevision;
    localPreviews.forEach(view => view.destroy());
    localPreviews = [];
    const container = document.querySelector('#source-preview');
    container.replaceChildren();
    const supported = selected.every(file => /\.(pdf|png|jpe?g)$/i.test(file.name));
    document.querySelector('#preview-help').textContent = supported
      ? 'Original document preview. Upload continues in the background. Use “View print layout” to check page selection and layout when ready.'
      : 'Office documents need conversion. A print layout preview will be available when conversion finishes. For a faster preview, choose a PDF.';
    if (!supported) return;
    await Promise.all(selected.map(async file => {
      const panel = document.createElement('div');
      container.append(panel);
      try {
        const type = /\.pdf$/i.test(file.name) ? 'application/pdf' : /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg';
        const view = await showDocument(panel, file.slice(0, file.size, type), { title: file.name });
        if (generation !== sourceRevision || !container.isConnected) view.destroy();
        else localPreviews.push(view);
      } catch {
        if (generation === sourceRevision) panel.textContent = 'Local preview unavailable. You can still upload and check the prepared print layout.';
      }
    }));
  }
  retryButton.onclick = () => recalculateQuote();
  previewButton.onclick = async () => {
    const current = quote, generation = revision;
    if (!current || isCalculating) return;
    previewButton.disabled = true;
    const help = document.querySelector('#preview-help');
    help.textContent = 'Loading prepared pages…';
    try {
      const blob = await downloadPdf(`/api/quotes/${current.id}/preview`, current.token);
      if (generation !== revision || !form.isConnected) return;
      preview?.destroy();
      preview = await showDocument(document.querySelector('#document-preview'), blob);
      if (generation !== revision) { preview?.destroy(); return; }
      document.querySelector('#source-preview').hidden = true;
      help.textContent = 'These are the prepared pages for your selected print options.';
    } catch (error) { if (generation === revision) help.textContent = error.message; }
    finally { if (generation === revision) previewButton.disabled = !quote; }
  };

  function scheduleQuote() {
    if (isOrdering) return;
    revision++;
    quote = null;
    placeBtn.disabled = previewButton.disabled = true;
    preview?.destroy();
    document.querySelector('#source-preview').hidden = false;
    if (localPreviews.length) document.querySelector('#preview-help').textContent = 'Original document preview. Print options are updating in the background.';
    orderStatusText.textContent = 'Updating options…';
    clearTimeout(calculateTimer);
    calculateTimer = setTimeout(recalculateQuote, 350);
  }

  function updatePaymentHelp() {
    const method = methodSelect.value;
    document.querySelector('#payment-note').textContent = method === 'online'
      ? 'Pay securely online with Google Pay, PhonePe, Cards or Netbanking. Order prints instantly upon confirmation.'
      : method === 'upi'
      ? 'Pay directly to the shop’s UPI QR on the next screen. The shop verifies and prints immediately.'
      : 'Pay cash at the shop counter. Printing starts as soon as payment is confirmed.';
  }
  methodSelect.onchange = updatePaymentHelp;
  updatePaymentHelp();

  function readOptions() {
    const data = new FormData(form);
    return {
      color: data.get('color') || 'bw',
      duplex: data.get('duplex') === 'true',
      copies: Math.max(1, Math.min(100, Number(data.get('copies')) || 1)),
      layout: data.get('layout') || 'single',
      range: String(data.get('range') || '').trim()
    };
  }

  form.querySelectorAll('[data-copy]').forEach(button => {
    button.onclick = () => {
      const input = form.elements.copies;
      input.value = Math.max(1, Math.min(100, (Number(input.value) || 1) + Number(button.dataset.copy)));
      document.querySelector('#spec-copies').textContent = input.value;
      scheduleQuote();
    };
  });

  form.oninput = () => {
    document.querySelector('#spec-copies').textContent = form.elements.copies.value || '1';
    scheduleQuote();
  };
  form.onchange = () => {
    if (form.elements.layout.value === 'card') {
      form.querySelector('[name=duplex][value=false]').checked = true;
    }
    scheduleQuote();
  };

  async function readChunkBase64(blob) {
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          const comma = typeof result === 'string' ? result.indexOf(',') : -1;
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('Failed to read chunk.'));
        reader.readAsDataURL(blob);
      });
    }
    const buffer = await blob.arrayBuffer();
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(buffer).toString('base64');
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }

  async function upload(file) {
    const cached = uploadsByFile.get(file);
    if (cached && cached.expires > Date.now()) return cached.value;
    const t0 = performance.now();
    const info = await api('/api/uploads', { method: 'POST', body: { slug, name: file.name, size: file.size } });
    let nextPart = 0;
    const parts = Math.ceil(file.size / info.chunkSize);
    const workers = await Promise.allSettled(Array.from({ length: Math.min(3, parts) }, async () => {
      while (nextPart < parts) {
        const part = nextPart++, start = part * info.chunkSize;
        const chunkBlob = file.slice(start, Math.min(file.size, start + info.chunkSize));
        const base64Data = await readChunkBase64(chunkBlob);
        await api(`/api/uploads/${info.id}/chunks/${part}`, { method: 'PUT', token: info.token, body: { data: base64Data } });
      }
    }));
    const failed = workers.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const value = { uploadId: info.id, token: info.token };
    uploadsByFile.set(file, { value, expires: Date.now() + 25 * 60000 });
    console.debug(`[Upload] "${file.name}" uploaded in ${(performance.now() - t0).toFixed(0)}ms (${parts} chunks)`);
    return value;
  }

  async function recalculateQuote() {
    if (!files.length || isCalculating || isOrdering) return;
    if (!form.reportValidity()) return;
    const generation = revision;
    const selectedFiles = files;
    isCalculating = true;
    clearTimeout(calculateTimer);
    retryButton.hidden = true;
    quote = null;
    placeBtn.disabled = true;
    errorEl.textContent = '';
    orderStatusText.textContent = 'Uploading document…';
    orderStatusText.className = 'badge pending';
    document.querySelector('#total-amount').textContent = '...';

    try {
      const settings = readOptions();
      const uploads = [];
      for (const file of selectedFiles) {
        uploads.push(await upload(file));
      }
      if (generation !== revision || !form.isConnected) return;
      orderStatusText.textContent = 'Preparing print file…';
      const requestKey = JSON.stringify({ uploads, settings });
      const artworkKey = JSON.stringify({ uploads, settings: { ...settings, copies: 1, duplex: false } });
      const reusable = preparedQuote?.key === artworkKey && Date.parse(preparedQuote.result.expires) > Date.now();
      let result;
      if (reusable) {
        try { result = await api(`/api/quotes/${preparedQuote.result.id}/reprice`, { method: 'POST', token: preparedQuote.result.token, body: { copies: settings.copies, duplex: settings.duplex } }); }
        catch (error) { if (error.status !== 409) throw error; preparedQuote = null; }
      }
      result ??= pendingPreparation?.key === requestKey ? pendingPreparation.result : await api('/api/quotes', { method: 'POST', body: { slug, files: uploads, options: settings, preferServer: true } });
      if (result.pending) pendingPreparation = { key: requestKey, result };
      result = await waitForQuote(result, api);
      preparedQuote = { key: artworkKey, result };
      pendingPreparation = null;
      if (generation !== revision || !form.isConnected) return;
      quote = result;
      document.querySelector('#spec-pages').textContent = String(result.pages);
      document.querySelector('#spec-sheets').textContent = String(result.sheets);
      document.querySelector('#spec-copies').textContent = String(settings.copies);
      document.querySelector('#total-amount').textContent = money(result.amount);
      document.querySelector('#price-subnote').textContent = `${result.pages} page${result.pages === 1 ? '' : 's'} · ${result.sides} side${result.sides === 1 ? '' : 's'} · ${result.sheets} sheet${result.sheets === 1 ? '' : 's'}`;
      orderStatusText.textContent = 'Ready to order';
      orderStatusText.className = 'badge active';
      document.querySelector('#step-2').classList.add('complete');
      document.querySelector('#step-3').setAttribute('aria-current', 'step');
      placeBtn.disabled = false;
      previewButton.disabled = false;
      if (!localPreviews.length) document.querySelector('#preview-help').textContent = 'Your order is ready. Viewing the print layout is optional.';
      placeBtn.innerHTML = `${icon('printer')} Place Print Order · ${money(result.amount)} →`;
    } catch (err) {
      if (generation !== revision || !form.isConnected) return;
      quote = null;
      if (err.preparationFailed || [400, 404, 409].includes(err.status)) pendingPreparation = null;
      if (!pendingPreparation) files.forEach(file => uploadsByFile.delete(file));
      retryButton.hidden = false;
      errorEl.textContent = err.message || 'Could not calculate price.';
      orderStatusText.textContent = 'Calculation failed';
      orderStatusText.className = 'badge danger';
      document.querySelector('#total-amount').textContent = '—';
    } finally {
      isCalculating = false;
      if (generation !== revision && form.isConnected) recalculateQuote();
    }
  }

  fileInput.onchange = async event => {
    if (isOrdering) return;
    const next = [...event.target.files];
    if (!next.length) return;

    const validTypes = health.office ? /\.(pdf|png|jpe?g|docx|pptx|xlsx)$/i : /\.(pdf|png|jpe?g)$/i;
    const isTooBig = next.reduce((sum, f) => sum + f.size, 0) > 20 * 1048576;
    const isBadType = next.some(f => !f.size || !validTypes.test(f.name));
    const isBadCard = next.length === 2 && !next.every(isImage);

    if (next.length > 2 || isTooBig || isBadType || isBadCard) {
      event.target.value = '';
      notify('Please choose 1 document or 2 card images (Front & Back), up to 20 MB total.');
      return;
    }

    files = next;
    dropzone.hidden = true;
    fileDisplay.hidden = false;

    const names = files.map(f => f.name).join(' + ');
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    document.querySelector('#display-file-name').textContent = names;
    document.querySelector('#display-file-size').textContent = `${formatBytes(totalSize)} · ${files.length === 1 ? '1 file' : '2 files'}`;
    statusBadge.textContent = `${files.length} file ready`;
    statusBadge.className = 'badge active';

    if (files.length === 2) {
      form.elements.layout.value = 'card';
      form.querySelector('[name=duplex][value=false]').checked = true;
    } else if (form.elements.layout.value === 'card') {
      form.elements.layout.value = 'single';
    }

    scheduleQuote();
    void previewSources(files);
  };

  if (dropPanel) {
    ['dragenter', 'dragover'].forEach(name => dropPanel.addEventListener(name, e => {
      e.preventDefault();
      dropPanel.classList.add('is-dragging');
    }));
    ['dragleave', 'drop'].forEach(name => dropPanel.addEventListener(name, e => {
      e.preventDefault();
      dropPanel.classList.remove('is-dragging');
    }));
    dropPanel.addEventListener('drop', e => {
      if (!isOrdering && e.dataTransfer?.files?.length) {
        fileInput.files = e.dataTransfer.files;
        fileInput.dispatchEvent(new Event('change'));
      }
    });
  }

  placeBtn.onclick = async () => {
    if (isOrdering || isCalculating) return;
    if (!quote || Date.parse(quote.expires) <= Date.now()) {
      await recalculateQuote();
      if (!quote) return;
    }
    isOrdering = true;
    form.inert = true;
    methodSelect.disabled = true;
    placeBtn.disabled = true;
    placeBtn.innerHTML = `Submitting order...`;
    errorEl.textContent = '';

    // Assign stable idempotency key per quote submission to prevent duplicates on retries
    quote.idempotencyKey ??= (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'idemp-' + Date.now() + '-' + Math.random().toString(36).slice(2));

    try {
      const fileName = files.map(f => f.name).join(' + ') || 'document.pdf';
      const result = await api('/api/orders', {
        method: 'POST',
        token: quote.token,
        headers: {
          'Idempotency-Key': quote.idempotencyKey
        },
        body: {
          quoteId: quote.id,
          method: methodSelect.value,
          fileName
        }
      });
      onOrder(result);
    } catch (err) {
      let friendlyMessage = err.message || 'Failed to place order.';
      if (err.status === 409) {
        friendlyMessage = 'Your quote or preview has expired. Recalculating price for you...';
        setTimeout(() => recalculateQuote(), 1200);
      } else if (err.status === 404) {
        friendlyMessage = 'Upload session expired. Please select and upload your file again.';
      } else if (err.status === 400) {
        friendlyMessage = 'Please review your print settings and try placing the order again.';
      } else if (err.status === 429) {
        friendlyMessage = 'The print shop is currently busy. Please wait a few seconds and tap Place Print Order again.';
      } else if (err.status >= 500) {
        friendlyMessage = 'Temporary connection issue. Tap Place Print Order to retry safely.';
      }
      errorEl.textContent = friendlyMessage;
      placeBtn.disabled = false;
      placeBtn.innerHTML = `${icon('printer')} Place Print Order · ${quote ? money(quote.amount) : ''} →`;
      isOrdering = false;
      form.inert = false;
      methodSelect.disabled = false;
    }
  };
}
