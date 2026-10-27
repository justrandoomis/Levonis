/**
 * LEVONIS PRINT CLOUD — THE CUSTOMER APP'S FOUNDATION (cloud.<root>, src/cloud).
 *
 * Fast and build-free: the pure helpers every Print Cloud screen writes its
 * figures and refusals with, the way back from the apex's sign-in page (an
 * allowlist — never an open redirect), the server's `system` label the app
 * is chosen by, the client's coverage of the customer API, the three
 * languages of every word, and the honesty rules a screen could break by
 * typing a figure into JSX.
 *
 * Run: node --import tsx --test tests/printCloudUiShell.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { storefrontRoutes } from '../worker/routes/storefront';
import { isSystemSlug } from '../worker/lib/hosts';
import { validIdempotencyKey } from '../worker/lib/printCloud/db';
import { OPERATIONS } from '../worker/lib/printCloud/openapi';
import { ApiError } from '../src/lib/api';
import { formatMoney } from '../src/lib/money';
import { formatFigure } from '../src/lib/localeNumber';
import { formatDate as orderDate } from '../src/components/orders/format';
import { appReturnUrl, isReturnApp, RETURN_APPS, storeReturnUrl } from '../src/components/auth/storeReturn';
import { externalAuthUrl } from '../src/lib/inAppBrowser';
import { CLOUD_APP_LABEL, cloudHandoffUrl } from '../src/cloud/signInUrl';
import { cloudErrorCode, cloudErrorText, IDEMPOTENCY_KEY_RE, newIdempotencyKey, qs } from '../src/cloud/api';
import { accessOf } from '../src/cloud/CloudContext';
import { activeTab, cloudSection, SECTION_PREFIXES, TABS } from '../src/cloud/routes';
import { CLOUD_TITLE } from '../src/cloud/brand';
import { fill, nameOf, tx } from '../src/cloud/text';
import { common } from '../src/cloud/strings/common';
import * as F from '../src/cloud/format';
import type { CloudStatus } from '../src/cloud/types';

const LANGS = ['ar', 'en', 'ckb'] as const;
const APEX = 'https://levonis-iq.com';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const lineOf = (source: ts.SourceFile, n: ts.Node) => `${source.fileName}:${source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1}`;

/** The source without its comments (tests/storefrontIsolation.test.ts's stripper: strings pass whole). */
const STRING_OR_COMMENT = /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`)|(\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$)|\/\/.*$/gm;
const code = (source: string) => source.replace(STRING_OR_COMMENT, (m: string, _s?: string, comment?: string) => (comment === undefined ? m : ''));

function walk(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, re, out);
    else if (re.test(name)) out.push(rel);
  }
  return out.sort();
}
const CLOUD_FILES = walk('src/cloud', /\.tsx?$/);

// ============================================================ figures

test('durations: minutes floored, «under a minute», hours alone, «—» for no figure — in three languages', () => {
  assert.equal(F.formatDuration(8280, 'en'), '2h 18m');
  assert.equal(F.formatDuration(8330, 'en'), '2h 18m', '2 h 18 m 50 s is never «2h 19m»');
  assert.equal(F.formatDuration(3600, 'en'), '1h');
  assert.equal(F.formatDuration(2700, 'en'), '45m');
  assert.equal(F.formatDuration(0, 'en'), '0m');
  assert.equal(F.formatDuration(30, 'en'), 'under 1m');
  assert.equal(F.formatDuration(null, 'en'), '—');
  assert.equal(F.formatDuration(undefined, 'ckb'), '—');
  assert.equal(F.formatDuration(Number.NaN, 'ar'), '—');
  assert.equal(F.formatDuration(8280, 'ar'), `${formatFigure(2, 'ar')} س ${formatFigure(18, 'ar')} د`);
  assert.equal(F.formatDuration(8280, 'ckb'), `${formatFigure(2, 'ckb')} کاتژمێر ${formatFigure(18, 'ckb')} خولەک`);
  assert.equal(F.formatDuration(30, 'ar'), 'أقل من دقيقة');
  assert.equal(F.formatDuration(30, 'ckb'), 'کەمتر لە خولەکێک');
});

test('hours: floored to a tenth, so a balance never shows an hour the customer does not have', () => {
  assert.equal(F.hoursFigure(66240), 18.4);
  assert.equal(F.hoursFigure(66239), 18.3);
  for (let tenths = 0; tenths <= 3000; tenths++) assert.equal(F.hoursFigure(tenths * 360), tenths / 10, `${tenths * 360} s`);
  assert.deepEqual(F.hoursParts(66240, 'en'), { value: '18.4', unit: 'h' });
  assert.equal(F.formatHours(66240, 'en'), '18.4 h');
  assert.equal(F.formatHours(86400, 'en'), '24 h');
  assert.equal(F.formatHours(66240, 'ar'), `${formatFigure(18.4, 'ar', 1)} ساعة`);
  assert.equal(F.formatHours(66240, 'ckb'), `${formatFigure(18.4, 'ckb', 1)} کاتژمێر`);
  assert.equal(F.formatHours(null, 'en'), '—');
});

test('grams and kilograms, counted units and lengths, in three languages', () => {
  assert.deepEqual(F.massParts(650, 'en'), { value: '650', unit: 'g' });
  assert.deepEqual(F.massParts(1250, 'en'), { value: '1.25', unit: 'kg' });
  assert.deepEqual(F.massParts(1259, 'en'), { value: '1.25', unit: 'kg' }, 'floored, never rounded up');
  assert.equal(F.formatMass(650, 'ar'), `${formatFigure(650, 'ar')} غرام`);
  assert.equal(F.formatMass(1250, 'ar'), `${formatFigure(1.25, 'ar', 2)} كيلوغرام`);
  assert.equal(F.formatMass(650, 'ckb'), `${formatFigure(650, 'ckb')} گرام`);
  assert.equal(F.formatMass(1250, 'ckb'), `${formatFigure(1.25, 'ckb', 2)} کیلۆگرام`);
  assert.equal(F.formatMass(null, 'en'), '—');
  assert.equal(F.formatQuantity(20, 'pc', 'en'), '20 pcs');
  assert.equal(F.formatQuantity(20, 'pc', 'ar'), `${formatFigure(20, 'ar')} قطعة`);
  assert.equal(F.formatQuantity(20, 'pc', 'ckb'), `${formatFigure(20, 'ckb')} دانە`);
  assert.equal(F.formatQuantity(1250, 'g', 'en'), '1.25 kg');
  assert.equal(F.formatQuantity(2500, 'mm', 'en'), '2.5 m');
  assert.equal(F.formatQuantity(3, 'box', 'en'), '3 box', 'an unknown unit is written as its code');
  assert.equal(F.formatQuantity(null, 'g', 'en'), '—');
  assert.equal(F.formatNozzle(400, 'en'), '0.4 mm');
  assert.equal(F.formatNozzle(400, 'ckb'), `${formatFigure(0.4, 'ckb', 2)} ملم`);
  assert.deepEqual(F.buildVolumeParts({ x: 256, y: 256, z: 256 }, 'ar'), { figure: '256 × 256 × 256', unit: 'مم' });
});

test('a count of days agrees with its number in Arabic; Sorani keeps the noun singular', () => {
  assert.equal(F.formatDays(1, 'en'), '1 day');
  assert.equal(F.formatDays(30, 'en'), '30 days');
  assert.equal(F.formatDays(1, 'ar'), 'يوم واحد');
  assert.equal(F.formatDays(2, 'ar'), 'يومان');
  assert.equal(F.formatDays(7, 'ar'), `${formatFigure(7, 'ar')} أيام`);
  assert.equal(F.formatDays(10, 'ar'), `${formatFigure(10, 'ar')} أيام`);
  assert.equal(F.formatDays(30, 'ar'), `${formatFigure(30, 'ar')} يومًا`);
  assert.equal(F.formatDays(100, 'ar'), `${formatFigure(100, 'ar')} يوم`);
  assert.equal(F.formatDays(103, 'ar'), `${formatFigure(103, 'ar')} أيام`);
  assert.equal(F.formatDays(365, 'ar'), `${formatFigure(365, 'ar')} يومًا`);
  assert.equal(F.formatDays(30, 'ckb'), `${formatFigure(30, 'ckb')} ڕۆژ`);
  assert.equal(F.formatDays(1, 'ckb'), `${formatFigure(1, 'ckb')} ڕۆژ`);
});

test('dinars are written by the house money rule, never converted', () => {
  for (const lang of LANGS) {
    assert.equal(F.formatIqd(24250, lang), formatMoney(24250, lang), lang);
    assert.equal(F.formatIqd(null, lang), '—', lang);
  }
  assert.match(F.formatIqd(24250, 'en'), /^24,250 IQD$/);
});

test('relative times: now, minutes, hours, days, then the date; Sorani written by hand', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  assert.equal(F.formatRelative(ago(20), 'en', now), 'just now');
  assert.equal(F.formatRelative(ago(20), 'ar', now), 'الآن');
  assert.equal(F.formatRelative(ago(20), 'ckb', now), 'ئێستا');
  assert.equal(F.formatRelative(ago(300), 'en', now), '5 minutes ago');
  assert.equal(F.formatRelative(ago(300), 'ckb', now), '5 خولەک لەمەوبەر');
  assert.equal(F.formatRelative(ago(-3 * 3600), 'en', now), 'in 3 hours');
  assert.equal(F.formatRelative(ago(-3 * 3600), 'ckb', now), 'دوای 3 کاتژمێر');
  assert.equal(F.formatRelative(ago(3590), 'en', now), '1 hour ago', 'never «60 minutes ago»');
  assert.equal(F.formatRelative(ago(2 * 86400), 'ckb', now), '2 ڕۆژ لەمەوبەر');
  const ar = F.formatRelative(ago(300), 'ar', now);
  assert.match(ar, /5/, 'Arabic keeps Latin digits, as the dates do');
  assert.notEqual(ar, F.formatRelative(ago(300), 'en', now));
  const old = ago(10 * 86400);
  for (const lang of LANGS) assert.equal(F.formatRelative(old, lang, now), orderDate(old, lang), `${lang}: past a week, the date itself`);
  assert.equal(F.formatRelative(null, 'en', now), '');
  assert.equal(F.formatRelative('not a date', 'en', now), '');
});

test('progress comes only from two real numbers, floored, never above 100', () => {
  assert.equal(F.progressPercent(142, 230), 61);
  assert.equal(F.progressPercent(29, 50), 58, 'integer-exact: not the 57 of (29 / 50) * 100');
  for (let total = 1; total <= 400; total++) {
    for (let done = 0; done <= total; done++) assert.equal(F.progressPercent(done, total), Math.floor((done * 100) / total));
  }
  assert.equal(F.progressPercent(300, 200), 100);
  assert.equal(F.progressPercent(0, 200), 0);
  for (const [done, total] of [[null, 10], [5, null], [5, 0], [5, -1], [-1, 5], [Number.NaN, 5], [5, Number.POSITIVE_INFINITY], [undefined, undefined]] as const) {
    assert.equal(F.progressPercent(done, total), null, `${done} of ${total}`);
  }
  assert.equal(F.permillePercent(625), 62);
  assert.equal(F.permillePercent(1000), 100);
  assert.equal(F.permillePercent(null), null);
  assert.equal(F.formatPercent(62, 'en'), '62%');
});

// ============================================================ words

test('a refusal is shown in the server’s own words, in the reader’s language', () => {
  const messages = { ar: 'لا يوجد رصيد كافٍ', en: 'Not enough balance', ckb: 'باڵانسی پێویست نییە' };
  const refusal = new ApiError(402, 'Not enough balance', 'INSUFFICIENT_BALANCE', { messages, available_iqd: 1000, required_iqd: 5000 });
  for (const lang of LANGS) assert.equal(cloudErrorText(refusal, lang), messages[lang], lang);
  assert.equal(cloudErrorCode(refusal), 'INSUFFICIENT_BALANCE');

  // A refusal without the reader's slot reads the error's own message — never another language's slot.
  const partial = new ApiError(409, 'Order is not payable', 'ORDER_NOT_PAYABLE', { messages: { ar: 'غير قابل للدفع', en: 'Not payable', ckb: '  ' } });
  assert.equal(cloudErrorText(partial, 'ckb'), 'Order is not payable');
  assert.equal(cloudErrorText(new ApiError(500, 'Server error'), 'en'), 'Server error');
  assert.equal(cloudErrorText(new Error('Network down'), 'ar'), 'Network down');
  for (const lang of LANGS) {
    assert.equal(cloudErrorText(undefined, lang), tx(common.unknownError, lang));
    assert.equal(cloudErrorText('boom', lang), tx(common.unknownError, lang));
    assert.equal(cloudErrorText(new Error('  '), lang), tx(common.unknownError, lang));
  }
  assert.equal(cloudErrorCode(new Error('x')), null);
  assert.equal(cloudErrorCode(new ApiError(500, 'x', '')), null);
});

test('the text accessor fills {names}, keeps unknown ones visible, and reads catalogue names', () => {
  assert.equal(fill('{a} of {b}', { a: 3, b: 'x' }), '3 of x');
  assert.equal(fill('{missing}', { a: 1 }), '{missing}');
  assert.equal(tx({ ar: 'أ {n}', en: 'E {n}', ckb: 'ک {n}' }, 'ckb', { n: 2 }), 'ک 2');
  assert.equal(nameOf({ name_ar: 'أ', name_en: 'E', name_ckb: '' }, 'ckb'), 'E', 'a missing Sorani name reads the English');
  assert.equal(nameOf({ name_ar: 'أ', name_en: 'E', name_ckb: 'ک' }, 'ar'), 'أ');
});

/** Every `{ ar, en, ckb }` object reachable from a module's exports. */
function trisOf(value: unknown, path: string, out: Array<{ path: string; tri: Record<string, unknown> }>, seen = new Set<unknown>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  const o = value as Record<string, unknown>;
  if ('ar' in o && 'en' in o && 'ckb' in o) out.push({ path, tri: o });
  else for (const [k, v] of Object.entries(o)) trisOf(v, `${path}.${k}`, out, seen);
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every word under src/cloud/strings exists in three languages, Sorani never a copy of the Arabic', async () => {
  const modules = walk('src/cloud/strings', /\.ts$/);
  assert.ok(modules.length >= 4, modules.join(', '));
  let count = 0;
  for (const rel of modules) {
    const mod = (await import(pathToFileURL(join(ROOT, rel)).href)) as Record<string, unknown>;
    const tris = trisOf(mod, rel, []);
    assert.ok(tris.length > 0, `${rel}: no { ar, en, ckb } strings found`);
    for (const { path, tri } of tris) {
      for (const lang of LANGS) assert.ok(typeof tri[lang] === 'string' && (tri[lang] as string).trim(), `${path}: empty ${lang}`);
      assert.notEqual(tri.ckb, tri.ar, `${path}: the Sorani is a copy of the Arabic (DECISIONS row 183)`);
      assert.notEqual(tri.en, tri.ar, `${path}: the English is a copy of the Arabic`);
      const vars = placeholders(tri.en as string);
      assert.equal(placeholders(tri.ar as string), vars, `${path}: the Arabic fills other {names} than the English`);
      assert.equal(placeholders(tri.ckb as string), vars, `${path}: the Sorani fills other {names} than the English`);
    }
    count += tris.length;
  }
  assert.ok(count > 100, `only ${count} strings`);
});

test('a { ar, en, ckb } written anywhere in src/cloud — a page’s own words, a unit — follows the same rules', () => {
  let count = 0;
  for (const rel of CLOUD_FILES) {
    const source = parse(rel);
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const slots = new Map<string, string | null>();
        for (const p of n.properties) {
          if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && (LANGS as readonly string[]).includes(p.name.text)) {
            slots.set(p.name.text, ts.isStringLiteralLike(p.initializer) ? p.initializer.text : null);
          }
        }
        // A WRITTEN Sorani slot (a literal, not a catalogue row's `name_ckb`) makes this a string of the interface.
        if (typeof slots.get('ckb') === 'string') {
          const where = lineOf(source, n);
          for (const lang of LANGS) assert.ok(typeof slots.get(lang) === 'string' && slots.get(lang)!.trim(), `${where}: no written ${lang}`);
          assert.notEqual(slots.get('ckb'), slots.get('ar'), `${where}: the Sorani is a copy of the Arabic`);
          count++;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  assert.ok(count > 100, `only ${count} strings`);
});

test('the product is «Levonis Print Cloud» in Latin letters, the document title on cloud.<root>', () => {
  assert.equal(CLOUD_TITLE, 'Levonis Print Cloud');
  const shell = read('src/cloud/PrintCloudApp.tsx');
  assert.match(shell, /useDocumentTitle\(CLOUD_TITLE\)/);
  assert.match(shell, /document\.title = title/);
});

// ============================================================ honesty in the markup

test('no Print Cloud file draws a placeholder image or a demo photo', () => {
  for (const rel of CLOUD_FILES) {
    const src = read(rel);
    assert.doesNotMatch(src, /placehold\.co|placeholder\.com|picsum\.photos|unsplash\.com|via\.placeholder/i, rel);
  }
});

/** A figure with a money unit: «24,250 IQD», «24250 د.ع», «IQD 5000», «$12». */
const MONEY = /\d[\d,.\u066B\u066C]*\s*(?:IQD|د\.ع|دينار|دینار|USD|\$)|(?:IQD|د\.ع|\$)\s*\d/u;
/** A figure with a duration unit: «2h 18m», «45 min», «3 ساعات», «2 کاتژمێر». */
const DURATION = /\d+(?:[.,]\d+)?\s*(?:h|hr|hrs|hours?|m|mins?|minutes?|s|secs?|seconds?|ساعة|ساعات|دقيقة|دقائق|س|د|کاتژمێر|خولەک|چرکە)(?![\p{L}\p{N}])/u;
/** Attributes that carry classes, addresses or ids rather than words. */
const NOT_WORDS = new Set(['className', 'to', 'href', 'id', 'key', 'group', 'role', 'type', 'dir', 'style', 'd', 'viewBox', 'src', 'aria-labelledby', 'aria-describedby', 'aria-controls']);

test('no figure is typed into the JSX: a price or a duration comes from the server, through format.ts', () => {
  for (const rel of CLOUD_FILES.filter((f) => f.endsWith('.tsx'))) {
    const source = parse(rel);
    const inJsx = (n: ts.Node): boolean => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isJsxAttribute(p)) return !NOT_WORDS.has(p.name.getText(source));
        if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return true;
      }
      return false;
    };
    const visit = (n: ts.Node) => {
      const text = ts.isJsxText(n)
        ? n.text
        : ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)
          ? n.text
          : null;
      if (text !== null && inJsx(n)) {
        const where = lineOf(source, n);
        assert.doesNotMatch(text, MONEY, `${where}: a price typed into the JSX («${text.trim()}»)`);
        assert.doesNotMatch(text, DURATION, `${where}: a duration typed into the JSX («${text.trim()}»)`);
      }
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
  // …and no word anywhere in src/cloud carries a price of its own.
  for (const rel of CLOUD_FILES) {
    const source = parse(rel);
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteralLike(n)) assert.doesNotMatch(n.text, MONEY, `${lineOf(source, n)}: «${n.text}»`);
      ts.forEachChild(n, visit);
    };
    visit(source);
  }
});

test('the patterns above do catch what they are for', () => {
  for (const s of ['24,250 IQD', '24250 د.ع', 'IQD 5000', '$12', '12,000 دينار']) assert.match(s, MONEY, s);
  for (const s of ['2h 18m', '45 min', '3 ساعات', '2 کاتژمێر', '18.4 h']) assert.match(s, DURATION, s);
  for (const s of ['h-4 w-4', 'Print Cloud', 'STL / 3MF / OBJ', 'Bambu Lab X1C', '256 × 256']) {
    assert.doesNotMatch(s, MONEY, s);
    assert.doesNotMatch(s, DURATION, s);
  }
});

test('every lucide icon of Print Cloud is imported once, in src/cloud/ui/icons.ts', () => {
  // vite.config.ts puts an icon two lazy modules import into vendor-icons, a capped chunk.
  for (const rel of CLOUD_FILES.filter((f) => f !== 'src/cloud/ui/icons.ts')) {
    assert.doesNotMatch(read(rel), /from 'lucide-react'/, `${rel}: import icons from src/cloud/ui/icons.ts`);
  }
});

// ============================================================ the server's label, the app it chooses

test('GET /resolve names the system host the server classified — `cloud` on cloud.<root>, null everywhere else', async () => {
  const raw = freshDb();
  const at = async (host: string) => {
    const app = stubApp(asD1(raw), null, (a) => a.route('/api/storefront', storefrontRoutes), { host, env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' }, publishV2: false });
    const res = await get(app, '/api/storefront/resolve');
    return { status: res.status, body: await json(res) };
  };
  const cloud = await at('cloud.levonis-iq.com');
  assert.equal(cloud.status, 200);
  assert.deepEqual(
    { kind: cloud.body.kind, system: cloud.body.system, store: cloud.body.store, root_domain: cloud.body.root_domain },
    { kind: 'system', system: 'cloud', store: null, root_domain: 'levonis-iq.com' }
  );
  for (const host of ['levonis-iq.com', 'www.levonis-iq.com', 'nosuch-shop.levonis-iq.com', 'cloud.example.net', 'example.net']) {
    const { body } = await at(host);
    assert.ok('system' in body, `${host}: no system field`);
    assert.equal(body.system, null, host);
  }
});

test('src/App.tsx renders Print Cloud from the server’s label, as a lazy chunk, beside the store branch', () => {
  const app = read('src/App.tsx');
  assert.match(app, /const PrintCloudApp = prefetchable\(\(\) => import\('\.\/cloud\/PrintCloudApp'\)\);/);
  assert.doesNotMatch(app, /from '\.\/cloud\//, 'nothing of src/cloud may ride in the entry');
  const storeBranch = app.indexOf('if (store || unknownStore || unavailableStore) return <StorefrontApp />;');
  const cloudBranch = app.indexOf("if (system === 'cloud') return <ChunkBoundary><Suspense");
  assert.ok(storeBranch > 0 && cloudBranch > storeBranch, 'the cloud branch follows the store branch');
  assert.ok(cloudBranch < app.indexOf('<Header />'), 'decided before the main chrome renders');

  const store = code(read('src/StoreContext.tsx'));
  assert.equal((store.match(/system: d\.system \|\| null,/g) ?? []).length, 2, 'the inline answer and the fetched one');
  assert.doesNotMatch(store, /location\.hostname|window\.location\.host\b/);
  // Neither reads the label off the address bar.
  for (const rel of ['src/App.tsx', 'src/StoreContext.tsx']) assert.doesNotMatch(code(read(rel)), /hostname\.startsWith\(|'cloud\.levonis|cloud\.\$\{/, rel);
});

test('Print Cloud’s pages are lazy chunks; Print and Account sit behind the sign-in, Store asks per screen', () => {
  const shell = read('src/cloud/PrintCloudApp.tsx');
  for (const page of ['Home', 'Landing', 'Printers', 'PrinterDetail', 'HowItWorks', 'print/PrintRoutes', 'store/StoreRoutes', 'account/AccountRoutes']) {
    assert.match(shell, new RegExp(`prefetchable\\(\\(\\) => import\\('\\./pages/${page}'\\)\\)`), page);
  }
  assert.doesNotMatch(shell, /^import .* from '\.\/pages\//m, 'no page is imported statically');
  assert.match(shell, /<RequireSignIn>\s*<PrintRoutes \/>\s*<\/RequireSignIn>/);
  assert.match(shell, /<RequireSignIn>\s*<AccountRoutes \/>\s*<\/RequireSignIn>/);
  assert.match(shell, /if \(section === 'store'\) return <StoreRoutes \/>;/);
  for (const rel of ['src/cloud/pages/print/PrintRoutes.tsx', 'src/cloud/pages/store/StoreRoutes.tsx', 'src/cloud/pages/account/AccountRoutes.tsx']) {
    assert.match(read(rel), /^export default function \w+\(\)/m, `${rel}: a default export that takes no props`);
  }
});

test('each section owns its prefixes; the shell’s own pages belong to none', () => {
  const cases: Array<[string, ReturnType<typeof cloudSection>]> = [
    ['/print', 'print'], ['/print/new', 'print'], ['/library', 'print'], ['/library/f_1', 'print'], ['/files', null], ['/files/f_1', null], ['/Projects/p_1', 'print'], ['/jobs/j_1', 'print'],
    ['/store', 'store'], ['/store/cart', 'store'], ['/orders', 'store'], ['/orders/pco_1', 'store'],
    ['/account', 'account'], ['/account/shipments/s_1', 'account'],
    ['/', null], ['/printers', null], ['/printers/pm_1', null], ['/how-it-works', null], ['/auth', null],
    ['/printing', null], ['/storefront', null], ['/accounts', null], ['/jobsite', null], ['/nope', null],
  ];
  for (const [path, section] of cases) assert.equal(cloudSection(path), section, path);
  assert.equal(activeTab('/printers/pm_1'), 'home');
  assert.equal(activeTab('/orders/pco_1'), 'store');
  assert.deepEqual(TABS.map((t) => t.id), ['home', 'print', 'store', 'account']);
  for (const tab of TABS) assert.equal(activeTab(tab.to), tab.id, `the ${tab.id} tab lights itself`);
  const all = Object.values(SECTION_PREFIXES).flat();
  assert.equal(new Set(all).size, all.length, 'no prefix belongs to two sections');
});

test('who may use the service: open for all; closed → an admin’s preview, everyone else the landing', () => {
  const status = (installed: boolean, enabled: boolean) => ({ installed, enabled }) as CloudStatus;
  assert.equal(accessOf(null, null, true, false), 'loading');
  assert.equal(accessOf(null, new Error('down'), true, true), 'unavailable');
  assert.equal(accessOf(status(true, true), null, false, false), 'open', 'an open service needs no answer about the viewer');
  assert.equal(accessOf(status(true, false), null, false, false), 'loading', 'closed: wait for the session before choosing');
  assert.equal(accessOf(status(true, false), null, true, false), 'closed');
  assert.equal(accessOf(status(true, false), null, true, true), 'preview');
  assert.equal(accessOf(status(false, true), null, true, false), 'closed', 'not installed is not open');
  assert.equal(accessOf(status(false, false), null, true, true), 'preview');
  // The server's own test of who passes a closed gate (worker/lib/printCloud/http.ts enabledGate).
  assert.match(read('src/cloud/CloudContext.tsx'), /const isAdmin = user\?\.role === 'admin';/);
});

// ============================================================ signing in on the apex, and back

test('the way back to Print Cloud is a literal allowlist: https://cloud.<apex><sanitized path>, nothing else', () => {
  assert.deepEqual([...RETURN_APPS], ['cloud']);
  assert.equal(CLOUD_APP_LABEL, 'cloud');
  for (const app of RETURN_APPS) assert.ok(isSystemSlug(app), `${app} is a system subdomain no shop can claim`);

  assert.equal(appReturnUrl('cloud', APEX, '/printers?x=1#top'), 'https://cloud.levonis-iq.com/printers?x=1#top');
  assert.equal(appReturnUrl('cloud', APEX, undefined), 'https://cloud.levonis-iq.com/');
  assert.equal(appReturnUrl('cloud', `${APEX}/`, '/jobs/j_1'), 'https://cloud.levonis-iq.com/jobs/j_1');
  // The path goes through sanitizeNextPath: no other origin can ride in it.
  for (const evil of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '@evil.com', '/auth?next=//evil.com']) {
    assert.equal(appReturnUrl('cloud', APEX, evil), 'https://cloud.levonis-iq.com/', evil);
  }
  // Only the literal label: never a host, a slug, a URL or a near miss.
  for (const app of ['evil.com', 'cloud.evil.com', 'evil.com/cloud', 'CLOUD', ' cloud', 'cloud ', 'studio', 'admin', 'ali3d', '', null, undefined, ['cloud'], { app: 'cloud' }, 1]) {
    assert.equal(appReturnUrl(app, APEX, '/'), null, JSON.stringify(app));
    assert.equal(isReturnApp(app), false, JSON.stringify(app));
  }
  // Only an https apex with no credentials, port or odd host.
  for (const site of ['', 'http://levonis-iq.com', 'https://user:pw@levonis-iq.com', 'https://levonis-iq.com:8443', 'https://localhost', 'javascript:alert(1)', 'not a url', 'https://evil.com@levonis-iq.com']) {
    assert.equal(appReturnUrl('cloud', site, '/'), null, site);
  }
  // The shop return is unchanged — and can never name Print Cloud's host.
  assert.equal(storeReturnUrl('ali3d', APEX, '/cart'), 'https://ali3d.levonis-iq.com/cart');
  assert.equal(storeReturnUrl('cloud', APEX, '/'), null);
});

test('the apex’s sign-in page goes back to Print Cloud only through that allowlist', () => {
  const auth = read('src/pages/Auth.tsx');
  assert.match(auth, /const \[appFromQuery\] = useState\(\(\) => searchParams\.get\('app'\) \|\| ''\);/);
  assert.match(auth, /const backToApp = back \? null : appReturnUrl\(appFromQuery, mainSite, dest\);/);
  assert.match(auth, /if \(!onStoreHost && !system\) \{/);
  assert.equal((auth.match(/appFromQuery/g) ?? []).length, 3, 'read once, built into a URL once, carried to the other browser once');
  assert.match(auth, /app=\{onStoreHost \|\| system \? '' : appFromQuery\}/);
  // Google is never offered on a system host (the server withholds it there too).
  assert.match(auth, /!onStoreHost &&\s*!system &&/);
});

test('cloud.<root> hands sign-in to the apex with the sanitized path, `app=cloud` and only a chosen language', () => {
  const at = (search: string, from: unknown, lang: string | null) => new URL(cloudHandoffUrl(APEX, search, from, lang));
  const u = at('?ref=abc&store=ali3d&lang=ar&next=/x', '/jobs/j_1?tab=log', 'ckb');
  assert.equal(u.origin, APEX);
  assert.equal(u.pathname, '/auth');
  assert.equal(u.searchParams.get('next'), '/jobs/j_1?tab=log');
  assert.equal(u.searchParams.get('app'), 'cloud');
  assert.equal(u.searchParams.get('lang'), 'ckb');
  assert.equal(u.searchParams.get('ref'), 'abc', 'a referral travels as it came');
  assert.equal(u.searchParams.has('store'), false, 'a shop never rides along');
  assert.equal(at('?next=//evil.com', undefined, null).searchParams.get('next'), '/');
  assert.equal(at('?next=/printers', undefined, null).searchParams.get('next'), '/printers');
  assert.equal(at('?lang=ar', '/', null).searchParams.has('lang'), false, 'a default language is not a choice');
  assert.equal(at('?app=evil.com', '/', 'xx').searchParams.getAll('app').join(), 'cloud');
  assert.equal(at('', { pathname: '//evil.com' }, 'en').searchParams.get('next'), '/');

  // The other browser of an in-app WebView carries the label only from the allowlist.
  assert.equal(new URL(externalAuthUrl(APEX, '/x', '', { app: 'cloud' })).searchParams.get('app'), 'cloud');
  for (const app of ['evil.com', 'CLOUD', 'studio', '']) assert.equal(new URL(externalAuthUrl(APEX, '/x', '', { app })).searchParams.has('app'), false, app);
});

// ============================================================ the client

test('src/cloud/api.ts has a function for every customer door, and names no door that does not exist', () => {
  const norm = (path: string) => path.replace(/\$\{qs\(.*\)\}$/, '').replace(/\$\{[^}]*\}/g, '{}').replace(/\{[A-Za-z]+\}/g, '{}');
  const src = read('src/cloud/api.ts');
  const named = new Set<string>();
  // The file's own helpers (`get('/status')`), not the house client they wrap (`api.get(`${CLOUD_API}${path}`)`).
  const CALL = /(?<![.\w])(get|post|patch|put|del)<[^(]*?>\(\s*(?:'([^']*)'|`((?:[^`\\]|\\.)*)`)/g;
  for (const m of src.matchAll(CALL)) named.add(`${m[1] === 'del' ? 'delete' : m[1]} ${norm(m[2] ?? m[3])}`);
  // The two paths a browser follows itself (a download), and the API's own description.
  for (const m of src.matchAll(/=>\s*`\$\{CLOUD_API\}(\/[^`]*)`/g)) named.add(`get ${norm(m[1])}`);
  for (const m of src.matchAll(/api\.get<[^(]*?>\(`\$\{CLOUD_API\}(\/[^`]*)`/g)) named.add(`get ${norm(m[1])}`);
  assert.ok(named.size > 70, `only ${named.size} doors found: the patterns above no longer read api.ts`);

  const customer = OPERATIONS.filter((o) => o.base === 'customer' && o.path !== '/payments/webhook').map((o) => `${o.method} ${norm(o.path)}`);
  // The wallet contract (pay a Print Cloud order from the Levonis wallet), added beside the table.
  const wallet = ['get /me/wallet', 'post /orders/{}/pay/wallet'];
  for (const door of customer) assert.ok(named.has(door), `no function for ${door}`);
  for (const door of wallet) assert.ok(named.has(door), `no function for ${door}`);
  for (const door of named) assert.ok(customer.includes(door) || wallet.includes(door), `api.ts names ${door}, which the API does not have`);
  assert.doesNotMatch(src, /payments\/webhook'\s*,/, 'the processor’s signed callback is never the browser’s');
});

test('money doors send an Idempotency-Key the server accepts, one fresh key per intent', () => {
  const src = read('src/cloud/api.ts');
  for (const fn of ['convertCredits', 'createOrder', 'payOrderFromWallet', 'confirmJob', 'createShipment']) {
    const at = src.indexOf(`export const ${fn} = `);
    assert.ok(at > 0, fn);
    const body = src.slice(at, src.indexOf(';', at));
    assert.match(body, /idempotencyKey: string/, `${fn} takes the key`);
    assert.match(body, /keyed\(idempotencyKey, opts\)/, `${fn} sends it`);
  }
  assert.equal(String(IDEMPOTENCY_KEY_RE), String(/^[A-Za-z0-9_.:-]{8,200}$/));
  const keys = new Set<string>();
  for (const scope of ['pc', 'order', 'pay:wallet', 'confirm job', '', '%%%']) {
    const key = newIdempotencyKey(scope);
    assert.ok(validIdempotencyKey(key), `${scope}: ${key}`);
    assert.match(key, IDEMPOTENCY_KEY_RE);
    keys.add(key);
  }
  assert.equal(keys.size, 6, 'every intent has its own key');
  assert.equal(qs({ a: 1, b: '', c: null, d: undefined, e: 'x y' }), '?a=1&e=x+y');
  assert.equal(qs({}), '');
});

test('every Print Cloud source file stays inside the house rules a test elsewhere would only catch later', () => {
  for (const rel of CLOUD_FILES) {
    const src = read(rel);
    assert.doesNotMatch(src, /backdrop-blur|\bzinc-|rounded-\[\d|shadow-\[|\bdark:/, `${rel}: clay only (no glass, zinc, arbitrary radius or shadow, no dark: variants)`);
    assert.doesNotMatch(src, /\b(?:left|right)-\d|\b[mp][lr]-\d|text-(?:left|right)\b/, `${rel}: logical properties only (RTL)`);
    assert.doesNotMatch(src, /علاوة/, `${rel}: the forbidden word`);
    assert.doesNotMatch(src, /ليفونيس|لیڤۆنیس|ليڤونيس/, `${rel}: «Levonis» is written in Latin letters`);
    assert.doesNotMatch(src, /localStorage\.setItem|sessionStorage\.setItem/, `${rel}: nothing of the customer's is cached on the device`);
  }
});

/**
 * NO CLOUD SCREEN MAY LIVE ON A PATH THE WORKER ANSWERS FIRST.
 *
 * wrangler.jsonc `run_worker_first` sends every listed path to the Worker
 * before the asset layer, on EVERY host — cloud.<root> included. A cloud
 * route under one of them works when it is reached by an in-app link and
 * breaks the moment it is reloaded or opened from a link: the Worker answers
 * `/files/<id>` with a media lookup, not with the app. That is how the file
 * library moved from `/files` to `/library`. The root `/` is the one shared
 * path, and the Worker hands it to the same document on purpose.
 */
test('no cloud route sits under a path wrangler.jsonc sends to the Worker first', () => {
  const wrangler = read('wrangler.jsonc');
  const blocks = wrangler.match(/"run_worker_first"\s*:\s*\[[^\]]*\]/g) ?? [];
  assert.ok(blocks.length >= 3, 'top-level, staging and dark each declare run_worker_first');
  const workerFirst = new Set(blocks.flatMap((b) => [...b.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]!)));
  const routes = new Set<string>();
  const collect = (rel: string) => {
    for (const m of read(rel).matchAll(/<Route\s+path="([^"]+)"/g)) routes.add(m[1]!);
  };
  collect('src/cloud/PrintCloudApp.tsx');
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (rel.endsWith('.tsx')) collect(rel);
    }
  };
  walk('src/cloud/pages');
  for (const prefixes of Object.values(SECTION_PREFIXES)) for (const p of prefixes) routes.add(p);
  assert.ok(routes.size > 20, `the cloud routes were read (${routes.size})`);
  for (const route of routes) {
    if (route === '*' || route === '/') continue;
    const concrete = route.replace(/:[^/]+/g, 'x').toLowerCase();
    for (const pattern of workerFirst) {
      if (pattern === '/') continue;
      const hit = pattern.endsWith('/*') ? concrete.startsWith(pattern.slice(0, -1)) || concrete === pattern.slice(0, -2) : concrete === pattern;
      assert.equal(hit, false, `${route} is answered by the Worker first (run_worker_first "${pattern}")`);
    }
  }
});
