/**
 * LEAK AUDIT — client-bundles: the price calculator on /tools (the lazy chunk
 * dist/assets/Tools-*.js, open to guests — src/App.tsx «OPEN TO GUESTS») PRINTS
 * the shop's BUYING cost of every print accessory, and the per-line cost of the
 * hardware a quote contains.
 *
 * The owner's rule: anyone other than the main admin / super admin sees ONLY the
 * final price — never a purchase cost, never an intermediate value of the
 * pricing chain, in no channel (API, HTML, JavaScript…).
 * `PrintAccessory.cost_iqd` is documented as «What ONE unit costs the shop»
 * (worker/lib/printAccessories.ts), and the engines put the margin ON TOP of it
 * («It still goes through the margin like every other cost»). So it is a
 * purchase cost, not a sale price — whatever the route comment in
 * worker/routes/printQuote.ts says about publishing it «by design».
 *
 * The client path, exercised end to end with the real code:
 *
 *   server   GET  /api/print-quote/accessories  (real printQuoteRoutes, every
 *            non-owner role of tests/fixtures/roleMatrix.ts ROLES)
 *     → client  GramsQuotePanel.tsx stores `r.accessories` unchanged
 *     → client  AccessoryPicker.tsx renders each option as
 *               `${name} — ${money(o.cost_iqd)}/${unit}`
 *
 *   server   POST /api/print-quote/grams-quote  (guest, customer)
 *     → client  AccessoryBreakdown renders `money(l.iqd)` per line
 *               (l.iqd = cost_iqd × qty — the hardware's buying cost)
 *
 * The React components are the very modules the Tools chunk is built from,
 * rendered with react-dom/server on the server's real answers. The rendered
 * HTML is what the guest's browser paints.
 *
 * And the shipped bundle itself: the built Tools chunk (when dist/ exists)
 * reads `.cost_iqd` off the accessory list and interpolates it into the label.
 * No existing guard sees any of this: bundlePrivateNames does not list
 * `cost_iqd`, costClientHints does not cover src/components/tools/, and the
 * role matrix exempts `.accessories[N].cost_iqd` (NOT_A_COST).
 *
 * LOCAL ONLY: in-memory / temp-file SQLite with every migration, the stub
 * session of tests/fixtures/app.ts, the local dist/ when present. No network.
 *
 * Run: node --import tsx --test tests/leakAudit_client-bundles_accessory_buying_cost_public.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { asD1, freshDb, json, post, stubApp, type Mount } from './fixtures/app';
import { ROLES, appFor, call, seededCopy, type RoleName } from './fixtures/roleMatrix';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { LanguageProvider } from '../src/LanguageContext';
import { CurrencyValueProvider, currencyValue } from '../src/CurrencyContext';
import AccessoryPicker, {
  AccessoryBreakdown,
  type AccessoryOption,
  type AccessoryRow,
} from '../src/components/tools/AccessoryPicker';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The shop's buying price of ONE accessory — a figure no price, id or count here can equal. */
const ACC_COST = 47_391;
/** How many the customer asks for, so the line cost the breakdown prints is ACC_COST × QTY. */
const QTY = 3;
const ACC_LINE_COST = ACC_COST * QTY; // 142_173

const AUDIT_ACCESSORY = {
  id: 'audit-magnet',
  name_ar: 'مغناطيس تدقيق',
  name_en: 'Audit magnet',
  name_ckb: 'ماگنێتی پشکنین',
  unit: 'piece',
  cost_iqd: ACC_COST,
  category: 'magnet',
  active: true,
};

function setCatalogue(raw: DatabaseSync): void {
  raw
    .prepare(
      `INSERT INTO admin_settings (key, value) VALUES ('printAccessories', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(JSON.stringify([AUDIT_ACCESSORY]));
}

/** A shop that has filled in its numbers (as tests/printQuoteGrams.test.ts does) and set the catalogue. */
function shop(): DatabaseSync {
  const raw = freshDb();
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  raw
    .prepare(
      `UPDATE printer_models
          SET purchase_iqd = 900000, residual_iqd = 100000, useful_print_hours = 4000,
              maintenance_iqd_per_hour = 150, printing_watts = 110,
              bed_heating_watts = 350, nozzle_heating_watts = 60
        WHERE id = 'bbl-a1m'`
    )
    .run();
  setCatalogue(raw);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');`);
  return raw;
}

