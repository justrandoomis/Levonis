/**
 * MEDIA AT FOUR LEVELS, ONE BINDING PER ROW (Bambu import spec §C.4 golden
 * cases, §G.3 selection rule).
 *
 * media.ts binds every gallery image the source ties to variants: one
 * variant → a variant row; exactly one value's variants → a value row; a
 * union of one group's values → one row per value (value_set); a value with
 * no row of its own gets its representative variant's hero. Content
 * duplicates (same stored object) collapse into the earliest copy. The page
 * then orders rows with the shared productMediaForSelection after leaving out
 * every row that contradicts the selection (media.ts contradicts).
 *
 * Content keys stand in for the server-side WebP hashes: the A1 gallery
 * repeats #0/#1 at #3/#4 and the H2D gallery #0/#1/#2 at #5/#6/#7 (same
 * pictures, older ids), which the import only knows after ingestion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, newProductId, type OptionModel } from '../packages/catalog/src/bambuImport/options';
import { contradicts, planMedia, type MediaPlan } from '../packages/catalog/src/bambuImport/media';
import { productMediaForSelection } from '../packages/pricing/src/productSelectionMedia';
import { sample, SAMPLE_HANDLES, type SampleHandle } from './fixtures/bambu/load';

const DUPLICATES: Partial<Record<SampleHandle, Record<number, number>>> = {
  a1: { 3: 0, 4: 1 },
  h2d: { 5: 0, 6: 1, 7: 2 },
};

function plan(h: SampleHandle): { model: OptionModel; media: MediaPlan; file: (rid: string) => string } {
  const x = sample(h);
  const productId = newProductId(x.sourceProductId);
  const model = buildOptions(x, productId);
  const dup = DUPLICATES[h] ?? {};
  const keyOf = new Map(x.gallery.map((g, i) => [g.resourceFileId, `k${dup[i] ?? i}`]));
  const media = planMedia({ productId, title: x.title, gallery: x.gallery, model, contentKey: (rid) => keyOf.get(rid) });
  const names = new Map(x.gallery.map((g) => [g.resourceFileId, (g.url.split('/').pop() ?? '').replace(/-compressed/g, '').replace(/\.[a-z]+$/i, '')]));
  return { model, media, file: (rid) => names.get(rid) ?? rid };
}

const idsOf = (model: OptionModel, names: string[]) =>
  names.map((n) => {
    const hit = model.groups.flatMap((g) => g.values).find((v) => v.nameEn === n);
    assert.ok(hit, `no value ${n}`);
    return hit!.id;
  });

/** The files a customer sees, in order, for a selection. */
function gallery(p: ReturnType<typeof plan>, names: string[]): string[] {
  const sel = idsOf(p.model, names);
  const key = [...sel].sort().map((id) => `o:${id}`).join('|');
  const variantId = p.model.variants.find((v) => v.comboKey === key)?.id ?? null;
  const rows = p.media.rows.filter((r) => !contradicts(r, p.model, sel));
  const ordered = productMediaForSelection(
    rows.map((r) => ({ url: r.resourceFileId, primary: r.isPrimary, option_value_id: r.optionValueId, variant_id: r.variantId })),
    { optionValueIds: sel, variantId }
  );
  return ordered.map((m) => p.file(m.url!));
}

test('A1: Standard leads with A1, Combo with A1_C; no A1_C image while A1 is selected', () => {
  const p = plan('a1');
  assert.equal(gallery(p, ['A1'])[0], 'A1');
  assert.equal(gallery(p, ['A1 Combo'])[0], 'A1_C');
  assert.ok(!gallery(p, ['A1']).includes('A1_C'));
  assert.deepEqual(p.media.report.collapsed.length, 2, 'the two repeated pictures collapse into #0 and #1');
  assert.equal(p.media.rows.filter((r) => r.isPrimary).length, 1);
  assert.equal(p.file(p.media.rows.find((r) => r.isPrimary)!.resourceFileId), 'A1');
});

