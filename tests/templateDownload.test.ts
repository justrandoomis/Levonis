/**
 * Mandate §6.1 — template DOWNLOAD + confirm-once guard.
 * Run: npm run test:unit   (tsx --test tests/*.test.ts)
 *
 * These pin the two things §6.1 says a 200 response alone does not prove:
 *  1. the bytes we serve are a real .txt attachment (headers Safari honours),
 *     and the importer accepts EXACTLY what the download serves — zero parse
 *     errors, zero unknown keys, with the rich field set still intact;
 *  2. confirming the same batch twice resolves to ONE write.
 *
 * The D1 stub below emulates only the two statements the fingerprint guard
 * issues. It proves the guard's contract (exactly one winner, release lets a
 * corrected retry through); the SQLite semantics of the upsert itself are
 * exercised against real D1 by the api-tests suites, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { AppContext } from '../worker/lib/types';
import {
  templateRoutes,
  buildBlankTemplate,
  buildExampleTemplate,
  templateDownloadDiagnostics,
  typeSpecScaffold,
  contentDisposition,
  applyFingerprint,
  claimApplyFingerprint,
  releaseApplyFingerprint,
} from '../worker/routes/template';
import {
  parseTemplate,
  toDocBody,
  translationBookkeeping,
  FIELD_REGISTRY,
  TEMPLATE_VERSION,
} from '../worker/lib/template';
import { validateProductDoc } from '../worker/lib/productModel';
import { narrowGroups, PRODUCT_TYPES } from '../worker/lib/templateFamilies';

// --------------------------------------------------------------- harness

/** Mounts the real routes behind a stub admin session. */
function adminApp() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'usr_test_admin', role: 'admin' } as never);
    await next();
  });
  app.route('/api/admin/template', templateRoutes);
  return app;
}

/** Full parse → merge → validate pass, exactly as the route does it for a
 *  create with no brand/catalog references to resolve. */
function pipeline(text: string) {
  const parsed = parseTemplate(text);
  const merge = toDocBody(parsed, null, { brand_id: null, catalog_ids: [] });
  const body: Record<string, unknown> = { ...merge.body };
  const bookkeeping = translationBookkeeping(body, null);
  body.content_rev = bookkeeping.content_rev;
  body.translation_meta = bookkeeping.translation_meta;
  return { parsed, merge, doc: validateProductDoc(body) };
}

// ------------------------------------------------- 1. download headers

test('GET /blank serves a real .txt attachment, not an HTML page', async () => {
  const res = await adminApp().request('/api/admin/template/blank');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  const cd = res.headers.get('content-disposition') ?? '';
  assert.match(cd, /^attachment;/);
  assert.match(cd, /filename="levonis-product-template\.txt"/);
  assert.match(cd, /filename\*=UTF-8''/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const text = await res.text();
  // A 200 carrying index.html is NOT a successful template download (§6.1).
  assert.ok(!/<!doctype html/i.test(text), 'must not be an HTML document');
  assert.ok(text.includes(`template_version=${TEMPLATE_VERSION}`));
  // Content-Length must be the UTF-8 BYTE length, not the JS string length —
  // the file is mostly Arabic, so the two differ.
  const bytes = new TextEncoder().encode(text).byteLength;
  assert.equal(res.headers.get('content-length'), String(bytes));
  assert.ok(bytes > text.length, 'Arabic content must be multi-byte');
});

test('GET /example serves its own attachment filename', async () => {
  const res = await adminApp().request('/api/admin/template/example');
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get('content-disposition') ?? '',
    /filename="levonis-product-template-example\.txt"/
  );
  assert.equal((await res.text()), buildExampleTemplate());
});

test('contentDisposition sanitizes and always ends in .txt', () => {
  // A header can never be broken out of, and a non-ASCII name still gets an
  // ASCII fallback plus the RFC 5987 form.
  const cd = contentDisposition('منتج "x"\r\nInjected: 1.txt');
  assert.ok(!cd.includes('\r') && !cd.includes('\n'));
  assert.match(cd, /filename="[A-Za-z0-9._-]+\.txt"/);
  assert.match(cd, /filename\*=UTF-8''/);
  assert.match(contentDisposition('report'), /filename="report\.txt"/);
});

// ---------------------------------------- 2. what we serve, we accept

