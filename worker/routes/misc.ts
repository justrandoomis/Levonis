import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, unavailable, str, oneOf } from '../lib/http';
import { getSettings, PUBLIC_SETTING_KEYS } from '../lib/settings';
import { rateLimit } from '../lib/ratelimit';

export const miscRoutes = new Hono<AppContext>();

miscRoutes.get('/health', (c) => c.json({ status: 'ok' }));

/** Public storefront settings (no secrets, no internal keys). */
miscRoutes.get('/settings/public', async (c) => {
  const settings = await getSettings(c.env.DB, PUBLIC_SETTING_KEYS);
  return c.json({ success: true, settings });
});

/** Machine translation via Gemini — admin-only, honestly disabled when unconfigured. */
miscRoutes.post('/translate', requireAdmin, async (c) => {
  await rateLimit(c, 'translate', 120, 3600);
  if (!c.env.GEMINI_API_KEY) {
    throw unavailable('Translation is not configured yet (GEMINI_API_KEY missing)', 'GEMINI_NOT_CONFIGURED');
  }
  const body = await c.req.json().catch(() => ({}));
  const text = str(body.text, 'text', { max: 8000, required: false });
  if (!text) return c.json({ success: true, translation: '' });
  const targetLang = oneOf(body.targetLang, 'targetLang', ['en', 'ar', 'ku'] as const);
  const langName = targetLang === 'en' ? 'English' : targetLang === 'ku' ? 'Sorani Kurdish' : 'Arabic';

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Translate the following text to ${langName}. Only output the translated text, no extra words or explanations.\n\n${text}`,
              },
            ],
          },
        ],
      }),
    }
  );
  if (!res.ok) {
    console.error('Gemini error', res.status, await res.text().catch(() => ''));
    throw unavailable('Translation service error', 'GEMINI_ERROR');
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const translation = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? '';
  return c.json({ success: true, translation });
});

// --- /api/extract: fetch product metadata from an external page (admin tool).

const BLOCKED_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;

function ipIsPrivate(host: string): boolean {
  // IPv4 literal check.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
    return false;
  }
  // IPv6 literal (bracketed or not).
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h.includes(':')) {
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::';
  }
  return false;
}

export function validateExtractUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('Only http(s) URLs are allowed');
  if (url.username || url.password) throw badRequest('URLs with credentials are not allowed');
  if (BLOCKED_HOST_RE.test(url.hostname) || ipIsPrivate(url.hostname)) {
    throw badRequest('This address is not allowed');
  }
  return url;
}

miscRoutes.post('/extract', requireAdmin, async (c) => {
  await rateLimit(c, 'extract', 30, 3600);
  const body = await c.req.json().catch(() => ({}));
  let url = validateExtractUrl(str(body.url, 'url', { min: 8, max: 2000 }));

  // Follow at most 3 redirects, re-validating each hop.
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LevonisBot/1.0)' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      if (!loc) break;
      url = validateExtractUrl(new URL(loc, url).toString());
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw badRequest('Failed to fetch the URL');
  const ctype = res.headers.get('Content-Type') || '';
  if (!ctype.includes('text/html')) throw badRequest('The URL did not return an HTML page');

  // Cap the body we parse at 1 MB.
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (total < 1_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    await reader.cancel().catch(() => {});
  }
  const html = new TextDecoder('utf-8').decode(concat(chunks));

  const meta = (prop: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    if (!tag) return '';
    return tag.match(/content=["']([^"']*)["']/i)?.[1] ?? '';
  };
  const name = decodeEntities(meta('og:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '');
  const description = decodeEntities(meta('og:description') || meta('description'));
  let image = meta('og:image');
  if (image && !/^https?:\/\//.test(image)) {
    try { image = new URL(image, url).toString(); } catch { image = ''; }
  }
  return c.json({
    success: true,
    product: { name: name.trim().slice(0, 300), description: description.trim().slice(0, 2000), images: image ? [image] : [] },
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, ch) => n + ch.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.length;
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}
