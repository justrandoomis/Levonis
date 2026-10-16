/**
 * «استيراد Bambu Lab» — THE OWNER'S IMPORT DASHBOARD (the Bambu import spec
 * §H.1, §H.2; src/components/adminImport/CatalogImportDashboard.tsx).
 *
 *   1. the state labels and the blocked item's resume instruction, word for
 *      word, in three languages; every Sorani its own;
 *   2. NO SKIP AND NO «ADVANCE THE CURSOR»: the screen only reads (no write
 *      verb to the API at all) and names no such control in any language;
 *   3. the answers of §H.1 are read defensively — a run, its progress counts,
 *      the current item, the rate, the ETA; items paged by cursor — and a
 *      link is drawn only to our own pages and to GitHub;
 *   4. a blocked item renders its blocker and the resume instruction;
 *   5. a lazy admin chunk, a tab of the catalogue section for the owner only.
 *
 * Run: node --import tsx --test tests/catalogImportDashboard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { LanguageProvider } from '../src/LanguageContext';
import { Blocked, StateChip, readItems, readRun } from '../src/components/adminImport/CatalogImportDashboard';
import { ITEM_STATES, ITEM_STATE_LABELS, PROGRESS_LABELS, RESUME_INSTRUCTION, RUN_STATE_LABELS, S } from '../src/components/adminImport/catalogImportStrings';

const SRC = readFileSync(join(ROOT, 'src/components/adminImport/CatalogImportDashboard.tsx'), 'utf8');
const STRINGS = readFileSync(join(ROOT, 'src/components/adminImport/catalogImportStrings.ts'), 'utf8');

// ------------------------------------------------------------------ 1. the words

test('the state labels and the resume instruction are the spec’s tables, word for word', () => {
  const spec: Record<string, [string, string, string]> = {
    DISCOVERED: ['مكتشَف', 'Discovered', 'دۆزراوە'],
    EXTRACTING: ['استخراج', 'Extracting', 'دەرهێنان'],
    ENRICHING: ['إثراء', 'Enriching', 'دەوڵەمەندکردن'],
    VALIDATING: ['تدقيق', 'Validating', 'پشکنین'],
    INGESTING_MEDIA: ['حفظ الصور', 'Saving images', 'پاشەکەوتکردنی وێنەکان'],
    WRITING: ['حفظ', 'Writing', 'پاشەکەوتکردن'],
    PUBLISHING: ['نشر', 'Publishing', 'بڵاوکردنەوە'],
    VERIFYING_LIVE: ['تحقق حي', 'Verifying live', 'پشتڕاستکردنەوەی ڕاستەوخۆ'],
    COMPLETE: ['مكتمل', 'Complete', 'تەواو'],
    RETRYING: ['إعادة المحاولة', 'Retrying', 'هەوڵدانەوە'],
    BLOCKED: ['متوقف لعائق', 'Blocked', 'ڕاگیراوە بەهۆی ڕێگرێک'],
    WITHDRAWN_AT_SOURCE: ['سُحب من المصدر (غير مكتمل)', 'Withdrawn at the source (not complete)', 'لە سەرچاوەوە کشێنرایەوە (تەواو نییە)'],
  };
  assert.deepEqual(ITEM_STATES, Object.keys(spec), 'the 0195 states, in order, and no SKIPPED state');
  for (const [k, [ar, en, ckb]] of Object.entries(spec)) assert.deepEqual(ITEM_STATE_LABELS[k as keyof typeof ITEM_STATE_LABELS], { ar, en, ckb }, k);
  assert.deepEqual(RESUME_INSTRUCTION, {
    ar: 'لاستئناف هذا المنتج: عالج السبب أعلاه ثم شغّل سير العمل 60 بوضع run مع resume.',
    en: 'To resume this product: fix the cause above, then run workflow 60 in run mode with resume.',
    ckb: 'بۆ دەستپێکردنەوەی ئەم بەرهەمە: هۆکارەکەی سەرەوە چارەسەر بکە، پاشان ڕێڕەوی کاری 60 بە دۆخی run لەگەڵ resume کار پێبکە.',
  });
  assert.deepEqual(S.title, { ar: 'استيراد Bambu Lab', en: 'Bambu Lab import', ckb: 'هاوردەکردنی Bambu Lab' });
  const all = [...Object.values(ITEM_STATE_LABELS), RESUME_INSTRUCTION, ...Object.values(RUN_STATE_LABELS), ...PROGRESS_LABELS.map(([, w]) => w), ...Object.values(S)];
  for (const w of all) {
    assert.ok(w.ar && w.en && w.ckb, JSON.stringify(w));
    assert.notEqual(w.ckb, w.ar, `«${w.en}»: the Sorani copies the Arabic`);
  }
});

// ------------------------------------------------------------------ 2. no skip, no cursor

test('no SKIP and no «advance the cursor»: the screen never writes, and names no such control', () => {
  assert.doesNotMatch(SRC, /api\.(post|put|patch|delete)\b/, 'the dashboard only reads');
  assert.doesNotMatch(SRC, /method:\s*['"](POST|PUT|PATCH|DELETE)/i);
  // The code and the words (comments aside: they say there is no such control).
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const text of [code(SRC), code(STRINGS)]) {
    assert.doesNotMatch(text, /\bskip\b|تخطّ|تخط[يى]|بازدان|advance[_ -]?cursor|تقديم المؤشر/i, 'no skip / advance-cursor wording or control');
  }
  // The only cursor is the item list's own paging parameter.
  assert.deepEqual([...SRC.matchAll(/cursor/g)].length > 0, true);
  assert.doesNotMatch(SRC, /\/(skip|advance|cursor)\b['"`]/, 'no such endpoint is ever called');
});

// ------------------------------------------------------------------ 3. reading the answers

test('a run is read defensively: progress counts only, the current item, the rate, the ETA, safe links only', () => {
  const run = readRun({
    run: {
      id: 'cir_0123456789abcdef01234567',
      state: 'running',
      started_at: '2026-10-16T08:00:00Z',
      closed_at: '',
      github_run_url: 'https://github.com/justrandoomis/Levonis/actions/runs/1',
      progress: { discovered_total: 1115, complete_count: 12, blocked_count: 1, secret_cost: 999, remaining_count: 'x' },
      current_item: { id: 'cii_1', handle: 'filament-buffer', processing_state: 'INGESTING_MEDIA', last_checkpoint_at: '2026-10-16T08:10:00Z', media_count: 7, option_count: 2 },
      last_verified_url: 'https://levonis-iq.com/product/filament-buffer',
      rate: { items_per_hour: 3.5, stages: { WRITING: { median_s: 12, p90_s: 30 } } },
      eta: { at: '2026-10-20T00:00:00Z', estimate: true },
    },
  })!;
  assert.equal(run.id, 'cir_0123456789abcdef01234567');
  assert.deepEqual(run.progress, { discovered_total: 1115, complete_count: 12, blocked_count: 1 }, 'only the §H.3 counts, only numbers');
  assert.equal(run.current?.state, 'INGESTING_MEDIA');
  assert.equal(run.current?.media, 7);
  assert.equal(run.rate.per_hour, 3.5);
  assert.deepEqual(run.rate.stages, [{ stage: 'WRITING', median_s: 12, p90_s: 30 }]);
  assert.equal(run.eta, '2026-10-20T00:00:00Z');
  assert.equal(run.github_run_url, 'https://github.com/justrandoomis/Levonis/actions/runs/1');
  assert.equal(run.last_verified_url, 'https://levonis-iq.com/product/filament-buffer');
  // A link anywhere else is not drawn (the store's own pages are owner provenance, never a link here).
  const odd = readRun({ id: 'cir_x', github_run_url: 'https://evil.example/run', last_verified_url: 'https://us.store.bambulab.com/products/h2d' })!;
  assert.equal(odd.github_run_url, '');
  assert.equal(odd.last_verified_url, '');
  assert.equal(readRun({}), null);
});

test('items: paged by the server’s cursor; a blocked item carries its blocker', () => {
  const page = readItems({
    items: [
      { id: 'cii_1', handle: 'h2d', processing_state: 'COMPLETE', queue_position: 1, attempts: 1, live_url: '/product/bambu-lab-h2d' },
      { id: 'cii_2', handle: 'a1', processing_state: 'BLOCKED', queue_position: 2, attempts: 3, blocker_code: 'VERIFY_FAILED_PERSISTENT', last_error: 'the hero image differs' },
      { handle: 'no-id' },
    ],
    next_cursor: 'c2',
  });
  assert.equal(page.items.length, 2);
  assert.equal(page.next, 'c2');
  assert.equal(page.items[0].live_url, '/product/bambu-lab-h2d');
  assert.equal(page.items[1].blocker_code, 'VERIFY_FAILED_PERSISTENT');
  assert.equal(page.items[1].blocker, 'the hero image differs');
});

// ------------------------------------------------------------------ 4. rendering

const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LanguageProvider, null, el));

test('a blocked item shows its blocker, then the resume instruction; every state chip carries its words', () => {
  const html = render(createElement(Blocked, { code: 'MEDIA_HOST_NOT_ALLOWED', text: 'store-test.bblcdn.com', lang: 'ckb' }));
  assert.match(html, /MEDIA_HOST_NOT_ALLOWED/);
  assert.ok(html.includes(RESUME_INSTRUCTION.ckb), html);
  assert.doesNotMatch(html, /<button/, 'no control on a blocked item');
  for (const state of ITEM_STATES) {
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const chip = render(createElement(StateChip, { state, lang }));
      assert.ok(chip.includes(ITEM_STATE_LABELS[state][lang]), `${state} ${lang}`);
    }
  }
});

// ------------------------------------------------------------------ 5. where it lives

test('a lazy admin chunk: the catalogue section’s tab for the verified owner, beside the products', () => {
  const admin = readFileSync(join(ROOT, 'src/pages/Admin.tsx'), 'utf8');
  assert.match(admin, /React\.lazy\(\(\) => import\('\.\.\/components\/adminImport\/CatalogImportTab'\)\)/);
  assert.match(admin, /id: 'catalog_import'/);
  assert.match(admin, /canSeeCatalogImport/);
  assert.match(admin, /'استيراد Bambu Lab', 'Bambu Lab import', 'هاوردەکردنی Bambu Lab'/);
});
