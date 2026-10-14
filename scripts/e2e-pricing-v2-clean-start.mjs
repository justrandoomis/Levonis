#!/usr/bin/env node
/**
 * PRICING V2 — THE CLEAN START, END TO END IN A REAL BROWSER (owner answers
 * of 2026-10-14, docs/DECISIONS.md row 222; implementation spec addendum
 * A.4–A.10).
 *
 * The real built SPA, the real Worker under `wrangler dev --local` and a real
 * local D1 that goes through the deploy's own order: a database at migration
 * 0188 holding a pre-existing product priced the OLD way (dinar prices, a
 * Direct Sale Extra, route commissions, typed colour prices, legacy cost
 * cells, 0181 cost inputs), an open cart holding it — then the cut-over
 * migrations 0189 and 0190, then the new Worker.
 *
 *   1  CUT-OVER. The invented pre-existing printer «Levo E2E CS Printer» is
 *      hidden from every customer read the browser and the APIs reach (the
 *      listing, its search, the product page, the public API, the sitemap)
 *      and unpurchasable (the cart refuses it, an open cart lists it as
 *      unavailable with an ar/en/ckb message and no number, the quote refuses
 *      it); its old values are only in the invisible archive row.
 *   2  OWNER. «يحتاج تسعيرًا» in the list and the queue; the owner opens it
 *      and prices it FROM COST in section ٣ (the 0181 inputs prefilled, the
 *      extras, the minimum profit, the pre-order discount typed), and in
 *      section ٥ (2 models × 3 colours) gives the Red colour +$2 and the Pro
 *      model a discount exception, then «نشر» → the review sheet → confirm.
 *      The printer is listed again; every SKU sells pre-order at P ≤ D; the
 *      customer reads final dinar prices only (no FINANCIAL_FIELDS key, no
 *      cost figure, no dollar figure).
 *   3  PRICE EDITOR (an admin who is not the owner). On the cost-first
 *      printer: no cost card, no cost figure in any answer, the prices
 *      read-only. On a second needs-pricing product («Levo E2E CS Filament»):
 *      the dollar price, a model difference and a discount typed in USD and
 *      published — and still no cost anywhere.
 *   4  ORDER LINE. The customer buys the printer (Standard / Red, direct):
 *      the order line carries cost NULL, basis `unpriced` and the frozen V2
 *      estimate — the replacement cost R of the direct channel at the rate
 *      it was computed at — never a legacy cost cell; the customer's order
 *      answer carries no estimate.
 *
 * LOCAL ONLY. The Worker listens on 127.0.0.1; every browser request to any
 * other host is aborted and counted, and the run fails unless that count is
 * 0 and no page error was thrown. No live site, no production database: the
 * database is a fresh `--persist-to` directory this script creates.
 *
 * How to run (one heavy process — run it alone; ~4-6 minutes):
 *   npm run build
 *   OUT_DIR=/tmp/e2e-pricing-v2 node scripts/e2e-pricing-v2-clean-start.mjs
 *
 * Env: OUT_DIR (results.json, screenshots, the wrangler log, the persist dir),
 * PORT (default 8851), CHROMIUM_PATH, PLAYWRIGHT_MODULE, KEEP_DEV=1 (leave
 * the dev server running at the end, for a human to look).
 */
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { splitStatements } from './lib/sql-split.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.js');
const PORT = Number(process.env.PORT || 8851);
const BASE = `http://127.0.0.1:${PORT}`;
const LOCAL_HOST = new URL(BASE).host;
const OUT = process.env.OUT_DIR || '/tmp/e2e-pricing-v2-clean-start';
const SHOTS = join(OUT, 'screenshots');
const PERSIST = join(OUT, 'persist');
const WRANGLER = process.env.WRANGLER || join(ROOT, 'node_modules/.bin/wrangler');
if (!existsSync(join(ROOT, 'dist/index.html'))) throw new Error('dist/ is missing: run `npm run build` first');
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------------ the invented catalogue

const OWNER = { id: 'u_owner', email: 'owner@levonis.test', password: 'owner-e2e-pass-1' };
const EDITOR = { id: 'u_editor', email: 'editor@levonis.test', password: 'editor-e2e-pass-1' };
const BUYER = { id: 'u_buyer', email: 'buyer@levonis.test', password: 'buyer-e2e-pass-1' };
const A = {
  id: 'e2e_cs_a',
  slug: 'levo-e2e-cs-printer',
  name: 'Levo E2E CS Printer',
  models: [
    { id: 'e2e_cs_a_std', en: 'Standard', ar: 'قياسي', ckb: 'ستاندارد' },
    { id: 'e2e_cs_a_pro', en: 'Pro', ar: 'برو', ckb: 'پرۆ' },
  ],
  colours: [
    { id: 'e2e_cs_a_blk', en: 'Black', ar: 'أسود', ckb: 'ڕەش', hex: '#111111' },
    { id: 'e2e_cs_a_wht', en: 'White', ar: 'أبيض', ckb: 'سپی', hex: '#f5f5f5' },
    { id: 'e2e_cs_a_red', en: 'Red', ar: 'أحمر', ckb: 'سوور', hex: '#cc2222' },
  ],
};
const B = {
  id: 'e2e_cs_b',
  slug: 'levo-e2e-cs-filament',
  name: 'Levo E2E CS Filament',
  models: [
    { id: 'e2e_cs_b_1kg', en: '1 kg', ar: '1 كغ', ckb: '1 کگ' },
    { id: 'e2e_cs_b_2kg', en: '2 kg', ar: '2 كغ', ckb: '2 کگ' },
  ],
};
/** The OLD dinar money (invented; never a live product's: this repository is public). */
const LEGACY = { priceA: 1_250_000, costA: 903_000, stdCost: 881_000, proPrice: 1_450_000, proCost: 1_047_000, redPrice: 1_290_000, redCost: 921_000, dse: 25_000, surcharge: 50_000, routeFee: 10_000, priceB: 30_000, costB: 18_000 };
/** What the owner types (section ٣ / ٥), and the rate world (1 USD = 1,600 IQD; CHINA_SEA 400,000 IQD per CBM). */
const OWNER_ENTRY = { extras: '15000', minProfit: '120', discount: '40', redDelta: '2', proDiscount: '25' };
const U = 1600;
/** What the editor types for the filament (price-first). */
const EDITOR_ENTRY = { usd: '20', twoKgDelta: '15', discount: '2' };

// ------------------------------------------------------------------ the local database

