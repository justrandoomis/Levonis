/**
 * A CUSTOMER'S CONFIGURATION, MINTED — the one helper every door that takes a
 * design uses (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 2
 * and 3, invariants P1, P2, P5, P11, P15; §0 row 4).
 *
 *   POST /api/personalize/configs (C1) — and, with the same call, the cart's
 *   add door, the request exit, share and publish in the later phases.
 *
 * WHAT IT GUARANTEES, IN ORDER:
 *   1. STRICT against the LIVE revision (`normalizeConfig`, L1): unknown keys
 *      or ids → CONFIG_INVALID {path}; ANY price-like key at any depth →
 *      CONFIG_INVALID; the text rule → DESIGN_TEXT_INVALID {path}; a QR/NFC
 *      target of the wrong shape → QR_TARGET_INVALID {path}; too many roster
 *      names → ROSTER_TOO_LARGE; over 16 KB (32 KB with a roster) →
 *      DESIGN_TOO_LARGE; made against another revision → BLUEPRINT_CHANGED
 *      {rev} (the studio migrates leniently and tries again).
 *   2. THE OWNER'S OWN PICTURES: every logo/photo key is the caller's private
 *      `design_asset` object under users/<uid>/design-assets/ (the shared
 *      `ownedFileObject` door, exact purpose) → else DESIGN_ASSET_NOT_OWNED {path}.
 *   3. DECENCY over every printed text (`textValues`): the `nameGuard` seed
 *      and the owner's `blocked_terms` (worker/lib/decency.ts) →
 *      DESIGN_TEXT_NOT_ALLOWED {path} — the word is NEVER quoted back.
 *   4. THE CHECK (`checkConfig`, L2): a `blocked` verdict → CONFIG_NEEDS_CHANGE
 *      {codes, missing}; a `review` verdict on a blueprint that is not made by
 *      request → CONFIG_NOT_ACCEPTED {verdict, codes} (no door could take it).
 *      Automatic fixes are price-neutral (P15); the configuration stored is
 *      the fixed one.
 *   5. THE PRICE from the engine alone (`priceConfig` through the check), with
 *      the live base (the variant's price, else the product's — resolveCatalogLine's
 *      rule, carried in the PublicBlueprint's variants) and the live part rows.
 *   6. ONE ROW per (owner, equal choices): INSERT OR IGNORE by (owner_id, hash)
 *      — the hash is SHA-256 of the canonical JSON — with a random twin code
 *      (12 Crockford base32 characters, 60 bits). Immutable from then on.
 */
import type { Env } from '../types';
import { safeParse } from '../types';
import { HttpError } from '../http';
import { newId } from '../crypto';
import { ownedFileObject } from '../fileOwnership';
import { loadOwnerTerms } from '../decency';
import { isIndecent } from '../nameGuard';
import { normalizeConfig, textValues, requiredMissing } from '@levonis/catalog/personalize/config';
import { canonicalJson, configHash } from '@levonis/catalog/personalize/canonical';
import { EngineError, priceContextFromPublic } from '@levonis/catalog/personalize/price';
import { checkConfig, type AssetFacts, type CheckResult } from '@levonis/catalog/personalize/check';
import { checkGroup } from '@levonis/catalog/personalize/vocab';
import { configWords } from '@levonis/catalog/personalize/summary';
import type { DesignConfig, EngineIssue, PriceBreakdown, PublicBlueprint } from '@levonis/catalog/personalize/types';

const nowIso = () => new Date().toISOString();

// -------------------------------------------------------------- refusals

const STATUS: Record<string, number> = {
  CONFIG_INVALID: 400,
  DESIGN_TEXT_INVALID: 400,
  QR_TARGET_INVALID: 400,
  ROSTER_TOO_LARGE: 400,
  DESIGN_TOO_LARGE: 413,
  BLUEPRINT_CHANGED: 409,
};

const SENTENCE: Record<string, string> = {
  CONFIG_INVALID: 'Something in this design is not one of the choices on offer — reload and try again.',
  DESIGN_TEXT_INVALID: 'This text cannot be printed — use letters, numbers and simple punctuation only.',
  QR_TARGET_INVALID: 'That link or number does not look right — check it and try again.',
  ROSTER_TOO_LARGE: 'There are more names than this product takes in one order.',
  DESIGN_TOO_LARGE: 'This design is too large to save — shorten a text or remove a picture.',
  BLUEPRINT_CHANGED: 'The shop has updated this product — your design was refreshed, check it and try again.',
};

/** The engine's refusal as the door's: its code, the first path, every error (at most 20). */
function engineRefusal(code: string, path: string | undefined, errors: readonly EngineIssue[] | undefined, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(STATUS[code] ?? 400, SENTENCE[code] ?? SENTENCE.CONFIG_INVALID, STATUS[code] ? code : 'CONFIG_INVALID', {
    path: path ?? '',
    ...(errors?.length ? { errors: errors.slice(0, 20) } : {}),
    ...extra,
  });
}

