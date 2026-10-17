export const meta = {
  name: 'product-discount',
  description: 'A discount card in the product form: the current Pricing V2 price is the before price, the owner enters the after price in USD or a percent with optional dates; stored as the existing special offer (USD-aware); strikethrough and percent badge on cards and the product page; design, build, adversarial review, fix',
  phases: [
    { title: 'Design', detail: 'one designer' },
    { title: 'Build', detail: 'one builder with tests' },
    { title: 'Review', detail: 'three lenses, two skeptics per finding' },
    { title: 'Fix', detail: 'fix confirmed findings' },
  ],
}

const S = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad'
const SHARED = `${S}/briefs/shared.md`
const WT = '/home/user/levonis-discount'
const OUT = `${S}/discount`

const context = `Read ${SHARED} first: its repository rules bind you (three languages ar/en/ckb with real Sorani; Clay primitives; never push; commits end with its two trailer lines; node_modules are symlinks — never npm install; Chromium at /opt/pw-browsers, playwright at /opt/node22/lib/node_modules/playwright; the parallel-rate key name never appears; no cost value in any log or customer answer). Ignore its Bambu-import task description. Worktree ${WT}, branch feat/product-discount at the live default 0d8ed43b. ADDITIVE MIGRATIONS ONLY, and use migration number 0197 (0196 is reserved by a parallel lane). The live site serves real customers; this ships through CI and workflow 7.
THE OWNER'S REQUEST (Arabic): "Products have no 'price before discount' field to make a discount, e.g. before $600, after $500, shown as a discount." THE OWNER'S DECISION (asked and answered in this session): the product's CURRENT price is the 'before' price automatically; the owner enters the price AFTER the discount (in USD, e.g. $500) or a percent, with optional start/end dates; it is a REAL offer that the cart, the order and the invoice honour; the strikethrough is always honest; in dollars and following the exchange rate.
WHAT EXISTS: the one promotion model "special offers" — offer_windows + offer_limits (migrations/0060_offer_eligibility.sql: offer_price_mode ''|'fixed'|'discount_percent'|'discount_iqd', offer_price_iqd, discount_percent 1..90, discount_iqd, plus_price_iqd, starts_at/ends_at, required_tiers, active), resolved by ONE resolver resolveOfferPrice (grep worker/), administered in src/components/adminOffers/AdminOffers.tsx (the admin «العروض الخاصة» tab) via worker/routes/offers.ts, which refuses OFFER_PRICE_CONFLICT and SCHEDULE_INVERTED; cards strike through only when the viewer's membership or a live offer actually lowers the price (src/components/home/ProductCard.tsx header, CardPrice). Pricing V2 (docs/PRICING-V2.md, worker/lib/pricing/v2/*, pricing_v2_sku_results) prices products in USD per model with colour ± $ and publishes IQD per SKU through the exchange rate; membership discounts (src/components/adminProducts/form/MembershipDiscountSection.tsx); the product form sections live in src/components/adminProducts/form/ and v2/.`

phase('Design')
const design = await agent(`${context}

You are the DESIGNER. Read the code named above and write a precise spec to ${WT}/docs/ux/PRODUCT-DISCOUNT.md (English) for:
1. The discount card in the product form's pricing section (V2): shows the current price per model/variant (the before price, read from what Pricing V2 publishes, in USD and IQD), lets the owner choose «سعر بعد الخصم» in USD (only when one price applies to the whole product — otherwise per model, or refused with a clear sentence) or «نسبة الخصم» (1..90 %), with an optional start and end, active toggle, and shows a live preview of before → after per variant in USD and IQD; saving writes the SAME offer_windows row the special-offers tab writes (subject ('product', id)) through the same server validation, never a second discount path; the special-offers tab and the card show the same row; deleting/ending the discount from either place.
2. USD offers that follow the exchange rate: an additive migration 0197 adding what a USD fixed price needs (e.g. offer_price_mode 'fixed_usd' with offer_price_usd_cents, or a USD discount amount), and the resolver change that converts it with EXACTLY the rate and rounding Pricing V2 uses for that SKU's published price (so before and after use the same rate at the same instant); an older database without 0197 keeps working (presence probe, CLAUDE.md rule 2). The resolver must never yield an after price ≥ the before price (no discount shown then) or below the floor rules that already exist (min_price_iqd, cost guards — check what the offers code enforces and what Pricing V2 enforces: an offer below cost — decide whether to refuse or warn, following the existing rules).
3. Honesty: the strikethrough shows the actual regular price at that moment (the V2 published price for the SKU), with a «−17 %» badge; never a typed before-price. Members' prices and offers: follow the existing precedence (read the resolver) and say how a card shows both.
4. The customer side: the product card, the product page price block, the cart line, checkout and the order/invoice show before/after consistently in ar/en/ckb and IQD (the site's display currency) — reuse the existing strikethrough components; the countdown if an end date exists (reuse what offers already show).
5. Tests to write: server (resolver with fixed_usd across a rate change, refusals, the form endpoint, the order snapshot), UI (the card, the form card), and a real-browser check.
Commit nothing. Final answer: the spec text.`, { label: 'design', phase: 'Design' })

