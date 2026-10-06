#!/usr/bin/env node
/**
 * A REAL local Levonis for the owner's two acceptance scenarios (§23 of the
 * 2026-10-06 brief, docs/GIFTS_QUICK_BUY.md §5):
 * the Worker under `wrangler dev`, local D1 migrated from migrations/, crons
 * reachable through /__scheduled, and seed data written with SQL.
 *
 *   npm run build                                       (dist/ must be current)
 *   node scripts/acceptance/stack.mjs reset .           wipe state, migrate, seed
 *   node scripts/acceptance/stack.mjs start .           wrangler dev on 127.0.0.1:8787
 *   node scripts/acceptance/quick-buy-api.mjs .         scenario 1 over HTTP
 *   node scripts/acceptance/quick-buy-ui.mjs .          scenario 1 in Chromium (fresh state)
 *   node scripts/acceptance/gifts-api.mjs .             scenario 2 over HTTP
 *   node scripts/acceptance/gifts-ui.mjs .              scenario 2 in Chromium
 *
 * The UI scripts need Playwright: PLAYWRIGHT_MODULE=<path to playwright> and,
 * optionally, CHROMIUM_PATH. Each scenario expects a fresh `reset` (the API and
 * the UI run of scenario 1 both activate the same customer).
 *
 * The minute cron is driven through wrangler's own scheduled handler,
 * /cdn-cgi/handler/scheduled — NOT /__scheduled, which the SPA asset
 * fallback answers before the Worker ever sees it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
/** Beside every other local wrangler state (.wrangler/ is ignored by git). */
export const STATE = join(HERE, '..', '..', '.wrangler', 'acceptance-state');
export const PORT = 8787;
export const BASE = `http://127.0.0.1:${PORT}`;
export const RATE = 1400;
export const TOKENS = { owner: 'e2e-owner-token-0001', sara: 'e2e-sara-token-0001' };
export const OWNER_EMAIL = 'owner@levonis.test';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const cents = (iqd) => Math.ceil((iqd * 100) / RATE);

const wrangler = (repo, args, opts = {}) =>
  execFileSync(join(repo, 'node_modules/.bin/wrangler'), args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });

export function sql(repo, statement) {
  const out = wrangler(repo, ['d1', 'execute', 'levonis-db', '--local', '--persist-to', STATE, '--json', '--command', statement]);
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? [];
}

function seedSql() {
  const later = '2027-12-31T00:00:00.000Z';
  return `
INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('exchangeRate', '${RATE}');
INSERT INTO users (id, email, username, name, password_hash, role, locale) VALUES
  ('u_owner', '${OWNER_EMAIL}', 'owner', 'مالك ليفونيس', 'x', 'admin', 'ar'),
  ('u_sara', 'sara@levonis.test', 'sara', 'سارة', 'x', 'customer', 'ar');
INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES
  ('${sha(TOKENS.owner)}', 'u_owner', '${later}', 'e2e'),
  ('${sha(TOKENS.sara)}', 'u_sara', '${later}', 'e2e');
INSERT INTO addresses (id, user_id, label, name, phone, address, landmark, is_default, governorate, area) VALUES
  ('addr_home', 'u_sara', 'البيت', 'سارة', '+9647701234567', 'الكرادة، شارع 12', 'قرب الجسر', 1, 'Baghdad', 'Karrada'),
  ('addr_work', 'u_sara', 'العمل', 'سارة', '+9647701234567', 'المنصور، شارع 3', '', 0, 'Baghdad', 'Mansour');
INSERT INTO products (id, slug, name, name_ar, price_iqd, status, stock, options, colors, selling_type, sale_types, preorder_transports, images, category_id, sub_category_id, sku) VALUES
  ('p_e2e_printer', 'e2e-a1-combo', 'Bambu Lab A1 Combo', 'طابعة Bambu Lab A1 كومبو', 600000, 'active', 3, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]', 'cat_printers', 'cat_printers_fdm', 'E2E-A1C'),
  ('p_e2e_pla', 'e2e-pla-basic', 'PLA Basic 1 kg', 'فيلامنت PLA أساسي 1 كغم', 25000, 'active', 10, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]', 'cat_materials', 'cat_materials_fdm', 'E2E-PLA'),
  ('p_e2e_nozzle', 'e2e-hardened-nozzle', 'Hardened Nozzle 0.4', 'فوهة مقساة 0.4', 40000, 'active', 4, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]', NULL, NULL, 'E2E-NZ4'),
  ('p_e2e_plate', 'e2e-pei-plate', 'Textured PEI Plate', 'لوح PEI محبب', 60000, 'active', 4, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '[]', NULL, NULL, 'E2E-PEI');
INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES
  ('p_e2e_printer', 'cat_printers_fdm', 9001), ('p_e2e_pla', 'cat_materials_fdm', 9001);
INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by) VALUES
  ('wt_e2e_fund', 'u_sara', 'deposit', 'USD', ${cents(2_000_000)}, 'approved', 'E2E top-up', '', 'admin');
`;
}

export function reset(repo) {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  process.stdout.write(wrangler(repo, ['d1', 'migrations', 'apply', 'levonis-db', '--local', '--persist-to', STATE], { env: { ...process.env, CI: '1' } }).split('\n').slice(-4).join('\n') + '\n');
  const file = join(STATE, 'seed.sql');
  writeFileSync(file, seedSql());
  wrangler(repo, ['d1', 'execute', 'levonis-db', '--local', '--persist-to', STATE, '--file', file]);
  console.log('seeded:', JSON.stringify(sql(repo, "SELECT COUNT(*) AS products FROM products WHERE id LIKE 'p_e2e_%'")));
}

export function start(repo) {
  const child = spawn(join(repo, 'node_modules/.bin/wrangler'), [
    'dev', '--local', '--persist-to', STATE, '--ip', '127.0.0.1', '--port', String(PORT), '--test-scheduled',
    '--var', `INITIAL_ADMIN_EMAIL:${OWNER_EMAIL}`, '--show-interactive-dev-session=false',
  ], { cwd: repo, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, repo, extra] = process.argv.slice(2);
  if (cmd === 'reset') reset(repo);
  else if (cmd === 'start') start(repo);
  else if (cmd === 'sql') console.log(JSON.stringify(sql(repo, extra), null, 2));
  else { console.error('usage: stack.mjs reset|start|sql <repo> [sql]'); process.exit(2); }
}