function initLocalD1() {
  rmSync(PERSIST, { recursive: true, force: true });
  mkdirSync(PERSIST, { recursive: true });
  execFileSync(WRANGLER, ['d1', 'execute', 'levonis-db', '--local', '--persist-to', PERSIST, '--command', 'SELECT 1'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  const dir = join(PERSIST, 'v3/d1/miniflare-D1DatabaseObject');
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (!file) throw new Error(`no local D1 file under ${dir}`);
  return join(dir, file);
}

/** One migration file the way D1 applies it (one transaction, bookkeeping in d1_migrations) — scripts/migrate-check.mjs. */
function applyMigrations(db, filter) {
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const applied = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql') && filter(f)).sort();
  const done = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const stmts = splitStatements(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
    db.exec('BEGIN');
    try {
      for (const s of stmts) db.exec(s);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw new Error(`${f}: ${e.message}`);
    }
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(f);
    done.push(f);
  }
  return done;
}

const migrationNo = (f) => Number(f.slice(0, 4));

function passwordHash(password) {
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const salt = randomBytes(16);
  return `pbkdf2$100000$${b64url(salt)}$${b64url(pbkdf2Sync(password, salt, 100000, 32, 'sha256'))}`;
}

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** Everything as the live database holds it at 0188: users, approved rates, two products priced the OLD way, an open cart. */
function seedBeforeCutOver(db) {
  const now = '2026-10-10T09:00:00.000Z';
  db.exec('BEGIN');
  try {
    for (const [u, role, scope, name] of [
      [OWNER, 'admin', null, 'مالك ليفونيس'],
      [EDITOR, 'admin', 'full', 'محرر الأسعار'],
      [BUYER, 'customer', null, 'زبون التجربة'],
    ]) {
      db.prepare(
        `INSERT INTO users (id, email, username, name, password_hash, role, locale, email_verified_at, admin_scope) VALUES (?, ?, ?, ?, ?, ?, 'ar', ?, ?)`
      ).run(u.id, u.email, u.id.replace('u_', 'e2e_'), name, passwordHash(u.password), role, now, scope);
    }
    // The rates the owner approved (tests/fixtures/fx.ts applyRate + syncDerived), and ONE central freight route.
    db.exec(`
      UPDATE fx_rate_pairs SET effective_rate='${U}', effective_version=effective_version+1, effective_source='review_approved', effective_applied_at='${now}', effective_applied_by='${OWNER.id}', last_known_good_rate='${U}', last_known_good_at='${now}', drift_anchor_rate='${U}', drift_anchor_at='${now}', market_rate='${U}', pending_market_rate=NULL, pending_effective_rate=NULL, pending_reason=NULL, pending_observed_at=NULL, fetch_status='OK', status='OK', last_check_result='APPLIED' WHERE pair='USD_IQD';
      UPDATE fx_rate_pairs SET effective_rate='1.1', effective_version=effective_version+1, effective_source='review_approved', effective_applied_at='${now}', effective_applied_by='${OWNER.id}', last_known_good_rate='1.1', last_known_good_at='${now}', drift_anchor_rate='1.1', drift_anchor_at='${now}', market_rate='1.1', pending_market_rate=NULL, pending_effective_rate=NULL, pending_reason=NULL, pending_observed_at=NULL, fetch_status='OK', status='OK', last_check_result='APPLIED' WHERE pair='EUR_USD';
      UPDATE fx_rate_pairs SET effective_rate='0.14', effective_version=effective_version+1, effective_source='review_approved', effective_applied_at='${now}', effective_applied_by='${OWNER.id}', last_known_good_rate='0.14', last_known_good_at='${now}', drift_anchor_rate='0.14', drift_anchor_at='${now}', market_rate='0.14', pending_market_rate=NULL, pending_effective_rate=NULL, pending_reason=NULL, pending_observed_at=NULL, fetch_status='OK', status='OK', last_check_result='APPLIED' WHERE pair='CNY_USD';
      UPDATE pricing_fx_rates SET rate_iqd='${U}', usd_iqd_rate='${U}', usd_version=(SELECT effective_version FROM fx_rate_pairs WHERE pair='USD_IQD'), version=version+1, updated_by='${OWNER.id}', updated_at='${now}' WHERE currency='USD';
      UPDATE pricing_fx_rates SET rate_iqd='1760', usd_iqd_rate='${U}', cross_rate='1.1', usd_version=(SELECT effective_version FROM fx_rate_pairs WHERE pair='USD_IQD'), cross_version=(SELECT effective_version FROM fx_rate_pairs WHERE pair='EUR_USD'), version=version+1, updated_by='${OWNER.id}', updated_at='${now}' WHERE currency='EUR';
      UPDATE pricing_fx_rates SET rate_iqd='224', usd_iqd_rate='${U}', cross_rate='0.14', usd_version=(SELECT effective_version FROM fx_rate_pairs WHERE pair='USD_IQD'), cross_version=(SELECT effective_version FROM fx_rate_pairs WHERE pair='CNY_USD'), version=version+1, updated_by='${OWNER.id}', updated_at='${now}' WHERE currency='CNY';
      UPDATE pricing_shipping_rates SET rate_iqd='400000', version=version+1, updated_by='${OWNER.id}', updated_at='${now}' WHERE profile='CHINA_SEA';
    `);
    // ---- A: the printer, 2 models × 3 colours, direct + pre-order by sea, priced the OLD way.
    db.exec(`
      INSERT INTO products (id, slug, name, name_ar, name_ku, description, status, price_iqd, product_cost_iqd, stock, selling_type, sale_types,
                            preorder_transports, inventory_mode, direct_surcharge_iqd, package_weight_g, package_depth_mm, package_width_mm, package_height_mm, category_id)
      VALUES (${q(A.id)}, ${q(A.slug)}, ${q(A.name)}, 'طابعة ليفو التجريبية', 'چاپکەری تاقیکردنەوەی لیڤۆ', 'An invented printer for the clean-start browser run.', 'active',
              ${LEGACY.priceA}, ${LEGACY.costA}, 30, 'direct_sale', '["direct_sale","pre_order"]',
              '[{"method":"sea","commission_iqd":${LEGACY.routeFee},"active":true}]', 'VARIANT_COMBINATION', ${LEGACY.surcharge}, 9000, 520, 600, 480, 'cat_printers');
      INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${A.id}_g', ${q(A.id)}, 'Model', 0, 1);
    `);
    A.models.forEach((m, j) => {
      const price = j === 1 ? LEGACY.proPrice : null;
      const cost = j === 1 ? LEGACY.proCost : LEGACY.stdCost;
      db.exec(`
        INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, regular_price_iqd, cost_iqd, variant_key, variant_label)
        VALUES (${q(m.id)}, ${q(A.id)}, '${A.id}_g', ${q(m.en)}, ${q(m.ar)}, ${q(m.ckb)}, ${j}, 1, 15, ${q(price)}, ${cost}, ${q(`m${j}`)}, ${q(m.en)});
        INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd, cost_iqd)
        VALUES ('${m.id}_d', ${q(A.id)}, ${q(m.id)}, 'direct_sale', 1, NULL, NULL),
               ('${m.id}_p', ${q(A.id)}, ${q(m.id)}, 'pre_order', 1, NULL, NULL);
        INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled, surcharge_iqd)
        VALUES ('${m.id}_p_sea', ${q(A.id)}, '${m.id}_p', 'sea', 1, 4500);
      `);
    });
    A.colours.forEach((c, k) => {
      const red = c.id.endsWith('_red');
      db.exec(`
        INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active, stock, regular_price_iqd, cost_iqd)
        VALUES (${q(c.id)}, ${q(A.id)}, ${q(c.en)}, ${q(c.ar)}, ${q(c.ckb)}, ${q(c.hex)}, ${k}, 1, 10, ${red ? LEGACY.redPrice : 'NULL'}, ${red ? LEGACY.redCost : 'NULL'});
      `);
    });
    let v = 0;
    for (const m of A.models) {
      for (const c of A.colours) {
        db.exec(`INSERT INTO product_variants (id, product_id, combo_key, sku, active, stock) VALUES ('${A.id}_v${v}', ${q(A.id)}, 'o:${m.id}|c:${c.id}', 'E2E-CS-A-${v}', 1, 5)`);
        v += 1;
      }
    }
    // Its 0181 engine inputs (NOT old dinar pricing: they prefill V2) and its old Direct Sale Extra (retired by V2).
    db.exec(`
      INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, supplier_cost_amount, supplier_cost_currency, supplier_input_mode, shipping_profile,
                                  pricing_weight_g, shipping_weight_g, shipping_length_mm, shipping_width_mm, shipping_height_mm, source_ref, updated_by, updated_at)
      VALUES (${q(A.id)}, 'base', '', 'MANUAL_OVERRIDE', '500', 'USD', 'SOURCE_CURRENCY', 'CHINA_SEA', 9000, 9000, 520, 600, 480, 'owner', '${OWNER.id}', '${now}');
      INSERT INTO pricing_rules (id, kind, scope, scope_id, product_id, state, amount_iqd, source, version, updated_at)
      VALUES ('rule_e2e_cs_dse', 'direct_sale_extra', 'product', '', ${q(A.id)}, 'ACTIVE', ${LEGACY.dse}, 'OWNER', 1, '${now}');
    `);
    // ---- B: the filament, 2 sizes, direct + pre-order by land, priced the OLD way.
    db.exec(`
      INSERT INTO products (id, slug, name, name_ar, name_ku, description, status, price_iqd, product_cost_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode, category_id, package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
      VALUES (${q(B.id)}, ${q(B.slug)}, ${q(B.name)}, 'خيط ليفو التجريبي', 'دەزووی تاقیکردنەوەی لیڤۆ', 'An invented filament for the clean-start browser run.', 'active',
              ${LEGACY.priceB}, ${LEGACY.costB}, 40, 'direct_sale', '["direct_sale","pre_order"]', '[{"method":"land","commission_iqd":${LEGACY.routeFee},"active":true}]', 'OPTION', 'cat_materials_fdm', 1300, 210, 210, 90);
      INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${B.id}_g', ${q(B.id)}, 'Size', 0, 1);
    `);
    B.models.forEach((m, j) => {
      db.exec(`
        INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, regular_price_iqd, cost_iqd, variant_key, variant_label)
        VALUES (${q(m.id)}, ${q(B.id)}, '${B.id}_g', ${q(m.en)}, ${q(m.ar)}, ${q(m.ckb)}, ${j}, 1, 20, ${j ? 55_000 : 'NULL'}, ${j ? 33_000 : 'NULL'}, ${q(`s${j}`)}, ${q(m.en)});
        INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('${m.id}_d', ${q(B.id)}, ${q(m.id)}, 'direct_sale', 1), ('${m.id}_p', ${q(B.id)}, ${q(m.id)}, 'pre_order', 1);
        INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled, surcharge_iqd) VALUES ('${m.id}_p_land', ${q(B.id)}, '${m.id}_p', 'land', 1, 2000);
      `);
    });
    // A picture each (the 0184 completeness rule hides a product without one); the R2 object itself is not needed.
    for (const p of [A, B]) {
      const key = `products/${p.id}/main.webp`;
      db.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify([{ id: `img_${p.id}`, url: `/files/${key}`, key, role: 'gallery', alt_ar: '', alt_en: p.name, alt_ckb: '', order: 0, primary: true }]), p.id);
      db.prepare("INSERT INTO product_images (id, product_id, url, r2_key, alt_en, sort_order, is_primary, content_type) VALUES (?, ?, ?, ?, ?, 0, 1, 'image/webp')").run(`img_${p.id}`, p.id, `/files/${key}`, key, p.name);
    }
    // ---- An open cart from before the cut-over: the printer, Standard / Black, direct.
    db.exec(`INSERT INTO cart_items (id, user_id, product_id, option_id, color_id, option_value_ids, fulfillment_type, qty)
             VALUES ('ci_e2e_cs_old', ${q(BUYER.id)}, ${q(A.id)}, ${q(A.models[0].id)}, ${q(A.colours[0].id)}, '${JSON.stringify([A.models[0].id])}', 'direct_sale', 1)`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * The products' pictures, as real WebP objects in the local public media bucket: a product save
 * reads and decodes every referenced image (worker/lib/productMediaIngest.ts), and the 0184
 * completeness rule hides a product without one.
 */
async function seedPictures() {
  const sharp = createRequire(join(ROOT, 'package.json'))('sharp');
  const dir = join(OUT, 'media');
  mkdirSync(dir, { recursive: true });
  for (const [p, colour] of [
    [A, '#1f3a5f'],
    [B, '#3f6b3a'],
  ]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="${colour}"/><text x="400" y="420" font-size="54" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${p.name}</text></svg>`;
    const file = join(dir, `${p.id}.webp`);
    writeFileSync(file, await sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer());
    execFileSync(WRANGLER, ['r2', 'object', 'put', `levonis-media-public/products/${p.id}/main.webp`, '--file', file, '--content-type', 'image/webp', '--local', '--persist-to', PERSIST], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    });
  }
}

// ------------------------------------------------------------------ checks and results

/** The cost figures no non-owner may ever read (R per SKU, the old cost cells, the supplier cost × U) — never written to the report. */
let costFigures = [];
const results = { started_at: new Date().toISOString(), base: BASE, cases: {}, blocked: [], page_errors: [], failures: [] };
let current = 'setup';
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  const entry = { name, ok: !!ok, ...(detail === undefined ? {} : { detail }) };
  (results.cases[current] ??= []).push(entry);
  console.log(`${ok ? '  ok  ' : '  FAIL'} [${current}] ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!ok) results.failures.push(`[${current}] ${name}`);
  return !!ok;
}

/** FINANCIAL_FIELDS, read from the server's own list (worker/lib/adminScope.ts). */
const FINANCIAL_FIELDS = (() => {
  const src = readFileSync(join(ROOT, 'worker/lib/adminScope.ts'), 'utf8');
  const block = src.slice(src.indexOf('export const FINANCIAL_FIELDS = ['), src.indexOf('] as const;', src.indexOf('export const FINANCIAL_FIELDS = [')));
  return new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
})();
/** Every key of a JSON value that FINANCIAL_FIELDS names (snake or camel), with its path. */
function financialKeys(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => financialKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const snake = k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
      if (FINANCIAL_FIELDS.has(k) || FINANCIAL_FIELDS.has(snake)) out.push(`${path}.${k}`);
      financialKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}
/** Figures that must never reach a non-owner (as digits, with or without thousands separators). */
function figureHits(text, figures) {
  const hits = [];
  for (const f of figures) {
    if (f === null || f === undefined) continue;
    const n = Number(f);
    if (!Number.isFinite(n) || n < 1000) continue;
    const plain = String(Math.round(n));
    const grouped = Math.round(n).toLocaleString('en-US');
    if (new RegExp(`(^|[^0-9])${plain}([^0-9]|$)`).test(text) || text.includes(grouped)) hits.push(plain);
  }
  return hits;
}

// ------------------------------------------------------------------ the dev server

let dev = null;
async function startDev() {
  const log = createWriteStream(join(OUT, 'wrangler-dev.log'));
  dev = spawn(
    WRANGLER,
    ['dev', '--local', '--persist-to', PERSIST, '--ip', '127.0.0.1', '--port', String(PORT), '--var', `INITIAL_ADMIN_EMAIL:${OWNER.email}`, '--show-interactive-dev-session=false'],
    { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_UPDATE_NOTIFIER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  dev.stdout.pipe(log);
  dev.stderr.pipe(log);
  for (let i = 0; i < 240; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/settings/public`);
      if (r.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not answer in 120 s (see wrangler-dev.log)');
}
function stopDev() {
  if (dev && !process.env.KEEP_DEV) {
    dev.kill('SIGINT');
    dev = null;
  }
}

/** Reads the local D1 the running Worker writes (WAL: a reader never blocks it). */
let dbFile = '';
function rows(sql, ...params) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}
const one = (sql, ...params) => rows(sql, ...params)[0] ?? null;

// ------------------------------------------------------------------ the browser

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });

/** A browser session for one person (null: a guest). Every non-local request is aborted and counted. */
async function session(who, { width = 1280, lang = 'ar' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'ar-IQ', serviceWorkers: 'block', hasTouch: width < 600 });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    let host = '';
    try {
      host = new URL(u).host;
    } catch {
      /* data: and the like */
    }
    if (host === LOCAL_HOST || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    results.blocked.push(`${current}: ${u.slice(0, 160)}`);
    return route.abort('blockedbyclient');
  });
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem('levo_lang', l); // src/LanguageContext.tsx LANG_KEY
    } catch {
      /* storage blocked */
    }
  }, lang);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => results.page_errors.push(`${current}: ${String(e).slice(0, 300)}`));
  page.on('dialog', (d) => d.accept());
  const answers = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.startsWith(BASE) || !new URL(url).pathname.startsWith('/api/')) return;
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* a redirect or an aborted body */
    }
    answers.push({ method: res.request().method(), path: new URL(url).pathname + new URL(url).search, status: res.status(), text });
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  if (who) {
    const login = await page.request.post(`${BASE}/api/auth/login`, { data: { identifier: who.email, password: who.password }, headers: { Origin: BASE } });
    if (login.status() !== 200) throw new Error(`sign-in ${who.email}: ${login.status()} ${(await login.text()).slice(0, 200)}`);
  }
  /** The person's own API call, made by the page itself (same origin, the browser's own cookie). */
  const api = (method, path, data) =>
    page.evaluate(
      async ([m, p, d]) => {
        const r = await fetch(p, { method: m, credentials: 'include', headers: d === null ? {} : { 'Content-Type': 'application/json' }, body: d === null ? undefined : JSON.stringify(d) });
        const text = await r.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        return { status: r.status, body, text };
      },
      [method, path, data === undefined ? null : data]
    );
  return { ctx, page, api, answers };
}

/** Waits until no request has been made for `quietMs`. */
async function settle(page, quietMs = 900, maxMs = 30000) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const start = Date.now();
  let last = await page.evaluate(() => performance.getEntriesByType('resource').length).catch(() => 0);
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(150);
    const n = await page.evaluate(() => performance.getEntriesByType('resource').length).catch(() => last);
    if (n !== last) {
      last = n;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) return;
  }
}
const shot = async (page, name, fullPage = true) => {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage }).catch((e) => console.log(`  (screenshot ${name}: ${e.message})`));
};

async function openSection(page, n) {
  const t = page.locator(`[data-section-toggle="${n}"]`).first();
  await t.waitFor({ timeout: 20000 });
  if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  await page.waitForTimeout(300);
}
async function openProductForm(page, id) {
  await page.goto(`${BASE}/admin?tab=products&edit=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-form="save-bar"]').first().waitFor({ timeout: 30000 });
  await settle(page, 1000);
  await openSection(page, 3);
  await page.locator('[data-form="pricing-v2"]').first().waitFor({ timeout: 20000 });
  await settle(page, 1000);
}
/** Types into an input as a person does (clears it first). */
async function typeInto(locator, text) {
  await locator.waitFor({ timeout: 15000 });
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(text, { delay: 20 });
}
/** The preview the form asks for after typing lands. */
async function previewLands(page) {
  await page.waitForTimeout(700);
  await page.waitForFunction(() => !document.querySelector('[data-form="pricing-v2"]')?.getAttribute('aria-busy'), null, { timeout: 30000 }).catch(() => {});
  await settle(page, 900);
}

/**
 * «نشر». The form sends the hash of the preview the reader is looking at (section ٣'s final prices
 * table); the server writes when it matches and answers 409 with its sheet when it does not (or when
 * a large change needs the tick) — then the sheet is confirmed. Returns how it went; on a refusal a
 * screenshot and the save's answer are thrown.
 */
async function publish(who, tag) {
  const page = who.page;
  const mark = who.answers.length;
  await page.locator('[data-action="save"]').first().click();
  const saved = () => who.answers.slice(mark).find((a) => a.method === 'POST' && a.path.startsWith('/api/admin/products-v2') && !a.path.includes('/pricing/preview') && a.status === 200);
  const deadline = Date.now() + 45000;
  let sheet = false;
  while (Date.now() < deadline) {
    if (saved()) break;
    if (await page.locator('[data-v2-review]').count()) {
      sheet = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  if (sheet) {
    await settle(page, 600);
    await shot(page, `${tag}-review-sheet`, false);
    const large = page.locator('[data-v2-review-large]');
    if (await large.count()) await large.first().check();
    await page.locator('[data-v2-review-confirm]').first().click();
    const until = Date.now() + 45000;
    while (Date.now() < until && !saved()) await page.waitForTimeout(250);
  }
  await settle(page, 1500);
  const ok = saved();
  if (!ok) {
    await shot(page, `${tag}-save-refused`);
    const saves = who.answers.slice(mark).filter((a) => a.method !== 'GET').map((a) => `${a.method} ${a.path} ${a.status} ${a.text.slice(0, 600)}`);
    const bar = await page.locator('[data-form="save-bar"]').first().innerText().catch(() => '');
    throw new Error(`«نشر» did not save: ${JSON.stringify({ saves, bar: bar.slice(0, 600) })}`);
  }
  let priced = null;
  try {
    priced = JSON.parse(ok.text)?.pricing_v2?.priced ?? null;
  } catch {
    priced = null;
  }
  return { sheet, priced, requests: who.answers.slice(mark).filter((a) => a.method !== 'GET').map((a) => `${a.method} ${a.path} ${a.status}`) };
}

// ================================================================== run
const failHard = (e) => {
  results.failures.push(`[${current}] crashed: ${e?.stack ?? e}`);
  console.error(e);
};
try {
  // ---------------------------------------------------------------- setup: 0188 → old catalogue → 0189 + 0190
  current = 'setup';
  dbFile = initLocalD1();
  {
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA foreign_keys = ON');
    const before = applyMigrations(db, (f) => migrationNo(f) <= 188);
    check('the database stands at migration 0188 (the live schema before the release)', before.at(-1)?.startsWith('0188'), before.at(-1));
    seedBeforeCutOver(db);
    const cut = applyMigrations(db, () => true);
    check('the release applies exactly 0189 and 0190 (the cut-over)', JSON.stringify(cut) === JSON.stringify(['0189_pricing_v2_core.sql', '0190_pricing_v2_clean_start.sql']), cut);
    db.close();
  }
  await seedPictures();
  const snap = one('SELECT reason, payload_json FROM pricing_legacy_snapshots WHERE product_id = ?', A.id);
  check('0190 archived the printer’s old values in one invisible row (reason clean_start)', snap?.reason === 'clean_start' && snap.payload_json.includes(String(LEGACY.priceA)) && snap.payload_json.includes(String(LEGACY.costA)));
  check('…and the filament’s', one('SELECT COUNT(*) AS n FROM pricing_legacy_snapshots WHERE product_id = ?', B.id)?.n === 1);
  check('no product row was mass-updated: the printer is still `active` with its old row', one('SELECT status, price_iqd FROM products WHERE id = ?', A.id)?.status === 'active');

  await startDev();
  check('wrangler dev answers on 127.0.0.1', true, BASE);

  // ---------------------------------------------------------------- 1. the cut-over: hidden and unpurchasable
  current = '1-cutover';
  {
    const guest = await session(null);
    const list = await guest.api('GET', '/api/products?limit=50');
    check('the listing answers', list.status === 200, list.status);
    check('the listing does not name the printer or the filament', !list.text.includes(A.id) && !list.text.includes(A.slug) && !list.text.includes(B.slug));
    const search = await guest.api('GET', `/api/products?search=${encodeURIComponent('E2E CS')}`);
    check('search finds neither', search.status === 200 && !search.text.includes(A.slug) && !search.text.includes(B.slug), search.status);
    const detail = await guest.api('GET', `/api/products/${A.slug}`);
    check('the product page API answers 404 for the printer', detail.status === 404, detail.status);
    const pub = await guest.api('GET', '/api/public/v1/products?limit=50');
    check('the public API does not list it', pub.status === 200 && !pub.text.includes(A.slug), pub.status);
    const pubOne = await guest.api('GET', `/api/public/v1/products/${A.slug}`);
    check('the public API product read is 404', pubOne.status === 404, pubOne.status);
    const sitemap = await guest.page.request.get(`${BASE}/sitemap.xml`);
    const sm = await sitemap.text();
    check('the sitemap does not carry it', sitemap.status() === 200 && !sm.includes(A.slug), sitemap.status());
    await guest.page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
    await settle(guest.page, 1200);
    check('the /products page does not show it', !(await guest.page.locator('body').innerText()).includes(A.name));
    await shot(guest.page, '1-guest-products');
    await guest.page.goto(`${BASE}/product/${A.slug}`, { waitUntil: 'domcontentloaded' });
    await settle(guest.page, 1200);
    const pageText = await guest.page.locator('body').innerText();
    check('the product page shows no price of it', !pageText.includes('1,250,000') && !pageText.includes('1250000') && !pageText.includes('1,290,000'));
    await shot(guest.page, '1-guest-product-page');
    await guest.ctx.close();

    for (const lang of ['ar', 'en', 'ckb']) {
      const buyer = await session(BUYER, { width: 390, lang });
      const cart = await buyer.api('GET', '/api/cart');
      const un = cart.body?.unavailable_lines ?? [];
      if (lang === 'ar') {
        check('the open cart prices nothing of the hidden line', (cart.body?.items ?? []).length === 0, cart.body?.items);
        check('…and lists it as unavailable, PRODUCT_CURRENTLY_UNAVAILABLE', un.length === 1 && un[0].product_id === A.id && un[0].code === 'PRODUCT_CURRENTLY_UNAVAILABLE', un);
        check('…named in ar, en and real Sorani, with no number', !!un[0]?.name?.ar && !!un[0]?.name?.en && !!un[0]?.name?.ckb && un[0].name.ckb !== un[0].name.ar && !/\d{4,}/.test(JSON.stringify(un)));
        const add = await buyer.api('POST', '/api/cart/items', { productId: A.id, qty: 1, optionValueIds: [A.models[0].id], colorId: A.colours[2].id, fulfillmentType: 'direct_sale' });
        check('adding it to the cart is refused', add.status >= 400 && add.status < 500, { status: add.status, code: add.body?.code });
        const addB = await buyer.api('POST', '/api/cart/items', { productId: B.id, qty: 1, optionValueIds: [B.models[0].id], fulfillmentType: 'direct_sale' });
        check('…and the filament too', addB.status >= 400 && addB.status < 500, { status: addB.status, code: addB.body?.code });
        const addr = await buyer.api('POST', '/api/addresses', { label: 'البيت', name: 'زبون التجربة', phone: '07701234567', address: 'شارع 62', governorate: 'baghdad', area: 'الكرادة', isDefault: true });
        results.address = addr.body?.id ?? addr.body?.address?.id ?? null;
        check('the buyer has an address', !!results.address, addr.text.slice(0, 200));
        const settings = await buyer.api('GET', '/api/settings/public');
        // Store pickup: a printer delivered home needs a wallet advance first (worker/lib/printerAdvance.ts).
        const methods = (settings.body?.settings?.checkoutDeliveryMethods ?? []).filter((m) => m.enabled !== false);
        results.delivery = (methods.find((m) => m.id === 'pickup') ?? methods[0])?.id ?? null;
        const quote = await buyer.api('POST', '/api/orders/quote', { addressId: results.address, deliveryMethodId: results.delivery, paymentMethodId: 'cash' });
        check('the checkout quote refuses cleanly (never a 500, never a price for it)', quote.status >= 400 && quote.status < 500 && !quote.text.includes('1250000'), { status: quote.status, code: quote.body?.code });
      } else {
        check(`the unavailable line reads in ${lang}`, un.length === 1 && !!un[0].name?.[lang]);
      }
      await buyer.page.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded' });
      await settle(buyer.page, 1500);
      const text = await buyer.page.locator('body').innerText();
      check(`the cart page (${lang}) shows the unavailable line without a price`, !text.includes('1,250,000') && !text.includes('1٬250٬000'));
      const line = (un[0]?.name?.[lang] ?? '').trim();
      check(`…in ${lang}: the line is named in the page’s language`, !!line && text.includes(line), line);
      (results.cartText ??= {})[lang] = text.slice(0, 400);
      await shot(buyer.page, `1-cart-unavailable-${lang}-390`);
      await buyer.ctx.close();
    }
  }

  // ---------------------------------------------------------------- 2. the owner prices the printer from cost and publishes
  current = '2-owner';
  {
    const owner = await session(OWNER);
    await owner.page.goto(`${BASE}/admin?tab=products`, { waitUntil: 'domcontentloaded' });
    await settle(owner.page, 1500);
    const badge = owner.page.locator(`[data-needs-pricing-badge="${A.id}"]`);
    check('the products list marks the printer «يحتاج تسعيرًا»', (await badge.count()) > 0 && (await badge.first().innerText()).includes('يحتاج تسعير'));
    check('the banner counts the hidden products', (await owner.page.locator('[data-needs-pricing-banner]').count()) === 1);
    await shot(owner.page, '2-owner-products-list');
    await owner.page.goto(`${BASE}/admin?tab=products&view=needs-pricing`, { waitUntil: 'domcontentloaded' });
    await owner.page.locator('[data-needs-pricing-queue]').first().waitFor({ timeout: 20000 });
    await settle(owner.page, 1200);
    check('the queue lists the printer and the filament', (await owner.page.locator(`[data-queue-product="${A.id}"]`).count()) === 1 && (await owner.page.locator(`[data-queue-product="${B.id}"]`).count()) === 1);
    const queueText = await owner.page.locator('[data-needs-pricing-queue]').innerText();
    check('the queue names no old dinar price', !queueText.includes('1,250,000') && !queueText.includes('1250000'));
    await shot(owner.page, '2-owner-queue');
    await owner.page.locator(`[data-queue-open="${A.id}"]`).first().click();
    await owner.page.locator('[data-form="save-bar"]').first().waitFor({ timeout: 30000 });
    await settle(owner.page, 1200);
    await openSection(owner.page, 3);
    await owner.page.locator('[data-form="pricing-v2"]').first().waitFor({ timeout: 20000 });
    await settle(owner.page, 1000);
    const form = owner.page.locator('[data-form="pricing-v2"]').first();
    check('section ٣ says the product is hidden until priced', (await owner.page.locator('[data-v2-hidden]').count()) === 1);
    check('no old dinar price is shown in section ٣', !(await form.innerText()).includes('1,250,000'));
    // From cost.
    const costOption = owner.page.locator('[data-v2-method-option="cost"]').first();
    if (await costOption.count()) await costOption.click();
    await previewLands(owner.page);
    const card = owner.page.locator('[data-v2-card="cost"]').first();
    await card.waitFor({ timeout: 15000 });
    if ((await owner.page.locator('[data-v2-field="supplier"]').count()) === 0) await owner.page.locator('[data-v2-toggle="cost"]').first().click();
    check('the 0181 supplier cost is prefilled (500 USD)', (await owner.page.locator('[data-v2-field="supplier"]').first().inputValue()) === '500');
    check('…and the stock route (CHINA_SEA)', (await owner.page.locator('[data-v2-field="route"]').first().inputValue()) === 'CHINA_SEA');
    // The extra cost per unit (its Money field has no data handle: the card's last input).
    const extras = card.locator('input').last();
    await typeInto(extras, OWNER_ENTRY.extras);
    await typeInto(owner.page.locator('[data-v2-field="min-profit"]').first(), OWNER_ENTRY.minProfit);
    await typeInto(owner.page.locator('[data-v2-field="discount"]').first(), OWNER_ENTRY.discount);
    await previewLands(owner.page);
    await shot(owner.page, '2-owner-section3-from-cost');
    // Section ٥: the Pro model's discount exception and the Red colour's +$2.
    await openSection(owner.page, 5);
    await settle(owner.page, 800);
    const pro = A.models[1].id;
    await owner.page.locator(`[data-v2-field="model-discount:${pro}"]`).first().selectOption('exception');
    await typeInto(owner.page.locator(`[data-v2-field="model-discount-usd:${pro}"]`).first(), OWNER_ENTRY.proDiscount);
    const red = A.colours[2].id;
    await owner.page.locator(`[data-v2-field="colour-price:${red}"]`).first().selectOption('delta');
    await typeInto(owner.page.locator(`[data-v2-field="colour-usd:${red}"]`).first(), OWNER_ENTRY.redDelta);
    await previewLands(owner.page);
    await shot(owner.page, '2-owner-section5-models-colours');
    results.owner_save = await publish(owner, '2-owner');
    check('«نشر» saved the printer with its prices (the preview the owner saw, or the sheet confirmed)', results.owner_save.priced === true, results.owner_save);
    const flag = await owner.api('GET', `/api/admin/products-v2/${A.id}`);
    check('the printer is V2, from cost, published', JSON.stringify(flag.body?.pricing_v2) === JSON.stringify({ v2: true, method: 'cost', needs_pricing: false }), flag.body?.pricing_v2 ?? flag.text.slice(0, 300));
    await shot(owner.page, '2-owner-after-publish');
    const res = rows('SELECT combo_key, channel, final_price_iqd, direct_price_iqd, replacement_cost_iqd, floor FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel', A.id);
    // The report keeps no cost: the prices and the floor only.
    results.printer_results = res.map((r) => ({ combo_key: r.combo_key, channel: r.channel, final_price_iqd: r.final_price_iqd, direct_price_iqd: r.direct_price_iqd, floor: r.floor }));
    const combos = [...new Set(res.map((r) => r.combo_key))];
    check('six SKUs (2 models × 3 colours), each direct and pre-order by sea', combos.length === 6 && res.length === 12, { combos: combos.length, rows: res.length });
    const price = (combo, ch) => res.find((r) => r.combo_key === combo && r.channel === ch)?.final_price_iqd ?? null;
    const comboOf = (m, c) => `o:${m}|c:${c}`;
    let pd = true;
    for (const combo of combos) {
      const d = price(combo, 'direct_sale');
      const p = price(combo, 'pre_order_sea');
      if (!(d && p && p <= d)) pd = false;
    }
    check('every SKU: pre-order P ≤ direct D', pd, results.printer_results);
    const std = A.models[0].id;
    const dBlack = price(comboOf(std, A.colours[0].id), 'direct_sale');
    const dRed = price(comboOf(std, red), 'direct_sale');
    check('Red sells $2 above Black (rounded up to the 1,000 step)', dRed - dBlack >= 2 * U - 1000 && dRed - dBlack <= 2 * U + 1000, { dBlack, dRed });
    const pStd = price(comboOf(std, A.colours[0].id), 'pre_order_sea');
    const pPro = price(comboOf(pro, A.colours[0].id), 'pre_order_sea');
    const dPro = price(comboOf(pro, A.colours[0].id), 'direct_sale');
    check('the Standard pre-order is the product discount ($40) under its direct', dBlack - pStd >= 40 * U - 1000 && dBlack - pStd <= 40 * U + 1000, { dBlack, pStd });
    check('the Pro pre-order follows its own exception ($25)', dPro - pPro >= 25 * U - 1000 && dPro - pPro <= 25 * U + 1000, { dPro, pPro });
    check('no price is a legacy number', !res.some((r) => [LEGACY.priceA, LEGACY.proPrice, LEGACY.redPrice].includes(r.final_price_iqd)));
    check('the old Direct Sale Extra was retired by the first write', one("SELECT COUNT(*) AS n FROM pricing_rules WHERE product_id = ? AND kind = 'direct_sale_extra'", A.id)?.n === 0);
    costFigures = [...new Set(res.map((r) => r.replacement_cost_iqd)), LEGACY.costA, LEGACY.stdCost, LEGACY.proCost, LEGACY.redCost, 800_000];
    await owner.ctx.close();

    // The customer: listed again, final numbers only. A guest's parameterised listing is an edge-cached
    // answer that ages out within s-maxage (120 s; worker/lib/edgePolicy.ts): the signed-in buyer's is
    // built for them, and a guest's listing under a parameter set nobody asked for before is fresh.
    const buyerNow = await session(BUYER);
    const mineList = await buyerNow.api('GET', '/api/products?limit=50');
    check('the printer is listed again (the buyer’s listing)', mineList.text.includes(A.slug));
    check('the filament is still hidden', !mineList.text.includes(B.slug));
    const mineSearch = await buyerNow.api('GET', `/api/products?search=${encodeURIComponent('E2E CS')}`);
    check('search finds it again', mineSearch.text.includes(A.slug));
    await buyerNow.page.goto(`${BASE}/products`, { waitUntil: 'domcontentloaded' });
    await settle(buyerNow.page, 1500);
    const productsText = await buyerNow.page.locator('body').innerText();
    check('the /products page shows it again', productsText.includes(A.name) || productsText.includes('طابعة ليفو التجريبية'));
    await shot(buyerNow.page, '2-buyer-products');
    await buyerNow.ctx.close();
    const guest = await session(null);
    const list = await guest.api('GET', '/api/products?limit=48');
    check('a guest’s fresh listing carries it too', list.text.includes(A.slug));
    const detail = await guest.api('GET', `/api/products/${A.slug}`);
    check('the product page API answers 200', detail.status === 200, detail.status);
    check('the customer answer carries no FINANCIAL_FIELDS key', financialKeys(detail.body).length === 0, financialKeys(detail.body).slice(0, 10));
    check('…no cost figure', figureHits(detail.text, costFigures).length === 0, figureHits(detail.text, costFigures));
    check('…and no dollar figure or rate', !/usd|replacement|minimum_profit|target_profit/i.test(detail.text));
    check('…but the final price of the default SKU', detail.text.includes(String(dBlack)) || detail.text.includes(String(Math.min(...res.map((r) => r.final_price_iqd)))));
    const pub = await guest.api('GET', `/api/public/v1/products/${A.slug}`);
    check('the public API reads it, with no FINANCIAL_FIELDS key', pub.status === 200 && financialKeys(pub.body).length === 0, { status: pub.status, keys: financialKeys(pub.body).slice(0, 5) });
    await guest.page.goto(`${BASE}/product/${A.slug}`, { waitUntil: 'domcontentloaded' });
    await settle(guest.page, 1500);
    const text = await guest.page.locator('body').innerText();
    check('the product page shows the printer', text.includes(A.name) || text.includes('طابعة ليفو التجريبية'));
    check('the page shows no cost figure and no dollar sign', figureHits(text, costFigures).length === 0 && !text.includes('$'), figureHits(text, costFigures));
    const customerAnswers = guest.answers.filter((a) => a.path.startsWith('/api/'));
    const leaked = customerAnswers.flatMap((a) => {
      let b = null;
      try {
        b = JSON.parse(a.text);
      } catch {
        b = null;
      }
      return financialKeys(b).map((k) => `${a.path} ${k}`);
    });
    check('no answer the product page read carries a FINANCIAL_FIELDS key', leaked.length === 0, leaked.slice(0, 10));
    await shot(guest.page, '2-guest-product-page');
    await guest.ctx.close();
  }

  // ---------------------------------------------------------------- 3. a price editor: dollars, never cost
  current = '3-editor';
  {
    const editor = await session(EDITOR);
    await openProductForm(editor.page, A.id);
    check('the printer (from cost): no cost card for an editor', (await editor.page.locator('[data-v2-card="cost"]').count()) === 0);
    check('…no supplier, route or minimum-profit field', (await editor.page.locator('[data-v2-field="supplier"], [data-v2-field="route"], [data-v2-field="min-profit"]').count()) === 0);
    check('…and its prices are the owner’s (read-only notice)', (await editor.page.locator('[data-v2-owner-only]').count()) === 1);
    await openSection(editor.page, 5);
    await settle(editor.page, 600);
    const formText = await editor.page.locator('main, body').first().innerText();
    check('…no cost figure anywhere on the form', figureHits(formText, costFigures).length === 0, figureHits(formText, costFigures));
    await shot(editor.page, '3-editor-printer-cost-first');
    // The filament: priced in dollars by the editor.
    await openProductForm(editor.page, B.id);
    check('the filament (needs pricing): the editor gets the dollar price field', (await editor.page.locator('[data-v2-field="product-usd"]').count()) === 1);
    check('…and no cost card', (await editor.page.locator('[data-v2-card="cost"]').count()) === 0);
    await typeInto(editor.page.locator('[data-v2-field="product-usd"]').first(), EDITOR_ENTRY.usd);
    await typeInto(editor.page.locator('[data-v2-field="discount"]').first(), EDITOR_ENTRY.discount);
    await previewLands(editor.page);
    await openSection(editor.page, 5);
    await settle(editor.page, 600);
    const twoKg = B.models[1].id;
    await editor.page.locator(`[data-v2-field="model-price:${twoKg}"]`).first().selectOption('delta');
    await typeInto(editor.page.locator(`[data-v2-field="model-usd:${twoKg}"]`).first(), EDITOR_ENTRY.twoKgDelta);
    await previewLands(editor.page);
    await shot(editor.page, '3-editor-filament-usd');
    results.editor_save = await publish(editor, '3-editor');
    check('«نشر» saved the filament with its prices', results.editor_save.priced === true, results.editor_save);
    const flag = await editor.api('GET', `/api/admin/products-v2/${B.id}`);
    check('the editor published the filament in dollars', JSON.stringify(flag.body?.pricing_v2) === JSON.stringify({ v2: true, method: 'usd', needs_pricing: false }), flag.body?.pricing_v2 ?? flag.text.slice(0, 300));
    const bRes = rows('SELECT combo_key, channel, final_price_iqd FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel', B.id);
    results.filament_results = bRes;
    const d1 = bRes.find((r) => r.combo_key === `o:${B.models[0].id}` && r.channel === 'direct_sale')?.final_price_iqd;
    const d2 = bRes.find((r) => r.combo_key === `o:${twoKg}` && r.channel === 'direct_sale')?.final_price_iqd;
    check('1 kg sells at $20 × U', d1 === Math.ceil((20 * U) / 1000) * 1000, { d1 });
    check('2 kg sells $15 above it', d2 === Math.ceil((35 * U) / 1000) * 1000, { d2 });
    check('the editor wrote no cost input', one("SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id = ? AND updated_by = ?", B.id, EDITOR.id)?.n === 0);
    const editorLeaks = editor.answers.flatMap((a) => {
      let b = null;
      try {
        b = JSON.parse(a.text);
      } catch {
        b = null;
      }
      return financialKeys(b).map((k) => `${a.method} ${a.path} ${k}`);
    });
    check('no answer the editor received carries a FINANCIAL_FIELDS key', editorLeaks.length === 0, editorLeaks.slice(0, 10));
    const editorFigures = editor.answers.flatMap((a) => figureHits(a.text, costFigures).map((f) => `${a.path} ${f}`));
    check('no answer the editor received carries a cost figure', editorFigures.length === 0, editorFigures.slice(0, 10));
    await editor.ctx.close();
  }

  // ---------------------------------------------------------------- 4. the order line: an estimate, never a legacy cost
  current = '4-order-line';
  {
    const buyer = await session(BUYER);
    // The pre-cut-over cart line is back on sale now; the buyer clears the cart and buys Standard / Red, direct.
    await buyer.api('DELETE', '/api/cart');
    const cartNow = await buyer.api('GET', '/api/cart');
    for (const item of cartNow.body?.items ?? []) await buyer.api('DELETE', `/api/cart/items/${item.id}`);
    await buyer.page.goto(`${BASE}/product/${A.slug}`, { waitUntil: 'domcontentloaded' });
    await settle(buyer.page, 1500);
    const add = await buyer.api('POST', '/api/cart/items', { productId: A.id, qty: 1, optionValueIds: [A.models[0].id], colorId: A.colours[2].id, fulfillmentType: 'direct_sale' });
    check('the printer can be added to the cart again', add.status === 200, { status: add.status, body: add.text.slice(0, 300) });
    await buyer.page.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded' });
    await settle(buyer.page, 1500);
    await shot(buyer.page, '4-cart');
    const quote = await buyer.api('POST', '/api/orders/quote', { addressId: results.address, deliveryMethodId: results.delivery, paymentMethodId: 'cash' });
    check('the quote prices it', quote.status === 200, { status: quote.status, body: quote.text.slice(0, 300) });
    const orderBody = { addressId: results.address, deliveryMethodId: results.delivery, paymentMethodId: 'cash', idempotencyKey: `e2e-cs-${Date.now()}`, printerStandardDeliveryAcceptance: { accepted: true, version: 1 } };
    // The checkout's two consents, at the versions the policies page publishes (as the checkout page sends them).
    const policies = await buyer.api('GET', '/api/policies');
    const docs = policies.body?.policies ?? policies.body?.documents ?? policies.body?.items ?? [];
    orderBody.policyAcceptance = (Array.isArray(docs) ? docs : Object.values(docs)).filter((d) => d && (d.key === 'terms' || d.key === 'privacy')).map((d) => ({ key: d.key, version: Number(d.version) }));
    const placed = await buyer.api('POST', '/api/orders', orderBody);
    const orderId = placed.body?.order?.id ?? placed.body?.id ?? placed.body?.orderId ?? null;
    check('the order is placed', placed.status === 200 && !!orderId, { status: placed.status, body: placed.text.slice(0, 400) });
    if (orderId) {
      results.order_id = orderId;
      const line = one('SELECT id, product_id, unit_price_iqd, cost_iqd, cost_basis, estimated_cost_iqd, estimated_cost_usd, estimated_usd_iqd_rate, estimated_fx_version FROM order_items WHERE order_id = ?', orderId);
      const r = one("SELECT replacement_cost_iqd, usd_iqd_rate, usd_fx_version FROM pricing_v2_sku_results WHERE product_id = ? AND combo_key = ? AND channel = 'direct_sale'", A.id, `o:${A.models[0].id}|c:${A.colours[2].id}`);
      check('the line records no confirmed cost (cost NULL, basis `unpriced`)', line?.cost_iqd === null && line?.cost_basis === 'unpriced', { cost_iqd: line?.cost_iqd, cost_basis: line?.cost_basis });
      check('the line carries the frozen V2 estimate: R of the direct channel', !!r && line?.estimated_cost_iqd === r.replacement_cost_iqd);
      check('…at the rate and version it was computed at', line?.estimated_usd_iqd_rate === r?.usd_iqd_rate && line?.estimated_fx_version === r?.usd_fx_version && Number(line?.estimated_fx_version) > 0);
      check('…with its dollar value', typeof line?.estimated_cost_usd === 'string' && Number(line.estimated_cost_usd) > 0);
      check('the estimate is never a legacy cost cell', ![LEGACY.costA, LEGACY.stdCost, LEGACY.redCost, LEGACY.proCost].includes(line?.estimated_cost_iqd));
      results.order_line = { cost_iqd: line?.cost_iqd, cost_basis: line?.cost_basis, estimate_is_R_direct: line?.estimated_cost_iqd === r?.replacement_cost_iqd, estimated_fx_version: line?.estimated_fx_version };
      const mine = await buyer.api('GET', `/api/orders/${orderId}`);
      check('the customer’s order answer carries no estimate and no FINANCIAL_FIELDS key', mine.status === 200 && financialKeys(mine.body).length === 0 && !mine.text.includes('estimated_cost'), { status: mine.status, keys: financialKeys(mine.body).slice(0, 5) });
      check('…and no cost figure', figureHits(mine.text, costFigures).length === 0, figureHits(mine.text, costFigures));
      await buyer.page.goto(`${BASE}/orders/${orderId}`, { waitUntil: 'domcontentloaded' });
      await settle(buyer.page, 1500);
      await shot(buyer.page, '4-customer-order');
    }
    await buyer.ctx.close();
    if (orderId) {
      const owner = await session(OWNER);
      const view = await owner.api('GET', `/api/admin/orders/${orderId}`);
      check('the owner’s order view answers', view.status === 200, view.status);
      // The finance workspace's order (calculateGoods): FIFO → linked batch → the frozen estimate → unknown.
      const fin = await owner.api('GET', `/api/admin/finance-workspace/orders/${encodeURIComponent(orderId)}`);
      const confidences = [...fin.text.matchAll(/"cost_confidence":"([a-z_]+)"/g)].map((m) => m[1]);
      results.owner_finance_confidence = confidences;
      check('the owner’s finance order reads the line as an ESTIMATE (cost_confidence `estimated`, never confirmed)', fin.status === 200 && confidences.includes('estimated') && !confidences.includes('fifo'), { status: fin.status, confidences });
      await owner.page.goto(`${BASE}/admin?tab=orders`, { waitUntil: 'domcontentloaded' });
      await settle(owner.page, 1500);
      await shot(owner.page, '4-owner-orders');
      await owner.ctx.close();
    }
  }

  // ---------------------------------------------------------------- 5. D1: «إضافة مخزون موجود» → a pending review → the owner applies it
  current = '5-purchase-review';
  {
    const owner = await session(OWNER);
    const priceRows = () => rows('SELECT combo_key, channel, final_price_iqd FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel', A.id);
    const before = priceRows();
    const redStd = `o:${A.models[0].id}|c:${A.colours[2].id}`;
    const sel = await owner.api('GET', `/api/admin/procurement/selections/${A.id}`);
    const selections = sel.body?.selections ?? [];
    const pick = selections.find((x) => x.scope === 'variant' && x.scope_id === `${A.id}_v2`);
    check('the purchase screen offers the Standard / Red stock identity', !!pick, selections.map((x) => `${x.scope}:${x.scope_id}`));
    const purchase = {
      operation_id: `op_e2e_${Date.now()}`,
      invoice_no: 'شحنة تجربة البداية الجديدة',
      currency: 'USD',
      exchange_rate: U,
      status: 'ordered',
      cost_state: 'final',
      lines: [{ product_id: A.id, scope: pick?.scope ?? 'variant', scope_id: pick?.scope_id ?? `${A.id}_v2`, qty_ordered: 3, invoiced_qty: 3, source_unit_amount: 520, weight_g: 9000, volume_mm3: 520 * 600 * 480 }],
      charges: [],
    };
    const saved = await owner.api('POST', '/api/admin/procurement/documents', purchase);
    check('the stock purchase is confirmed', saved.status === 200 && !!saved.body?.id, { status: saved.status, body: saved.text.slice(0, 300) });
    const pid = saved.body?.id;
    if (pid) {
      const review = one("SELECT id, state FROM pricing_v2_purchase_reviews WHERE product_id = ? AND purchase_id = ?", A.id, pid);
      check('the confirm wrote one pending price review for the printer', review?.state === 'pending');
      check('…and moved no price', JSON.stringify(priceRows()) === JSON.stringify(before));
      const doc = await owner.api('GET', `/api/admin/procurement/documents/${pid}`);
      check('the purchase document names the product whose review waits (ids and states only)', JSON.stringify(doc.body?.price_reviews) === JSON.stringify([{ product_id: A.id, state: 'pending' }]), doc.body?.price_reviews);
      const lineId = doc.body?.lines?.[0]?.line_id;
      const received = await owner.api('POST', `/api/admin/procurement/documents/${pid}/receive`, { operation_id: `rc_e2e_${Date.now()}`, lines: [{ line_id: lineId, qty: 3, rejected_qty: 0 }] });
      check('«إضافة مخزون موجود»: the stock is received with the review still pending (no price write in that flow)', received.status === 200 && one('SELECT state FROM pricing_v2_purchase_reviews WHERE id = ?', review?.id)?.state === 'pending', { status: received.status, body: received.text.slice(0, 300) });
      check('…and the prices still have not moved', JSON.stringify(priceRows()) === JSON.stringify(before));
      // The editor never reaches the review.
      const editor = await session(EDITOR);
      const denied = await editor.api('GET', `/api/admin/products-v2/${A.id}/purchase-review`);
      check('a price editor is refused the review (COST_ACCESS_DENIED)', denied.status === 403 && denied.body?.code === 'COST_ACCESS_DENIED', { status: denied.status, code: denied.body?.code });
      await editor.ctx.close();
      // The owner reviews it from the product's section ٣.
      await openProductForm(owner.page, A.id);
      const card = owner.page.locator(`[data-v2-purchase-review="${review?.id}"]`).first();
      await card.waitFor({ timeout: 20000 }).catch(() => {});
      check('section ٣ shows «● تكلفة شراء جديدة بانتظار مراجعتك»', (await card.count()) === 1 && (await card.innerText()).includes('تكلفة شراء جديدة بانتظار مراجعتك'));
      await owner.page.locator('[data-v2-purchase-review-action="preview"]').first().click();
      await owner.page.locator('[data-v2-purchase-review-preview]').first().waitFor({ timeout: 20000 });
      await settle(owner.page, 800);
      const sheet = await card.innerText();
      check('the review lists the changed prices with readable channel names', /مباشر|البيع المباشر/.test(sheet) && !sheet.includes('direct_sale'), sheet.slice(0, 300));
      await shot(owner.page, '5-owner-purchase-review');
      const tick = owner.page.locator('[data-v2-purchase-review-large]');
      if (await tick.count()) await tick.first().check();
      await owner.page.locator('[data-v2-purchase-review-action="apply"]').first().click();
      const until = Date.now() + 30000;
      while (Date.now() < until && one('SELECT state FROM pricing_v2_purchase_reviews WHERE id = ?', review?.id)?.state === 'pending') await owner.page.waitForTimeout(300);
      await settle(owner.page, 1200);
      await shot(owner.page, '5-owner-after-apply');
      check('the review is applied', one('SELECT state FROM pricing_v2_purchase_reviews WHERE id = ?', review?.id)?.state === 'applied');
      // A variant line feeds its model's level (the procurement rule, worker/lib/pricingEngine/fromPurchase.ts) and its
      // own SKU level only where that differs from what it inherits.
      const input = one("SELECT scope, scope_id, supplier_cost_amount, source_ref FROM pricing_inputs WHERE product_id = ? AND source_ref = ?", A.id, `purchase:${pid}`);
      check('the purchase is now the Standard model’s current cost input (source purchase:<id>)', !!input && input.scope === 'option' && input.scope_id === A.models[0].id && input.supplier_cost_amount === '520', input);
      const after = priceRows();
      const at = (list, combo, ch) => list.find((r) => r.combo_key === combo && r.channel === ch)?.final_price_iqd ?? null;
      const dMove = at(after, redStd, 'direct_sale') - at(before, redStd, 'direct_sale');
      check('from cost: Standard / Red’s direct price moved by the new R (+$20 × U)', Math.abs(dMove - 20 * U) <= 1000, { dMove });
      const gapBefore = at(before, redStd, 'direct_sale') - at(before, redStd, 'pre_order_sea');
      const gapAfter = at(after, redStd, 'direct_sale') - at(after, redStd, 'pre_order_sea');
      check('the pre-order follows by its discount (the gap D − P is unchanged)', Math.abs(gapAfter - gapBefore) <= 1000, { gapBefore, gapAfter });
      const std = after.filter((r) => r.combo_key.startsWith(`o:${A.models[0].id}|`));
      check('every Standard SKU moved by the same new R (both channels)', std.length === 6 && std.every((r) => Math.abs(r.final_price_iqd - at(before, r.combo_key, r.channel) - 20 * U) <= 1000));
      const pro = after.filter((r) => r.combo_key.startsWith(`o:${A.models[1].id}|`));
      check('the Pro model kept every price', pro.length === 6 && pro.every((r) => at(before, r.combo_key, r.channel) === r.final_price_iqd));
      results.purchase_review = { dMove, gapBefore, gapAfter };
    }
    await owner.ctx.close();
  }
} catch (e) {
  failHard(e);
} finally {
  current = 'teardown';
  check('no request left the local host', results.blocked.length === 0, results.blocked.slice(0, 10));
  check('no page error', results.page_errors.length === 0, results.page_errors.slice(0, 10));
  await browser.close().catch(() => {});
  stopDev();
  results.finished_at = new Date().toISOString();
  results.checks = checks;
  results.passed = checks - results.failures.filter((f) => !f.includes('crashed:')).length;
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${results.failures.length ? 'FAILED' : 'PASSED'}: ${checks} checks, ${results.failures.length} failures. Results: ${join(OUT, 'results.json')}`);
  process.exitCode = results.failures.length ? 1 : 0;
}
