import type { Env } from './types';

/**
 * Admin notifications over Telegram. Requires TELEGRAM_BOT_TOKEN (secret)
 * and TELEGRAM_ADMIN_CHAT_ID (the chat/channel the bot posts into). When
 * either is missing the feature is simply off — callers treat the result
 * honestly and nothing pretends to have been sent.
 *
 * Messages are sent as plain text (no parse_mode) so user-supplied names
 * cannot inject Telegram markup.
 */

export function telegramConfigured(env: Env): boolean {
  return !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_CHAT_ID);
}

export async function notifyAdmins(env: Env, text: string): Promise<boolean> {
  if (!telegramConfigured(env)) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error('Telegram sendMessage failed', res.status, await res.text().catch(() => ''));
    }
    return res.ok;
  } catch (e) {
    console.error('Telegram sendMessage error', e);
    return false;
  }
}

/** Token validity check (server-side only; never exposes the token). */
export async function telegramGetMe(env: Env): Promise<{ ok: boolean; username?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return { ok: data.ok === true, username: data.result?.username };
  } catch {
    return { ok: false };
  }
}
