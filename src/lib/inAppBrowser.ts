/**
 * IN-APP BROWSER DETECTION — why Google sign-in is hidden inside Instagram.
 *
 * «عندما يفتح الرابط من الرسالة في الانستغرام او الماسنجر … يكون جوجل عند
 *  التسجيل يظهر حظر access denied»
 *
 * Google refuses OAuth inside embedded WebViews ("Error 403:
 * disallowed_useragent"). Instagram, Facebook, Messenger, TikTok, Snapchat,
 * LINE, WhatsApp's in-app browser, X/Twitter and every Android `; wv)` WebView
 * are exactly that, so the Google button there is a dead end. This module
 * answers ONE question from the user agent — "is this an embedded WebView
 * where Google will refuse?" — and builds the links that take the SAME page
 * out to a real browser.
 *
 * Pure: no `window`, no `navigator`. The caller passes the UA and the two
 * facts the UA alone cannot tell (standalone PWA mode, touch points), so every
 * rule is covered by tests/inAppBrowser.test.ts against real UA strings.
 *
 * Sharp edges this deliberately avoids:
 *  - A FALSE POSITIVE hides Google from someone who could have used it, so the
 *    generic iOS rule ("WebKit without a Safari/ token") is off in standalone
 *    home-screen mode (whose UA also lacks Safari/ but where Google works),
 *    and a Macintosh UA only counts as an iPad WebView when it has touch.
 *  - SFSafariViewController (Telegram iOS, Twitter's reader, many apps) sends
 *    the full Safari UA and Google allows it — it is NOT flagged unless a named
 *    app token says otherwise.
 *  - The URL handed to the external browser is built from the page's own
 *    origin and a return path that went through sanitizeNextPath — this
 *    module never accepts an absolute URL from the query string.
 */

export type InAppApp =
  | 'instagram'
  | 'facebook'
  | 'messenger'
  | 'tiktok'
  | 'snapchat'
  | 'line'
  | 'whatsapp'
  | 'twitter'
  | 'linkedin'
  | 'pinterest'
  | 'wechat'
  | 'telegram'
  | 'webview';

export type InAppOs = 'ios' | 'android' | 'other';

export interface InAppInfo {
  /** True when Google sign-in will be refused here. */
  inApp: boolean;
  /** Which app, when a named token was found; 'webview' for the generic rules. */
  app: InAppApp | null;
  os: InAppOs;
}

export interface DetectOptions {
  /** `navigator.standalone === true` or `(display-mode: standalone)` — a home-screen web app. */
  standalone?: boolean;
  /** `navigator.maxTouchPoints` — tells an iPad (desktop-class UA) from a Mac. */
  maxTouchPoints?: number;
}

