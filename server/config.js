export function configuration() {
  const production = process.env.NODE_ENV === 'production';
  const origin = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:3000').origin;
  if (production) {
    for (const name of ['DATABASE_URL', 'FILE_ENCRYPTION_KEY', 'PUBLIC_BASE_URL', 'CRON_SECRET']) if (!process.env[name]) throw new Error(`Required production configuration: ${name}`);
    if (!origin.startsWith('https://')) throw new Error('Production PUBLIC_BASE_URL must use HTTPS.');
    if (!/^[a-f0-9]{64}$/i.test(process.env.FILE_ENCRYPTION_KEY)) throw new Error('Use a 32-byte hex encryption key.');
    if (process.env.CRON_SECRET.length < 32) throw new Error('Use a cron secret of at least 32 characters.');
    if (new URL(process.env.DATABASE_URL).searchParams.get('sslmode') !== 'verify-full') throw new Error('Production database URL must use sslmode=verify-full.');
  }
  return { production, origin, payments: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET && process.env.PAYMENT_SETTLEMENT_MODE === 'single_merchant') };
}