test('H2D: H2D + standard → H2D; H2D AMS Combo alone → H2DC; Laser Full Combo → H2DL; no H2DL or H2DC while H2D is selected', () => {
  const p = plan('h2d');
  assert.equal(gallery(p, ['H2D', 'standard'])[0], 'H2D');
  assert.equal(gallery(p, ['H2D AMS Combo'])[0], 'H2DC');
  assert.equal(gallery(p, ['H2D Laser Full Combo'])[0], 'H2DL-10w');
  const h2d = gallery(p, ['H2D']);
  assert.ok(!h2d.includes('H2DL-10w') && !h2d.includes('H2DC'), h2d.join(','));
  // The full selection with a bundle: its own variant image ranks first (variant rank 0 < value rank 200).
  assert.equal(gallery(p, ['H2D AMS Combo', 'Dual AMS 2 Pro Bundle'])[0], 'H2DUSMS2PRo');
  // H2DL is the variant set of ONE value (H2D Laser Full Combo), not {10W, 40W}; 10W and 40W only
  // borrow it as their representative (they have no image of their own).
  const h2dl = p.media.rows.filter((r) => p.file(r.resourceFileId) === 'H2DL-10w');
  const own = h2dl.filter((r) => r.rule !== 'representative');
  assert.equal(own.length, 1);
  assert.equal(own[0].rule, 'value');
  assert.equal(p.model.groups.flatMap((g) => g.values).find((v) => v.id === own[0].optionValueId)?.nameEn, 'H2D Laser Full Combo');
  assert.deepEqual(h2dl.filter((r) => r.rule === 'representative').map((r) => p.model.groups.flatMap((g) => g.values).find((v) => v.id === r.optionValueId)?.nameEn).sort(), ['10W', '40W']);
});

test('PEI plate: H2C → FAP035; H2D → FAP025; P2S → FAP033 (value_set rows of one image)', () => {
  const p = plan('bambu-textured-pei-plate');
  assert.equal(gallery(p, ['H2C'])[0], 'FAP035');
  assert.equal(gallery(p, ['H2D'])[0], 'FAP025');
  assert.equal(gallery(p, ['P2S'])[0], 'FAP033');
  const fap033 = p.media.rows.filter((r) => p.file(r.resourceFileId) === 'FAP033');
  assert.deepEqual(new Set(fap033.map((r) => r.rule)), new Set(['value_set']));
  assert.deepEqual(
    fap033.map((r) => p.model.groups[0].values.find((v) => v.id === r.optionValueId)!.nameEn).sort(),
    ['A1', 'P1 Series', 'P2S', 'X1 Series', 'X2D']
  );
});

test('PLA Basic: each colour leads with its colour image; Black Refill and Black Spool share one', () => {
  const p = plan('pla-basic-filament');
  const colour = p.model.groups.find((g) => g.kind === 'color')!;
  for (const v of colour.values.slice(0, 12)) {
    const first = gallery(p, [v.nameEn])[0];
    const own = p.media.rows.find((r) => r.optionValueId === v.id || p.model.variants.find((x) => x.id === r.variantId)?.valueIds.includes(v.id));
    assert.ok(own, `${v.nameEn} has a bound image`);
    assert.equal(first, p.file(own!.resourceFileId), v.nameEn);
  }
  const black = colour.values.find((v) => /^Black/.test(v.nameEn))!;
  const shared = p.model.variants.filter((v) => v.valueIds.includes(black.id));
  assert.ok(shared.length >= 2);
  assert.equal(new Set(shared.map((v) => v.heroResourceFileId)).size, 1, 'Black Refill and Black Spool share their hero');
  assert.ok(p.media.report.sharesImageWithSiblings.length > 0, 'shares_image_with_siblings is reported');
  assert.ok(p.media.swatches.length > 0 && p.media.swatches.every((s) => s.sourceMediaId.startsWith('swatch:')), 'swatches are not gallery rows');
});

test('AMS 2 Pro: the 13 variants on gallery #0 are bound to that one image; the 2 bundles lead with their own', () => {
  const p = plan('ams-2-pro.options');
  const x = sample('ams-2-pro.options');
  const first = x.gallery[0].resourceFileId;
  const onFirst = p.model.variants.filter((v) => v.heroResourceFileId === first);
  assert.equal(onFirst.length, 13);
  // §C.4 step 2: V(#0) is exactly the union of five "units" values, so the binding is one value_set row per
  // value (5 rows, one image) rather than 13 variant rows; every one of the 13 selections leads with #0 either way.
  const rows = p.media.rows.filter((r) => r.resourceFileId === first && r.rule === 'value_set');
  assert.equal(rows.length, 5);
  const covered = new Set(p.model.variants.filter((v) => rows.some((r) => v.valueIds.includes(r.optionValueId!))).map((v) => v.id));
  assert.deepEqual([...covered].sort(), onFirst.map((v) => v.id).sort());
  const nameOf = (id: string) => p.model.groups.flatMap((g) => g.values).find((v) => v.id === id)!.nameEn;
  for (const v of onFirst) assert.equal(gallery(p, v.valueIds.map(nameOf))[0], p.file(first), v.valueIds.map(nameOf).join(' + '));
  const bundles = p.model.variants.filter((v) => v.heroResourceFileId !== first);
  assert.equal(bundles.length, 2);
  for (const v of bundles) assert.equal(gallery(p, v.valueIds.map(nameOf))[0], p.file(v.heroResourceFileId!));
});

