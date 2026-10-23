import { cp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['scripts/check.mjs'], { stdio: 'inherit' });
await mkdir('public/vendor', { recursive: true });
await cp('node_modules/pdfjs-dist/build', 'public/vendor/pdfjs', { recursive: true });
await cp('node_modules/pdfjs-dist/standard_fonts', 'public/vendor/pdfjs-fonts', { recursive: true });
await cp('node_modules/pdfjs-dist/wasm', 'public/vendor/pdfjs-wasm', { recursive: true });
console.log('Vercel static assets prepared.');
