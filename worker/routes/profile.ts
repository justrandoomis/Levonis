import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { publicUser, localeToDb } from '../lib/types';
import { requireAuth, badRequest, conflict, notFound, str, oneOf, username, displayName } from '../lib/http';
import { assertDecent } from '../lib/decency';
import { newId } from '../lib/crypto';
import { allCountries } from '../lib/phone';
import { computeCompletion, nextPromptAt, shouldPromptCompletion } from '../lib/profileCompletion';
import { rateLimit } from '../lib/ratelimit';
import { isSafeMediaKey } from '../lib/mediaStorage';
import { loadAuthoritativeProductImages } from '../lib/productSelectionImage';

export const profileRoutes = new Hono<AppContext>();
profileRoutes.use('*', requireAuth);

const USERNAME_COOLDOWN_DAYS = 14;

const KNOWN_COUNTRIES = new Set(allCountries().map((x) => x.iso));
function isKnownCountry(iso: string): boolean {
  return KNOWN_COUNTRIES.has(iso);
}

profileRoutes.patch('/', async (c) => {
  await rateLimit(c, 'profile-save', 60, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));

  const name = body.name !== undefined ? displayName(body.name) : user.name;
  if (body.name !== undefined) await assertDecent(c.env.DB, { name });
  const bio = body.bio !== undefined ? str(body.bio, 'bio', { max: 500, required: false }) : user.bio;
  const website = body.website !== undefined ? str(body.website, 'website', { max: 200, required: false }) : user.website;
  // API speaks 'ckb'; the DB column stores 'ku' (see localeToDb).
  const locale =
    body.locale !== undefined
      ? localeToDb(oneOf(body.locale, 'locale', ['en', 'ar', 'ckb', 'ku'] as const))
      : user.locale;

  let profileJson = user.profile_json;
  if (body.profile !== undefined) {
    if (typeof body.profile !== 'object' || body.profile === null || Array.isArray(body.profile)) {
      throw badRequest('profile must be an object');
    }
    const s = JSON.stringify(body.profile);
    if (s.length > 8000) throw badRequest('profile data is too large');
    profileJson = s;
  }

  let newUsername = user.username;
  if (body.username !== undefined && body.username !== user.username) {
    const uname = username(body.username);
    await assertDecent(c.env.DB, { username: uname });
    // Server-enforced 14-day cooldown, from the audit trail of past changes.
    const recent = await c.env.DB.prepare(
      `SELECT created_at FROM audit_log WHERE actor_id = ? AND action = 'profile.username_change'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(user.id)
      .first<{ created_at: string }>();
    if (recent && Date.now() - new Date(recent.created_at).getTime() < USERNAME_COOLDOWN_DAYS * 86_400_000) {
      throw badRequest(`You can only change your username once every ${USERNAME_COOLDOWN_DAYS} days`);
    }
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?')
      .bind(uname, user.id)
      .first();
    if (taken) throw conflict('This username is taken', 'USERNAME_TAKEN');
    newUsername = uname;
  }

  const avatarKey =
    body.avatarKey !== undefined ? str(body.avatarKey, 'avatarKey', { max: 300, required: false }) || null : user.avatar_key;
  // OWNERSHIP, not just shape: an avatar key is an R2 object path, and
  // without this prefix check a person could point their avatar at somebody
  // else's uploaded object.
  const ownsAvatar =
    avatarKey &&
    isSafeMediaKey(avatarKey) &&
    (avatarKey.startsWith(`avatars/${user.id}/`) || avatarKey.startsWith(`users/${user.id}/avatar/`));
  if (avatarKey && !ownsAvatar) {
    throw badRequest('Invalid avatar reference');
  }

  // '' clears the country back to "not said"; an unrecognised code is
  // refused rather than stored, because unlike signup this is a deliberate
  // edit and silently dropping it would look like the save failed.
  let country = user.country;
  if (body.country !== undefined) {
    const raw = String(body.country ?? '').trim().toUpperCase();
    if (raw === '') country = null;
    else if (isKnownCountry(raw)) country = raw;
    else throw badRequest('Unknown country code', 'BAD_COUNTRY');
  }

  try {
    await c.env.DB.prepare(
      `UPDATE users SET name = ?, bio = ?, website = ?, locale = ?, profile_json = ?, username = ?, avatar_key = ?,
          country = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
      .bind(name, bio, website, locale, profileJson, newUsername, avatarKey, country, user.id)
      .run();
  } catch (e) {
    // The availability check above and this write are not one operation, so
    // two people claiming the same handle at the same time both pass the
    // check. The UNIQUE index is what actually decides; its refusal becomes
    // the same 409 rather than a 500.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('username')) {
      throw conflict('This username is taken', 'USERNAME_TAKEN');
    }
    throw e;
  }

  if (newUsername !== user.username) {
    await c.env.DB.prepare(
      "INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, 'profile.username_change', ?, ?)"
    )
      .bind(user.id, user.id, JSON.stringify({ to: newUsername }))
      .run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  return c.json({ success: true, user: publicUser(updated as never) });
});

// Onboarding and profile completion ------------------------------------------
//
// Two questions that look like one and are not:
//
//   ONBOARDING is "did this person finish the signup wizard". It is answered
//   once, and 'done' can mean they filled everything in OR that they skipped
//   every optional step — both are legitimate finishes.
//
//   COMPLETION is "does the profile have the pieces the platform uses". It is
//   computed from the fields on every read, so it can never disagree with
//   them, and it keeps changing as the person edits their account.
//
// Nothing in either is required to browse, buy or hold an account.

