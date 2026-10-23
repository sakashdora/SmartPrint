import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
await mkdir('.data/fixtures', { recursive: true });
const pdf = await PDFDocument.create(), regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
for (let n = 1; n <= 2; n++) {
  const page = pdf.addPage([595.28, 841.89]);
  page.drawRectangle({ x: 0, y: 720, width: 595.28, height: 121, color: rgb(0.1,0.32,0.65) });
  page.drawText('Project notes', { x: 44, y: 775, size: 28, font: bold, color: rgb(1,1,1) });
  page.drawText(`Sample document / page ${n}`, { x: 44, y: 745, size: 12, font: regular, color: rgb(1,1,1) });
  page.drawText(n === 1 ? 'Planning a community garden' : 'Our next steps', { x: 44, y: 665, size: 21, font: bold });
  const lines = n === 1 ? ['A shared space for neighbours to grow herbs and vegetables.', 'The plan starts with four raised beds and a small seating area.', '', 'Materials', '4 raised garden beds', '8 bags of compost', 'Watering cans and hand tools', '', 'Everyone can help for an hour on Saturday morning.'] : ['1. Confirm the location and available sunlight.', '2. Choose easy seasonal plants.', '3. Prepare the soil and arrange the raised beds.', '4. Make a simple watering schedule.', '', 'This is a synthetic document for print-preview testing.'];
  lines.forEach((line, i) => page.drawText(line, { x: 44, y: 620 - i * 30, size: 13, font: regular }));
  page.drawRectangle({ x: 44, y: 170, width: 505, height: 100, color: rgb(.9,.95,.9) });
  page.drawText('Preview the layout before printing.', { x: 64, y: 216, size: 16, font: bold, color: rgb(.1,.4,.2) });
}
await writeFile('.data/fixtures/sample-document.pdf', await pdf.save());
const image = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#ffffff' } }).composite([{ input: Buffer.from('<svg width="1000" height="600"><rect x="80" y="80" width="840" height="440" rx="20" fill="#dbe9fa"/><text x="130" y="200" font-size="42" fill="#17477c">SAMPLE CARD</text><text x="130" y="280" font-size="28">Alex Sample</text><text x="130" y="340" font-size="22">Preview test - not a real ID</text></svg>') }]).png().toBuffer();
await writeFile('.data/fixtures/sample-card.png', image);
console.log('Synthetic preview files created.');
