/**
 * A re-layout (variant, density, format) keeps what the person chose that it
 * can keep, and refuses — rather than silently drops — a binding it cannot
 * draw (findings model-2, model-4; spec §24, §34-7).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrandKit } from '../src/brand';
import { buildFromTemplate, rebuild, type RebuildContext } from '../src/layout';
import { applyOps } from '../src/ops';
import { FORMATS, type CreativeDocument, type Layer, type TextLayer } from '../src/schema';
import { NO_EVIDENCE } from '../src/templates';
import { approximateMeasurer } from '../src/text';
import { allowedFor, buildInput, built, snapshot } from './fixtures';

const base = defaultBrandKit();
const kit = { ...base, backgrounds: [...base.backgrounds, { id: 'sand', label: 'Sand', kind: 'solid' as const, color: '#2a2d31', asset_id: null }] };
const ctxOf = (over: Partial<RebuildContext> = {}): RebuildContext => ({
  brand: kit, brandVersion: null, snapshots: { main: snapshot() }, claims: {}, evidence: NO_EVIDENCE, family: null, logo: { width: 1254, height: 1254 }, backgroundNatural: null, measure: approximateMeasurer, ...over,
});
const L = (doc: CreativeDocument, id: string): Layer | undefined => doc.layers.find((l) => l.id === id);
const edit = (doc: CreativeDocument, ops: unknown[]) => {
  const r = applyOps(doc, ops, { actor: 'human', brand: kit, allowed: allowedFor(), measure: approximateMeasurer });
  assert.ok(r.ok, JSON.stringify(r));
  return r.ok ? r.doc : doc;
};

/** The reviewer's probe: recolour and lock the headline, delete the CTA, apply the «sand» background. */
function personalised(): CreativeDocument {
  let doc = built({ brand: kit }).doc;
  doc = edit(doc, [{ op: 'set_color', layer_id: 'headline', color: '#c9cdc4' }]);
  doc = edit(doc, [{ op: 'set_lock', layer_id: 'headline', locked: true }]);
  doc = edit(doc, [{ op: 'delete_layer', layer_id: 'cta_group' }]);
  return edit(doc, [{ op: 'apply_background_preset', preset_id: 'sand' }]);
}

test('a person`s re-layout keeps the background in use, a deleted CTA, a chosen colour and a lock', () => {
  const doc = personalised();
  for (const change of [{ variant: 'price_first' as const }, { density: 'detailed' as const }, { format: FORMATS.story }]) {
    const r = rebuild(doc, change, ctxOf());
    assert.ok(r, JSON.stringify(change));
    if (!r) continue;
    const h = L(r.doc, 'headline') as TextLayer;
    assert.equal(h.color, '#c9cdc4', `${JSON.stringify(change)}: the person's colour`);
    assert.equal(h.locked, true, `${JSON.stringify(change)}: the lock`);
    assert.equal(L(r.doc, 'cta'), undefined, `${JSON.stringify(change)}: the deleted CTA stays deleted`);
    assert.equal(L(r.doc, 'cta_group'), undefined);
    const bg = L(r.doc, 'background')!;
    assert.ok(bg.type === 'shape' && bg.fill === '#2a2d31', `${JSON.stringify(change)}: the sand background, not the kit default`);
  }
  // A colour the current palette no longer has is not carried (the template's colour is used).
  const narrowed = { ...kit, colors: { ...kit.colors, palette: kit.colors.palette.filter((c) => c !== '#c9cdc4') } };
  const r2 = rebuild(doc, { variant: 'price_first' }, ctxOf({ brand: narrowed }));
  assert.equal((L(r2!.doc, 'headline') as TextLayer).color, narrowed.colors.text);
});

test('Claude may not start that re-layout while the headline is locked; once unlocked it may, and the result is exposed', () => {
  const doc = personalised();
  const ai = { actor: 'ai' as const, brand: kit, allowed: allowedFor(), measure: approximateMeasurer };
  const refused = applyOps(doc, [{ op: 'switch_template_variant', variant: 'price_first' }], ai);
  assert.ok(!refused.ok && refused.refusals[0].code === 'locked_layer' && refused.refusals[0].layer_id === 'headline', JSON.stringify(refused));
  const free = edit(doc, [{ op: 'set_lock', layer_id: 'headline', locked: false }]);
  const ok = applyOps(free, [{ op: 'switch_template_variant', variant: 'price_first' }], ai);
  assert.ok(ok.ok && ok.rebuild && ok.rebuild.kind === 'variant');
});

test('a product picture the person deleted stays out, and the product`s bound words stay in', () => {
  const doc = edit(built().doc, [{ op: 'delete_layer', layer_id: 'product' }]);
  const r = rebuild(doc, { format: FORMATS.story }, ctxOf());
  assert.ok(r);
  if (!r) return;
  assert.equal(r.doc.products.length, 1, 'the binding is kept');
  assert.equal(L(r.doc, 'product'), undefined, 'no picture comes back');
  for (const id of ['product_name', 'price']) assert.ok(L(r.doc, id), `${id} kept`);
  assert.deepEqual(r.conflicts.filter((c) => c.code === 'overlap' || c.code === 'outside_safe_area'), []);
  // A split template stacks its words instead of leaving them half a page beside an empty column.
  const split = edit(built({ template: 'compact_product', variant: 'product_first' }).doc, [{ op: 'delete_layer', layer_id: 'product' }]);
  const rs = rebuild(split, { density: 'detailed' }, ctxOf())!;
  const headline = L(rs.doc, 'headline') as TextLayer;
  assert.ok(headline.width > rs.doc.format.width * 0.7, `headline ${Math.round(headline.width)}px wide`);
});

test('a binding the re-layout cannot draw refuses the re-layout instead of disappearing', () => {
  const doc = built().doc;
  assert.equal(rebuild(doc, { density: 'detailed' }, ctxOf({ snapshots: {} })), null, 'snapshot not loaded');
  const claim = {
    id: 'claim_free_dlv', version: 2,
    title: { ar: 'توصيل (نص تجريبي)', en: 'Delivery (test)', ckb: 'گەیاندن (تاقیکاری)' },
    summary: { ar: 'ملخص تجريبي', en: 'Test summary', ckb: 'پوختەی تاقیکاری' },
    conditions: { ar: 'شروط تجريبية', en: 'Test conditions', ckb: 'مەرجی تاقیکاری' },
    details_path: null,
  };
  const service = buildFromTemplate(buildInput({ template: 'service_card', variant: 'feature_first', products: [], service: claim, objective: 'service_trust', copy: { headline: 'اطمئن لطابعتك', cta: 'اعرف التفاصيل' } })).doc;
  assert.equal(rebuild(service, { format: FORMATS.portrait }, ctxOf({ snapshots: {}, claims: {} })), null, 'claim not in the approved list');
  const ok = rebuild(service, { format: FORMATS.portrait }, ctxOf({ snapshots: {}, claims: { [claim.id]: claim } }));
  assert.ok(ok && ok.doc.services.length === 1 && L(ok.doc, 'service_conditions'), 'with the claim, the conditions are drawn');
});
