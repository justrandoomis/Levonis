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
  finance: 'src/components/adminFinance/AdminFinance.tsx',
  verifyCard: 'src/components/auth/OwnerCostVerifyCard.tsx',
  verifyBanner: 'src/components/auth/EmailVerifyBanner.tsx',
} as const;

test('no screen decides anything from the legacy `can_view_financials` hint any more', () => {
  for (const file of Object.values(SCREENS)) {
    assert.doesNotMatch(codeOf(file), /can_view_financials/, file);
  }
});

test('no hint is read fail-open (`!== false` or `=== false`, where undefined would pass)', () => {
  for (const file of Object.values(SCREENS)) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /(is_owner|can_view_cost|can_write_cost|can_move_money|owner_email_unverified)\s*!==\s*false/, `${file}: fail-open`);
    assert.doesNotMatch(code, /(is_owner|can_view_cost|can_write_cost|can_move_money|owner_email_unverified)\s*===\s*false/, `${file}: fail-open`);
  }
});

test('the finance tab is the owner’s: can_view_cost === true, and the tab body is gated as well as the sidebar', () => {
  const code = codeOf(SCREENS.admin);
  assert.match(code, /const canSeeFinance = user\?\.can_view_cost === true;/);
  assert.match(code, /\.\.\.\(canSeeFinance \|\| ownerMustVerify\s*\?\s*\[\{ id: 'finance'/);
  assert.match(code, /activeTab === 'finance' && canSeeFinance &&\s*\(\s*<AdminFinance \/>/);
});

// ------------------------------------------------- DECISIONS row 185 amendment

test('the owner before the address is verified keeps the finance entry, and it opens the verify card — never the finance screen', () => {
  const code = codeOf(SCREENS.admin);
  // The hint, === true, and only when cost is not already open.
  assert.match(code, /const ownerMustVerify = !canSeeFinance && user\?\.owner_email_unverified === true;/);
  assert.match(code, /activeTab === 'finance' && ownerMustVerify && <OwnerCostVerifyCard \/>/);
  // The card never mounts AdminFinance and fetches no cost.
  const card = codeOf(SCREENS.verifyCard);
  assert.doesNotMatch(card, /AdminFinance|\/api\/admin\//, 'the card reads no admin (cost) route');
  assert.doesNotMatch(card, /\b(localStorage|sessionStorage|indexedDB)\b/);
});

test('the card offers ONE primary action into the existing verification flow, and re-reads the session to open cost without a reload', () => {
  const card = codeOf(SCREENS.verifyCard);
  assert.match(card, /api\.post<\{ verified\?: boolean \}>\('\/api\/auth\/verify-email\/send'\)/);
  assert.equal((card.match(/variant="primary"/g) ?? []).length, 1, 'one primary action');
  assert.match(card, /refusalText\('OWNER_EMAIL_UNVERIFIED', lang\)/, 'the body is the refusal contract’s own sentence');
  assert.match(card, /window\.addEventListener\('focus', reread\)/);
  assert.match(card, /document\.addEventListener\('visibilitychange', reread\)/);
  assert.match(card, /await refreshUser\(\)/);
  // The confirm button of the emailed link refreshes the session, so the hints flip at once.
  const banner = codeOf(SCREENS.verifyBanner);
  assert.match(banner, /await api\.post<\{ owner_first_proof\?: unknown \}>\('\/api\/auth\/verify-email\/confirm', \{ token \}\);[\s\S]{0,600}void refreshUser\(\);/);
});

test('the OWNER_EMAIL_UNVERIFIED refusal is rendered BY CODE with the same action; every other 403 keeps "main admin only"', () => {
  const finance = codeOf(SCREENS.finance);
  const byCode = finance.indexOf("error.code === 'OWNER_EMAIL_UNVERIFIED'");
  const generic = finance.indexOf('{s.forbidden}');
  assert.ok(byCode > 0 && generic > byCode, 'the by-code branch comes before the generic refusal');
  assert.match(finance, /error\.code === 'OWNER_EMAIL_UNVERIFIED'\) \{\s*return <OwnerCostVerifyCard \/>;/);
});

test('the finance workspace (the screen AdminFinance opens) renders OWNER_EMAIL_UNVERIFIED by code as the card', () => {
  const ws = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  assert.match(ws, /if \(e instanceof ApiError && e\.code === 'OWNER_EMAIL_UNVERIFIED'\) setMustVerify\(true\);/);
  assert.match(ws, /if \(mustVerify\) return <OwnerCostVerifyCard \/>;/);
});

test('the product form and the inventory show the compact prompt on the hint, === true', () => {
  assert.match(codeOf(SCREENS.productForm), /\{!canSeeCost && user\?\.owner_email_unverified === true && <OwnerCostVerifyCard compact \/>\}/);
  assert.match(codeOf(SCREENS.inventory), /\{user\?\.owner_email_unverified === true && <OwnerCostVerifyCard compact \/>\}/);
});

test('the card speaks ar, en and real Sorani — ckb never the Arabic or the English, cost «تێچوو»', () => {
  const src = sourceOf(SCREENS.verifyCard);
  const block = (lang: string) => {
    const at = src.indexOf(`  ${lang}: {`);
    assert.ok(at > 0, lang);
    // Up to and including the last entry's own newline, so it is read too.
    return src.slice(at, src.indexOf('\n  },', at) + 1);
  };
  // Plain and `(s: number) =>` sentences, and the ones that hold the address
  // as an element (`(e: Email) => (<>…</>)`) — every sentence, not the easy ones.
  const strings = (b: string) => [
    ...[...b.matchAll(/(\w+): (?:\((?:email: string|s: number)\) =>\s*)?[`'](.+?)[`'],?\n/g)].map((m) => [m[1]!, m[2]!] as const),
    ...[...b.matchAll(/(\w+): \(e: Email\) => \(\s*<>\s*([\s\S]+?)\s*<\/>/g)].map((m) => [m[1]!, m[2]!.replace(/\s+/g, ' ')] as const),
  ];
  const ar = new Map(strings(block('ar')));
  const en = new Map(strings(block('en')));
  const ckb = new Map(strings(block('ckb')));
  assert.ok(ckb.size >= 15, `only ${ckb.size} Sorani strings read`);
  for (const k of ['sent', 'notConfigured', 'cooldown', 'resend', 'checkFailed', 'afterSave']) assert.ok(ckb.has(k), `${k} was read`);
  assert.deepEqual([...ckb.keys()].sort(), [...ar.keys()].sort());
  assert.deepEqual([...en.keys()].sort(), [...ar.keys()].sort());
  for (const [k, v] of ckb) {
    assert.notEqual(v, ar.get(k), `${k}: the Sorani is the Arabic`);
    assert.notEqual(v, en.get(k), `${k}: the Sorani is the English`);
    assert.match(v, /[ڕڵێۆەگچپژ]/, `${k}: no Sorani letter`);
    assert.doesNotMatch(v, /[ةىيك]/, `${k}: an Arabic-only letter in the Sorani`);
  }
  assert.match(ckb.get('title')!, /تێچوو/);
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
  assert.match(code, /const sessionCost = user\?\.can_view_cost === true;/);
  // …and only once the cost slices were READ by a session that sees cost: the
  // owner verifying while this screen is open must not be shown the defaults
  // the stripped read filled in (DECISIONS row 185 amendment).
  assert.match(code, /const ownerCost = sessionCost && costRead;/);
  assert.match(code, /if \(!only \|\| only === 'cost'\) setCostRead\(withCost\);/);
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
  for (const k of ['is_owner?: boolean;', 'can_view_cost?: boolean;', 'can_write_cost?: boolean;', 'can_move_money?: boolean;', 'can_view_financials?: boolean;', 'owner_email_unverified?: boolean;']) {
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

// ------------------------------------------------- review of the amendment (2026-10-08)

test('the card never sends the owner to a Google control that does not exist, and says plainly when email cannot be sent', () => {
  const src = sourceOf(SCREENS.verifyCard);
  const strings = src.slice(src.indexOf('const STRINGS = {'), src.indexOf('} as const;'));
  assert.doesNotMatch(strings, /settings|إعدادات|ڕێکخستنەکانی هەژمار/i, 'Settings has no Google link button');
  assert.match(strings, /EMAIL_API_KEY and EMAIL_FROM/, 'the 503 state names what is missing');
  assert.match(strings, /If Google is already connected to/);
  // With no email service the state is known up front, from the status route.
  const card = codeOf(SCREENS.verifyCard);
  assert.match(card, /s\?\.emailConfigured === false\) setState\('not_configured'\)/);
});

test('the card waits a minute between sends, relabels the button «Resend», and says only the newest link works', () => {
  const card = codeOf(SCREENS.verifyCard);
  assert.match(card, /const RESEND_COOLDOWN_S = 60;/);
  assert.match(card, /disabled=\{cooldown > 0\}/);
  assert.match(card, /const sendLabel = sentOnce \? t\.resend : t\.send;/);
  assert.match(sourceOf(SCREENS.verifyCard), /Only the link in the newest email works\./);
});

test('the status line is always in the accessibility tree, so "sent" and "failed" are announced', () => {
  const card = codeOf(SCREENS.verifyCard);
  assert.doesNotMatch(card, /empty:hidden/);
  assert.equal((card.match(/role="status" aria-live="polite" className=\{message \? `[^`]+` : 'sr-only'\}/g) ?? []).length, 2);
});

test('«check now» asks the server and says so when it could not — never "not verified yet" for a failed request', () => {
  const card = codeOf(SCREENS.verifyCard);
  const recheck = card.slice(card.indexOf('const recheck = useCallback'), card.indexOf('const message'));
  assert.match(recheck, /api\.get<VerifyStatus>\('\/api\/auth\/verify-email\/status'\)/);
  assert.match(recheck, /if \(s\?\.verified === true\) \{\s*await refreshUser\(\);/);
  assert.match(recheck, /catch \{\s*setState\('check_failed'\);/);
});

test('the emailed link for the owner’s address says "sign in first" by code, not "invalid link"', () => {
  const banner = codeOf(SCREENS.verifyBanner);
  assert.match(banner, /e\.code === 'VERIFY_SIGN_IN_REQUIRED'\) setConfirmState\('sign_in'\)/);
  assert.match(banner, /refusalText\('VERIFY_SIGN_IN_REQUIRED', lang\)/);
});

test('the product form never shows, or saves, the blanks of a document read without cost', () => {
  const code = codeOf(SCREENS.productForm);
  // Whether the document carried its cost is read from the document itself.
  assert.match(code, /return Object\.prototype\.hasOwnProperty\.call\(product, 'product_cost_iqd'\);/);
  // …and from the relations answer too: both have to carry it (the mixed-read race).
  assert.match(code, /setCostLoaded\(carriesCost\(p\.product\) && relationsCarryCost\(r\)\);/);
  assert.match(code, /if \(res\.product\) setCostLoaded\(carriesCost\(res\.product\) && relationsCarryCost\(fresh\)\);/);
  // Cost inputs need the hint AND a document read with cost.
  assert.match(code, /const costShown = canSeeCost && costLoaded;/);
  assert.match(code, /\{costShown && \(\s*<Field ar="التكلفة" en="Cost"/);
  assert.match(code, /canSeeCost=\{costShown\}/);
  // A save of a document read without cost says so; the server then keeps every stored cost.
  assert.match(code, /\.\.\.\(next\.id && !costLoaded \? \{ cost_loaded: false \} : \{\}\)/);
  // An untouched form re-reads the product once when cost opens; one with edits says the cost comes after the save.
  assert.match(code, /if \(!canSeeCost \|\| costLoaded \|\| !reloadId \|\| loading \|\| dirty\) return;/);
  assert.match(code, /\{canSeeCost && !costLoaded && <CostOpensAfterSave \/>\}/);
});

test('the quick price panel and print pricing: a read without cost is never saved as one, and the prompt shows there too', () => {
  const quick = codeOf('src/components/adminProducts/QuickPricePanel.tsx');
  assert.match(quick, /\.\.\.\(data\.can_view_cost \? \{\} : \{ cost_loaded: false \}\)/);
  assert.match(quick, /\{!data\.can_view_cost && user\?\.owner_email_unverified === true && <OwnerCostVerifyCard compact \/>\}/);
  const print = codeOf(SCREENS.printPricing);
  assert.match(print, /\{user\?\.owner_email_unverified === true && <OwnerCostVerifyCard compact \/>\}/);
  assert.match(print, /if \(only === 'cost'\) return \{ \.\.\.cur, pricing: next\.pricing, materials: next\.materials \};/);
  // The server side of the same rule: a flagged save is written like an assistant's.
  const save = codeOf('worker/routes/adminProducts.ts');
  assert.match(save, /const costBlind = prev !== null && body\.cost_loaded === false;/);
  assert.match(save, /actor: \{ adminId: admin\.id, money: writesCost \}/);
  const cells = codeOf('worker/routes/adminProductRelations.ts');
  assert.match(cells, /if \(!canWriteCost\(c\.env, admin\) \|\| body\.cost_loaded === false\) \{/);
});
