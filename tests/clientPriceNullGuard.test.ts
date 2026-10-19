/**
 * THE CLIENT NEVER TURNS A MISSING PRICE INTO 0 (DECISIONS rows 239 (3) and
 * 240, spec §3.9).
 *
 * A catalog-only product arrives with `price_iqd: null` and `price_status:
 * 'unpriced'`. Every customer surface reads the status (`isUnpriced`,
 * src/lib/priceStatus.ts) and prints «السعر غير متوفر حالياً». A fallback such
 * as `price_iqd ?? 0` or `Number(p.price_iqd) || 0` would quietly print «0 د.ع»
 * — the one figure the owner ruled out — so this guard greps `src/` for the
 * three shapes and fails on any new one.
 *
 * The allow-list names each remaining site and why it is not a product's
 * price: a composition editor's own field, a chat deal's snapshot, an order,
 * an offer row. A new entry needs the same kind of reason. (The trade-in
 * desk's fallback left with Services S-P2's rewrite of AdminTradeIn.tsx, so
 * its entry went with it.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

// No leading \b: `original_price_iqd ?? 0` and `display_price_iqd ?? 0` are the same fallback.
const BANNED = [/price_iqd \?\? 0\b/, /display_price_iqd \?\? 0\b/, /price_iqd\) \|\| 0\b/];

/** file → [how many matches are allowed, why none of them is a catalogue product's price]. */
const ALLOWED: Record<string, [number, string]> = {
  'src/components/adminOffers/AdminOffers.tsx': [1, "an offer row's own offer_price_iqd in the admin offers editor"],
  'src/components/chat/cards/OrderCards.tsx': [1, "a chat custom order's frozen snapshot price, not a catalogue read"],
  'src/components/chat/cards/DealCards.tsx': [2, "a chat deal's frozen snapshot price, not a catalogue read"],
  'src/components/adminMystery/AdminMystery.tsx': [1, "the mystery composition editor's own owner-set field"],
  'src/components/adminBundles/AdminBundles.tsx': [1, "the bundle composition editor's own owner-set field"],
  'src/components/adminCommunity/AdminCommunity.tsx': [1, "a community order's agreed price"],
};

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true })
    .map((f) => `${dir}/${String(f).split('\\').join('/')}`)
    .filter((f) => /\.(ts|tsx)$/.test(f));
}

/** Code lines only: a comment may quote the banned shape while explaining it. */
const codeLines = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''));

test('no customer surface turns a null product price into 0', () => {
  const offenders: string[] = [];
  const counts = new Map<string, number>();
  for (const file of files('src')) {
    codeLines(readFileSync(join(ROOT, file), 'utf8')).forEach((line, i) => {
      if (!BANNED.some((re) => re.test(line))) return;
      counts.set(file, (counts.get(file) ?? 0) + 1);
      if (!ALLOWED[file]) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `a price fallback to 0 — branch on isUnpriced() instead:\n${offenders.join('\n')}`);
  for (const [file, [max, why]] of Object.entries(ALLOWED)) {
    const n = counts.get(file) ?? 0;
    assert.ok(n <= max, `${file} has ${n} fallbacks, the allow-list grants ${max} (${why}) — reclassify it here`);
  }
});

test('every allow-list entry still exists, so the list cannot rot into a blanket exemption', () => {
  for (const [file, [, why]] of Object.entries(ALLOWED)) {
    const n = codeLines(readFileSync(join(ROOT, file), 'utf8')).filter((l) => BANNED.some((re) => re.test(l))).length;
    assert.ok(n > 0, `${file} no longer needs its allow-list entry (${why}) — remove it`);
  }
});

test('the card helpers and the card price read the status before any figure', () => {
  const card = readFileSync(join(ROOT, 'src/components/CardPrice.tsx'), 'utf8');
  assert.match(card, /if \(isUnpriced\(p\)[^\n]*\) return <UnpricedPrice/);
  // The availability rule lives in packages/catalog (shared with the public API and the support
  // assistant); the card's module re-exports it.
  const lib = readFileSync(join(ROOT, 'packages/catalog/src/availability.ts'), 'utf8');
  assert.match(lib, /if \(p\.price_status === 'unpriced'\) return \{ state: 'unknown'/);
  const cardLib = readFileSync(join(ROOT, 'src/lib/productCard.ts'), 'utf8');
  assert.match(cardLib, /import \{ cardAvailability \} from '\.\.\/\.\.\/packages\/catalog\/src\/availability'/);
  const status = readFileSync(join(ROOT, 'src/lib/priceStatus.ts'), 'utf8');
  // UNPRICED_TEXT stays eager: a card must never flash a blank price while a lazy chunk loads.
  assert.doesNotMatch(status, /\bimport\(/);
});
