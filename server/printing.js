import { selectedPages } from './print-options.js';
export { validateOptions, selectedPages, price } from './print-options.js';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

async function grayscalePdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fontPath = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
  const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: fontPath, useSystemFonts: false, isEvalSupported: false, maxImageSize: 20_000_000 });
  const pdf = await task.promise;
  const output = await PDFDocument.create();
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const source = await pdf.getPage(n), viewport = source.getViewport({ scale: 2 });
      if (viewport.width * viewport.height > 20_000_000 || viewport.width <= 0 || viewport.height <= 0) throw new Error('Page dimensions are too large.');
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await source.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const jpg = await sharp(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength), {
        raw: { width: canvas.width, height: canvas.height, channels: 4 }
      }).greyscale().jpeg({ quality: 92 }).toBuffer();
      const image = await output.embedJpg(jpg), page = output.addPage([viewport.width / 2, viewport.height / 2]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      canvas.width = 1; canvas.height = 1; source.cleanup();
    }
    return output.save();
  } finally { await task.destroy(); }
}

export async function prepare(files, options) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) throw new Error('Upload one PDF/image, or two images for a card pair.');
  if (options.layout === 'card' ? files.length !== 2 : files.length !== 1) throw new Error('Card pair needs two images; other layouts need one file.');
  const source = await PDFDocument.create();
  let totalBytes = 0;
  let hasPdfInput = false;
  for (const file of files) {
    if (typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('Invalid upload encoding.');
    const bytes = Buffer.from(file.data, 'base64'); totalBytes += bytes.length;
    if (totalBytes > 20 * 1024 * 1024) throw new Error('Upload up to 20 MiB in total.');
    const isPdf = bytes.subarray(0, 5).toString() === '%PDF-';
    if (isPdf) {
      hasPdfInput = true;
      if (options.layout === 'card') throw new Error('Use two JPG or PNG images for a card pair.');
      if (options.crop || options.enhance || options.smartCrop || options.rotate) throw new Error('Crop, rotate and enhancement are available for images. Reset these options for a PDF.');
      const pdf = await PDFDocument.load(bytes);
      if (pdf.getPageCount() > 100) throw new Error('Upload a document with at most 100 pages.');
      for (const page of await source.copyPages(pdf, pdf.getPageIndices())) source.addPage(page);
    } else {
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpg) throw new Error('Supported files are PDF, JPG and PNG.');
      let pipeline = sharp(bytes, { limitInputPixels: 40_000_000 }).rotate();
      if (options.smartCrop) pipeline = pipeline.trim({ threshold: 12 });
      let normalized = await pipeline.png().toBuffer();
      if (options.crop) { const meta = await sharp(normalized).metadata(); const x = Math.floor(meta.width * options.crop / 100), y = Math.floor(meta.height * options.crop / 100); normalized = await sharp(normalized).extract({ left: x, top: y, width: meta.width - 2 * x, height: meta.height - 2 * y }).png().toBuffer(); }
      pipeline = sharp(normalized).rotate(options.rotate);
      if (options.enhance) pipeline = pipeline.normalize().sharpen();
      if (options.color === 'bw') pipeline = pipeline.greyscale();
      const image = await source.embedPng(await pipeline.png().toBuffer());
      const page = source.addPage([image.width, image.height]); page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }
  }
  const selection = selectedPages(options.range, source.getPageCount());
  if (!selection.length || (options.layout === 'card' && selection.length !== 2)) throw new Error('Select both images for a card pair.');
  const output = await PDFDocument.create();
  await source.flush();
  const embedded = await output.embedPages(selection.map(i => source.getPage(i)));
  const perSide = options.layout === 'single' ? 1 : 2;
  for (let i = 0; i < embedded.length; i += perSide) {
    const page = output.addPage([595.28, 841.89]);
    for (let j = 0; j < perSide && embedded[i + j]; j++) {
      const item = embedded[i + j];
      const box = options.layout === 'card' ? { x: 60, y: 550 - j * 185, w: 242.65, h: 153.07 } : { x: 24, y: perSide === 1 ? 24 : 433 - j * 409, w: 547.28, h: perSide === 1 ? 793.89 : 385 };
      const scale = Math.min(box.w / item.width, box.h / item.height);
      page.drawPage(item, { x: box.x + (box.w - item.width * scale) / 2, y: box.y + (box.h - item.height * scale) / 2, width: item.width * scale, height: item.height * scale });
    }
  }
  const outputBytes = await output.save();
  const needsPdfGrayscale = options.color === 'bw' && hasPdfInput;
  return { bytes: needsPdfGrayscale ? await grayscalePdf(outputBytes) : outputBytes, pages: selection.length, outputPages: output.getPageCount() };
}