/** Order matters: Messenger's UA also carries FBAN/FBAV, so it is tested first. */
const NAMED: ReadonlyArray<[InAppApp, RegExp]> = [
  ['messenger', /FBAN\/(?:MessengerForiOS|Messenger)|FB_IAB\/(?:MESSENGER|Orca-Android)|\bMessenger\b.*FBAV|FBAN\/Orca/i],
  ['instagram', /\bInstagram\b/i],
  ['facebook', /FBAN\/|FBAV\/|FB_IAB\/|FBIOS|\[FB/i],
  ['tiktok', /musical_ly|BytedanceWebview|\bTikTok\b|trill_|aweme/i],
  ['snapchat', /\bSnapchat\b/i],
  ['line', /\bLine\/\d/i],
  ['whatsapp', /\bWhatsApp\b/i],
  ['twitter', /\bTwitter(?:Android| for i(?:Phone|Pad))|TwitterAndroid/i],
  ['linkedin', /LinkedInApp/i],
  ['pinterest', /\bPinterest\b/i],
  ['wechat', /MicroMessenger/i],
  // Telegram Android's own in-app browser is a WebView ("Telegram-Android/…").
  // Telegram iOS opens links in SFSafariViewController (plain Safari UA) —
  // allowed by Google, so it never matches here.
  ['telegram', /Telegram-Android/i],
];

export function detectOs(ua: string, maxTouchPoints = 0): InAppOs {
  if (/\b(iPhone|iPod|iPad)\b/.test(ua)) return 'ios';
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return 'ios';
  if (/\bAndroid\b/i.test(ua)) return 'android';
  return 'other';
}

export function detectInAppBrowser(ua: string, opts: DetectOptions = {}): InAppInfo {
  const s = typeof ua === 'string' ? ua : '';
  const os = detectOs(s, opts.maxTouchPoints ?? 0);
  if (!s) return { inApp: false, app: null, os };

  for (const [app, re] of NAMED) {
    if (re.test(s)) return { inApp: true, app, os };
  }

  if (os === 'android') {
    // Android System WebView marks itself with "; wv)" (and old ones with
    // "Version/x.y Chrome/…" without being Chrome proper). Chrome Custom Tabs
    // send the real Chrome UA and are fine.
    if (/;\s*wv\)/.test(s)) return { inApp: true, app: 'webview', os };
    return { inApp: false, app: null, os };
  }

  if (os === 'ios') {
    if (opts.standalone) return { inApp: false, app: null, os };
    // Every real iOS browser (Safari, SFSafariViewController, Chrome CriOS,
    // Firefox FxiOS, Edge EdgiOS, Opera OPT) carries a "Safari/" token; a bare
    // WKWebView does not.
    if (/AppleWebKit/i.test(s) && !/Safari\//.test(s)) return { inApp: true, app: 'webview', os };
    return { inApp: false, app: null, os };
  }

  return { inApp: false, app: null, os };
}

/** Human names for the banner — brand names, the same in every language. */
export const IN_APP_NAMES: Record<InAppApp, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  messenger: 'Messenger',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  line: 'LINE',
  whatsapp: 'WhatsApp',
  twitter: 'X',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  wechat: 'WeChat',
  telegram: 'Telegram',
  webview: '',
};

/**
 * The absolute sign-in URL to reopen in a real browser, carrying the return
 * destination (`next`) and the referral code (`ref`).
 *
 * `origin` must be the page's own `location.origin`; `next` must already have
 * passed sanitizeNextPath (a same-origin relative path). Router state
 * (`location.state.from`) does not survive a browser switch — that is why the
 * destination is written into the query here.
 */
export function externalAuthUrl(origin: string, next: string, ref = ''): string {
  const u = new URL('/auth', origin);
  if (next && next !== '/' && next.startsWith('/') && !next.startsWith('//')) u.searchParams.set('next', next);
  const r = ref.trim();
  if (r) u.searchParams.set('ref', r.slice(0, 64));
  return u.toString();
}

/**
 * Android: open an http(s) URL in Chrome from inside a WebView.
 * `intent://host/path?query#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=…;end`
 * The fallback URL (the same page) is what Android loads when Chrome is not
 * installed, instead of sending the person to the Play Store.
 */
export function chromeIntentUrl(httpsUrl: string): string {
  const u = new URL(httpsUrl);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('chromeIntentUrl: http(s) only');
  const rest = `${u.host}${u.pathname}${u.search}`;
  return (
    `intent://${rest}#Intent;scheme=${u.protocol.slice(0, -1)};package=com.android.chrome;` +
    `S.browser_fallback_url=${encodeURIComponent(u.toString())};end`
  );
}

/**
 * iOS 17+: `x-safari-https://…` asks the system to open the URL in Safari.
 * Older iOS and some apps ignore it — which is why the banner keeps «انسخ
 * الرابط» and the ⋯ → «فتح في Safari» instructions next to it.
 */
export function safariSchemeUrl(httpsUrl: string): string | null {
  const u = new URL(httpsUrl);
  if (u.protocol !== 'https:') return null;
  return `x-safari-${u.toString()}`;
}
