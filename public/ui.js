// Fixed, local SVG paths keep icons consistent without an external font or service.
const paths = {
  printer: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6zM17 12h1"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  file: '<path d="M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h6"/>',
  wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M16 14h5M3 5l14-3v3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/>',
  shop: '<path d="M3 10h18l-2-7H5zM4 10v11h16V10M9 21v-7h6v7M3 10c0 4 4 4 4 0 0 4 5 4 5 0 0 4 5 4 5 0 0 4 4 4 4 0"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6zM8 12l3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  refresh: '<path d="M20 7V2m0 5h-5M4 17v5m0-5h5M20 7a9 9 0 0 0-16 3m0 7a9 9 0 0 0 16-3"/>',
  qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6zM21 12h-3M12 3v3M12 12h3M3 12h3M12 18v3"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
  lock: '<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v3"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>',
  logout: '<path d="M9 3H3v18h6M9 12h12m-5-5 5 5-5 5"/>',
  sliders: '<path d="M3 6h4m6 0h8M3 18h10m6 0h2M7 3v6h6V3zM13 15v6h6v-6z"/>',
  crop: '<path d="M6 2v16h16M2 6h16v16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
};
export function icon(name, className = '') {
  return `<svg class="icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
}
export const brand = () => `<a class="brand" href="#print" aria-label="SmartPrint home"><img class="brand-img" src="/logo.png" alt="SmartPrint"></a>`;