test('blank template parses with zero errors and zero unknown keys', () => {
  const d = templateDownloadDiagnostics();
  assert.equal(d.blank.errors, 0, 'the downloaded blank must not carry parse errors');
  assert.deepEqual(d.blank.unknown_keys, []);
});

test('every per-type blank parses clean with active, empty specification rows', () => {
  // `?type=` appends the product type's own specification sheet. It is served
  // as empty `spec.*` rows whose update semantics are preserve-on-empty; this
  // proves it for EVERY type rather than assuming it.
  //
  // COUNTED FROM THE REGISTRY, not written out. This line said `4` and the day
  // «ليزر» and «مواد ليزر وقص» joined PRODUCT_TYPES it failed on the number
  // while the two new sheets it was meant to check went unexamined. The
  // registry is the list; a type added to it is a type proved here.
  const d = templateDownloadDiagnostics();
  assert.equal(d.typed.length, PRODUCT_TYPES.length);
  for (const t of d.typed) {
    assert.equal(t.errors, 0, `the ${t.type} template must not carry parse errors`);
    assert.deepEqual(t.unknown_keys, [], `the ${t.type} template must not carry unknown keys`);
  }
});

test('the per-type scaffold names that type\'s spec fields', () => {
  // A printer's scaffold must actually list printer specifications, otherwise
  // the type parameter is decoration.
  const printer = typeSpecScaffold('printer').join('\n');
  const filament = typeSpecScaffold('filament').join('\n');
  assert.notEqual(printer, filament);
  for (const text of [printer, filament]) {
    for (const line of text.split('\n')) {
      assert.ok(line === '' || line.startsWith('#') || /^spec\.[a-z0-9_]+=$/.test(line), `unexpected scaffold line: ${line}`);
    }
  }
  assert.ok(printer.includes('spec.technology='));
  assert.ok(filament.includes('spec.material_type='));
  assert.ok(!filament.includes('spec.build_volume='), 'a filament template must not repeat printer rows');
});

test('the TXT scaffold changes again when the selected printer section changes', () => {
  const fdm = typeSpecScaffold(
    'printer',
    narrowGroups('printer', [{ id: 'cat_printers_fdm', slug: 'fdm-printers' }]),
    'FDM printers',
  ).join('\n');
  const resin = typeSpecScaffold(
    'printer',
    narrowGroups('printer', [{ id: 'cat_printers_resin', slug: 'resin-printers' }]),
    'Resin printers',
  ).join('\n');

  assert.notEqual(fdm, resin);
  assert.match(fdm, /spec\.nozzle_temp_max=/);
  assert.doesNotMatch(fdm, /spec\.lcd_size=/);
  assert.match(resin, /spec\.lcd_size=/);
  assert.doesNotMatch(resin, /spec\.nozzle_temp_max=/);
});

test('blank template auto-disables only the known unparseable required ints', () => {
  // Tripwire: if the field registry gains another key whose blank value the
  // parser rejects, this fails loudly instead of silently commenting it out.
  const d = templateDownloadDiagnostics();
  assert.deepEqual(
    d.blank.disabled.map((x) => x.content).sort(),
    ['display_order=', 'price_iqd='],
  );
});

test('a scalar that lives inside a grouped section is served ONCE — never as a duplicate key', () => {
  // The device-coverage scalars (`warranty_base_months`, `serialized`) share
  // the "warranty" section with the repeated `warranty_plans` group, exactly
  // as the usage URL shares its section with the guide steps. Printing them
  // in both the scalar pass and the group pass served each key twice; the
  // parser called the second copy a duplicate and the healer commented it
  // out — a blank that quietly lost two keys. Pinned here.
  const text = buildBlankTemplate().text;
  for (const key of ['warranty_base_months', 'serialized', 'usage_official_url']) {
    const active = text.split('\n').filter((line) => line.trim().startsWith(`${key}=`));
    assert.equal(active.length, 1, `${key} must be served exactly once, got ${active.length}`);
  }
  assert.ok(text.includes('warranty_base_months=__NULL__'), 'the base is honestly not configured on a blank');
  assert.ok(text.includes('serialized=false'), 'serialization is stated, not assumed, on a blank');
});

