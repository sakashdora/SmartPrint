// Export the complete counter sign, including an unobstructed QR quiet zone.
export async function downloadQrPoster(shop, qr) {
  const image = new Image();
  image.src = qr.image;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 1600; canvas.height = 2200;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1600, 2200);
  ctx.fillStyle = '#1556b8'; ctx.fillRect(0, 0, 1600, 24);
  ctx.textAlign = 'center';
  const text = (value, y, size, color = '#172b49', weight = 600) => {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px "Segoe UI", Arial, sans-serif`;
    while (ctx.measureText(value).width > 1380 && size > 24) ctx.font = `${weight} ${--size}px "Segoe UI", Arial, sans-serif`;
    ctx.fillText(value, 800, y);
  };
  text('SMARTPRINT', 135, 38, '#1556b8', 700);
  text(shop.name, 260, 76);
  text(shop.location || '', 330, 32, '#617084', 400);
  text('Scan to print', 475, 88, '#1556b8', 700);
  text('Your documents. Your phone. Ready at this counter.', 550, 33, '#617084', 400);
  ctx.drawImage(image, 200, 625, 1200, 1200);
  text('1  Scan     •     2  Upload & preview     •     3  Pay & collect', 1920, 36);
  text('PDF • Photos • Documents', 2000, 32, '#617084', 400);
  text(qr.url, 2100, 29, '#1556b8', 400);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not create the QR poster. Please try again.');
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `${shop.slug}-counter-poster.png`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
