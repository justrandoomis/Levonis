/**
 * THE STUDIO SCREENS' RULES, WITHOUT A BROWSER —
 * src/components/creativeStudio/screensModel.ts, and the screens' sources.
 *
 *  - the visual priority has an effect: the chosen priority's composition
 *    leads, only priorities the template supports are offered, a lesson is
 *    never offered «the price» (spec §11, §12, §34.18);
 *  - «use this idea» carries the claim, the composition, the caption, the alt
 *    text and the job; a build keeps the idea's job only while its headline
 *    is the idea's own; a template-only build stays 'template' (§10, §27);
 *  - Home asks for ideas with NO priorities (the opportunity kinds are not the
 *    owner's priorities, §10 «لا تختلق»);
 *  - Settings sends the model only when it changed (a revoked key must not
 *    lock the caps) and the priorities only when they changed; there is no
 *    automatic-fix-rounds field (§34.18);
 *  - a family badge is drawn only with evidence, and says why not (§7);
 *  - the catalogue watch runs to the end of a pass and reports a baseline;
 *  - the archive's «to» date includes its own day (§22);
 *  - upload texts follow the review the server returned (§6);
 *  - claims: grouped, validated like the server, approvable only with three
 *    languages (§7-ج, §19).
 *
 * Run: node --import tsx --test tests/creativeStudioScreensModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import type { ClaimDto, IdeaRecordDto, ProviderStatusDto, WatchSyncResponse } from '../packages/creativeDoc/src/api';
import { NO_EVIDENCE } from '../packages/creativeDoc/src/templates';
import {
  archiveQuery, claimApprovable, claimBody, claimForm, claimFormProblems, compositionVariants, createOrigin, effectivePriority, familyBadge, familyChoice,
  familyForObjective, groupClaims, ideaJobFor, ideaPrefill, ideasRequest, initialPriority, isJobRefusal, parsePriorities, runCatalogSync, settingsPayload,
  supportedPriorities, uploadedText,
} from '../src/components/creativeStudio/screensModel';
import { S } from '../src/components/creativeStudio/strings';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('the chosen visual priority leads the compositions; only priorities the template supports are offered', () => {
  // A priced product, selling: the price can lead.
  for (const p of ['product', 'price', 'feature'] as const) assert.ok(supportedPriorities('product_hero', 'sell', 'priced').includes(p), p);
  assert.deepEqual(compositionVariants('product_hero', 'sell', 'priced', 'product')[0], 'product_first');
  assert.deepEqual(compositionVariants('product_hero', 'sell', 'priced', 'price')[0], 'price_first');
  assert.deepEqual(compositionVariants('product_hero', 'sell', 'priced', 'feature')[0], 'feature_first');
  // Each choice gives a different first composition — the control has an effect.
  const firsts = supportedPriorities('product_hero', 'sell', 'priced').map((p) => compositionVariants('product_hero', 'sell', 'priced', p)[0]);
  assert.equal(new Set(firsts).size, firsts.length);
  // At most three, whatever the template holds.
  assert.ok(compositionVariants('product_hero', 'sell', 'priced', 'price').length <= 3);
  // No public price: the price is not offered, and a stale «price» choice falls back to the template's own first.
  assert.ok(!supportedPriorities('product_hero', 'sell', 'unpriced').includes('price'));
  assert.equal(effectivePriority('price', supportedPriorities('product_hero', 'sell', 'unpriced')), 'product');
  // A lesson about a priced product is never offered the price.
  assert.ok(!supportedPriorities('product_hero', 'education', 'priced').includes('price'));
  assert.ok(!compositionVariants('product_hero', 'education', 'priced', 'price').includes('price_first'));
  // A service card offers the message only where it has a message-first composition.
  assert.ok(!supportedPriorities('service_card', 'service_trust', null).includes('price'));
  assert.ok(supportedPriorities('service_card', 'service_trust', null).includes('headline'));
  assert.equal(compositionVariants('service_card', 'service_trust', null, 'headline')[0], 'headline_first');
  // Every offered priority leads its own composition, for every template New design builds.
  for (const [tpl, obj, price] of [['service_card', 'service_trust', null], ['education_slide', 'education', null], ['compact_product', 'sell', 'priced']] as const) {
    for (const p of supportedPriorities(tpl, obj, price)) assert.ok(compositionVariants(tpl, obj, price, p).length >= 1, `${tpl} ${p}`);
  }
  // As many compositions as the template has for the goal, never more than three (the header says «up to three»).
  assert.ok(compositionVariants('education_slide', 'education', null, 'feature').length <= 3);
});

const IDEA: IdeaRecordDto = {
  id: 'idea_1', status: 'new', job_id: 'job_ideas_1', created_at: '2026-10-27T09:00:00Z',
  objective: 'service_trust', target_kind: 'service', target_ref: 'cclm_warranty', audience: 'مشترو الطابعات', reason: 'ضمان معتمد',
  evidence_ids: ['service_claim:cclm_warranty'], message: 'ضمان سنة كاملة', headline: 'ضمان سنة على كل طابعة', subhead: 'صيانة مجانية',
  cta: 'اعرف الشروط', post_type: 'carousel', layout: 'headline_first', caption: 'ضمان Levonis لسنة كاملة', alt_text: 'بطاقة ضمان على خلفية فحمية',
};

test('«use this idea» carries the claim, the composition, the caption, the alt text and the job', () => {
  const p = ideaPrefill(IDEA);
  assert.equal(p.mode, 'service');
  assert.equal(p.claimId, 'cclm_warranty');
  assert.equal(p.productId, undefined);
  assert.equal(p.objective, 'service_trust');
  assert.equal(p.variant, 'headline_first');
  assert.equal(p.caption, IDEA.caption);
  assert.equal(p.alt, IDEA.alt_text);
  assert.equal(p.jobId, 'job_ideas_1');
  assert.deepEqual(p.copy, { headline: IDEA.headline, subhead: IDEA.subhead, cta: IDEA.cta });
  // The idea's composition is preselected: its priority leads the compositions.
  assert.equal(initialPriority(p), 'headline');
  assert.equal(compositionVariants('service_card', 'service_trust', null, initialPriority(p))[0], 'headline_first');
  assert.equal(initialPriority(null), 'product');
  // A product idea names the product, not a claim.
  const prod = ideaPrefill({ ...IDEA, objective: 'arrival', target_kind: 'product', target_ref: 'p_print', layout: 'price_first' });
  assert.equal(prod.mode, 'product');
  assert.equal(prod.productId, 'p_print');
  assert.equal(prod.claimId, undefined);
  assert.equal(initialPriority(prod), 'price');
  assert.equal(familyForObjective('arrival', 'product'), 'new_arrival');
});

test('who wrote a new design: the idea’s job while its headline is the idea’s, Claude’s composition job, else the template', () => {
  const p = ideaPrefill(IDEA);
  assert.equal(ideaJobFor(p, IDEA.headline), 'job_ideas_1');
  assert.equal(ideaJobFor(p, `  ${IDEA.headline} `), 'job_ideas_1');
  assert.equal(ideaJobFor(p, 'عنوان كتبه المالك'), null, 'rewritten words are the owner’s');
  assert.equal(ideaJobFor(null, IDEA.headline), null);
  assert.deepEqual(createOrigin('job_ideas_1'), { origin: 'ai', job_id: 'job_ideas_1' });
  assert.deepEqual(createOrigin(null), { origin: 'template', job_id: null });
  // A job the server will not link falls back to the template; a version conflict or a schema refusal does not.
  assert.ok(isJobRefusal('JOB_ALREADY_APPLIED'));
  assert.ok(!isJobRefusal('CREATIVE_SCHEMA_MISSING'));
  assert.ok(!isJobRefusal('VERSION_CONFLICT'));
});

test('Home asks for ideas with NO priorities: the opportunity kinds are never sent as the owner’s', () => {
  assert.deepEqual(ideasRequest('key-0001'), { count: 5, priorities: [], idempotency_key: 'key-0001' });
  const home = read('src/components/creativeStudio/Home.tsx');
  assert.match(home, /ai\.ideas\(ideasRequest\(/);
  assert.doesNotMatch(home, /priorities\s*=\s*\[\.\.\.new Set/, 'no priorities built from what is on screen');
  assert.match(home, /startNew\(ideaPrefill\(idea\)\)/);
});

const STATUS: Pick<ProviderStatusDto, 'model' | 'priorities'> = { model: 'model-stored', priorities: ['الطابعات أولاً'] };
const FORM = {
  model: 'model-stored', effort: 'low' as const, vision: false, rates: null, priorities: 'الطابعات أولاً',
  budget: { daily_requests: 10, daily_tokens: 1000, daily_usd: null, monthly_usd: null, max_parallel: 1, auto_fix_rounds: 2 },
};

test('Settings sends the model only when it changed, and the priorities only when they changed', () => {
  const same = settingsPayload(STATUS, FORM);
  assert.ok(!('model' in same), 'an unchanged model is not sent (the live model list may be down)');
  assert.ok(!('priorities' in same), 'unchanged priorities are not sent');
  assert.equal(same.budget?.daily_requests, 10);
  assert.equal(same.effort, 'low');
  assert.equal(settingsPayload(STATUS, { ...FORM, model: 'model-other' }).model, 'model-other');
  assert.equal(settingsPayload(STATUS, { ...FORM, model: '' }).model, null, 'clearing the model is a change');
  assert.equal(settingsPayload({ model: null }, { ...FORM, model: '' }).model, undefined);
  assert.deepEqual(settingsPayload(STATUS, { ...FORM, priorities: 'الطابعات أولاً\n  الفلمنت   الجديد \nالطابعات أولاً' }).priorities, ['الطابعات أولاً', 'الفلمنت الجديد']);
  // A Worker that does not report priorities: an untouched empty field erases nothing.
  assert.ok(!('priorities' in settingsPayload({ model: null }, { ...FORM, model: '', priorities: '' })));
  assert.equal(parsePriorities(Array.from({ length: 20 }, (_, i) => `p${i}`).join('\n')).length, 12);
  const src = read('src/components/creativeStudio/SettingsTab.tsx');
  assert.match(src, /saveSettings\(settingsPayload\(/);
  assert.doesNotMatch(src, /auto_fix_rounds|setFixRounds/, 'no field for an automatic fix loop that does not exist');
  assert.ok(!('setFixRounds' in S));
});

test('a family badge is drawn only with evidence, and says which evidence is missing', () => {
  assert.deepEqual(familyBadge(null, NO_EVIDENCE), { kind: 'none' });
  assert.deepEqual(familyBadge('education', { arrival: true, back_in_stock: true, offer: true }), { kind: 'none' });
  const missing = familyBadge('new_arrival', NO_EVIDENCE);
  assert.equal(missing.kind, 'no_evidence');
  assert.equal(missing.kind === 'no_evidence' && missing.needs, 'arrival');
  assert.equal(familyBadge('new_arrival', { ...NO_EVIDENCE, arrival: true }).kind, 'drawn');
  assert.equal(familyBadge('back_in_stock', { ...NO_EVIDENCE, arrival: true }).kind, 'no_evidence');
  assert.equal(familyBadge('price_offer', { ...NO_EVIDENCE, offer: true }).kind, 'drawn');
  assert.deepEqual(familyChoice('price_offer'), { objective: 'sell', template: 'product_hero', priority: 'price' });
  assert.deepEqual(familyChoice('education'), { objective: 'education', template: 'education_slide', priority: 'feature' });
  const nd = read('src/components/creativeStudio/NewDesign.tsx');
  assert.doesNotMatch(nd, /family: null/, 'the family reaches the layout and Claude');
});

const step = (o: Partial<WatchSyncResponse>): WatchSyncResponse => ({ processed: 0, baseline: false, baseline_complete: true, pass_complete: false, arrivals: 0, back_in_stock: 0, ...o });

test('the catalogue update repeats POST /watch/sync to the end of the pass and reports a baseline honestly', async () => {
  const answers = [step({ processed: 50, baseline: true, baseline_complete: false }), step({ processed: 50, baseline: true, baseline_complete: false }), step({ processed: 7, baseline: true, pass_complete: true })];
  const seen: number[] = [];
  const t = await runCatalogSync(async () => answers.shift()!, (x) => seen.push(x.processed));
  assert.deepEqual(seen, [50, 100, 107]);
  assert.deepEqual(t, { steps: 3, processed: 107, arrivals: 0, back_in_stock: 0, baseline: true, complete: true });
  const next = await runCatalogSync(async () => step({ processed: 9, arrivals: 2, back_in_stock: 1, pass_complete: true }));
  assert.equal(next.baseline, false);
  assert.equal(next.arrivals, 2);
  // A runaway pass stops at the cap and says it is not complete.
  const capped = await runCatalogSync(async () => step({ processed: 1 }), undefined, undefined, 5);
  assert.deepEqual([capped.steps, capped.complete], [5, false]);
});

test('the archive’s «to» date includes its own day; upload texts follow the returned review', () => {
  assert.equal(archiveQuery({ to: '2026-10-27' }).to, '2026-10-27T23:59:59.999Z');
  assert.equal(archiveQuery({ to: '' }).to, '');
  assert.equal(archiveQuery({ from: '2026-10-27', to: '2026-10-28T10:00:00Z' }).to, '2026-10-28T10:00:00Z');
  assert.equal(uploadedText('approved'), S.assetsUploaded);
  assert.equal(uploadedText('needs_review'), S.assetsUploadedPending);
  assert.doesNotMatch(S.assetsUploaded.ar, /ينتظر/, 'an approved upload is not said to wait');
  assert.match(read('src/components/creativeStudio/AssetsTab.tsx'), /uploadedText\(created\.review\)/);
});

const claim = (o: Partial<ClaimDto>): ClaimDto => ({
  id: 'cclm_1', key: 'warranty', version: 1, status: 'approved', title: { ar: 'ضمان سنة', en: 'One-year warranty', ckb: 'گەرەنتیی ساڵێک' },
  summary: { ar: 'ضمان الوكيل', en: 'Dealer warranty', ckb: 'گەرەنتیی بریکار' }, conditions: { ar: '', en: '', ckb: '' }, details_path: '/policies/warranty',
  product_ids: [], valid_from: null, valid_until: null, last_verified_at: null, source_note: '', approved_at: null, ...o,
});

test('service claims: one card per claim, checked like the server, approvable only in three languages', () => {
  const groups = groupClaims([claim({}), claim({ version: 2, status: 'pending' }), claim({ id: 'cclm_2', key: 'delivery', status: 'pending' })]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].approved?.version, 1);
  assert.equal(groups[0].pending?.version, 2);
  assert.equal(groups[1].approved, null);
  const blank = claimForm();
  assert.deepEqual(claimFormProblems(blank, true).sort(), ['key', 'title']);
  const f = { ...claimForm(claim({ valid_from: '2026-11-01T00:00:00Z' })), valid_until: '2026-10-01' };
  assert.equal(f.valid_from, '2026-11-01');
  assert.deepEqual(claimFormProblems(f, false), ['dates']);
  assert.deepEqual(claimFormProblems({ ...f, valid_until: '', title: { ...f.title, ckb: f.title.ar } }, false), ['ckb_copy']);
  assert.deepEqual(claimFormProblems({ ...f, valid_until: '', details_path: 'https://evil.example' }, false), ['path']);
  const body = claimBody({ ...f, valid_until: '', details_path: '  ', product_ids: ['p1', 'p1'] });
  assert.equal(body.valid_until, null);
  assert.equal(body.details_path, null);
  assert.deepEqual(body.product_ids, ['p1']);
  assert.equal(claimApprovable(claim({})), true);
  assert.equal(claimApprovable(claim({ summary: { ar: 'x', en: 'x', ckb: '' } })), false);
  // New design's empty service state leads to the screen that creates claims.
  assert.match(read('src/components/creativeStudio/NewDesign.tsx'), /goTab\('claims'\)/);
  assert.match(read('src/components/creativeStudio/StudioShell.tsx'), /'claims'/);
});

test('a Home opportunity row opens New design: a product row on its product with its goal, a topic row with the goal set', async () => {
  const { opportunityPrefill, chatIdeaPrefill } = await import('../src/components/creativeStudio/screensModel');
  assert.deepEqual(opportunityPrefill({ kind: 'offer', ref: 'p_1' }), { mode: 'product', productId: 'p_1', objective: 'sell' });
  assert.deepEqual(opportunityPrefill({ kind: 'arrival', ref: 'p_2' }), { mode: 'product', productId: 'p_2', objective: 'arrival' });
  assert.deepEqual(opportunityPrefill({ kind: 'back_in_stock', ref: 'p_3' }), { mode: 'product', productId: 'p_3', objective: 'back_in_stock' });
  assert.deepEqual(opportunityPrefill({ kind: 'service_claim', ref: 'clm_1' }), { mode: 'service', claimId: 'clm_1', objective: 'service_trust' });
  assert.deepEqual(opportunityPrefill({ kind: 'education_topic', ref: '' }), { mode: 'product', objective: 'education' });
  assert.deepEqual(opportunityPrefill({ kind: 'coverage_gap', ref: 'cat_1' }), { mode: 'product', objective: 'sell' });
  const p = chatIdeaPrefill({ objective: 'sell', product_ref: 'p_1', headline: 'دقة', subhead: '', note: '' }, 'cjob_1');
  assert.deepEqual(p, { mode: 'product', productId: 'p_1', objective: 'sell', copy: { headline: 'دقة', subhead: undefined }, jobId: 'cjob_1' });
});