/**
 * R6 FOR EVERY FULL SELECTION (review 4, finding 3). A representative row is
 * bound to a value but shows its source variant's hero; for every real
 * variant of every fixture, no image left in the gallery may be the hero ONLY
 * of variants that clash with the selection. PLA Basic Orange + Refill + 1 kg
 * used to show the Jade White picture (the Refill representative).
 */
test('every fixture, every variant: no visible image is the hero only of contradicting variants', () => {
  let selections = 0;
  for (const h of SAMPLE_HANDLES) {
    const p = plan(h);
    const heroes = new Map<string, Set<string>>();
    for (const v of p.model.variants) {
      if (!v.heroResourceFileId) continue;
      heroes.set(v.heroResourceFileId, new Set([...(heroes.get(v.heroResourceFileId) ?? []), v.id]));
    }
    // A collapsed copy shows the same picture as its canonical row.
    for (const [copy, kept] of p.media.report.collapsed) {
      const set = heroes.get(kept) ?? new Set<string>();
      for (const id of heroes.get(copy) ?? []) set.add(id);
      heroes.set(kept, set);
    }
    for (const v of p.model.variants) {
      selections++;
      const visible = p.media.rows.filter((r) => !contradicts(r, p.model, v.valueIds));
      const wrong = visible.filter((r) => {
        const of = heroes.get(r.resourceFileId);
        return !!of && of.size > 0 && !of.has(v.id);
      });
      const names = v.valueIds.map((id) => p.model.groups.flatMap((g) => g.values).find((x) => x.id === id)!.nameEn).join(' + ');
      assert.deepEqual(wrong.map((r) => `${p.file(r.resourceFileId)} (${r.rule})`), [], `${h}: ${names}`);
    }
  }
  assert.ok(selections >= 80, `${selections} full selections`);
  // The case the review named, by file.
  const pla = plan('pla-basic-filament');
  const orange = gallery(pla, ['Orange (10300)', 'Refill', '1kg']);
  assert.ok(!orange.some((f) => /White/i.test(f)), orange.join(','));
  // A representative still leads a PARTIAL selection: the store's own picture for that choice (§C.4 step 3).
  const h2d = plan('h2d');
  assert.equal(gallery(h2d, ['H2D AMS Combo'])[0], 'H2DC');
  assert.ok(!gallery(h2d, ['H2D AMS Combo', 'Dual AMS 2 Pro Bundle']).includes('H2DC'), 'the Standard picture is gone once another bundle is chosen');
  for (const r of h2d.media.rows) assert.equal(r.viaVariantId !== null, r.rule === 'representative', `${r.rule}: viaVariantId`);
});

test('every fixture: one primary on gallery index 0, deterministic pi_ ids, one binding per row, alt text in three languages', () => {
  for (const h of SAMPLE_HANDLES) {
    const p = plan(h);
    const x = sample(h);
    const primaries = p.media.rows.filter((r) => r.isPrimary);
    assert.equal(primaries.length, 1, h);
    assert.equal(primaries[0].resourceFileId, x.gallery[0].resourceFileId, h);
    assert.ok(p.media.rows.every((r) => /^pi_[0-9a-f]{24}$/.test(r.id)), h);
    assert.equal(new Set(p.media.rows.map((r) => r.id)).size, p.media.rows.length, `${h}: duplicate row id`);
    for (const r of p.media.rows) {
      assert.ok(!(r.optionValueId && r.variantId), `${h}: one binding per row`);
      assert.ok(r.alt.en && r.alt.ar.startsWith('صورة') && r.alt.ckb.startsWith('وێنەی'), `${h}: alt in three languages`);
    }
  }
});
