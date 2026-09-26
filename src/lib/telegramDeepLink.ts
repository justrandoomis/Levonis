/**
 * THE THREE WAYS INTO THE BOT — «عند الضغط على start … لا يفتح ولا يضغط الزر،
 * هذا في الايفون».
 *
 * The server hands the browser one link, `https://t.me/<bot>?start=<nonce>`.
 * On an iPhone that link can fail in three different places:
 *  1. inside an in-app browser (Instagram, Messenger…) the universal link is
 *     not honoured, t.me's own web page loads instead, and its «START BOT»
 *     button (a `tg://` link) is swallowed by the WebView — nothing happens;
 *  2. opened in a NEW tab, Safari may show t.me's page rather than hand the
 *     link to the app;
 *  3. in Telegram, an existing chat sometimes shows no START button at all.
 *
 * So the page offers, from one parsed link:
 *  - `app`     `tg://resolve?domain=<bot>&start=<nonce>` — opens the Telegram
 *              app directly (iOS asks «Open in Telegram?»), no web page between;
 *  - `web`     the original https link — the fallback when `tg://` is refused;
 *  - `command` `/start <nonce>` — to paste into the bot chat when START never
 *              shows; the bot accepts it (worker/routes/telegram.ts handleStart).
 *
 * Returns null for anything that is not a t.me start link with a valid
 * payload, so a malformed server value can never be turned into a link.
 */

/** Telegram's rule for a start parameter: A–Z a–z 0–9 _ - and at most 64 chars. */
export const START_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Telegram usernames: 5–32, letters/digits/underscore, bots end in "bot". */
const BOT_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export interface TelegramOpenLinks {
  bot: string;
  payload: string;
  app: string;
  web: string;
  command: string;
  /** The chat without the payload — for "open the bot, then paste the command". */
  chat: string;
}

export function telegramOpenLinks(deepLink: string): TelegramOpenLinks | null {
  let u: URL;
  try {
    u = new URL(deepLink);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.hostname !== 't.me' && u.hostname !== 'telegram.me')) return null;
  const bot = u.pathname.replace(/^\/+|\/+$/g, '');
  const payload = u.searchParams.get('start') ?? '';
  if (!BOT_RE.test(bot) || !START_PARAM_RE.test(payload)) return null;
  return {
    bot,
    payload,
    app: `tg://resolve?domain=${bot}&start=${payload}`,
    web: `https://t.me/${bot}?start=${payload}`,
    command: `/start ${payload}`,
    chat: `https://t.me/${bot}`,
  };
}

/** Phones and tablets have the Telegram app; a desktop browser may not have Telegram Desktop. */
export function prefersAppScheme(ua: string, maxTouchPoints = 0): boolean {
  return /\b(iPhone|iPod|iPad|Android)\b/i.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}