const mount: Mount = (a) => {
  a.route('/api/print-quote', printQuoteRoutes);
};

// ------------------------------------------------------------ rendering

/** The providers the Tools page renders under: a language, and the shop's IQD money reader. */
function paint(el: ReactElement, lang: 'ar' | 'en' | 'ckb' = 'ar'): string {
  const money = currencyValue('IQD', () => undefined, null);
  return withLang(lang, () =>
    renderToStaticMarkup(
      createElement(LanguageProvider, {
        children: createElement(CurrencyValueProvider, { value: money, children: el }),
      })
    )
  );
}

/** Render in a chosen language: LanguageProvider reads its first language from localStorage. */
function withLang<T>(lang: string, work: () => T): T {
  const g = globalThis as { localStorage?: unknown };
  const before = g.localStorage;
  // src/LanguageContext.tsx LANG_KEY.
  const store = new Map<string, string>([['levo_lang', lang]]);
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: store.size,
  };
  try {
    return work();
  } finally {
    if (before === undefined) delete g.localStorage;
    else g.localStorage = before;
  }
}

/** The text a reader sees: tags dropped, entities decoded, digit groupings and Arabic-Indic digits normalised. */
function screenText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/(\d)[,٫٬\u00a0\u202f](?=\d)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every buying-cost figure the painted screen shows, with a little context around it. */
function paintedCosts(html: string, figures: readonly number[]): string[] {
  const text = screenText(html);
  const out: string[] = [];
  for (const n of figures) {
    const re = new RegExp(`(?<!\\d)${n}(?!\\d)`, 'g');
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      out.push(`${n} in «…${text.slice(Math.max(0, at - 40), at + String(n).length + 12)}…»`);
    }
  }
  return out;
}

const openRow = (id: string, qty = ''): AccessoryRow[] => [{ key: 'k1', id, qty }];

// ====================================================================== 1

const NON_OWNER = Object.keys(ROLES) as RoleName[];

test('the /tools accessory picker paints no accessory buying cost, for any non-owner role', async () => {
  const found: string[] = [];
  const exercised: string[] = [];
  for (const role of NON_OWNER) {
    const raw = seededCopy();
    setCatalogue(raw);
    const { status, body } = await call(appFor(raw, ROLES[role] ?? null), 'GET', '/api/print-quote/accessories');
    raw.close();
    assert.equal(status, 200, `${role}: ${JSON.stringify(body)}`);
    // Exactly what GramsQuotePanel.tsx does with the answer: `setAccessoryOptions(r.accessories)`.
    const options = ((body as { accessories?: AccessoryOption[] }).accessories ?? []) as AccessoryOption[];
    assert.ok(options.some((o) => o.id === AUDIT_ACCESSORY.id), `${role}: the owner's accessory is not in the answer`);

    for (const lang of ['ar', 'en', 'ckb'] as const) {
      // A row on the screen opens the section (`useState(rows.length > 0)`), as it is
      // the moment the customer opens «إضافات وقطع» to pick a part.
      const html = paint(createElement(AccessoryPicker, { options, rows: openRow(''), onChange: () => undefined }), lang);
      // The picker really rendered the owner's row — otherwise this proves nothing.
      assert.ok(
        html.includes(`value="${AUDIT_ACCESSORY.id}"`),
        `${role}/${lang}: the picker did not render the accessory option: ${html.slice(0, 400)}`
      );
      exercised.push(`${role}/${lang}`);
      for (const l of paintedCosts(html, [ACC_COST])) found.push(`${role}/${lang}: ${l}`);
    }
  }
  assert.equal(exercised.length, NON_OWNER.length * 3);
  assert.deepEqual(
    found,
    [],
    `the /tools accessory picker (src/components/tools/AccessoryPicker.tsx, built into Tools-*.js) paints the shop's accessory BUYING cost («What ONE unit costs the shop») to ${new Set(found.map((f) => f.split('/')[0])).size} non-owner roles: ${found.slice(0, 4).join(' | ')}`
  );
});

// ====================================================================== 2