test('blank template keeps the RICH field set — nothing is slimmed away', () => {
  const text = buildBlankTemplate().text;
  for (const spec of FIELD_REGISTRY.scalars) {
    if (spec.exported === false) continue;
    assert.ok(text.includes(`${spec.key}=`), `missing scalar key ${spec.key}`);
    assert.ok(text.includes(`# ${spec.key} —`), `missing documentation for ${spec.key}`);
  }
  for (const group of FIELD_REGISTRY.groups) {
    for (const spec of group.fields) {
      if (spec.exported === false) continue;
      assert.ok(text.includes(`${group.name}.1.${spec.key}=`), `missing ${group.name}.1.${spec.key}`);
    }
    for (const spec of group.rowFields ?? []) {
      assert.ok(
        text.includes(`${group.name}.1.rows.1.${spec.key}=`),
        `missing ${group.name}.1.rows.1.${spec.key}`
      );
    }
  }
});

test('an untouched blank carries no active repeated-group item', () => {
  const { text, groupsDisabled } = buildBlankTemplate();
  assert.ok(groupsDisabled.length > 0);
  const active = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const groupLines = active.filter((l) => /^[a-z_]+\.\d+\./.test(l));
  assert.deepEqual(groupLines, [], 'group sample items must ship commented out');
});

test('blank + a name + a price is a valid create (download → fill → import)', () => {
  const filled = buildBlankTemplate()
    .text.replace(/^name_ar=$/m, 'name_ar=منتج اختبار الدورة الكاملة')
    .replace(/^name_en=$/m, 'name_en=Round trip test')
    .replace(/^# price_iqd=.*$/m, 'price_iqd=75000');
  const { parsed, merge, doc } = pipeline(filled);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(merge.needs_review, []);
  assert.equal(doc.name_ar, 'منتج اختبار الدورة الكاملة');
  assert.equal(doc.price_iqd, 75_000);
  // No phantom option/colour/image invented from the blank's documentation.
  assert.deepEqual([doc.options.length, doc.colors.length, doc.media.length], [0, 0, 0]);
});

// ------------------------------------------------------- 3. the example

test('example template is valid end-to-end and creates a draft', () => {
  const { parsed, merge, doc } = pipeline(buildExampleTemplate());
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.unknown_keys, []);
  assert.deepEqual(merge.needs_review, [], 'the example must resolve without review');
  assert.equal(doc.status, 'draft');
  assert.ok(/مثال|example/i.test(`${doc.name_ar} ${doc.name_en}`), 'example must name itself');
  assert.equal(doc.price_iqd, 100_000);
});

test('example demonstrates the owner\'s form: the base is the cheapest, options and colours are increases', () => {
  const { doc } = pipeline(buildExampleTemplate());
  const [small, large] = doc.options;
  assert.equal(small.regular_price_iqd, null, '__NULL__ inherits, it is not zero');
  assert.equal(large.regular_price_iqd, null, '+20000 is not a price');
  assert.equal(large.regular_adjust_iqd, 20_000, 'it is the increase over the 100,000 base');
  assert.equal(small.availability_type, '', 'availability follows the product');
  // option_index is an import-only alias that must resolve to the option id.
  const gold = doc.colors.find((c) => c.name_en === 'Gold');
  assert.equal(gold?.option_id, large.id);
  assert.equal(gold?.regular_price_iqd, null);
  assert.equal(gold?.regular_adjust_iqd, 15_000, '+15,000 over the Large option');
  // …and the last form section is in the file too.
  assert.equal(doc.usage_guide.steps.length, 1);
  assert.equal(doc.usage_guide.steps[0].kind, 'setup');
});

test('example never ships an active image URL (no broken-image product)', () => {
  const { doc } = pipeline(buildExampleTemplate());
  assert.deepEqual(doc.media, []);
  const active = buildExampleTemplate()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  assert.ok(!active.some((l) => l.startsWith('images.')), 'image lines must stay commented');
});

// --------------------------------------------- 4. confirm-once guard

test('fingerprint ignores line endings and surrounding whitespace', async () => {
  const a = await applyFingerprint('usr_1', 'draft', null, 'name_ar=س\nprice_iqd=1\n');
  const b = await applyFingerprint('usr_1', 'draft', null, '  name_ar=س\r\nprice_iqd=1\r\n  ');
  assert.equal(a, b, 'the same file from Windows and macOS is the same batch');
});

