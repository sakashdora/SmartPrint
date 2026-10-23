export function configuration() {
  const production = process.env.NODE_ENV === 'production';
  let rawUrl = String(process.env.PUBLIC_BASE_URL || '').trim();

  // If in production and PUBLIC_BASE_URL is missing or pointing to localhost:
  if (production && (!rawUrl || rawUrl.includes('localhost'))) {
    if (process.env.VERCEL_URL) {
      rawUrl = `https://${process.env.VERCEL_URL}`;
    }
  }

  if (!rawUrl) {
    rawUrl = production ? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://smartprint.vercel.app') : 'http://localhost:3000';
  }

  // Ensure protocol
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = `https://${rawUrl}`;
  }

  // In production, automatically upgrade http:// to https://
  if (production && rawUrl.startsWith('http://') && !rawUrl.includes('localhost')) {
    rawUrl = rawUrl.replace(/^http:\/\//i, 'https://');
  }

  process.env.PUBLIC_BASE_URL = rawUrl;
  const origin = new URL(rawUrl).origin;

  if (production) {
    for (const name of ['DATABASE_URL', 'FILE_ENCRYPTION_KEY', 'PUBLIC_BASE_URL', 'CRON_SECRET']) {
      if (!process.env[name]) throw new Error(`Required production configuration: ${name}`);
    }
    if (!origin.startsWith('https://') && !origin.includes('localhost')) {
      throw new Error('Production PUBLIC_BASE_URL must use HTTPS.');
    }
    if (!/^[a-f0-9]{64}$/i.test(process.env.FILE_ENCRYPTION_KEY)) throw new Error('Use a 32-byte hex encryption key.');
    if (process.env.CRON_SECRET.length < 32) throw new Error('Use a cron secret of at least 32 characters.');
    const sslmode = new URL(process.env.DATABASE_URL).searchParams.get('sslmode');
    if (sslmode !== 'verify-full' && sslmode !== 'require') throw new Error('Production database URL must use sslmode=verify-full or sslmode=require.');
  }
  return { production, origin, payments: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET && process.env.PAYMENT_SETTLEMENT_MODE === 'single_merchant') };
}
