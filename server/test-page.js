import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export async function generateTestPage(shopName = 'SmartPrint Shop', deviceName = 'Shop Printer') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const width = page.getWidth();
  const height = page.getHeight();

  // Primary Header Banner
  page.drawRectangle({
    x: 36,
    y: height - 120,
    width: width - 72,
    height: 84,
    color: rgb(0.08, 0.42, 0.92),
  });

  page.drawText('SmartPrint · Shop Printer Diagnostic Page', {
    x: 52,
    y: height - 72,
    size: 20,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  page.drawText('Hardware Connection & Auto-Print Verified', {
    x: 52,
    y: height - 96,
    size: 11,
    font,
    color: rgb(0.88, 0.94, 1),
  });

  // Diagnostic Info Section
  const infoY = height - 150;
  page.drawRectangle({
    x: 36,
    y: infoY - 80,
    width: width - 72,
    height: 90,
    color: rgb(0.96, 0.97, 0.99),
    borderColor: rgb(0.85, 0.88, 0.93),
    borderWidth: 1,
  });

  page.drawText(`Shop: ${shopName}`, { x: 50, y: infoY - 20, size: 13, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
  page.drawText(`Printer Device: ${deviceName}`, { x: 50, y: infoY - 42, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
  page.drawText(`Date & Time: ${new Date().toLocaleString('en-IN')}`, { x: 50, y: infoY - 62, size: 10, font, color: rgb(0.4, 0.4, 0.4) });

  // Calibration and Margins Box
  page.drawRectangle({
    x: 36,
    y: 50,
    width: width - 72,
    height: height - 310,
    borderColor: rgb(0.75, 0.78, 0.85),
    borderWidth: 1,
  });

  // Color Swatches
  page.drawText('COLOR & TONER DENSITY CALIBRATION:', { x: 52, y: height - 265, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2) });

  const swatches = [
    { label: 'Cyan', color: rgb(0.0, 0.75, 0.95) },
    { label: 'Magenta', color: rgb(0.90, 0.10, 0.60) },
    { label: 'Yellow', color: rgb(0.98, 0.85, 0.05) },
    { label: 'Black 100%', color: rgb(0.05, 0.05, 0.05) },
    { label: 'Gray 60%', color: rgb(0.40, 0.40, 0.40) },
    { label: 'Gray 30%', color: rgb(0.70, 0.70, 0.70) }
  ];

  const totalWidth = width - 104;
  const swatchWidth = totalWidth / swatches.length;

  swatches.forEach((swatch, idx) => {
    const sx = 52 + idx * swatchWidth;
    page.drawRectangle({
      x: sx,
      y: height - 315,
      width: swatchWidth - 8,
      height: 40,
      color: swatch.color,
    });
    page.drawText(swatch.label, {
      x: sx,
      y: height - 330,
      size: 8,
      font,
      color: rgb(0.3, 0.3, 0.3),
    });
  });

  // Alignment Marks
  page.drawText('PAGE MARGIN & ALIGNMENT TEST:', { x: 52, y: height - 370, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
  page.drawRectangle({
    x: 52,
    y: height - 440,
    width: width - 104,
    height: 55,
    borderColor: rgb(0.8, 0.8, 0.8),
    borderWidth: 1,
    color: rgb(0.98, 0.98, 0.99)
  });
  page.drawText('Outer Margin Box (Top: 36pt, Left: 36pt, Right: 36pt, Bottom: 50pt).', { x: 64, y: height - 400, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
  page.drawText('Verify that all borders appear straight without clipping or skew.', { x: 64, y: height - 420, size: 9, font, color: rgb(0.3, 0.3, 0.3) });

  // Crisp Text & Font Legibility Scale
  page.drawText('MICRO-PRINT & TYPOGRAPHIC RESOLUTION:', { x: 52, y: height - 475, size: 10, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
  page.drawText('6 pt: The quick brown fox jumps over the lazy dog (Clean edge test)', { x: 52, y: height - 495, size: 6, font, color: rgb(0.2, 0.2, 0.2) });
  page.drawText('8 pt: The quick brown fox jumps over the lazy dog (Fine document text)', { x: 52, y: height - 515, size: 8, font, color: rgb(0.2, 0.2, 0.2) });
  page.drawText('10 pt: The quick brown fox jumps over the lazy dog (Standard reading text)', { x: 52, y: height - 535, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
  page.drawText('12 pt: The quick brown fox jumps over the lazy dog (High clarity heading)', { x: 52, y: height - 560, size: 12, font: fontBold, color: rgb(0.1, 0.1, 0.1) });

  // Confirmation Footer
  page.drawRectangle({
    x: 52,
    y: 80,
    width: width - 104,
    height: 60,
    color: rgb(0.92, 0.98, 0.94),
    borderColor: rgb(0.65, 0.88, 0.72),
    borderWidth: 1
  });

  page.drawText('CONFIRMATION SUCCESSFUL:', { x: 66, y: 120, size: 10, font: fontBold, color: rgb(0.08, 0.55, 0.25) });
  page.drawText('Your Windows printer is successfully connected to SmartPrint and printing correctly.', { x: 66, y: 104, size: 9, font, color: rgb(0.12, 0.45, 0.22) });
  page.drawText('You can now fulfill customer jobs seamlessly with automated queue management.', { x: 66, y: 90, size: 9, font, color: rgb(0.12, 0.45, 0.22) });

  page.drawText('SmartPrint Automated Print Pipeline · End-to-End Cryptographic Security', { x: 52, y: 60, size: 8, font, color: rgb(0.5, 0.5, 0.5) });

  return await doc.save();
}
