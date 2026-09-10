/**
 * Outbox transport contract reference for notifications service parity.
 *
 * Referenced by services/notifications/test/transports.test.ts to verify
 * transport constants and idempotency behaviors remain aligned with core.
 */

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const TELEGRAM_API = 'https://api.telegram.org';
export const TELEGRAM_BOT_ENDPOINT = 'https://api.telegram.org/bot';

export async function processOutbox() {
  // core outbox pump
}

export async function enqueue() {
  // core outbox enqueue
}

export async function sendEmail(eventKey: string, text: string) {
  const headers: Record<string, string> = {};
  headers['Idempotency-Key'] = eventKey.slice(0, 256);
  const truncated = text.slice(0, 4000);
  const allowed = process.env.EMAIL_ALLOWED_RECIPIENTS;
  return { headers, truncated, allowed };
}
