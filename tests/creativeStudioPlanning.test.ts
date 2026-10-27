/**
 * PHASE 4 — CAMPAIGNS, THE INTERNAL CALENDAR AND THE PLANNING MODEL
 * (spec §20, §21, §25; migration 0216; worker/lib/creative/planning.ts,
 * src/components/creativeStudio/planningModel.ts).
 *
 *   - a campaign is created, a design joins it with no new version, and the
 *     campaign lists it; an assistant admin is still refused;
 *   - a planned day is set and removed without touching status or version,
 *     and an impossible day is refused;
 *   - on a database without 0216 the reads answer empty and a write is 503;
 *   - a carousel plan's job is cited by every slide made from it;
 *   - the month grid starts on Saturday, slides group by their first slide.
 *
 * Run: node --import tsx --test tests/creativeStudioPlanning.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, dbThrough, get, json as body, post, put } from './fixtures/app';
import { ASSISTANT, BASE, design, seedStudioUsers, studioApp, studioDb } from './fixtures/creativeStudio';
import { create, seedJob } from './fixtures/creativeStudioDesigns';
import { baghdadToday, carouselGroups, gridOrder, monthWeeks } from '../src/components/creativeStudio/planningModel';
import type { DocumentSummaryDto } from '../packages/creativeDoc/src/api';

test('campaigns: create, attach a design (no new version), list; the plan sets and clears a day', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  const made = await post(app, `${BASE}/campaigns`, { name: 'Ramadan', starts_on: '2026-02-18', ends_on: '2026-03-19' });
  assert.equal(made.status, 201);
  const campaign = (await body(made)).campaign;
  assert.equal((await post(app, `${BASE}/campaigns`, { name: 'x', starts_on: '2026-03-02', ends_on: '2026-03-01' })).status, 400);

  const d = await create(app, design());
  const attached = await put(app, `${BASE}/documents/${d.id}/campaign`, { campaign_id: campaign.id });
  assert.equal(attached.status, 200);
  assert.equal((await body(attached)).document.version, d.version, 'joining a campaign makes no new version');
  const listed = await body(await get(app, `${BASE}/documents?campaign_id=${campaign.id}`));
  assert.deepEqual(listed.documents.map((x: { id: string }) => x.id), [d.id]);
  assert.equal((await body(await get(app, `${BASE}/campaigns`))).campaigns[0].document_count, 1);
  assert.equal((await put(app, `${BASE}/documents/${d.id}/campaign`, { campaign_id: 'ccmp_missing' })).status, 404);

  assert.equal((await put(app, `${BASE}/documents/${d.id}/plan`, { planned_for: '2026-02-30' })).status, 400);
  assert.equal((await put(app, `${BASE}/documents/${d.id}/plan`, { planned_for: '2026-03-05' })).status, 200);
  const plan = await body(await get(app, `${BASE}/plan?from=2026-03-01&to=2026-03-31`));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].planned_for, '2026-03-05');
  assert.equal(plan.items[0].document.status, 'draft', 'planning changes no status');
  assert.equal(plan.items[0].document.version, d.version);
  await put(app, `${BASE}/documents/${d.id}/plan`, { planned_for: null });
  assert.equal((await body(await get(app, `${BASE}/plan?from=2026-03-01&to=2026-03-31`))).items.length, 0);

  const asst = studioApp(raw, ASSISTANT);
  assert.equal((await get(asst, `${BASE}/campaigns`)).status, 403);
});

test('deploy-ahead: without migration 0216 the reads are empty and a write is 503', async () => {
  const app = studioApp(seedStudioUsers(dbThrough('0215')), OWNER);
  const list = await get(app, `${BASE}/campaigns`);
  assert.equal(list.status, 200);
  assert.equal((await body(list)).migrated, false);
  assert.equal((await body(await get(app, `${BASE}/plan`))).migrated, false);
  assert.equal((await post(app, `${BASE}/campaigns`, { name: 'x' })).status, 503);
});

test('a carousel plan is the actor’s own and every slide made from it cites it', async () => {
  const raw = await studioDb();
  const app = studioApp(raw, OWNER);
  seedJob(raw, 'cjob_car', { task: 'carousel' });
  const first = await create(app, design(), { kind: 'slide', origin: 'ai', job_id: 'cjob_car' });
  const second = await create(app, design(), { kind: 'slide', parent_id: first.id, origin: 'ai', job_id: 'cjob_car' });
  assert.equal((await body(await get(app, `${BASE}/documents/${second.id}/versions/1`))).version.job_id, 'cjob_car');
  seedJob(raw, 'cjob_car_theirs', { task: 'carousel', actor: 'usr_full' });
  assert.equal((await post(app, `${BASE}/documents`, { title: 'x', content: design(), origin: 'ai', job_id: 'cjob_car_theirs' })).status, 400);
  const slides = (await body(await get(app, `${BASE}/documents?kind=slide`))).documents as DocumentSummaryDto[];
  assert.deepEqual(carouselGroups(slides).map((g) => g.map((s) => s.id)), [[first.id, second.id]]);
});

test('planning model: Saturday-first weeks, the Baghdad day, the grid order', () => {
  const weeks = monthWeeks('2026-11');
  assert.equal(weeks[0]!.indexOf('2026-11-01'), 1, '1 Nov 2026 is a Sunday: the second cell of a Saturday-first week');
  assert.equal(weeks.flat().filter(Boolean).length, 30);
  assert.equal(baghdadToday(Date.parse('2026-10-27T22:30:00Z')), '2026-10-28');
  assert.deepEqual(gridOrder([{ planned_for: '2026-11-03' }, { planned_for: '2026-11-01' }, { planned_for: '2026-11-02' }]).map((x) => x.planned_for), ['2026-11-03', '2026-11-02', '2026-11-01']);
});
