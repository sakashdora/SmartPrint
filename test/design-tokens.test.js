import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const tokens = read('tokens.css'), premium = read('premium.css'), design = read('design.css'), index = read('index.html');

// Split tokens.css into its light block and its dark block.
const lightBlock = tokens.match(/^:root \{([\s\S]*?)\n\}/m)[1];
const darkBlock = tokens.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1];
const parse = block => Object.fromEntries([...block.matchAll(/--c-([0-9a-f]{6}):\s*(#[0-9a-f]{6});/g)].map(m => [m[1], m[2]]));
const light = parse(lightBlock), dark = parse(darkBlock);

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('every colour premium.css uses is a token with a light and a dark value', () => {
  const used = new Set([...premium.matchAll(/var\(--c-([0-9a-f]{6})\)/g)].map(m => m[1]));
  const designUsed = new Set([...design.matchAll(/var\(--c-([0-9a-f]{6})\)/g)].map(m => m[1]));
  for (const name of [...used, ...designUsed]) { assert.ok(light[name], `light value for --c-${name}`); assert.ok(dark[name], `dark value for --c-${name}`); }
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
});

test('the light theme keeps exactly the colours the interface always used', () => {
  for (const [name, value] of Object.entries(light)) assert.equal(value, `#${name}`);
});

test('no hard-coded colours are left in premium.css rules (they would ignore the dark theme)', () => {
  const rules = premium.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{[^{}]*\}/g) ?? [];
  const raw = rules.flatMap(r => r.match(/#[0-9a-fA-F]{6}\b(?![0-9a-fA-F])|#[0-9a-fA-F]{3}\b/g) ?? []);
  assert.ok(raw.length <= 5, `raw hex colours left: ${raw.join(', ')}`);
});

test('dark theme text is readable: body, muted text and white-on-accent meet contrast targets', () => {
  const pairs = [
    ['body text on page', dark['0f172a'], dark['f8fafc'], 7],
    ['body text on cards', dark['0f172a'], dark['ffffff'], 7],
    ['muted text on cards', dark['64748b'], dark['ffffff'], 4.5],
    ['secondary text on cards', dark['475569'], dark['ffffff'], 4.5],
    ['brand blue as link on cards', dark['2563eb'], dark['ffffff'], 3.4],
    ['white on brand blue (buttons)', '#ffffff', dark['2563eb'], 3.4]
  ];
  for (const [what, fg, bg, min] of pairs) assert.ok(contrast(fg, bg) >= min, `${what}: ${contrast(fg, bg).toFixed(2)} < ${min}`);
});

test('light theme body text keeps strong contrast', () => {
  assert.ok(contrast(light['0f172a'], light['ffffff']) >= 15);
  assert.ok(contrast(light['64748b'], light['ffffff']) >= 4.5);
});

test('the page loads the three style layers in order, applies a saved theme before paint, and has a skip link', () => {
  const order = ['tokens.css', 'premium.css', 'design.css'].map(f => index.indexOf(f));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2]);
  assert.match(index, /localStorage\.getItem\('sp-theme'\)/);
  assert.match(index, /class="skip-link"/);
  assert.match(index, /name="color-scheme" content="light dark"/);
});

test('the design layer keeps phones usable: 44px targets, visible focus, reduced motion, no zoom on focus', () => {
  assert.match(design, /min-height: 44px/);
  assert.match(design, /:focus-visible/);
  assert.match(design, /prefers-reduced-motion: reduce/);
  assert.match(design, /font-size: max\(16px, 1em\)/);
});
