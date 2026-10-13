/**
 * VARIANT VERIFY (DECISIONS row 220 port, fix/leak-port 5e6f581c) — #20
 * "customer-api supplier source URL on product media".
 *
 * The port blanks `media[].source_url` in every PUBLIC projection
 * (`projectPublic`) and teaches the shared scanner (tests/fixtures/
 * costlyProduct.ts `leaks`) that a non-empty `source_url` inside a media /
 * images list is «a supplier source» — for EVERY non-owner role the sweeps
 * walk, staff admins included.
 *
 * Two gaps remain:
 *
 *   A. GUARD GAP. The role-matrix seed's costly product carries no picture
 *      (`images` '[]', no product_images row), so the new scanner rule never
 *      meets a supplier link in tests/costRoleMatrix*.test.ts or any sweep
 *      built on `seededCopy()`: it is dead in every sweep.
 *   B. STAFF ANSWERS. Seed one picture with a supplier link and walk EVERY GET
 *      of BASE_MOUNTS as every role: guests, customers, merchants, employees
 *      and investors are clean, but every non-owner ADMIN scope (assistant,
 *      full, legacy NULL, grantee with delegation off, support assistant)
 *      receives the supplier link from the admin product list, the product
 *      document, the relations drawer and both template exports — the very
 *      finding the port's scanner flags. Owner-only by the rule the port
 *      applied to #20 («supplier identity is private»); if the owner rules
 *      staff may see it, the scanner rule needs a NOT_A_COST entry instead.
 *
 * LOCAL ONLY: role-matrix SQLite copy, the real routers, no network.
 * Run: node --import tsx --test tests/leakVerify_variants_staff_product_media_supplier_source_url.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ROLES, ROLES, appFor, call, getPaths, leaks, seededCopy, type RoleName } from './fixtures/roleMatrix';

const SUPPLIER = 'https://supplier-secret-staff.example/listing/a1.jpg';
const MARK = /supplier-secret-staff\.example/;

function withPicture() {
  const raw = seededCopy();
  raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(
    JSON.stringify([{
      id: 'img_json', url: '/files/products/p_a1/gallery/aa.webp', key: 'products/p_a1/gallery/aa.webp', role: 'gallery',
      alt_ar: '', alt_en: 'A1', alt_ckb: '', order: 0, primary: true, width: 10, height: 10, source_url: SUPPLIER,
      option_value_id: '', color_id: '', variant_id: '',
    }]),
    'p_a1'
  );
  raw.prepare(`INSERT INTO product_images (id, product_id, url, r2_key, source_url, content_type, sort_order, is_primary,
                 width, height, bytes, alt_en, quarantined, quarantine_reason)
               VALUES ('img_rel','p_a1','/files/products/p_a1/gallery/bb.webp','products/p_a1/gallery/bb.webp',?,'image/webp',1,0,10,10,10,'A1',0,'')`)
    .run(SUPPLIER);
  return raw;
}

/** Every GET of BASE_MOUNTS as `role`, with a picture that carries a supplier link: the answers that carry it. */
async function sweep(role: RoleName): Promise<string[]> {
  const raw = withPicture();
  const app = appFor(raw, ROLES[role]);
  const hits: string[] = [];
  for (const p of getPaths()) {
    const res = await call(app, 'GET', p);
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    if (!MARK.test(text ?? '')) continue;
    // The port's own scanner, where it can parse the answer; the raw marker otherwise (a TXT/ZIP export).
    const scanner = leaks(res.body).filter((l) => /supplier source/.test(l));
    hits.push(`${res.status} GET ${p}${scanner.length ? `  (leaks(): ${scanner[0]})` : '  (export text carries the link)'}`);
  }
  return hits;
}

/**
 * A (the guard gap, closed here): the role-matrix seed carries no picture, so
 * the scanner's `source_url` rule met nothing in the shared sweeps. This sweep
 * seeds one picture WITH a supplier link (the JSON mirror and a relation row)
 * and walks every GET of BASE_MOUNTS as every customer-facing role — the #20
 * fix (`projectPublic` blanks the link) is held by a guard that sees a link.
 */
for (const role of ['guest', 'customer', 'merchant', 'employee', 'investor'] as RoleName[]) {
  test(`A: a product picture's supplier link reaches no ${role} answer (every GET, a seeded link)`, async () => {
    const raw = withPicture();
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM product_images WHERE source_url = ?").get(SUPPLIER) as { n: number }).n, 1, 'control: the link is seeded');
    assert.deepEqual(await sweep(role), [], `${role} receives the supplier link`);
  });
}

/**
 * B: staff. Kept, failing, as `todo` — the owner rules. Every non-owner admin
 * scope reads the link on the admin product list, the product document, the
 * relations drawer and both template exports. It is the picture's
 * provenance, not a cost; upstream lets assistant admins read supplier
 * provenance (worker/lib/inventoryProvenancePrivacy.ts), and the admin
 * product save echoes it back (quarantined pictures cannot be saved without
 * their `source_url`, worker/lib/productPersistence.ts) — stripping it for
 * staff would refuse or erase it on their next save. If the owner rules that
 * supplier identity is his alone, it needs an admin projection that keeps
 * the stored link on save; otherwise the scanner rule takes a NOT_A_COST entry
 * for staff.
 */
const OWNER_RULING =
  'OWNER RULING NEEDED (DECISIONS row 220): a picture’s supplier link is provenance, not a cost; staff read supplier provenance by upstream rule and their product saves echo the link back';

test('B: every non-owner admin scope receives a product picture’s supplier source URL', { todo: OWNER_RULING }, async () => {
  const found: string[] = [];
  for (const role of ADMIN_ROLES) {
    const hits = await sweep(role);
    if (hits.length) found.push(`${role}:\n      ${hits.join('\n      ')}`);
  }
  assert.deepEqual(found, [], `non-owner roles receive the supplier source URL of a product picture:\n  ${found.join('\n  ')}`);
});
