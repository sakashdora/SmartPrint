// Export the complete counter sign, including an unobstructed QR quiet zone.
export async function downloadQrPoster(shop, qr) {
  if (!qr || !qr.image) {
    throw new Error('QR image data is missing.');
  }

  const image = new Image();
  image.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    image.onload = done;
    image.onerror = () => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Failed to load QR code image for poster.'));
      }
    };
    image.src = qr.image;
    if (image.complete && image.naturalWidth > 0) {
      done();
    } else if (typeof image.decode === 'function') {
      image.decode().then(done).catch(() => {});
    }
  });

  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 2200;
  const ctx = canvas.getContext('2d');

  // Clean white poster background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1600, 2200);

  // Top brand stripe gradient
  const grad = ctx.createLinearGradient(0, 0, 1600, 0);
  grad.addColorStop(0, '#2563eb');
  grad.addColorStop(1, '#7c3aed');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1600, 28);

  ctx.textAlign = 'center';
  const text = (value, y, size, color = '#0f172a', weight = 600) => {
    const str = String(value ?? '');
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px "Inter", "Segoe UI", system-ui, sans-serif`;
    while (ctx.measureText(str).width > 1380 && size > 20) {
      size--;
      ctx.font = `${weight} ${size}px "Inter", "Segoe UI", system-ui, sans-serif`;
    }
    ctx.fillText(str, 800, y);
  };

  // Top badge: OFFICIAL COUNTER QR
  ctx.fillStyle = '#eff6ff';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(580, 75, 440, 52, 26);
  } else {
    ctx.rect(580, 75, 440, 52);
  }
  ctx.fill();
  ctx.strokeStyle = '#bfdbfe';
  ctx.lineWidth = 2;
  ctx.stroke();

  text('✦ OFFICIAL COUNTER QR ✦', 110, 24, '#1d4ed8', 700);

  // Shop Name & Subtitle
  text(shop?.name || 'SmartPrint Counter', 230, 78, '#0f172a', 800);
  if (shop?.location) {
    text(shop.location, 290, 32, '#64748b', 500);
  }
  text('Scan to print documents directly from your phone', 360, 36, '#2563eb', 600);

  // QR frame background with soft border
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(240, 430, 1120, 1120, 36);
  } else {
    ctx.rect(240, 430, 1120, 1120);
  }
  ctx.fill();
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 4 Corner brackets (matching the UI standee frame)
  const cornerLen = 50;
  const cornerPad = 265;
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';

  // Top-left
  ctx.beginPath();
  ctx.moveTo(cornerPad, cornerPad + 185 + cornerLen);
  ctx.lineTo(cornerPad, cornerPad + 185);
  ctx.lineTo(cornerPad + cornerLen, cornerPad + 185);
  ctx.stroke();

  // Top-right
  ctx.beginPath();
  ctx.moveTo(1600 - cornerPad - cornerLen, cornerPad + 185);
  ctx.lineTo(1600 - cornerPad, cornerPad + 185);
  ctx.lineTo(1600 - cornerPad, cornerPad + 185 + cornerLen);
  ctx.stroke();

  // Bottom-left
  ctx.beginPath();
  ctx.moveTo(cornerPad, 1550 - cornerLen);
  ctx.lineTo(cornerPad, 1550);
  ctx.lineTo(cornerPad + cornerLen, 1550);
  ctx.stroke();

  // Bottom-right
  ctx.beginPath();
  ctx.moveTo(1600 - cornerPad - cornerLen, 1550);
  ctx.lineTo(1600 - cornerPad, 1550);
  ctx.lineTo(1600 - cornerPad, 1550 - cornerLen);
  ctx.stroke();

  // Draw the QR Code image cleanly inside
  ctx.drawImage(image, 310, 500, 980, 980);

  // Steps pill bar
  ctx.fillStyle = '#f1f5f9';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(200, 1620, 1200, 90, 45);
  } else {
    ctx.rect(200, 1620, 1200, 90);
  }
  ctx.fill();

  text('❶  Scan QR      ❷  Upload & Options      ❸  Collect Print', 1678, 38, '#1e293b', 700);

  // Supported formats & assurance
  text('Fast & Secure  •  PDF, Photos, Word & Documents  •  Encrypted & Auto-Deleted', 1790, 30, '#64748b', 500);

  // Direct web URL
  if (qr?.url) {
    text(qr.url, 1870, 32, '#2563eb', 600);
  }

  // Footer brand
  text('Powered by SmartPrint  •  Scan. Set. Print.', 2060, 26, '#94a3b8', 600);

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not create the QR poster. Please try again.');

  const slug = shop?.slug || shop?.name?.toLowerCase()?.replace(/[^a-z0-9]+/g, '-') || 'shop';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slug}-counter-poster.png`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
