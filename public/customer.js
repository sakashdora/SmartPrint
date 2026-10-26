import { icon } from './ui.js';
import { downloadPdf, showDocument } from './viewer.js';
import { waitForQuote } from './preparation.js';

export async function renderCustomer({ api, mount, money, escape, health, notify, onOrder }) {
  let slug = new URLSearchParams(location.search).get('shop');
  if (!slug) {
    mount(`<main class="home-master-shell">
      <!-- HERO SECTION -->
      <section class="home-hero-section">
        <div class="home-hero-inner">
          <!-- Left Column -->
          <div class="home-hero-left">
            <div class="home-eyebrow-pill">
              CONTACTLESS &bull; FAST &bull; SECURE &mdash;
            </div>

            <h1 class="home-hero-title">
              Print your documents<br>
              <span class="gradient-text-anytime">anytime,</span> <span class="gradient-text-anywhere">anywhere</span>
            </h1>

            <p class="home-hero-sub">
              Scan the QR code at a SmartPrint shop, upload your document, choose print options, pay and collect. Simple, secure and reliable.
            </p>

            <!-- 3-Step Process Cards -->
            <div class="home-three-steps-row">
              <div class="process-step-card">
                <div class="step-card-top">
                  <span class="step-num-badge step-blue">01</span>
                  <span class="step-icon-corner">${icon('qr')}</span>
                </div>
                <strong class="step-title">Scan at Counter</strong>
                <p class="step-desc">Use your phone to scan your shop's QR code.</p>
              </div>

              <div class="process-step-card">
                <div class="step-card-top">
                  <span class="step-num-badge step-purple">02</span>
                  <span class="step-icon-corner">${icon('file')}</span>
                </div>
                <strong class="step-title">Upload & Options</strong>
                <p class="step-desc">Upload your file, choose B&W or colour, set pages and copies.</p>
              </div>

              <div class="process-step-card">
                <div class="step-card-top">
                  <span class="step-num-badge step-orange">03</span>
                  <span class="step-icon-corner">${icon('printer')}</span>
                </div>
                <strong class="step-title">Pay & Collect</strong>
                <p class="step-desc">Pay by UPI or cash, then collect your printed document.</p>
              </div>
            </div>

            <!-- Hero Action Buttons -->
            <div class="home-hero-cta-box">
              <button type="button" class="btn-hero-primary-wide" id="hero-find-shop-btn">
                ${icon('shop')} <span>Get Started &mdash; Find a Shop &rarr;</span>
              </button>
              <div class="hero-shop-owner-sub">
                <span class="pin-icon">${icon('pin')}</span> Or <a href="#register" class="sub-register-link">register your shop and start accepting print orders</a>
              </div>
            </div>
          </div>

          <!-- Right Column / Hero Composition -->
          <div class="home-hero-right">
            <div class="hero-image-wrapper">
              <img class="hero-main-photo" src="/hero-scanner.jpg" alt="SmartPrint Counter QR Scanner Stand and Customer Phone" width="1280" height="720">
            </div>
          </div>
        </div>
      </section>

      <!-- AUDIENCE CATEGORY CARDS SECTION -->
      <section class="home-audience-section">
        <div class="home-container">
          <div class="audience-cards-grid">
            <!-- Card 1: For Customers -->
            <div class="audience-card blue-theme">
              <div class="audience-card-top">
                <div class="audience-icon-circle blue">
                  ${icon('users')}
                </div>
                <div class="audience-content-block">
                  <h3 class="audience-title">For Customers</h3>
                  <p class="audience-desc">Quick and easy document printing at your local shop.</p>
                </div>
                <span class="audience-arrow">&rarr;</span>
              </div>
              <div class="audience-benefits-strip">
                <span class="benefit-item">${icon('check')} No account needed</span>
                <span class="benefit-item">${icon('check')} Secure upload</span>
                <span class="benefit-item">${icon('check')} Pay at shop</span>
              </div>
            </div>

            <!-- Card 2: For Shop Owners -->
            <a href="#register" class="audience-card green-theme">
              <div class="audience-card-top">
                <div class="audience-icon-circle green">
                  ${icon('shop')}
                </div>
                <div class="audience-content-block">
                  <h3 class="audience-title">For Shop Owners</h3>
                  <p class="audience-desc">Register your shop, get your QR code and start accepting orders.</p>
                </div>
                <span class="audience-arrow">&rarr;</span>
              </div>
              <div class="audience-benefits-strip">
                <span class="benefit-item">${icon('check')} Free to register</span>
                <span class="benefit-item">${icon('check')} Manage print queue</span>
                <span class="benefit-item">${icon('check')} Track payments</span>
              </div>
            </a>

            <!-- Card 3: Enterprise & Security -->
            <a href="#how-it-works" class="audience-card purple-theme">
              <div class="audience-card-top">
                <div class="audience-icon-circle purple">
                  ${icon('shield')}
                </div>
                <div class="audience-content-block">
                  <h3 class="audience-title">Enterprise Security</h3>
                  <p class="audience-desc">Bank-grade encryption, private processing, and zero retention guarantee.</p>
                </div>
                <span class="audience-arrow">&rarr;</span>
              </div>
              <div class="audience-benefits-strip">
                <span class="benefit-item">${icon('check')} End-to-end TLS</span>
                <span class="benefit-item">${icon('check')} Auto-purge files</span>
                <span class="benefit-item">${icon('check')} Zero data leaks</span>
              </div>
            </a>
          </div>
        </div>
      </section>

      <!-- WHY CHOOSE SMARTPRINT SECTION -->
      <section class="home-why-section" id="how-it-works">
        <div class="home-container">
          <div class="why-choose-card">
            <div class="why-choose-grid">
              <!-- Left heading & intro -->
              <div class="why-left-intro">
                <h2 class="why-title">Why choose SmartPrint?</h2>
                <p class="why-subtitle">
                  A simple, secure and reliable way to print your documents at local shops. Built for students, professionals and businesses.
                </p>
              </div>

              <!-- Right 4 benefits items -->
              <div class="why-four-features-grid">
                <div class="why-feature-item">
                  <div class="feature-icon-circle green">
                    ${icon('lightning')}
                  </div>
                  <div class="feature-text-block">
                    <strong class="feature-name">Fast & Easy</strong>
                    <p class="feature-detail">Upload and submit in minutes.</p>
                  </div>
                </div>

                <div class="why-feature-item">
                  <div class="feature-icon-circle blue">
                    ${icon('shield')}
                  </div>
                  <div class="feature-text-block">
                    <strong class="feature-name">Secure & Private</strong>
                    <p class="feature-detail">Your files are automatically deleted.</p>
                  </div>
                </div>

                <div class="why-feature-item">
                  <div class="feature-icon-circle orange">
                    ${icon('pin')}
                  </div>
                  <div class="feature-text-block">
                    <strong class="feature-name">Wide Network</strong>
                    <p class="feature-detail">Print at authorized local shops.</p>
                  </div>
                </div>

                <div class="why-feature-item">
                  <div class="feature-icon-circle purple">
                    ${icon('creditcard')}
                  </div>
                  <div class="feature-text-block">
                    <strong class="feature-name">Flexible Payment</strong>
                    <p class="feature-detail">Pay by UPI or cash at the shop.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- FINAL CALL TO ACTION SECTION -->
      <section class="home-bottom-cta-section" id="for-shop-owners">
        <div class="home-container">
          <div class="bottom-cta-inner">
            <div class="bottom-cta-text">
              <h2 class="bottom-cta-heading">Get started with SmartPrint today</h2>
              <p class="bottom-cta-sub">Find a nearby shop, scan the QR code and print your documents in minutes.</p>
            </div>
            <div class="bottom-cta-actions">
              <button type="button" class="btn-bottom-find-shop" id="bottom-find-shop-btn">
                ${icon('shop')} <span>Find a Shop &rarr;</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Shop Finder Dialog -->
      <dialog class="crop-dialog shop-finder-dialog" id="shop-finder-modal">
        <div class="shop-finder-modal-content">
          <div class="shop-finder-header">
            <div>
              <h3>Choose a SmartPrint Partner Shop</h3>
              <p class="muted">Select an active print shop to open the document upload portal:</p>
            </div>
            <button type="button" class="icon-button modal-close-btn" id="close-shop-finder">&times;</button>
          </div>
          <div class="shop-finder-list" id="shop-finder-list">
            <p class="muted">Loading available shops...</p>
          </div>
        </div>
      </dialog>
    </main>`);

    // Wire up Find a Shop buttons to show the real active shops list
    const openShopModal = async () => {
      const modal = document.querySelector('#shop-finder-modal');
      const listContainer = document.querySelector('#shop-finder-list');
      if (!modal) return;
      modal.showModal();
      try {
        const shops = await api('/api/shops');
        if (!shops || !shops.length) {
          listContainer.innerHTML = `<div class="empty"><strong>No active shops available.</strong><span class="muted">Register your shop to begin accepting customer prints.</span><div style="margin-top:12px;"><a href="#register" class="primary">Register Shop →</a></div></div>`;
          return;
        }
        listContainer.innerHTML = shops.map(s => `
          <a class="shop-finder-item" href="/?shop=${encodeURIComponent(s.slug)}">
            <div class="shop-finder-item-left">
              <div class="shop-finder-icon">${icon('shop')}</div>
              <div>
                <strong>${escape(s.name)}</strong>
                <small class="muted" style="display:block;">${escape(s.location)}</small>
              </div>
            </div>
            <div class="shop-finder-rates">
              <span class="rate-pill">₹${(s.bw / 100).toFixed(2)} B&W</span>
              <span class="rate-pill color">₹${(s.color / 100).toFixed(2)} Colour</span>
              <span class="finder-arrow">→</span>
            </div>
          </a>
        `).join('');
      } catch (err) {
        listContainer.innerHTML = `<p class="error">Unable to load shops: ${escape(err.message)}</p>`;
      }
    };

    document.querySelector('#hero-find-shop-btn')?.addEventListener('click', openShopModal);
    document.querySelector('#bottom-find-shop-btn')?.addEventListener('click', openShopModal);
    document.querySelector('#close-shop-finder')?.addEventListener('click', () => {
      document.querySelector('#shop-finder-modal')?.close();
    });
    return;
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
  let files = [], originalFiles = [], editedFiles = [], activeDocumentMode = 'original';
  let quote = null, isCalculating = false, isOrdering = false;
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
    <!-- Shop Information Card -->
    <div class="shop-context-card">
      <div class="shop-context-left">
        <div class="shop-store-icon">${icon('shop')}</div>
        <div class="shop-context-info">
          <div class="shop-name-row">
            <strong class="shop-name">${escape(shop.name)}</strong>
            <span class="badge badge-open">Open</span>
          </div>
          <div class="shop-location-row">
            ${icon('pin')} <span>${escape(shop.location || 'Local Store')}</span>
          </div>
        </div>
      </div>
      <div class="shop-rates-row">
        <span class="rate-badge rate-bw">${money(shop.bw)} B&W / page</span>
        <span class="rate-badge rate-color">${money(shop.color)} Colour / page</span>
      </div>
    </div>

    <!-- Hero Header -->
    <div class="customer-hero-header">
      <h1 class="customer-hero-title">Upload document to print</h1>
      <p class="customer-hero-sub">Select your file, choose print options, and submit your order directly to the shop printer.</p>
      
      <!-- 3-Step Indicator -->
      <div class="customer-stepper" aria-label="Order progress">
        <div class="step-item is-active" id="step-1">
          <span class="step-circle"><span class="step-circle-num">1</span><span class="step-circle-check">✓</span></span>
          <span class="step-name">Upload file</span>
        </div>
        <div class="step-line" id="line-1"></div>
        <div class="step-item" id="step-2">
          <span class="step-circle"><span class="step-circle-num">2</span><span class="step-circle-check">✓</span></span>
          <span class="step-name">Print options</span>
        </div>
        <div class="step-line" id="line-2"></div>
        <div class="step-item" id="step-3">
          <span class="step-circle"><span class="step-circle-num">3</span><span class="step-circle-check">✓</span></span>
          <span class="step-name">Pay & print</span>
        </div>
      </div>
    </div>

    <!-- Two-Column Order Layout -->
    <div class="customer-order-layout">
      <!-- Left Column: Step 1 (Document) & Step 2 (Print Options) -->
      <div class="customer-steps-column">
        
        <!-- Step 1 Card: Select Document -->
        <section class="panel customer-card select-document-card" id="drop-panel">
          <div class="customer-card-header">
            <div class="card-step-title">
              <span class="step-num-bubble">1</span>
              <h2 id="step-1-card-heading">1. Select Document</h2>
            </div>
            <div class="card-header-actions">
              <span class="badge" id="file-count-badge">No file chosen</span>
              <label class="secondary small btn-change-header" for="files" id="btn-change-header" hidden>
                ${icon('refresh')} <span>Change Document</span>
              </label>
            </div>
          </div>

          <div class="document-section-content">
            <!-- State 1: Upload Dropzone (visible before upload) -->
            <div class="direct-dropzone" id="direct-dropzone">
              <div class="dropzone-icon-circle">
                ${icon('upload')}
              </div>
              <strong class="dropzone-main-text">Drag & drop your document here</strong>
              <span class="dropzone-or-divider">or</span>
              <label class="primary btn-browse-files" for="files">
                ${icon('file')} <span>Browse files</span>
              </label>
              <p class="dropzone-sub-text">PDF, JPG, PNG${health.office ? ', Word, PowerPoint, Excel' : ''}<br>Up to 20 MB</p>
              <input id="files" class="visually-hidden" type="file" accept=".pdf,.jpg,.jpeg,.png${health.office ? ',.docx,.pptx,.xlsx' : ''}" multiple>
            </div>

            <!-- Empty Preview Placeholder (visible before upload) -->
            <div class="preview-empty-card" id="preview-empty-state">
              <div class="preview-empty-icon">${icon('file')}</div>
              <div class="preview-empty-text">
                <strong>Document preview</strong>
                <p>Your document preview will appear here after you upload a file.</p>
              </div>
            </div>

            <!-- State 2: Uploaded File Summary (revealed after upload) -->
            <div class="selected-files-display" id="selected-files-display" hidden>
              <div class="selected-file-item">
                <div class="file-icon-wrap" id="file-icon-wrap">
                  <span class="file-badge-pdf" id="file-type-badge">PDF</span>
                </div>
                <div class="file-meta-wrap">
                  <div class="file-name-row">
                    <strong id="display-file-name" class="file-name-text">filename.pdf</strong>
                  </div>
                  <div class="file-meta-sub-row">
                    <span class="file-size-sub" id="display-file-size">0 KB</span>
                    <span class="file-success-badge" id="file-success-badge">
                      <span class="badge-check-icon">✓</span> File uploaded successfully
                    </span>
                  </div>
                </div>
                <div class="file-actions-wrap">
                  <button type="button" class="secondary small btn-crop-doc" id="btn-crop-doc" style="display:none;" title="Scan & crop document">
                    ${icon('crop')} <span>Edit / Scan</span>
                  </button>
                  <label class="secondary small btn-change-file" for="files" id="btn-change-file" title="Change file">
                    ${icon('refresh')} <span>Change Document</span>
                  </label>
                  <button type="button" class="btn-remove-file" id="btn-remove-file" title="Remove document" aria-label="Remove document">
                    ✕
                  </button>
                </div>
              </div>
            </div>

            <!-- State 2: Dedicated Document Editor Section -->
            <div class="document-editor-card" id="document-editor-card" hidden>
              <div class="doc-editor-section-header">
                <div class="doc-editor-title-group">
                  <strong class="doc-editor-title">Document Editor</strong>
                  <span class="doc-editor-sub">Edit, enhance or rotate your document before printing.</span>
                </div>
                <span class="badge active" id="doc-editor-status-badge">Original (Unedited)</span>
              </div>

              <!-- Mode Selector Tabs -->
              <div class="doc-editor-mode-selector">
                <button type="button" class="doc-mode-toggle is-active" id="btn-choice-original" data-choice="original">
                  Print Original
                </button>
                <button type="button" class="doc-mode-toggle" id="btn-choice-edit" data-choice="edit">
                  Edit / Scan Document
                </button>
              </div>

              <!-- Quick Action Toolbar -->
              <div class="doc-editor-toolbar" id="doc-editor-toolbar">
                <button type="button" class="action-chip-btn" id="chip-doc-rotate" title="Rotate document 90°">
                  ${icon('rotate')} <span>Rotate</span>
                </button>
                <button type="button" class="action-chip-btn" id="chip-doc-autocrop" title="Automatically detect corners and crop">
                  ${icon('crop')} <span>Crop</span>
                </button>
                <button type="button" class="action-chip-btn" id="chip-doc-corners" title="Adjust 4 independent corners">
                  📐 <span>4-Corner</span>
                </button>
                <button type="button" class="action-chip-btn" id="chip-doc-enhance" title="Boost text contrast and clarity">
                  ✨ <span>Enhance</span>
                </button>
                <button type="button" class="action-chip-btn" id="chip-doc-blur" title="Redact private personal details">
                  🔒 <span>Redact</span>
                </button>
                <button type="button" class="action-chip-btn" id="chip-doc-filters" title="Grayscale or Clean B&W">
                  🎨 <span>Filters</span>
                </button>
                <button type="button" class="action-chip-btn" id="btn-revert-original" title="Reset all changes to original">
                  ↺ <span>Reset</span>
                </button>
              </div>

              <!-- Active Edit Banner -->
              <div class="doc-edit-active-banner" id="doc-edit-active-banner" hidden>
                <div class="active-banner-info">
                  <span class="active-banner-pill">✓ Document Edited</span>
                  <span class="active-banner-text" id="doc-edit-active-text">Scanner enhancements applied. Ready for printing.</span>
                </div>
                <div class="active-banner-actions">
                  <button type="button" class="secondary small" id="btn-revert-banner">Revert to Original</button>
                  <button type="button" class="primary small" id="btn-adjust-edits">Adjust Edits</button>
                </div>
              </div>
            </div>

            <!-- State 2: Controlled Document Preview Viewport -->
            <div class="document-preview-pane" id="document-preview-pane" hidden>
              <div class="preview-box-header">
                <div class="preview-header-left">
                  <span class="preview-title">Document preview</span>
                  <span class="preview-pill" id="preview-pill">No file chosen</span>
                </div>
                <div class="preview-header-right">
                  <button type="button" class="secondary small btn-view-layout" id="show-preview" disabled>
                    View print layout
                  </button>
                </div>
              </div>
              <div class="preview-box-content" id="preview-viewport">
                <!-- Actual rendered previews -->
                <div id="source-preview" class="source-preview-container"></div>
                <div id="document-preview" class="document-preview-container"></div>
              </div>
              <div class="preview-box-footer" id="preview-footer" hidden>
                <span class="preview-help-text" id="preview-help"></span>
              </div>
            </div>
          </div>
        </section>

        <!-- Step 2 Card: Print Options -->
        <form id="print-form" class="panel customer-card print-options-card">
          <div class="customer-card-header">
            <div class="card-step-title">
              <span class="step-num-bubble">2</span>
              <h2>2. Print Options</h2>
            </div>
          </div>

          <div class="options-controls-grid">
            <!-- Colour selection -->
            <div class="option-group option-color-group">
              <label class="option-group-label">Colour</label>
              <div class="option-cards-two">
                <label class="option-card choice-card-active">
                  <input type="radio" name="color" value="bw" checked class="visually-hidden">
                  <div class="option-card-inner">
                    <span class="option-radio-dot"></span>
                    <div class="option-card-content">
                      <strong class="option-title">Black & White</strong>
                      <span class="option-price">(${money(shop.bw)})</span>
                    </div>
                  </div>
                </label>
                <label class="option-card">
                  <input type="radio" name="color" value="color" class="visually-hidden">
                  <div class="option-card-inner">
                    <span class="option-radio-dot"></span>
                    <div class="option-card-content">
                      <strong class="option-title">Colour</strong>
                      <span class="option-price">(${money(shop.color)})</span>
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <!-- Sides selection -->
            <div class="option-group option-sides-group">
              <label class="option-group-label">Sides</label>
              <div class="segmented-control segments-two">
                <label class="segment-btn is-active">
                  <input type="radio" name="duplex" value="false" checked class="visually-hidden">
                  <span>One-sided</span>
                </label>
                <label class="segment-btn">
                  <input type="radio" name="duplex" value="true" class="visually-hidden">
                  <span>Both sides (Duplex)</span>
                </label>
              </div>
            </div>

            <!-- Layout selection -->
            <div class="option-group option-layout-group">
              <label class="option-group-label">Layout</label>
              <div class="segmented-control segments-three">
                <label class="segment-btn is-active">
                  <input type="radio" name="layout" value="single" checked class="visually-hidden">
                  <span>Standard</span>
                </label>
                <label class="segment-btn">
                  <input type="radio" name="layout" value="two" class="visually-hidden">
                  <span>2 pages on 1</span>
                </label>
                <label class="segment-btn">
                  <input type="radio" name="layout" value="card" class="visually-hidden">
                  <span>ID Card (Fit)</span>
                </label>
              </div>
            </div>

            <!-- Row: Copies, Range, Format -->
            <div class="options-three-col-row">
              <!-- Copies Stepper -->
              <div class="option-group option-copies-group">
                <label class="option-group-label" for="copies">Copies</label>
                <div class="stepper-box">
                  <button type="button" class="stepper-btn" data-copy="-1" aria-label="Fewer copies">−</button>
                  <input id="copies" name="copies" type="number" min="1" max="100" value="1" required class="stepper-input">
                  <button type="button" class="stepper-btn" data-copy="1" aria-label="More copies">+</button>
                </div>
              </div>

              <!-- Pages to print -->
              <div class="option-group option-range-group">
                <label class="option-group-label" for="print-range-input">Pages to print</label>
                <div class="input-with-icon">
                  <input id="print-range-input" name="range" placeholder="All pages (e.g. 1-3, 5)">
                </div>
              </div>

              <!-- Paper format -->
              <div class="option-group option-paper-group">
                <label class="option-group-label">Paper format</label>
                <div class="paper-format-box">
                  <span class="paper-name">A4 standard</span>
                  <small class="paper-dims">(210 × 297 mm)</small>
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>

      <!-- Right Column: Order Summary Card -->
      <aside class="customer-summary-column">
        <section class="panel customer-card customer-order-summary-card">
          <div class="summary-card-header">
            <span class="summary-header-icon">${icon('file')}</span>
            <h2>Order Summary</h2>
          </div>

          <div class="summary-specs-list" id="summary-specs">
            <div class="summary-spec-row">
              <span>Status</span>
              <strong id="order-status-text" class="badge badge-awaiting" aria-live="polite">Awaiting Document</strong>
            </div>
            <div class="summary-spec-row">
              <span>Pages</span>
              <strong id="spec-pages">—</strong>
            </div>
            <div class="summary-spec-row">
              <span>Paper sheets</span>
              <strong id="spec-sheets">—</strong>
            </div>
            <div class="summary-spec-row">
              <span>Copies</span>
              <strong id="spec-copies">1</strong>
            </div>
            <div class="summary-spec-row">
              <span>Colour</span>
              <strong id="summary-spec-color">Black & White</strong>
            </div>
            <div class="summary-spec-row">
              <span>Sides</span>
              <strong id="summary-spec-sides">One-sided</strong>
            </div>
            <div class="summary-spec-row">
              <span>Layout</span>
              <strong id="summary-spec-layout">Standard</strong>
            </div>
            <div class="summary-spec-row">
              <span>Paper size</span>
              <strong id="summary-spec-paper">A4 (210 × 297 mm)</strong>
            </div>
            <div class="summary-spec-row" id="summary-doc-mode-row">
              <span>Document</span>
              <strong id="summary-doc-mode-text" class="badge">Original</strong>
            </div>
          </div>

          <div class="summary-total-section">
            <span class="total-label-caps">TOTAL AMOUNT</span>
            <strong id="total-amount" class="total-price-large">—</strong>
            <small class="total-price-sub" id="price-subnote">Select a document to calculate price</small>
          </div>

          <div class="summary-payment-section">
            <label class="field payment-select-field">
              <span class="payment-label">Payment Method</span>
              <div class="payment-select-wrap">
                <span class="payment-select-icon">${icon('wallet')}</span>
                <select id="method">
                  ${health.payments ? '<option value="online">Online Payment (UPI, Cards, Netbanking)</option>' : ''}
                  <option value="upi" ${shop.upi_id ? 'selected' : 'disabled'}>Direct UPI · Shop verifies${shop.upi_id ? '' : ' (unavailable)'}</option>
                  <option value="cash" ${!shop.upi_id && !health.payments ? 'selected' : ''}>Cash at counter</option>
                </select>
              </div>
            </label>
            <div class="payment-instruction-box">
              ${icon('info')}
              <span id="payment-note">Pay directly to the shop’s UPI QR on the next screen. The shop verifies and prints immediately.</span>
            </div>
          </div>

          <button id="place-order-btn" class="primary wide btn-place-order" disabled>
            ${icon('lock')} <span>Place Print Order →</span>
          </button>

          <p class="inline-error" id="order-error" role="alert"></p>
          <button type="button" class="secondary wide btn-retry-quote" id="retry-quote" hidden>Retry preparation</button>

          <div class="summary-security-footer">
            <div class="security-lock-icon">${icon('shield')}</div>
            <p>Your files are encrypted. Print files are deleted after printing; temporary uploads expire automatically.</p>
          </div>
        </section>
      </aside>
    </div>

    <!-- Bottom: Privacy Information & Supporting Assurance -->
    <div class="customer-bottom-privacy-card">
      <div class="bottom-privacy-inner">
        <div class="bottom-privacy-icon">${icon('shield')}</div>
        <div class="bottom-privacy-content">
          <strong>Your files are secure</strong>
          <p>Files are encrypted and automatically deleted after printing. Temporary uploads expire automatically.</p>
        </div>
      </div>
    </div>

    <!-- Trust Strip -->
    <div class="customer-trust-strip">
      <div class="trust-badge-item">
        <div class="trust-icon-box icon-green">${icon('lock')}</div>
        <div class="trust-text">
          <strong>Secure & Private</strong>
          <p>Your files are encrypted and automatically deleted after printing.</p>
        </div>
      </div>
      <div class="trust-badge-item">
        <div class="trust-icon-box icon-blue">${icon('lightning')}</div>
        <div class="trust-text">
          <strong>Fast & Convenient</strong>
          <p>Upload, pay and print in minutes directly at your local shop.</p>
        </div>
      </div>
      <div class="trust-badge-item">
        <div class="trust-icon-box icon-teal">${icon('shield')}</div>
        <div class="trust-text">
          <strong>Trusted by Students & Professionals</strong>
          <p>High quality prints with instant contactless pickup across partner shops.</p>
        </div>
      </div>
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

  function updateSummarySpecs() {
    const options = readOptions();
    const colorEl = document.querySelector('#summary-spec-color');
    if (colorEl) colorEl.textContent = options.color === 'color' ? 'Colour' : 'Black & White';
    const sidesEl = document.querySelector('#summary-spec-sides');
    if (sidesEl) sidesEl.textContent = options.duplex ? 'Both sides (Duplex)' : 'One-sided';
    const layoutEl = document.querySelector('#summary-spec-layout');
    if (layoutEl) layoutEl.textContent = options.layout === 'card' ? 'ID Card (Fit)' : options.layout === 'two' ? '2 pages on 1' : 'Standard';
    const copiesEl = document.querySelector('#spec-copies');
    if (copiesEl) copiesEl.textContent = String(options.copies);
  }

  function updateFileMetaDisplay(pageCount) {
    const activeList = activeDocumentMode === 'original' ? originalFiles : editedFiles;
    if (!activeList.length) return;
    const names = activeList.map(f => f.name).join(' + ');
    const totalSize = activeList.reduce((sum, f) => sum + f.size, 0);
    const nameEl = document.querySelector('#display-file-name');
    const sizeEl = document.querySelector('#display-file-size');
    if (nameEl) nameEl.textContent = names;
    if (sizeEl) {
      const pageNum = pageCount ?? (quote?.pages);
      const pageStr = pageNum ? ` • ${pageNum} page${pageNum === 1 ? '' : 's'}` : (activeList.length === 1 ? ' • 1 file' : ' • 2 files');
      sizeEl.textContent = `${formatBytes(totalSize)}${pageStr}`;
    }
    const badgeEl = document.querySelector('#file-type-badge');
    if (badgeEl && activeList[0]) {
      const isPdf = /\.pdf$/i.test(activeList[0].name);
      const isImg = /\.(png|jpe?g)$/i.test(activeList[0].name);
      badgeEl.textContent = isPdf ? 'PDF' : isImg ? 'IMG' : 'DOC';
      badgeEl.className = isPdf ? 'file-badge-pdf' : isImg ? 'file-badge-img' : 'file-badge-doc';
    }
  }

  function switchToOriginalMode() {
    activeDocumentMode = 'original';
    files = originalFiles;
    document.querySelector('#btn-choice-original')?.classList.add('is-active');
    document.querySelector('#btn-choice-edit')?.classList.remove('is-active');
    const badge = document.querySelector('#doc-editor-status-badge');
    if (badge) {
      badge.textContent = 'Original (Unedited)';
      badge.className = 'badge active';
    }
    const sumBadge = document.querySelector('#summary-doc-mode-text');
    if (sumBadge) {
      sumBadge.textContent = 'Original';
      sumBadge.className = 'badge';
    }
    const banner = document.querySelector('#doc-edit-active-banner');
    if (banner) banner.hidden = true;
    updateFileMetaDisplay();
    scheduleQuote();
    void previewSources(files);
    notify('Switched to Original document. Printing without edits.');
  }

  function switchToEditedMode() {
    activeDocumentMode = 'edited';
    files = editedFiles;
    document.querySelector('#btn-choice-original')?.classList.remove('is-active');
    document.querySelector('#btn-choice-edit')?.classList.add('is-active');
    const badge = document.querySelector('#doc-editor-status-badge');
    if (badge) {
      badge.textContent = 'Scanned & Enhanced';
      badge.className = 'badge printing';
    }
    const sumBadge = document.querySelector('#summary-doc-mode-text');
    if (sumBadge) {
      sumBadge.textContent = 'Scanned & Enhanced';
      sumBadge.className = 'badge active';
    }
    const banner = document.querySelector('#doc-edit-active-banner');
    if (banner) {
      banner.hidden = false;
      const bannerText = document.querySelector('#doc-edit-active-text');
      if (bannerText && editedFiles[0]) {
        bannerText.textContent = `Scanner enhancements applied (${editedFiles[0].name}).`;
      }
    }
    updateFileMetaDisplay();
    scheduleQuote();
    void previewSources(files);
    notify('Document updated with scanner enhancements.');
  }

  async function launchDocumentEditor(initialMode = 'auto') {
    if (!files.length) return;
    const targetFile = originalFiles[0];
    let editableFile = targetFile;

    // If PDF, render target page to high-DPI image for scanner operations
    if (/\.pdf$/i.test(targetFile.name)) {
      try {
        notify('Preparing document page for editor...');
        const pdfjs = await import('/vendor/pdfjs/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
        const arrayBuf = await targetFile.arrayBuffer();
        const task = pdfjs.getDocument({
          data: new Uint8Array(arrayBuf),
          isEvalSupported: false,
          maxImageSize: 20_000_000,
          standardFontDataUrl: '/vendor/pdfjs-fonts/',
          wasmUrl: '/vendor/pdfjs-wasm/'
        });
        const pdf = await task.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2.2 });
        const offCanvas = document.createElement('canvas');
        offCanvas.width = viewport.width;
        offCanvas.height = viewport.height;
        await page.render({ canvasContext: offCanvas.getContext('2d'), viewport }).promise;
        const blob = await new Promise(res => offCanvas.toBlob(res, 'image/png'));
        offCanvas.width = offCanvas.height = 1;
        editableFile = new File([blob], targetFile.name.replace(/\.[^.]+$/, '') + '-page1.png', { type: 'image/png' });
      } catch (err) {
        notify('Unable to extract page for scanning: ' + err.message);
        return;
      }
    }

    try {
      const result = await openDocumentEditor({
        file: editableFile,
        initialMode,
        onPrintOriginal: () => {
          switchToOriginalMode();
        }
      });

      if (result && result.action === 'edited' && result.file) {
        editedFiles = [result.file];
        switchToEditedMode();
      } else if (result && result.action === 'original') {
        switchToOriginalMode();
      }
    } catch (err) {
      notify(err.message);
    }
  }

  // Bind Document Editor Mode and Toolbar buttons immediately
  document.querySelector('#btn-choice-original')?.addEventListener('click', () => switchToOriginalMode());
  document.querySelector('#btn-choice-edit')?.addEventListener('click', () => launchDocumentEditor('auto'));
  document.querySelector('#chip-doc-autocrop')?.addEventListener('click', () => launchDocumentEditor('auto'));
  document.querySelector('#chip-doc-corners')?.addEventListener('click', () => launchDocumentEditor('perspective'));
  document.querySelector('#chip-doc-enhance')?.addEventListener('click', () => launchDocumentEditor('enhance'));
  document.querySelector('#chip-doc-blur')?.addEventListener('click', () => launchDocumentEditor('blur'));
  document.querySelector('#chip-doc-rotate')?.addEventListener('click', () => launchDocumentEditor('rotate'));
  document.querySelector('#chip-doc-filters')?.addEventListener('click', () => launchDocumentEditor('filter'));
  document.querySelector('#btn-revert-original')?.addEventListener('click', () => switchToOriginalMode());
  document.querySelector('#btn-revert-banner')?.addEventListener('click', () => switchToOriginalMode());
  document.querySelector('#btn-adjust-edits')?.addEventListener('click', () => launchDocumentEditor('perspective'));
  document.querySelector('#btn-crop-doc')?.addEventListener('click', () => launchDocumentEditor('auto'));

  // Bind Remove Document button
  document.querySelector('#btn-remove-file')?.addEventListener('click', () => {
    if (isOrdering || isCalculating) return;
    files = [];
    originalFiles = [];
    editedFiles = [];
    activeDocumentMode = 'original';
    fileInput.value = '';
    dropzone.hidden = false;
    fileDisplay.hidden = true;
    const editorCard = document.querySelector('#document-editor-card');
    if (editorCard) editorCard.hidden = true;
    const previewPane = document.querySelector('#document-preview-pane');
    if (previewPane) previewPane.hidden = true;
    const previewEmpty = document.querySelector('#preview-empty-state');
    if (previewEmpty) previewEmpty.hidden = false;
    const changeHeader = document.querySelector('#btn-change-header');
    if (changeHeader) changeHeader.hidden = true;
    statusBadge.textContent = 'No file chosen';
    statusBadge.className = 'badge';
    const cardHeading = document.querySelector('#step-1-card-heading');
    if (cardHeading) cardHeading.textContent = '1. Select Document';
    document.querySelector('#step-1')?.classList.remove('complete');
    document.querySelector('#step-1')?.classList.add('is-active');
    document.querySelector('#step-2')?.classList.remove('is-active', 'complete');
    document.querySelector('#step-3')?.classList.remove('is-active', 'complete');
    document.querySelector('#line-1')?.classList.remove('is-active');
    document.querySelector('#line-2')?.classList.remove('is-active');
    previewSources([]);
    quote = null;
    preparedQuote = null;
    pendingPreparation = null;
    placeBtn.disabled = true;
    document.querySelector('#spec-pages').textContent = '—';
    document.querySelector('#spec-sheets').textContent = '—';
    document.querySelector('#total-amount').textContent = '—';
    document.querySelector('#price-subnote').textContent = 'Select a document to calculate price';
    orderStatusText.textContent = 'Awaiting Document';
    orderStatusText.className = 'badge badge-awaiting';
    placeBtn.innerHTML = `${icon('printer')} <span>Place Print Order →</span>`;
    notify('Document removed.');
  });

  form.querySelectorAll('input[type=radio]').forEach(radio => {
    radio.addEventListener('change', () => {
      const name = radio.name;
      form.querySelectorAll(`input[name="${name}"]`).forEach(r => {
        const cardParent = r.closest('.option-card');
        const segParent = r.closest('.segment-btn');
        if (cardParent) cardParent.classList.toggle('choice-card-active', r.checked);
        if (segParent) segParent.classList.toggle('is-active', r.checked);
      });
      updateSummarySpecs();
    });
  });

  async function previewSources(selected) {
    const generation = ++sourceRevision;
    localPreviews.forEach(view => view.destroy());
    localPreviews = [];
    const container = document.querySelector('#source-preview');
    container.replaceChildren();
    const emptyState = document.querySelector('#preview-empty-state');
    const previewPill = document.querySelector('#preview-pill');
    const previewFooter = document.querySelector('#preview-footer');
    const previewPane = document.querySelector('#document-preview-pane');

    if (selected.length) {
      if (emptyState) emptyState.hidden = true;
      if (previewPane) previewPane.hidden = false;
      if (previewPill) previewPill.textContent = selected.map(f => f.name).join(', ');
      if (previewFooter) previewFooter.hidden = false;
      document.querySelector('#step-1')?.classList.add('complete');
      document.querySelector('#step-1')?.classList.remove('is-active');
      document.querySelector('#step-2')?.classList.add('is-active');
      document.querySelector('#line-1')?.classList.add('is-active');
    } else {
      if (emptyState) emptyState.hidden = false;
      if (previewPane) previewPane.hidden = true;
      if (previewPill) previewPill.textContent = 'No file chosen';
      if (previewFooter) previewFooter.hidden = true;
    }

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
    updateSummarySpecs();
    scheduleQuote();
  };
  form.onchange = () => {
    if (form.elements.layout.value === 'card') {
      form.querySelector('[name=duplex][value=false]').checked = true;
    }
    updateSummarySpecs();
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
      orderStatusText.textContent = 'Ready to Print';
      orderStatusText.className = 'badge active';
      document.querySelector('#step-2')?.classList.add('complete');
      document.querySelector('#step-3')?.classList.add('is-active');
      document.querySelector('#line-2')?.classList.add('is-active');
      placeBtn.disabled = false;
      previewButton.disabled = false;
      if (!localPreviews.length) document.querySelector('#preview-help').textContent = 'Your order is ready. Viewing the print layout is optional.';
      placeBtn.innerHTML = `${icon('lock')} <span>Place Print Order · ${money(result.amount)} →</span>`;
      updateFileMetaDisplay(result.pages);
      updateSummarySpecs();
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

    originalFiles = [...next];
    editedFiles = [...next];
    activeDocumentMode = 'original';
    files = originalFiles;

    dropzone.hidden = true;
    fileDisplay.hidden = false;

    const editorCard = document.querySelector('#document-editor-card');
    if (editorCard) editorCard.hidden = false;
    const previewEmpty = document.querySelector('#preview-empty-state');
    if (previewEmpty) previewEmpty.hidden = true;
    const previewPane = document.querySelector('#document-preview-pane');
    if (previewPane) previewPane.hidden = false;
    const changeHeader = document.querySelector('#btn-change-header');
    if (changeHeader) changeHeader.hidden = false;
    const cardHeading = document.querySelector('#step-1-card-heading');
    if (cardHeading) cardHeading.textContent = '1. Document';

    updateFileMetaDisplay();
    statusBadge.textContent = `${files.length} file ready`;
    statusBadge.className = 'badge active';

    const choiceOrig = document.querySelector('#btn-choice-original');
    if (choiceOrig) choiceOrig.onclick = () => switchToOriginalMode();

    const choiceEdit = document.querySelector('#btn-choice-edit');
    if (choiceEdit) choiceEdit.onclick = () => launchDocumentEditor('auto');

    const chipAuto = document.querySelector('#chip-doc-autocrop');
    if (chipAuto) chipAuto.onclick = () => launchDocumentEditor('auto');

    const chipCorners = document.querySelector('#chip-doc-corners');
    if (chipCorners) chipCorners.onclick = () => launchDocumentEditor('perspective');

    const chipEnhance = document.querySelector('#chip-doc-enhance');
    if (chipEnhance) chipEnhance.onclick = () => launchDocumentEditor('enhance');

    const chipBlur = document.querySelector('#chip-doc-blur');
    if (chipBlur) chipBlur.onclick = () => launchDocumentEditor('blur');

    const chipRotate = document.querySelector('#chip-doc-rotate');
    if (chipRotate) chipRotate.onclick = () => launchDocumentEditor('rotate');

    const chipFilters = document.querySelector('#chip-doc-filters');
    if (chipFilters) chipFilters.onclick = () => launchDocumentEditor('filter');

    const revertBtn = document.querySelector('#btn-revert-original');
    if (revertBtn) revertBtn.onclick = () => switchToOriginalMode();

    const revertBanner = document.querySelector('#btn-revert-banner');
    if (revertBanner) revertBanner.onclick = () => switchToOriginalMode();

    const adjustBtn = document.querySelector('#btn-adjust-edits');
    if (adjustBtn) adjustBtn.onclick = () => launchDocumentEditor('perspective');

    const cropBtn = document.querySelector('#btn-crop-doc');
    if (cropBtn) {
      cropBtn.hidden = false;
      if (cropBtn.style) cropBtn.style.display = 'inline-flex';
      cropBtn.onclick = () => launchDocumentEditor('auto');
    }

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
