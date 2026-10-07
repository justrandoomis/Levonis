/**
 * THE CLIENT HIDES COST SCREENS ON THE SERVER'S HINT, FAIL-CLOSED — owner
 * decision 2, security spec §6 items 2–5, master plan C16, step S1.
 *
 * Every screen that used to ask `can_view_financials !== false` let
 * `undefined` through — an older session payload, a failed field — and showed
 * the finance tab, the cost inputs and the rounding tool to whoever was
 * signed in. Each now reads the server hint that matches what it shows, with
 * `=== true`, so a missing hint HIDES:
 *
 *   finance tab, investors, inventory cost tabs, product cost fields  can_view_cost
 *   rounding drift, Telegram approvers, appointing admins             can_move_money
 *   «منح صلاحية كاملة (بلا تكاليف)»                                    is_owner
 *
 * The server refuses regardless; this pins that the UI never offers what the
 * server would refuse, and never shows what it would strip.
 *
 * Run: node --import tsx --test tests/costClientHints.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { codeOf, sourceOf } from './fixtures/source';

const SCREENS = {
  admin: 'src/pages/Admin.tsx',
  legacyInvest: 'src/pages/LegacyInvestmentRedirect.tsx',
  productForm: 'src/components/adminProducts/ProductForm.tsx',
  rounding: 'src/components/adminWallet/RoundingDriftTool.tsx',
  telegram: 'src/components/adminUsers/TelegramIdentities.tsx',
  assistant: 'src/components/adminUsers/AssistantAccess.tsx',
  inventory: 'src/components/adminInventory/AdminInventory.tsx',
  users: 'src/components/AdminUsers.tsx',
  printPricing: 'src/components/adminCommunity/PrintPricingAdmin.tsx',
  receiving: 'src/components/adminOperations/PurchaseReceivePanel.tsx',
  settings: 'src/pages/Settings.tsx',
} as const;

test('no screen decides anything from the legacy `can_view_financials` hint any more', () => {
  for (const file of Object.values(SCREENS)) {
    assert.doesNotMatch(codeOf(file), /can_view_financials/, file);
  }
});

test('no hint is read fail-open (`!== false` or `=== false`, where undefined would pass)', () => {
  for (const file of Object.values(SCREENS)) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /(is_owner|can_view_cost|can_write_cost|can_move_money)\s*!==\s*false/, `${file}: fail-open`);
    assert.doesNotMatch(code, /(is_owner|can_view_cost|can_write_cost|can_move_money)\s*===\s*false/, `${file}: fail-open`);
  }
});

test('the finance tab is the owner’s: can_view_cost === true, and the tab body is gated as well as the sidebar', () => {
  const code = codeOf(SCREENS.admin);
  assert.match(code, /const canSeeFinance = user\?\.can_view_cost === true;/);
  assert.match(code, /\.\.\.\(canSeeFinance\s*\?\s*\[\{ id: 'finance'/);
  assert.match(code, /activeTab === 'finance' && canSeeFinance &&/);
});

test('the legacy investment link sends only the owner to the investors section', () => {
  const code = codeOf(SCREENS.legacyInvest);
  assert.match(code, /user\.can_view_cost === true/);
  assert.match(code, /admin && ownerCost \? '\/admin\?tab=finance&finance=investors' : '\/earnings'/);
});

test('the product form renders cost inputs for the owner only', () => {
  assert.match(codeOf(SCREENS.productForm), /const canSeeCost = user\?\.can_view_cost === true;/);
});

test('the inventory cost tabs need the hint AND a payload that carries the valuation', () => {
  assert.match(
    codeOf(SCREENS.inventory),
    /const showsCosts = user\?\.can_view_cost === true && overview !== null && 'inventory_value_iqd' in overview;/
  );
});

test('the print-pricing cost tabs (pricing, printers, materials) open for the owner only', () => {
  const code = codeOf(SCREENS.printPricing);
  assert.match(code, /const ownerCost = user\?\.can_view_cost === true;/);
  assert.match(code, /\.filter\(\(s\) => ownerCost \|\| !COST_TABS\.has\(s\.id\)\)/);
  for (const t of ['pricing', 'printers', 'materials']) {
    assert.match(code, new RegExp(`tab === '${t}' && ownerCost &&`), `${t}: the body is gated as well as the tab`);
  }
});

test('every admin but the owner receives a shipment through the cost-free receiving view', () => {
  // The purchase register is the owner's; receiving stays an operations act
  // (SEC §1.2). A full admin's «استلام شحنة» opens PurchaseReceivePanel, which
  // reads /receiving (an allowlist with no price) and never the document,
  // the register or the procurement config.
  const inventory = codeOf(SCREENS.inventory);
  assert.match(inventory, /kind === 'purchase' \|\| kind === 'receive' \? \(showsCosts \? 'procurement' : 'receiving'\)/);
  assert.match(inventory, /tab === 'receiving' && !showsCosts && /);
  const panel = codeOf(SCREENS.receiving);
  assert.match(panel, /`\$\{PROCUREMENT\}\/receiving`/);
  assert.match(panel, /`\$\{PROCUREMENT\}\/receiving\/\$\{encodeURIComponent\(id\)\}`/);
  assert.doesNotMatch(panel, /\/config|documents\?|documents\/\$\{encodeURIComponent\(id\)\}`\)/, 'never the cost routes');
  assert.doesNotMatch(panel, /cost_iqd|purchase_unit|charges_iqd|exchange_rate|localStorage|sessionStorage|indexedDB/);
});

test('the users editor shows the stored scope after a save, offers the investor flag to the owner only, and speaks refusals by code', () => {
  const code = codeOf(SCREENS.users);
  assert.match(code, /const mayFlagInvestor = viewer\?\.is_owner === true;/);
  assert.match(code, /\{mayFlagInvestor && \(/, 'the Investor checkbox is the owner’s');
  assert.match(code, /\.\.\.\(mayFlagInvestor \? \{ is_investor: !!updatedUser\.is_investor \} : \{\}\)/, 'and only the owner sends it');
  assert.match(code, /res && 'admin_scope' in res \? \(res\.admin_scope \?\? null\) : updatedUser\.admin_scope/, 'the scope read back is the one shown');
  assert.match(code, /apiRefusal\(err, lang, err\.message\)/);
});

test('the owner is not offered an email change the server refuses; the reason is said in the reader’s language', () => {
  const code = codeOf(SCREENS.settings);
  assert.match(code, /emailStatus\?\.emailConfigured && user\?\.is_owner === true \?/);
  assert.match(code, /refusalText\('OWNER_EMAIL_LOCKED', lang\)/);
  assert.match(code, /setEmailFormError\(err instanceof ApiError \? apiRefusal\(err, lang, err\.message\) : s\.loadFailed\)/);
});

test('money tools follow can_move_money === true', () => {
  assert.match(codeOf(SCREENS.rounding), /if \(user\?\.can_move_money !== true\) return null;/);
  assert.match(codeOf(SCREENS.telegram), /const mayBind = user\?\.can_move_money === true;/);
  assert.match(codeOf(SCREENS.assistant), /const mayGrant = user\?\.can_move_money === true;/);
});

test('«منح صلاحية كاملة (بلا تكاليف)» is offered to the owner only, explained, and sends the explicit scope', () => {
  const code = codeOf(SCREENS.assistant);
  assert.match(code, /const mayLift = user\?\.is_owner === true;/);
  assert.match(code, /\{isAdmin && isAssistant && mayLift && \(/, 'the lift button is behind is_owner');
  assert.match(code, /\{s\.liftExplains\}/, 'what full access does and does not do is said beside the button');
  assert.match(code, /\{isAdmin && isAssistant && !mayLift && \(/, 'everyone else is told why there is no button');
  assert.match(code, /refusalText\('SCOPE_ELEVATION_OWNER_ONLY', lang\)/);
  assert.match(code, /action === 'lift'\s*\?\s*\{ admin_scope: 'full' \}/);
  assert.match(code, /\{s\.newAdminNote\}/, 'the new-admin notice is on the screen');
  // A refusal is rendered by CODE in the admin's language, not as the raw "ar / en" sentence.
  assert.match(code, /apiRefusal\(err, lang, err\.message\)/);
  // …and the scope shown after a change is the one the server read back (critique G-4).
  assert.match(code, /res && 'admin_scope' in res/);
});

test('the full admin is labelled «كامل (بلا تكاليف)» in all three languages; the new strings carry real Sorani', () => {
  const strings = sourceOf('src/components/adminUsers/strings.ts');
  assert.ok(strings.includes("fullBadge: loc('كامل (بلا تكاليف)', 'Full (no costs)', 'تەواو (بەبێ تێچوون)')"));
  assert.ok(strings.includes("actLift: loc('منح صلاحية كاملة (بلا تكاليف)', 'Give full access (no costs)', 'دەسەڵاتی تەواو بدە (بەبێ تێچوون)')"));
  for (const key of ['liftExplains', 'newAdminNote', 'confirmLift', 'needFinancial']) {
    const m = new RegExp(`${key}: loc\\(\\s*'([^']+)',\\s*'([^']+)',\\s*'([^']+)'\\s*\\)`).exec(strings);
    assert.ok(m, `${key} has ar, en and ckb`);
    const [, ar, en, ckb] = m!;
    assert.notEqual(ckb, ar, `${key}: the Sorani is not the Arabic`);
    assert.notEqual(ckb, en);
    assert.match(ckb!, /[ڕڵێۆەگچپژ]/, `${key}: the ckb carries Sorani letters`);
  }
  // The old promise — full access shows the cost — is gone from every language.
  assert.doesNotMatch(strings, /رؤية التكلفة والربح وكل الأرقام المالية/);
  assert.doesNotMatch(strings, /gives this account the cost, the profit/);
});

test('the users table tells the owner from a full admin', () => {
  const code = codeOf(SCREENS.users);
  assert.match(code, /u\.role === 'admin' && u\.is_owner === true && \(/);
  assert.match(code, /u\.role === 'admin' && u\.is_owner !== true && \(/);
});

test('the session type documents the hints and the legacy alias', () => {
  const api = sourceOf('src/lib/api.ts');
  for (const k of ['is_owner?: boolean;', 'can_view_cost?: boolean;', 'can_write_cost?: boolean;', 'can_move_money?: boolean;', 'can_view_financials?: boolean;']) {
    assert.ok(api.includes(k), k);
  }
});

test('critique G-31: no owner cost screen keeps data in browser storage (localStorage, sessionStorage, IndexedDB)', () => {
  const dirs = ['src/components/adminPricing', 'src/components/adminInventory', 'src/components/financeWorkspace', 'src/components/adminFinance'];
  const files: string[] = [];
  const walk = (d: string) => {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) return;
    for (const n of readdirSync(abs)) {
      const p = join(abs, n);
      if (statSync(p).isDirectory()) walk(relative(ROOT, p));
      else if (/\.(ts|tsx)$/.test(n)) files.push(relative(ROOT, p));
    }
  };
  for (const d of dirs) walk(d);
  assert.ok(files.length > 20, `only ${files.length} owner-screen files scanned`);
  const offenders = files.filter((f) => /\b(localStorage|sessionStorage|indexedDB)\b/.test(codeOf(f)));
  assert.deepEqual(offenders, [], 'a cost screen must not leave cost on the device');
});