export const designAssetNotOwned = (path: string): HttpError =>
  new HttpError(400, 'That picture is not one of your uploads — add it again.', 'DESIGN_ASSET_NOT_OWNED', { path });

export const designTextNotAllowed = (path: string): HttpError =>
  new HttpError(400, 'Please choose different words for this design.', 'DESIGN_TEXT_NOT_ALLOWED', { path });

// ------------------------------------------------------------- twin codes

/** Crockford base32 — no I, L, O or U, so a code read aloud or typed from a tag is never mistaken. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TWIN_CODE_LENGTH = 12;

/** A random twin code: 12 Crockford characters from the platform's CSPRNG (60 bits). */
export function mintTwinCode(): string {
  const bytes = new Uint8Array(TWIN_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CROCKFORD[b & 31]).join('');
}

// ------------------------------------------------------------------ mint

/** The facts the check needs about the owner's pictures (their pixel sizes, from the upload ledger). */
async function assetFacts(db: D1Database, userId: string, config: DesignConfig): Promise<{ facts: Record<string, AssetFacts>; missing: string | null }> {
  const choices: Array<{ path: string; area: string; key: string }> = [
    ...Object.entries(config.logo).map(([area, a]) => ({ path: `logo.${area}.key`, area, key: a.key })),
    ...Object.entries(config.photo).map(([area, a]) => ({ path: `photo.${area}.key`, area, key: a.key })),
  ];
  if (!choices.length) return { facts: {}, missing: null };
  const prefix = `users/${userId}/design-assets/`;
  const [owned, dims] = await Promise.all([
    Promise.all(choices.map((ch) => ownedFileObject(db, ch.key, userId, ['design_asset'], { exactPurpose: true, prefix }))),
    db
      .prepare(
        `SELECT object_key, width, height FROM file_objects
          WHERE owner_id = ?1 AND object_key IN (SELECT value FROM json_each(?2))`
      )
      .bind(userId, JSON.stringify(choices.map((ch) => ch.key)))
      .all<{ object_key: string; width: number | null; height: number | null }>()
      .then((r) => r.results ?? [])
      .catch(() => [] as Array<{ object_key: string; width: number | null; height: number | null }>),
  ]);
  const bad = choices.find((_, i) => !owned[i] || owned[i]!.kind !== 'image');
  if (bad) return { facts: {}, missing: bad.path };
  const facts: Record<string, AssetFacts> = {};
  for (const ch of choices) {
    const d = dims.find((x) => x.object_key === ch.key);
    if (d && Number(d.width) > 0 && Number(d.height) > 0) facts[ch.area] = { px_w: Number(d.width), px_h: Number(d.height) };
  }
  return { facts, missing: null };
}

/** THE CHECK AND THE PRICE of a normalised configuration against a PublicBlueprint (the studio runs the same). */
export function judge(pub: PublicBlueprint, config: DesignConfig, assets: Record<string, AssetFacts> = {}): CheckResult {
  try {
    return checkConfig(pub, config, { price: priceContextFromPublic(pub, config.variant), assets });
  } catch (e) {
    if (e instanceof EngineError) throw engineRefusal('CONFIG_INVALID', e.path || 'variant', [{ path: e.path || 'variant', code: 'CONFIG_INVALID' }]);
    throw e;
  }
}

export interface MintedConfig {
  config_id: string;
  twin_code: string;
  unit_iqd: number;
  adds: PriceBreakdown['adds'];
  check: { verdict: CheckResult['verdict']; issues: CheckResult['issues'] };
  config: DesignConfig;
  /** False when the same owner already held these exact choices (the same id comes back). */
  created: boolean;
}

/**
 * Mint (or find) the owner's configuration of `pub`'s product from `raw`.
 * `pub` is the LIVE PublicBlueprint the door built for this caller (the route
 * has already decided the switch, the preview and the store's state).
 */
