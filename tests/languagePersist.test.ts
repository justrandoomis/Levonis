/**
 * «لغة إشعار التليغرام إنجليزية رغم أن لغة المستخدم عربية» — THE SITE LANGUAGE
 * A SIGNED-IN READER PICKS IS THE ACCOUNT'S.
 *
 * Every switcher in the shop — the header, the dashboard, the auth shell, the
 * welcome page — calls `LanguageProvider.setLang`, and `setLang` wrote
 * localStorage and nothing else; only the Settings page PATCHed the profile.
 * So a customer reading the whole site in Arabic kept whatever `users.locale`
 * said, and their Telegram notices (worker/lib/customerNotify.ts) followed the
 * column, not the screen.
 *
 * The provider is rendered for real (`renderToStaticMarkup`, `createElement` so
 * this stays a `.ts` file) under a real `AuthContext.Provider`, and the switch
 * is the context's own `setLang`. The request that leaves is captured at
 * `fetch`; the second half proves the server turns that request into the
 * notification language.
 *
 * Run: node --import tsx --test tests/languagePersist.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Hono } from 'hono';
import { AuthContext } from '../src/AuthContext';
import { LanguageProvider, useLanguage } from '../src/LanguageContext';
import { asD1, freshDb } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import { profileRoutes } from '../worker/routes/profile';
import { reachFor } from '../worker/lib/customerNotify';
import type { Env } from '../worker/lib/types';

type Captured = ReturnType<typeof useLanguage>;

function mount(user: { id: string } | null): Captured {
  let captured: Captured | null = null;
  function Grab() {
    captured = useLanguage();
    return null;
  }
  const tree = createElement(LanguageProvider, { children: createElement(Grab) });
  renderToStaticMarkup(
    createElement(AuthContext.Provider, {
      value: {
        isAuthenticated: !!user,
        user: user as never,
        login: async () => {},
        loginWithGoogle: async () => {},
        register: async () => {},
        refreshUser: async () => {},
        logout: async () => {},
        isLoaded: true,
      },
      children: tree,
    })
  );
  assert.ok(captured, 'the provider rendered its child');
  return captured!;
}

function captureFetch(): { calls: Array<{ url: string; method: string; body: string }>; restore: () => void } {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method ?? 'GET'), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('A SIGNED-IN switch saves the language to the ACCOUNT', async () => {
  const f = captureFetch();
  try {
    mount({ id: 'u1' }).setLang('ar');
    await settle();
    assert.deepEqual(
      f.calls.map((c) => ({ url: c.url, method: c.method, body: JSON.parse(c.body) })),
      [{ url: '/api/profile', method: 'PATCH', body: { locale: 'ar' } }]
    );
  } finally {
    f.restore();
  }
});

test('A SIGNED-OUT switch saves nothing — there is no account to write to', async () => {
  const f = captureFetch();
  try {
    mount(null).setLang('en');
    await settle();
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test('THE PROVIDER STILL RENDERS WITH NO AuthProvider ABOVE IT (the browser fixtures do exactly this)', () => {
  let ok = false;
  function Grab() {
    useLanguage();
    ok = true;
    return null;
  }
  renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(Grab) }));
  assert.ok(ok);
});

test('THE OTHER HALF — that PATCH turns an English column into Arabic notifications', async () => {
  // A real-address account whose column says English: the case the
  // placeholder fallback can never reach.
  const raw = freshDb();
  raw
    .prepare(
      `INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale)
       VALUES ('u1','Ali','ali@gmail.com','ali','h','customer','2026-01-01T00:00:00.000Z','en')`
    )
    .run();
  const env = { DB: asD1(raw) } as unknown as Env;
  assert.equal((await reachFor(env, 'u1')).lang, 'en', 'before: the column decides');

  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.env = env as never;
    c.set('user', { ...(raw.prepare("SELECT * FROM users WHERE id = 'u1'").get() as object) } as never);
    await next();
  });
  app.route('/api/profile', profileRoutes);
  const res = await app.request('/api/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ locale: 'ar' }),
  });
  assert.equal(res.status, 200, await res.text());
  assert.equal((await reachFor(env, 'u1')).lang, 'ar', 'after: the reader’s own choice');
});