test('fingerprint separates admin, mode, duplicate choice and content', async () => {
  const base = await applyFingerprint('usr_1', 'draft', null, 'name_ar=س');
  const others = await Promise.all([
    applyFingerprint('usr_2', 'draft', null, 'name_ar=س'),
    applyFingerprint('usr_1', 'update', null, 'name_ar=س'),
    applyFingerprint('usr_1', 'draft', 'update_existing', 'name_ar=س'),
    applyFingerprint('usr_1', 'draft', null, 'name_ar=ص'),
  ]);
  for (const other of others) assert.notEqual(other, base);
  assert.equal(new Set(others).size, others.length);
});

/** Minimal D1 stub for the two statements the guard issues. */
function fakeDb(nowSeconds: number) {
  const rows = new Map<string, { window_start: number; count: number }>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (!sql.includes('INSERT INTO rate_limits')) return null;
              const [key, now, cutoff] = args as [string, number, number];
              const existing = rows.get(key);
              if (!existing) {
                rows.set(key, { window_start: now, count: 1 });
                return { count: 1, window_start: now } as T;
              }
              const fresh = existing.window_start > cutoff;
              const next = { window_start: fresh ? existing.window_start : now, count: fresh ? existing.count + 1 : 1 };
              rows.set(key, next);
              return { count: next.count, window_start: next.window_start } as T;
            },
            async run() {
              if (sql.startsWith('DELETE FROM rate_limits')) {
                const [key, generation] = args as [string, number];
                if (rows.get(key)?.window_start === generation) rows.delete(key);
              }
              return { success: true };
            },
          };
        },
      };
    },
    _rows: rows,
    _now: nowSeconds,
  };
  return db as unknown as D1Database & { _rows: typeof rows };
}

test('only the first confirm of a batch claims the write', async () => {
  const db = fakeDb(Math.floor(Date.now() / 1000));
  const fp = await applyFingerprint('usr_1', 'draft', null, 'name_ar=س');
  assert.ok(await claimApplyFingerprint(db, fp), 'first confirm writes');
  assert.equal(await claimApplyFingerprint(db, fp), null, 'double-click writes nothing');
  assert.equal(await claimApplyFingerprint(db, fp), null, 'a timed-out retry writes nothing');
});

test('a different batch is never blocked by another batch claim', async () => {
  const db = fakeDb(Math.floor(Date.now() / 1000));
  const a = await applyFingerprint('usr_1', 'draft', null, 'name_ar=أ');
  const b = await applyFingerprint('usr_1', 'draft', null, 'name_ar=ب');
  assert.ok(await claimApplyFingerprint(db, a));
  assert.ok(await claimApplyFingerprint(db, b));
});

test('a claim released after a failed write lets the corrected retry through', async () => {
  const db = fakeDb(Math.floor(Date.now() / 1000));
  const fp = await applyFingerprint('usr_1', 'draft', null, 'name_ar=س');
  const claim = await claimApplyFingerprint(db, fp);
  assert.ok(claim);
  await releaseApplyFingerprint(db, fp, claim!); // the INSERT threw — nothing was written
  assert.ok(await claimApplyFingerprint(db, fp), 'retry after a failed write is allowed');
});

test('a losing double-click cannot strand the winner fingerprint after the winner fails', async () => {
  const db = fakeDb(Math.floor(Date.now() / 1000));
  const fp = await applyFingerprint('usr_1', 'draft', null, 'name_ar=س');
  const claim = await claimApplyFingerprint(db, fp);
  assert.ok(claim);
  assert.equal(await claimApplyFingerprint(db, fp), null, 'the concurrent duplicate does not own the claim');
  await releaseApplyFingerprint(db, fp, claim!);
  assert.ok(await claimApplyFingerprint(db, fp), 'failure releases the owned claim even after a duplicate arrived');
});

test('an expired owner cannot release a newer fingerprint generation', async () => {
  const db = fakeDb(1_000_000);
  const fp = await applyFingerprint('usr_1', 'draft', null, 'name_ar=س');
  const realNow = Date.now;
  let nowMs = 1_000_000_000;
  Date.now = () => nowMs;
  try {
    const oldClaim = await claimApplyFingerprint(db, fp);
    assert.ok(oldClaim);
    nowMs += 901_000;
    const newClaim = await claimApplyFingerprint(db, fp);
    assert.ok(newClaim, 'the expired lease has a new owner');
    assert.notEqual(newClaim!.window_start, oldClaim!.window_start);
    await releaseApplyFingerprint(db, fp, oldClaim!);
    assert.equal(await claimApplyFingerprint(db, fp), null, 'the stale owner did not delete the new generation');
  } finally {
    Date.now = realNow;
  }
});
