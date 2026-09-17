import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, unavailable, str, oneOf } from '../lib/http';
import { getSettings, PUBLIC_SETTING_KEYS } from '../lib/settings';
import { rateLimit } from '../lib/ratelimit';
import { readSchemaStatus } from '../lib/schemaVersion';

export const miscRoutes = new Hono<AppContext>();

/**
 * LIVENESS, AND WHETHER THE DATABASE IS AS NEW AS THIS CODE.
 *
 * `status` keeps its old meaning and its old shape exactly: this route
 * answering 200 means the Worker is up, which is what the staging deploy's
 * retry loop and `wildcard-subdomains.yml`'s routing probe ask it. Neither is
 * broken by what was added, and neither would be served by a health check that
 * refuses to answer when something else is wrong.
 *
 * `schema` is the part that was missing on the night a Worker carrying
 * migration 0085 was deployed over a database at 0083: the storefront's first
 * screen was a SERVICE_SETUP error card, and this endpoint said `{"status":
 * "ok"}` the whole time, because it was a literal that touched nothing. The
 * deploy's own final gate curls this route — so the check meant to catch a bad
 * deploy passed on a shop that was completely dark.
 *
 * It is DATA, not a verdict. The deploy workflows assert `schema.behind == 0`
 * and fail there, where failing is useful; a person can read the same answer
 * in one request.
 */
miscRoutes.get('/health', async (c) => {
  const schema = await readSchemaStatus(c.env.DB);
  // A probe is read while something is already wrong — never cache it.
  c.header('Cache-Control', 'no-store');
  return c.json({ status: 'ok', schema });
});

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