export async function mintConfig(
  db: D1Database,
  _env: Pick<Env, 'DB'> | null,
  input: { userId: string; pub: PublicBlueprint; raw: unknown; terms?: RegExp[] }
): Promise<MintedConfig> {
  const { userId, pub } = input;
  const norm = normalizeConfig(input.raw, pub);
  if (!norm.ok) throw engineRefusal(norm.code, norm.path, norm.errors, norm.code === 'BLUEPRINT_CHANGED' ? { rev: pub.rev } : {});
  let config = norm.value;

  // `terms`: the owner's blocked terms, when the door already read them in its first wave.
  const [assets, terms] = await Promise.all([
    assetFacts(db, userId, config),
    input.terms ?? (textValues(config).length ? loadOwnerTerms(db) : Promise.resolve([] as RegExp[])),
  ]);
  if (assets.missing) throw designAssetNotOwned(assets.missing);
  for (const t of textValues(config)) if (isIndecent(t.value, terms)) throw designTextNotAllowed(t.path);

  const check = judge(pub, config, assets.facts);
  if (check.verdict === 'blocked') {
    const codes = [...new Set(check.issues.filter((i) => checkGroup(i.code) === 'blocked' || (checkGroup(i.code) !== 'review' && i.fix?.kind !== 'auto')).map((i) => i.code))];
    throw new HttpError(409, 'This design needs a change before it can be made — see what the page suggests.', 'CONFIG_NEEDS_CHANGE', {
      codes,
      missing: requiredMissing(config, pub),
    });
  }
  if (check.verdict === 'review' && !pub.sell.request) {
    throw new HttpError(409, 'The shop needs to look at this design first, and this product is not made on request — ask the shop.', 'CONFIG_NOT_ACCEPTED', {
      verdict: check.verdict,
      codes: [...new Set(check.issues.filter((i) => checkGroup(i.code) === 'review').map((i) => i.code))],
    });
  }
  config = check.config;
  if (!check.price) throw new HttpError(409, 'This design needs a change before it can be made — see what the page suggests.', 'CONFIG_NEEDS_CHANGE', { codes: ['COMPONENT_OUT'], missing: [] });

  const hash = await configHash(config);
  const spec = canonicalJson(config);
  let created = false;
  let row: { id: string; twin_code: string } | null = null;
  for (let attempt = 0; attempt < 4 && !row; attempt++) {
    // A new configuration answers its own row (one round trip); an existing one
    // (the same owner and choices) is ignored and read back; a twin-code
    // collision is ignored too, reads nothing, and tries a fresh code.
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO design_configs (id, owner_id, product_id, rev, hash, spec, public, twin_code, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)
         RETURNING id, twin_code`
      )
      .bind(newId('cfg'), userId, pub.product.id, config.rev, hash, spec, mintTwinCode(), nowIso())
      .first<{ id: string; twin_code: string }>();
    if (inserted) {
      created = true;
      row = inserted;
      break;
    }
    row = await db
      .prepare('SELECT id, twin_code FROM design_configs WHERE owner_id = ?1 AND hash = ?2')
      .bind(userId, hash)
      .first<{ id: string; twin_code: string }>();
  }
  if (!row) throw new Error('design_configs: no row after four attempts (twin-code collisions)');
  return {
    config_id: row.id,
    twin_code: row.twin_code,
    unit_iqd: check.price.unit_iqd,
    adds: check.price.adds,
    check: { verdict: check.verdict, issues: check.issues },
    config,
    created,
  };
}

// ----------------------------------------------------------------- read

export interface ConfigRow {
  id: string;
  owner_id: string;
  product_id: string;
  rev: number;
  hash: string;
  spec: string;
  public: number;
  twin_code: string;
  created_at: string;
}

/** The OWNER's configuration by id — null for anyone else's (the door's 404 says nothing). */
export async function ownConfig(db: D1Database, userId: string, id: string): Promise<ConfigRow | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return db
    .prepare('SELECT id, owner_id, product_id, rev, hash, spec, public, twin_code, created_at FROM design_configs WHERE id = ?1 AND owner_id = ?2')
    .bind(id, userId)
    .first<ConfigRow>();
}

export const configOf = (row: Pick<ConfigRow, 'spec'>): DesignConfig | null => safeParse<DesignConfig | null>(row.spec, null);

// ----------------------------------------------------------------- words

/** The configuration in words, in the three languages — the order line's words (C3) and the studio's ReadyLine. */
export interface ConfigWords {
  ar: string;
  en: string;
  ckb: string;
}

/** The merchant's OWN names for a product's option values (0126): the name for en, the Arabic one (else the name) for ar and ckb. */
export interface OptionNames {
  en: Record<string, string>;
  ar: Record<string, string>;
}

/** One small read, independent of the configuration — the doors run it in their first wave. */
export async function optionNames(db: D1Database, productId: string): Promise<OptionNames> {
  const { results } = await db
    .prepare('SELECT id, name, name_ar FROM community_product_option_values WHERE product_id = ?1')
    .bind(productId)
    .all<{ id: string; name: string; name_ar: string | null }>()
    .catch(() => ({ results: [] as Array<{ id: string; name: string; name_ar: string | null }> }));
  const out: OptionNames = { en: {}, ar: {} };
  for (const r of results ?? []) {
    out.en[r.id] = r.name;
    out.ar[r.id] = r.name_ar || r.name;
  }
  return out;
}

/** L3's `configWords` in ar/en/ckb with the merchant's own value names — pure. */
export function wordsFrom(pub: PublicBlueprint, config: DesignConfig, names: OptionNames): ConfigWords {
  return {
    ar: configWords(pub, config, 'ar', { values: names.ar }),
    en: configWords(pub, config, 'en', { values: names.en }),
    ckb: configWords(pub, config, 'ckb', { values: names.ar }),
  };
}

/** `optionNames` then `wordsFrom` — for a caller that has no wave to share the read with. */
export async function configWordsFor(db: D1Database, pub: PublicBlueprint, config: DesignConfig): Promise<ConfigWords> {
  return wordsFrom(pub, config, await optionNames(db, pub.product.id));
}
