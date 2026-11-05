import { randomUUID } from 'node:crypto';

// Outgoing e-mail. Every message is written to `email_outbox` first, so nothing is lost and a platform
// administrator can hand a link over manually while no provider is configured. If RESEND_API_KEY and
// EMAIL_FROM are set the message is also sent through Resend's HTTPS API (no extra dependency); any other
// provider can be added behind the same function. Failures never break the request that triggered the mail.
const now = () => new Date().toISOString();

export async function sendMail(db, { to, subject, text, kind }) {
  const id = randomUUID();
  try {
    await db.query("INSERT INTO email_outbox (id,to_email,subject,body,kind,status,created) VALUES ($1,$2,$3,$4,$5,'queued',$6)", [id, to, subject, text, kind, now()]);
  } catch (error) {
    console.warn('[Mailer] Could not store message:', error.message);
    return null;
  }
  const key = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM;
  if (!key || !from || process.env.NODE_ENV === 'test') return id;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`provider answered ${response.status}`);
    await db.query("UPDATE email_outbox SET status='sent', sent_at=$1 WHERE id=$2", [now(), id]);
  } catch (error) {
    await db.query("UPDATE email_outbox SET status='failed', error=$1 WHERE id=$2", [String(error.message).slice(0, 200), id]).catch(() => {});
  }
  return id;
}