phase('Build')
const build = await agent(`${context}

You are the BUILDER. Implement this spec in ${WT} with tests that fail without each change (real routes and real migrations in node:sqlite worlds; tests/d1Waves.test.ts and bundle budgets must still pass; every money path tested end to end: offer saved in the form → card and page show before/after → cart → checkout → order snapshot and invoice carry the offer price; a rate change moves both before and after). Run a local real-browser check (npm run build + wrangler dev --local, seeded product with a V2 price, a discount saved through the form as an admin) in ar, en and ckb; save screenshots to ${OUT}/shots/ and look at them. Gates: npm run check exits 0; neighbours of every touched module (grep tests/ for offer*, pricing*, v2*, productForm*, adminProduct*, cart*, checkout*, orders*, invoice*, productCard*, claySystem, bundleBudget, motionLazy, d1Waves, rootShardBalance, refusalStrings, programmeRefusals, liveCostProbes, leakAudit*) with exact counts. Commit in small titled commits ("product discount: …"); never push. Final answer: commits, files, tests with counts, screenshot paths, deviations.

THE SPEC:
${design}`, { label: 'build', phase: 'Build' })

const FIND = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, title: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' }, scenario: { type: 'string' }, proof: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'title', 'file', 'scenario', 'proof', 'fix'] } }, summary: { type: 'string' } }, required: ['findings', 'summary'] }
const VERDICT = { type: 'object', properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } }, required: ['refuted', 'reason'] }
const rc = `${context}\n\nYou REVIEW branch feat/product-discount in ${WT} (git diff 0d8ed43b..HEAD; read only; probes under ${OUT}/review-<lens>/). Spec: ${WT}/docs/ux/PRODUCT-DISCOUNT.md. Builder report:\n${build}\nReal defects only, each proven (file:line plus failing probe or screenshot).`
const LENSES = [
  { key: 'money', text: 'LENS: MONEY. The price a customer is charged equals the price shown, on every path (card, page, cart, quick buy, checkout, order, invoice, refunds/returns that read the order price, the finance reports); the rate and rounding of a USD offer equal Pricing V2\'s for the same SKU at the same instant; no stacking with bundle price modes or membership beyond the existing precedence; an offer can never price below what the existing guards allow; a stale cached card cannot show an offer that ended (cache rules); the 0197 migration is additive and an older database works; no cost leaks to customers or logs.' },
  { key: 'owner-ui', text: 'LENS: THE OWNER AND THE CUSTOMER IN AR, EN, CKB. Real screenshots (local build) of the form card, the special-offers tab showing the same row, the product card and page, cart and checkout in ar, en and ckb at phone and desktop sizes; look at them: real Sorani, bidi of $/IQD amounts and percent signs in RTL, clarity of before/after, the per-model case, refusals in three languages, Clay tokens, no layout shift.' },
  { key: 'regression', text: 'LENS: NOTHING ELSE BREAKS. Existing special offers (fixed IQD, percent, discount IQD, tier-gated, scheduled, bundles and mystery offers) behave exactly as before; Pricing V2 publish/reprice and the import stock gate unaffected; existing tests unchanged in meaning; budgets not loosened.' },
]

phase('Review')
const reviewed = await pipeline(
  LENSES,
  (lens) => agent(`${rc}\n\n${lens.text}\n\nFinal answer: the structured findings.`, { label: `review:${lens.key}`, phase: 'Review', schema: FIND }),
  (res, lens) => (!res || !res.findings.length) ? [] : parallel(res.findings.map((f, i) => () => parallel([0, 1].map((k) => () => agent(`${rc}\n\nYOU ARE A SKEPTIC. Try to REFUTE this ${lens.key} finding; re-run its proof. refuted=true only if not a real defect.\n\nFINDING (${f.severity}) ${f.title}\nFile: ${f.file}:${f.line ?? ''}\nScenario: ${f.scenario}\nProof: ${f.proof}\nFix: ${f.fix}`, { label: `verify:${lens.key}:${i}:${k}`, phase: 'Review', schema: VERDICT }))).then((v) => ({ ...f, lens: lens.key, upheld: v.filter(Boolean).filter((x) => !x.refuted).length })))),
)
const confirmed = reviewed.filter(Boolean).flat().filter(Boolean).filter((f) => f.upheld >= 1)
log(`confirmed findings: ${confirmed.length}`)

phase('Fix')
const fix = confirmed.length
  ? await agent(`${context}\n\nYou FIX the confirmed review findings on feat/product-discount in ${WT} (never push): failing test first, minimal fix, confirm the test fails with the fix reverted, re-take changed screenshots; gates as for the build. Commit ("product discount, review: …"). Final answer: commits, per finding what you did, tests.\n\nFINDINGS:\n${JSON.stringify(confirmed, null, 1)}`, { label: 'fix', phase: 'Fix' })
  : 'nothing to fix'
return { design, build, confirmed: confirmed.map((f) => ({ severity: f.severity, title: f.title, lens: f.lens })), fix }