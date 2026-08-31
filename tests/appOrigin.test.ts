/**
 * Where a password-reset link points.
 *
 * THE ATTACK THIS CLOSES needs no attacker. A customer browsing
 * `ali3d.levonis-iq.com` clicks "forgot password". If the origin for that
 * link came from the request, the email would carry a token to a page whose
 * content a merchant controls.
 *
 * That could not happen before wildcard subdomains, which is exactly why the
 * old fallback — `new URL(c.req.url).origin`, commented "only for local dev"
 * — was safe when it was written and stopped being safe when a second kind
 * of hostname started reaching the same Worker.
 *
 * The tests below are written as "where does the link go", because that is
 * the only question that matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import { trustedOrigin } from '../worker/lib/appOrigin';

/** Ask the helper what origin it would use for a request to `host`. */
async function originFor(host: string, env: Record<string, string>): Promise<string> {
  const app = new Hono<AppContext>();
  app.get('/probe', (c) => {
    c.env = env as never;
    return c.text(trustedOrigin(c));
  });
  const res = await app.request(`https://${host}/probe`, { headers: { Host: host } });
  return res.text();
}

const PROD = { APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const NO_ORIGIN = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };

// ------------------------------------------------- the configured case

test('a configured APP_ORIGIN wins on every host, including a merchant one', async () => {
  for (const host of ['levonis-iq.com', 'www.levonis-iq.com', 'ali3d.levonis-iq.com', 'studio.levonis-iq.com']) {
    assert.equal(await originFor(host, PROD), 'https://levonis-iq.com', host);
  }
});

test('a trailing slash on the configured value is not carried into links', async () => {
  const o = await originFor('levonis-iq.com', { ...PROD, APP_ORIGIN: 'https://levonis-iq.com///' });
  assert.equal(o, 'https://levonis-iq.com');
});

// ------------------------------------------------------- THE FIX

test('WITHOUT a configured origin, a merchant host NEVER becomes the link origin', async () => {
  // The whole point. A token must not be sent to a page a merchant controls.
  assert.equal(await originFor('ali3d.levonis-iq.com', NO_ORIGIN), 'https://levonis-iq.com');
  assert.equal(await originFor('evil.levonis-iq.com', NO_ORIGIN), 'https://levonis-iq.com');
});

test('nor does a system host', async () => {
  assert.equal(await originFor('studio.levonis-iq.com', NO_ORIGIN), 'https://levonis-iq.com');
  assert.equal(await originFor('mail.levonis-iq.com', NO_ORIGIN), 'https://levonis-iq.com');
});

test('nor does a name too deep to be a store', async () => {
  // `a.b.levonis-iq.com` classifies as foreign but sits UNDER the root, so it
  // is next to merchant-controlled content and gets the same treatment.
  assert.equal(await originFor('a.b.levonis-iq.com', NO_ORIGIN), 'https://levonis-iq.com');
});

// ---------------------------------------------------- the dev fallback

test('the apex still falls back to itself, which is what local dev needs', async () => {
  assert.equal(await originFor('levonis-iq.com', NO_ORIGIN), 'https://levonis-iq.com');
  assert.equal(await originFor('www.levonis-iq.com', NO_ORIGIN), 'https://www.levonis-iq.com');
});

test('a host outside the platform domain falls back to itself — no merchant is served there', async () => {
  for (const host of ['levonis-staging.someone.workers.dev', 'localhost', '127.0.0.1']) {
    assert.equal(await originFor(host, NO_ORIGIN), `https://${host}`, host);
  }
});

test('with no root domain configured at all, the request origin is the only answer there is', async () => {
  // Nothing can be classified, so nothing can be ruled out. The deploy
  // workflow warns loudly about this state; the link still has to go
  // somewhere.
  assert.equal(await originFor('levonis-iq.com', {}), 'https://levonis-iq.com');
  assert.equal(await originFor('ali3d.levonis-iq.com', {}), 'https://ali3d.levonis-iq.com');
});

// ------------------------------------------------------- one place only

test('auth and studio both use the shared helper rather than their own copy', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  for (const f of ['worker/routes/auth.ts', 'worker/routes/studio.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.match(src, /import \{ trustedOrigin \} from '\.\.\/lib\/appOrigin'/, `${f} does not import the helper`);
    // Two copies of a security rule is one copy that gets fixed and one that
    // does not — which is precisely what happened here.
    assert.equal(
      /function trustedOrigin\s*\(/.test(src),
      false,
      `${f} still defines its own trustedOrigin`
    );
  }
});