/** What is missing, and whether it is time to ask about it. */
profileRoutes.get('/completion', async (c) => {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT name, username, avatar_key, locale, country, phone_e164, email,
            onboarding_state, profile_prompt_at, profile_prompt_count
       FROM users WHERE id = ?`
  )
    .bind(user.id)
    .first();
  if (!row) throw notFound('Account not found');

  const completion = computeCompletion(row as never);
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    ...completion,
    // The ONE thing the client must not decide for itself. A dismissal kept
    // in the browser is per-device and per-browser: the same person gets
    // asked again on their phone, and again after clearing site data.
    shouldPrompt: shouldPromptCompletion(row as never, new Date()),
    promptCount: Number((row as { profile_prompt_count?: number }).profile_prompt_count ?? 0),
  });
});

/**
 * "Maybe later". Records the dismissal and schedules the next one further
 * out, so a person who keeps saying later is asked less and less rather than
 * the same amount forever.
 */
profileRoutes.post('/completion/dismiss', async (c) => {
  await rateLimit(c, 'completion-dismiss', 20, 3600);
  const user = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT profile_prompt_count FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ profile_prompt_count: number }>();
  const count = Number(row?.profile_prompt_count ?? 0);
  const at = nextPromptAt(count, new Date());
  await c.env.DB.prepare(
    'UPDATE users SET profile_prompt_count = ?, profile_prompt_at = ? WHERE id = ?'
  )
    .bind(count + 1, at, user.id)
    .run();
  return c.json({ success: true, nextPromptAt: at, promptCount: count + 1 });
});

/**
 * Finish (or skip) the signup wizard.
 *
 * SKIPPING IS A REAL OUTCOME, not a failure to complete: the account is
 * already created and fully usable by the time this is called. All this does
 * is stop the wizard from reappearing and let the gentler completion prompt
 * take over. `state` is the only required field for exactly that reason.
 *
 * Profile fields are NOT saved here — PATCH /api/profile already does that,
 * with the avatar ownership check, the username cooldown and the reserved
 * list. A second write path for the same columns is a second place for those
 * rules to be forgotten.
 */
profileRoutes.post('/onboarding', async (c) => {
  await rateLimit(c, 'onboarding', 30, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const state = oneOf(body.state, 'state', ['done', 'skipped'] as const);

  await c.env.DB.prepare(
    "UPDATE users SET onboarding_state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  )
    .bind(state, user.id)
    .run();

  // Somebody who just walked through the wizard has been asked already;
  // reappearing with the same request on the next page load is the exact
  // behaviour this whole feature is meant to avoid. The first completion
  // prompt therefore waits out the same interval a dismissal would earn.
  if (state === 'skipped') {
    await c.env.DB.prepare('UPDATE users SET profile_prompt_at = ? WHERE id = ? AND profile_prompt_at IS NULL')
      .bind(nextPromptAt(0, new Date()), user.id)
      .run();
  }

  const updated = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  return c.json({ success: true, user: publicUser(updated as never) });
});

// Favorites ("Collection") ----------------------------------------------------

profileRoutes.get('/favorites', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.name_ar, p.price_iqd
       FROM favorites f JOIN products p ON p.id = f.product_id
      WHERE f.user_id = ? AND p.status = 'active' ORDER BY f.created_at DESC LIMIT 100`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const images = await loadAuthoritativeProductImages(
    c.env.DB,
    results.map((product) => String(product.id))
  );
  return c.json({
    success: true,
    favorites: results.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      name_ar: p.name_ar,
      image: images.get(String(p.id)) ?? '',
      price_iqd: p.price_iqd,
    })),
  });
});

profileRoutes.put('/favorites/:productId', async (c) => {
  const user = c.get('user')!;
  const productId = c.req.param('productId');
  const product = await c.env.DB.prepare("SELECT id FROM products WHERE id = ? AND status = 'active'")
    .bind(productId)
    .first();
  if (!product) throw notFound('Product not found');
  await c.env.DB.prepare('INSERT INTO favorites (user_id, product_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .bind(user.id, productId)
    .run();
  return c.json({ success: true, favorite: true });
});

profileRoutes.delete('/favorites/:productId', async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND product_id = ?')
    .bind(user.id, c.req.param('productId'))
    .run();
  return c.json({ success: true, favorite: false });
});

// Warranty claims -------------------------------------------------------------

profileRoutes.get('/warranty-claims', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM warranty_claims WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  )
    .bind(user.id)
    .all();
  return c.json({ success: true, claims: results });
});

profileRoutes.post('/warranty-claims', async (c) => {
  await rateLimit(c, 'warranty', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const productName = str(body.productName, 'productName', { min: 2, max: 200 });
  const description = str(body.description, 'description', { min: 10, max: 3000 });
  let orderItemId: string | null = null;
  if (body.orderItemId) {
    orderItemId = str(body.orderItemId, 'orderItemId', { max: 60 });
    const owned = await c.env.DB.prepare(
      `SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.id = ? AND o.user_id = ?`
    )
      .bind(orderItemId, user.id)
      .first();
    if (!owned) throw badRequest('That order item does not belong to your account');
  }
  const id = newId('wc');
  await c.env.DB.prepare(
    'INSERT INTO warranty_claims (id, user_id, order_item_id, product_name, description) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, user.id, orderItemId, productName, description)
    .run();
  return c.json({ success: true, id, status: 'submitted' });
});
