/**
 * The client half of «حاسبة الأسعار: خيار الرابط … تغيير الطابعة لا يغيّر
 * السعر», read as source the way the other client suites here do it. Each
 * assertion names the owner-visible behaviour it holds in place; the server
 * half is tests/printQuoteLinkAndPrinters.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

test('the calculator has a link input that posts to the guest link door', () => {
  const tools = read('src/pages/Tools.tsx');
  const api = read('src/components/tools/linkQuoteApi.ts');
  assert.match(api, /api\.post<LinkQuoteResponse>\('\/api\/print-quote\/link'/);
  assert.match(tools, /quoteByLink\(\{ url, printer_model_id: printerId, material_id: materialId \}\)/);
  assert.match(tools, /id="tools-link"/);
  // The label exists in all three languages.
  for (const label of ['أو الصق رابط المجسم', 'or paste a model link', 'یان بەستەری مۆدێل دابنێ']) {
    assert.ok(tools.includes(label), label);
  }
  // A busy spinner while it asks.
  assert.match(tools, /linkBusy \? <Loader2/);
});

test('an unresolved link names the site and model and offers download-and-upload, and a request only while open', () => {
  const tools = read('src/pages/Tools.tsx');
  const block = tools.slice(tools.indexOf('data-link-unresolved'), tools.indexOf('data-link-priced'));
  assert.match(block, /s\.linkUnresolved\(providerName\(linkResult\.link\.provider, linkResult\.link\.host\), linkResult\.link\.external_id\)/);
  assert.match(block, /href=\{linkResult\.link\.canonical_url\}/);
  assert.match(block, /fileInput\.current\?\.click\(\)/);
  // The request action is conditional on the community being open to this
  // viewer, and carries the link in router state.
  assert.match(block, /\{!requestsClosed && \(/);
  assert.match(block, /sendLinkAsRequest\(linkResult\.link\.canonical_url\)/);
  // A signed-in customer carries the link in router state; a guest signs in
  // first and carries it in ?link= (communityGate.test.ts pins that half).
  assert.match(tools, /if \(user\) navigate\('\/requests', \{ state: \{ printLink: url \} \}\);/);
  assert.match(tools, /const requestsClosed = communityAccess\?\.may_enter === false;/);
});

test('the calculator\'s «send a print request» step disappears while the community is shut', () => {
  const tools = read('src/pages/Tools.tsx');
  assert.match(tools, /\{quote && !requestsClosed && \(/);
});

test('the wizard opens on the link source with the carried link, and checks it', () => {
  const wizard = read('src/components/print/PrintRequestWizard.tsx');
  assert.match(wizard, /initialLink\?: string;/);
  const effect = wizard.slice(wizard.indexOf('const initialLinkTaken'), wizard.indexOf('// ------------------------------------------------------- create + measure'));
  assert.match(effect, /setSource\('link'\)/);
  assert.match(effect, /setLinkUrl\(initialLink\.trim\(\)\)/);
  assert.match(effect, /checkLink\(initialLink\.trim\(\)\)/);
  // The button no longer hands its click event to checkLink as a URL.
  assert.match(wizard, /onClick=\{\(\) => void checkLink\(\)\}/);

  const requests = read('src/pages/Requests.tsx');
  assert.match(requests, /printLink/);
  assert.match(requests, /initialLink=\{carriedLink \|\| undefined\}/);
  assert.match(requests, /carriedLink && user \? 'new' : 'board'/);
});

test('a second file dropped mid-upload cannot price the wrong model', () => {
  const tools = read('src/pages/Tools.tsx');
  const pick = tools.slice(tools.indexOf('const pickSeq'), tools.indexOf('const calculate'));
  assert.match(pick, /const seq = \+\+pickSeq\.current;/);
  assert.match(pick, /if \(seq === pickSeq\.current\) setAnalysisId\(up\.analysis_id\)/);
  assert.match(pick, /if \(seq === pickSeq\.current\) setStage\('idle'\)/);
  // The drop target is shut while busy.
  const drop = tools.slice(tools.indexOf('onDrop={(e) => {'), tools.indexOf('onDrop={(e) => {') + 200);
  assert.match(drop, /if \(busy\) return;/);
  // A new analysis clears whatever was priced for the last one.
  assert.match(tools, /useEffect\(\(\) => \{\s*invalidate\(\);\s*\}, \[analysisId, invalidate\]\);/);
});

test('a printer change re-prices at once and shows the previous printer\'s figure for the same job', () => {
  const tools = read('src/pages/Tools.tsx');
  assert.match(tools, /setComparison\(\{ name: printer\.model, price: quote\.price_iqd, jobKey \}\);\s*setAutoRecalc\(true\);/);
  assert.match(tools, /comparison && comparison\.jobKey === jobKey/);
  assert.match(tools, /if \(!autoRecalc \|\| busy \|\| !analysisId \|\| !printerId\) return;/);
});

test('the screen says when the printer genuinely cannot move the price — from the Worker\'s groups, never guessed', () => {
  const tools = read('src/pages/Tools.tsx');
  assert.match(tools, /p\.price_group === printer\.price_group/);
  assert.match(tools, /if \(!printer\?\.price_group \|\| quantity !== 1\) return '';/);
  assert.match(tools, /data-printer-honesty/);
  const grams = read('src/components/tools/GramsQuotePanel.tsx');
  assert.match(grams, /statedMinutes === 0 &&/);
  assert.match(grams, /p\.untimed_price_group === printers\[0\]\.untimed_price_group/);
  assert.match(grams, /بدون زمن الطباعة لا تغيّر الطابعة هذا السعر/);
});

test('the admin editor is mounted under print pricing and writes the audited route', () => {
  const admin = read('src/components/adminCommunity/PrintPricingAdmin.tsx');
  assert.match(admin, /\{tab === 'printers' && <PrinterModelsEditor t=\{t\} \/>\}/);
  const editor = read('src/components/adminCommunity/PrinterModelsEditor.tsx');
  assert.match(editor, /api\.get<ListResponse & \{ success: boolean \}>\('\/api\/admin\/print-quote\/printer-models'\)/);
  assert.match(editor, /api\.patch\(`\/api\/admin\/print-quote\/printer-models\/\$\{encodeURIComponent\(m\.id\)\}`, body\)/);
  // An emptied box is sent as null ("not recorded"), never as 0.
  assert.match(editor, /out\[f\.column\] = typed === '' \? null : Number\(typed\);/);
  const index = read('worker/index.ts');
  assert.match(index, /app\.route\('\/api\/admin\/print-quote', adminPrintQuoteRoutes\);/);
});
