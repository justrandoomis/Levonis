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
import { LanguageProvider, authLinkLang, chosenLang, useLanguage } from '../src/LanguageContext';
import { storeHandoffUrl } from '../src/components/auth/nextPath';
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
        loginWithGoogle: async () => 'ok' as const,
        register: async () => {},
        refreshUser: async () => {},
        adoptSession: async () => 'ok' as const,
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

// ------------------------------------------- the language a sign-in link carries (review, 2026-10-18)

test('authLinkLang: only on /auth, only ar/en/ckb', () => {
  assert.equal(authLinkLang('https://levonis-iq.com/auth?next=%2Fcart&store=ali3d&lang=ckb'), 'ckb');
  assert.equal(authLinkLang('https://levonis-iq.com/auth?lang=en'), 'en');
  assert.equal(authLinkLang('https://levonis-iq.com/auth/?lang=ar'), 'ar');
  // ?lang= means a policy document's language elsewhere; it must not switch the site.
  assert.equal(authLinkLang('https://levonis-iq.com/policies/terms?version=3&lang=en'), null);
  assert.equal(authLinkLang('https://levonis-iq.com/?lang=en'), null);
  assert.equal(authLinkLang('https://levonis-iq.com/authx?lang=en'), null);
  for (const bad of ['fr', 'ku', 'EN', '', 'ckb;x']) {
    assert.equal(authLinkLang(`https://levonis-iq.com/auth?lang=${encodeURIComponent(bad)}`), null, bad);
  }
  assert.equal(authLinkLang('not a url'), null);
});

/**
 * One browser origin at a time: its own storage, its own address bar. The
 * history stub moves the address the way `history.replaceState` does, so a
 * «reload» opens what the bar shows.
 */
function originAt(storage: Map<string, string>, href: string) {
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  const location = { href };
  g.window = {
    location,
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: string) => {
        location.href = new URL(url, location.href).href;
      },
    },
  };
  g.localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
  return { address: () => location.href };
}

function withBrowserGlobals(run: () => void) {
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  const before = { window: g.window, localStorage: g.localStorage };
  try {
    run();
  } finally {
    g.window = before.window;
    g.localStorage = before.localStorage;
    if (before.window === undefined) delete g.window;
    if (before.localStorage === undefined) delete g.localStorage;
  }
}

test('a shop visitor handed to the apex reads the sign-in page in THEIR language, and keeps it', () => {
  // levo_lang is per-origin storage: the apex had none, and greeted a Sorani
  // reader from a shop in Arabic — and mailed the code, and created the
  // account, in Arabic too.
  withBrowserGlobals(() => {
    const shop = new Map<string, string>([['levo_lang', 'ckb']]);
    originAt(shop, 'https://ali3d.levonis-iq.com/cart');
    assert.equal(chosenLang(), 'ckb', 'the shop reader chose Sorani');
    const link = storeHandoffUrl('https://levonis-iq.com', '', '/cart', 'ali3d', chosenLang());

    const apex = new Map<string, string>();
    const bar = originAt(apex, link);
    assert.equal(mount(null).lang, 'ckb', 'the page opens in the carried language');
    assert.equal(apex.get('levo_lang'), 'ckb', 'and keeps it, as a switch would');
    assert.equal(new URL(bar.address()).searchParams.get('lang'), null, 'adopted once, then gone from the address');
    assert.equal(new URL(bar.address()).searchParams.get('store'), 'ali3d', 'every other parameter stays');
    assert.equal(new URL(bar.address()).searchParams.get('next'), '/cart');

    // Later pages read the stored choice; a policy link's ?lang= changes nothing.
    originAt(apex, 'https://levonis-iq.com/policies/terms?lang=en');
    assert.equal(mount(null).lang, 'ckb');
    // An invalid value is ignored: the stored choice stands.
    originAt(apex, 'https://levonis-iq.com/auth?lang=fr');
    assert.equal(mount(null).lang, 'ckb');
    assert.equal(apex.get('levo_lang'), 'ckb');
  });
});

test('a FIRST visit to a shop carries no language: the apex keeps the choice it already has', () => {
  withBrowserGlobals(() => {
    // The shop origin has never been switched: it shows the default, which is not a choice.
    const shop = new Map<string, string>();
    originAt(shop, 'https://ali3d.levonis-iq.com/');
    assert.equal(mount(null).lang, 'ar', 'the shop shows its default');
    assert.equal(chosenLang(), null, 'and nothing was chosen');
    const link = storeHandoffUrl('https://levonis-iq.com', '', '/', 'ali3d', chosenLang());
    assert.equal(new URL(link).searchParams.get('lang'), null);

    const apex = new Map<string, string>([['levo_lang', 'en']]);
    originAt(apex, link);
    assert.equal(mount(null).lang, 'en', 'the apex reader\'s English stands');
    assert.equal(apex.get('levo_lang'), 'en', 'never overwritten by the shop\'s default');
  });
});

test('a switch made on /auth survives a reload: the carried ?lang= is not adopted twice', () => {
  withBrowserGlobals(() => {
    const apex = new Map<string, string>();
    const bar = originAt(apex, 'https://levonis-iq.com/auth?next=%2F&store=ali3d&lang=ckb');
    assert.equal(mount(null).lang, 'ckb');
    // The reader switches to English on the sign-in page (setLang stores it).
    apex.set('levo_lang', 'en');
    // Reload — or the tab the browser discarded during the t.me round trip
    // comes back — at the address the bar now shows.
    originAt(apex, bar.address());
    assert.equal(mount(null).lang, 'en', 'the switch stands');
    assert.equal(apex.get('levo_lang'), 'en');
  });
});