test('the /tools grams quote breakdown paints no accessory line cost to a guest or a customer', async () => {
  const found: string[] = [];
  for (const [who, user] of [
    ['guest', null],
    ['customer', { id: 'buyer', role: 'customer', email: 's@x.co' }],
  ] as const) {
    const raw = shop();
    const res = await post(stubApp(asD1(raw), user, mount), '/api/print-quote/grams-quote', {
      printer_model_id: 'bbl-a1m',
      rows: [{ material_id: 'pla', grams: 100, color_hex: '#000000' }],
      print_minutes: 180,
      // Exactly the body GramsQuotePanel sends: `accessories: accessoryPayload(accessoryRows)`.
      accessories: [{ id: AUDIT_ACCESSORY.id, qty: QTY }],
    });
    const body = await json(res);
    raw.close();
    assert.equal(res.status, 200, `${who}: ${JSON.stringify(body)}`);
    assert.equal(body.success, true, `${who}: ${JSON.stringify(body)}`);
    // The final price exists and is allowed; it is not what this test inspects.
    assert.ok(Number(body.quote?.price_iqd) > 0, `${who}: no final price: ${JSON.stringify(body.quote)}`);
    const lines = (body.accessories ?? []) as Array<{ id: string; qty: number; iqd: number; name_ar: string; name_en: string; name_ckb: string }>;
    assert.ok(lines.some((l) => l.id === AUDIT_ACCESSORY.id), `${who}: the accessory never reached the engine: ${JSON.stringify(body)}`);

    // Exactly what GramsQuotePanel.tsx renders under the result:
    //   <AccessoryBreakdown lines={result.accessories ?? []} unknown={result.accessories_unknown ?? []} />
    for (const lang of ['ar', 'en', 'ckb'] as const) {
      const html = paint(
        createElement(AccessoryBreakdown, { lines, unknown: (body.accessories_unknown ?? []) as string[] }),
        lang
      );
      assert.ok(screenText(html).includes(`${QTY}×`), `${who}/${lang}: the breakdown did not render the line: ${html}`);
      for (const l of paintedCosts(html, [ACC_COST, ACC_LINE_COST])) found.push(`${who}/${lang}: ${l}`);
    }
  }
  assert.deepEqual(
    found,
    [],
    `the /tools grams quote (AccessoryBreakdown, money(l.iqd)) paints the hardware's BUYING cost (cost_iqd × qty) beside the final price: ${found.slice(0, 4).join(' | ')}`
  );
});

// ====================================================================== 3

test('the shipped customer code of /tools does not read the accessory buying cost', () => {
  // The source the Tools chunk is built from (always present).
  const SOURCES = ['src/components/tools/AccessoryPicker.tsx', 'src/components/tools/GramsQuotePanel.tsx'];
  const found: string[] = [];
  for (const rel of SOURCES) {
    const code = readFileSync(join(ROOT, rel), 'utf8')
      // Comments out, line breaks kept, so the reported line numbers are the file's own.
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // A READ of the buying cost (or of the per-line / total hardware cost) that reaches the screen.
    for (const m of code.matchAll(/\.(cost_iqd|unit_iqd|accessories_iqd)\b|\bl\.iqd\b/g)) {
      const line = code.slice(0, m.index).split('\n').length;
      found.push(`${rel}:${line} reads «${m[0]}»`);
    }
  }

  // The built chunk, when a build is present (dist/ is local, from `npm run build`).
  const ASSETS = join(ROOT, 'dist', 'assets');
  if (existsSync(ASSETS)) {
    const tools = readdirSync(ASSETS).filter((f) => /^Tools-.*\.js$/.test(f));
    assert.ok(tools.length >= 1, 'dist/ exists but holds no Tools chunk');
    for (const f of tools) {
      const code = readFileSync(join(ASSETS, f), 'utf8');
      assert.ok(code.includes('/api/print-quote/accessories'), `${f} is not the calculator chunk`);
      for (const m of code.matchAll(/[\w$]+\.cost_iqd\)?[^,;]{0,24}/g)) found.push(`dist/assets/${f} ships «${m[0]}»`);
    }
  }

  assert.deepEqual(
    found,
    [],
    `the guest-open /tools calculator code reads and paints the shop's accessory BUYING cost: ${found.join(' | ')}`
  );
});
