export function configuration() {
  const production = process.env.NODE_ENV === 'production';
  let rawUrl = String(process.env.PUBLIC_BASE_URL || '').trim();

  // If in production and PUBLIC_BASE_URL is missing or pointing to localhost:
  if (production && (!rawUrl || rawUrl.includes('localhost'))) {
    if (process.env.RENDER_EXTERNAL_URL) {
      rawUrl = process.env.RENDER_EXTERNAL_URL;
    } else if (process.env.RENDER_EXTERNAL_HOSTNAME) {
      rawUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
    } else if (process.env.KOYEB_PUBLIC_DOMAIN) {
      rawUrl = `https://${process.env.KOYEB_PUBLIC_DOMAIN}`;
    } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      rawUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    } else if (process.env.RAILWAY_STATIC_URL) {
      rawUrl = `https://${process.env.RAILWAY_STATIC_URL}`;
    } else if (process.env.VERCEL_URL) {
      rawUrl = `https://${process.env.VERCEL_URL}`;
    }
  }

  if (!rawUrl) {
    const defaultHost = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.KOYEB_PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || process.env.VERCEL_URL;
    rawUrl = production ? (defaultHost ? `https://${defaultHost}` : (process.env.RENDER_EXTERNAL_URL || 'https://smartprint.onrender.com')) : 'http://localhost:3000';
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
    if (process.env.CRON_SECRET.length < 32) {
      console.warn('[Security] CRON_SECRET is shorter than 32 characters. Using provided secret.');
    }
    try {
      const dbUrl = new URL(process.env.DATABASE_URL);
      const isLocalDb = ['localhost', '127.0.0.1', '::1', 'db'].includes(dbUrl.hostname);
      const sslmode = dbUrl.searchParams.get('sslmode');
      if (!isLocalDb && (!sslmode || (sslmode !== 'verify-full' && sslmode !== 'require'))) {
        dbUrl.searchParams.set('sslmode', 'require');
        process.env.DATABASE_URL = dbUrl.toString();
        console.log('[Config] Automatically enabled sslmode=require for production database connection.');
      }
    } catch {}
  }
  const settlement = process.env.PAYMENT_SETTLEMENT_MODE || 'single_merchant';
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const isLiveKey = keyId.startsWith('rzp_live');
  const liveAuthorized = process.env.RAZORPAY_LIVE_ENABLED === 'true';

  if (isLiveKey && !liveAuthorized) {
    console.warn('[Payments Security] Razorpay live key detected but RAZORPAY_LIVE_ENABLED is not true. Live payments remain disabled.');
  }

  const paymentsEnabled = Boolean(
    keyId &&
    process.env.RAZORPAY_KEY_SECRET &&
    settlement === 'single_merchant' &&
    (!isLiveKey || liveAuthorized)
  );

  const paymentMode = paymentsEnabled ? (isLiveKey && liveAuthorized ? 'live' : 'test') : 'disabled';
  return { production, origin, payments: paymentsEnabled, paymentMode };
}

