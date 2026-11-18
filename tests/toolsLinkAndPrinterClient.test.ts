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

test('the editor opens with the carried link, and checks it once on arrival', () => {
  // The four-step editor (community UI plan C4, src/components/community/requests/editor/RequestEditor.tsx):
  // the carried link is checked through the server once the blank page is ready, which is the
  // act that makes the draft; the link becomes a link source of step 1.
  const editor = read('src/components/community/requests/editor/RequestEditor.tsx');
  assert.match(editor, /carriedLink: carried = '',/);
  const effect = editor.slice(editor.indexOf('const carriedLink = useRef(false);'), editor.indexOf('// ---------------------------------------------------------------- uploads'));
  assert.match(effect, /const link = arrival\.current\.link;/);
  assert.match(effect, /void addLinkFlowRef\.current\(link\)/);
  assert.match(editor, /const d = await requestsApi\.checkLink\(url\);/, 'checked by the server, never fetched from the browser');

  // The board forwards the carried link to the editor route (community UI plan B4), router state
  // and ?link= both, and the editor page hands it to the editor.
  const requests = read('src/pages/Requests.tsx');
  assert.match(requests, /printLink/);
  assert.match(requests, /carriedLink && user \? 'new' : 'board'/);
  assert.match(requests, /navigate\(newRequestTarget\(params\), \{ replace: true, state: location\.state \}\)/);
  assert.match(read('src/pages/community/RequestNew.tsx'), /<RequestEditor requestId=\{id\} carriedLink=\{carriedLink\}/);
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
  // The owner's alone (decision 2): the tab is offered on can_view_cost === true.
  assert.match(admin, /\{tab === 'printers' && ownerCost && <PrinterModelsEditor t=\{t\} \/>\}/);
  assert.match(admin, /const sessionCost = user\?\.can_view_cost === true;/);
  assert.match(admin, /const ownerCost = sessionCost && costRead;/);
  const editor = read('src/components/adminCommunity/PrinterModelsEditor.tsx');
  assert.match(editor, /api\.get<ListResponse & \{ success: boolean \}>\('\/api\/admin\/print-quote\/printer-models'\)/);
  assert.match(editor, /api\.patch\(`\/api\/admin\/print-quote\/printer-models\/\$\{encodeURIComponent\(m\.id\)\}`, body\)/);
  // An emptied box is sent as null ("not recorded"), never as 0.
  assert.match(editor, /out\[f\.column\] = typed === '' \? null : Number\(typed\);/);
  const index = read('worker/index.ts');
  assert.match(index, /app\.route\('\/api\/admin\/print-quote', adminPrintQuoteRoutes\);/);
});

test('settings reprice by themselves once, after they settle, and never leave a price looking current', () => {
  const tools = read('src/pages/Tools.tsx');
  // One measure call per settled decision (the route allows 40 an hour).
  assert.match(tools, /const t = setTimeout\(\(\) => \{\s*setAutoRecalc\(false\);\s*void calculate\(\);\s*\}, 600\);/);
  // A manual press during the wait IS that reprice: the timer may not repeat it.
  const calc = tools.slice(tools.indexOf('const calculate = useCallback'), tools.indexOf('const busy ='));
  assert.match(calc, /setAutoRecalc\(false\);\s*invalidate\(\);/);
  // The measure and the price land together, so the card does not blink out mid-reprice.
  assert.ok(calc.indexOf('setAnalysis(measured.analysis)') > calc.indexOf('await quoteAnalysis'));
  // The previous answer is shown only while a reprice is pending, dimmed and aria-busy.
  assert.match(tools, /const repricing = !fresh && stale !== null && \(autoRecalc \|\| busy\);/);
  assert.match(tools, /aria-busy=\{repricing\}/);
  // A printer that runs none of the materials cannot leave «updating» on screen.
  assert.match(tools, /if \(!usableMaterials\.length\) \{[\s\S]{0,200}setAutoRecalc\(false\);/);
});

test('a material with no shop price still offers the request its notice tells the customer to send', () => {
  const tools = read('src/pages/Tools.tsx');
  assert.match(tools, /\{quote && quote\.confidence === 'insufficient' && !requestsClosed && \(\s*<button type="button" onClick=\{\(\) => navigate\('\/requests'\)\}/);
});

test('the grams door reprices without closing the keyboard, and never for the same job twice', () => {
  const grams = read('src/components/tools/GramsQuotePanel.tsx');
  // Inputs stay enabled while a price loads; only Calculate waits (the focused box used to blur).
  assert.ok(!/disabled=\{busy/.test(grams), 'a job input is disabled while a price loads');
  // So an answer for a job the form has moved on from is dropped by its ticket.
  assert.match(grams, /if \(seq !== reqSeq\.current\) return;/);
  // A change that leaves the job as it was puts the last answer back, with no call.
  assert.match(grams, /lastAnswer\.current\.sig === jobSig/);
  // Once priced, later changes always reprice — even after clearing a box or a change mid-wait.
  assert.match(grams, /if \(everPriced\.current\) setAutoRecalc\(true\);/);
  // Adding an empty colour row is not a new job.
  const add = grams.slice(grams.indexOf('const addRow'), grams.indexOf('const removeRow'));
  assert.ok(!/invalidate\(\)/.test(add), 'adding an empty row throws the price away');
});
