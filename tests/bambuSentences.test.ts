/**
 * THE SENTENCE CLASSIFIER (Bambu import spec §C.10 golden sentences).
 *
 * Every sentence of every prose field is labelled: money, promotion and US
 * shipping-policy sentences are removed; warranty / return / refund sentences
 * are withheld from customers (kept owner-only, L-19); voltage purchase
 * advice is region evidence. Technical text that merely contains a number or
 * a temperature is kept. Hits are counts, never text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySentence, refusedClassOf, scrubProse, splitSentences } from '../packages/catalog/src/bambuImport/sentences';
import { buildImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { sample, type SampleHandle } from './fixtures/bambu/load';

const KEPT = [
  'Prints come off easily when the temperature of the heatbed reaches room temperature, and we always recommend waiting until it reaches 35℃ or lower.',
  'A: No,they aren\'t. A1 3D printers sold after January 30, 2024 are not from the same batch as those recalled before.',
  'They already contain all the necessary fixes to mitigate the heatbed cable issue which caused the recall.',
  'Max Speed of Tool Head 500mm/s',
  'Diameter: 1.75mm +/- 0.03mm',
  'Supports up to 4 AMS units with 16 colours.',
  // Near misses of the review 4 patterns: technical, kept.
  'Supports up to 4 AMS units per printer.',
  'Up to 30% energy savings compared with the previous fan.',
  'Space-saving design with a free-standing spool holder.',
  'Free-flowing filament path with 50% less friction.',
  'Keep the spare nozzles in a dry box near the printer.',
  // ... and of the second corpus scan: what a product saves in use, a value name, an informational note (corpus pages).
  'Flexible and rigid, low cost and exotic materials in one print', // h2d
  'This results in a longer lifespan for the printing plate, reducing printing costs (less than 20% adhesion loss after 300 prints) and lowering carbon emissions.', // build-plate-combo
  'This means you can save a significant amount of energy during heating, leading to lower power bills and, more importantly, helping to protect our planet.', // build-plate-combo
  'A softer look and easier printing haven’t come at the cost of strength with Bambu PETG Matte.', // petg-matte
  "H2D's smart algorithms optimize filament use, maximizing dual-nozzle efficiency to save time and materials.", // h2d
  "Perfect for small and intricate models, with precision that's worth the wait", // bambu-hotend-a1-a2
  'It is worth mentioning that it can biodegrade in some artificial composting conditions.', // pla-basic-filament
  '• Assign each of the six induction hotends to specific filament, storing filament info automatically for seamless reloads — perfect for high-value engineering filaments', // vortek-utility-hotends-bundle
  'Saves an average of 10 minutes per 100 filament changes.', // ams-2-pro
  'Purchase additional AMS units for more colors.', // p1s
  '(*Vision Encoder sold separately)', // h2d
  'The side panels we shipped earlier also did not have tabs.', // left-plastic-panel-p1-series
  'Add All To Cart - ZH088', // n20-reduction-gear-motor: an option value's own name
  'X1 Series Exclusive', // the compatibility value of 54 spare parts
];
const REMOVED: Array<[string, 'money' | 'promotion' | 'shipping_policy']> = [
  ['30-day price protection, 2-year warranty & 30-day returns at official store.', 'money'],
  ['Add only $50 to the A1 Combo for the AMS lite.', 'money'],
  ['Now US$399 at the official store.', 'money'],
  ['Check out our Multi-Size Hotends Kit for an exclusive bundle discount.', 'promotion'],
  ['Save on officially refurbished Bambu Lab H2D.', 'promotion'],
  ['Get 10% off with code SPRING.', 'promotion'],
  ['Free shipping on orders over a threshold.', 'promotion'],
  ['Packaging may vary, shipping costs are the same for all orders placed at the same time.', 'shipping_policy'],
];

/**
 * REVIEW 4, FINDING 2: real sentences of the crawled corpus that reached a
 * public payload string before the lists were widened (page in the comment).
 */
const CORPUS_REMOVED: Array<[string, 'money' | 'promotion' | 'shipping_policy']> = [
  // promotion and discounts
  ['Best of all, this all-in-one bundle  offers a 30% savings  compared to individual sheets—giving you more room to create and more value for your projects.', 'promotion'], // ultimate-opaque-glossy-acrylic-kit
  ['Bambu Support for PLA delivers enhanced performance at 34% less cost than its predecessor.', 'money'], // support-for-pla-new
  ['Unlock the Full Power of the H2C Vortek System and save more with the ultimate all-in-one bundle.', 'promotion'], // h2c (variant note)
  ['You can add them to cart from the " Buy add-ons to save more " section.', 'promotion'], // wireless-charger-kit-k012
  ['🎁  Free Silicone Sock (3 pcs)!    🎁', 'promotion'], // multi-size-hotends-kit (variant note)
  ['For original rear panel P2S owner: Free updated rear panel to optimize exhaust efficiency.', 'promotion'], // external-exhaust-fan-kit-p2s
  ['🎉 Unlock Creative Wonders! 🎁', 'promotion'], // material-mystery-box
  // stock and purchase limits
  ['(2) Limited Stock:  Available only while supplies last.', 'shipping_policy'], // material-mystery-box
  ['The maximum purchase quantity for any single item is limited to five (5) units per user and per order.', 'shipping_policy'],
  ['You may place an order from any variant in stock.', 'shipping_policy'], // ams-2-pro
  ['PETG HF is discontinued and will not be restocked once sold out.', 'shipping_policy'], // petg-hf
  ['Note: ASA-CF 1kg variant is discontinued and will not be restocked once sold out.', 'shipping_policy'], // asa-cf
  // the store's shipping terms
  ['Your order may be shipped in separate packages and arrive at different times.', 'shipping_policy'], // h2c (variant note)
  ['How will my order be shipped and divided into packages?', 'shipping_policy'], // h2c FAQ
  ['The parts of this set will be packaged and shipped using standard shipping packaging.', 'shipping_policy'], // card-shuffler and 90 more
  ['Standard Shipping Packaging:  The items in this set will be packaged and shipped using standard shipping packaging.', 'shipping_policy'], // hwb-pumpkinfamily
  // price claims
  ['Precise, easy to use, unbeatable price.', 'money'], // r1 short description
  ['Bambu Lab A1 detailed test - ‘Just works’ 3D printing for a great price', 'money'], // a1
  ['Its competitive price, combined with solid performance and well-designed features, make it an attractive option for 3D printing enthusiasts."', 'money'], // p2s
  ['The Bambu Lab P1S represents excellent value for money.', 'money'], // p2s
  ['Great value:  Unlock unlimited possibilities with just one pack at an incredible price!', 'money'], // makers-beginner-kit
  ['Reasonable price', 'money'], // high-performance-bearings
];

/**
 * The second corpus scan (every customer-facing payload string walked through
 * the closed schema): price and value claims without the word "price", a gift
 * with purchase, the store's buttons and cart, packing and order terms.
 */
const CORPUS_REMOVED_2: Array<[string, 'money' | 'promotion' | 'shipping_policy']> = [
  ['Affordable dual-nozzle 3D printer from the No.1 best-selling brand.', 'money'], // x2d short description
  ['Most affordable multi-color 3D printer.', 'money'], // a1-mini
  ['• Buying the bundle is cheaper than purchasing items individually.', 'money'], // winter-cottage-led-lamp, wooden-desktop-pinball
  ["PLA is the most common material in 3D printing as it's easy to print and inexpensive.", 'money'], // pla-basic-filament, pla-matte
  ['• More expensive than ordinary bearings', 'money'], // plastic-deep-groove-ball-bearings
  ['Its strong resistance to water, UV, and temperature makes it a highly cost-effective option for outdoor applications.', 'money'], // petg-basic
  ['From garden labels to bathroom accessories, it’s a practical, budget-friendly choice for prints that need to withstand everyday conditions.', 'money'], // petg-basic
  ['Enjoy greater stability, improved printability, and better results, all while saving money.', 'money'], // support-for-pla-new
  ['This approach minimizes material usage, saving both time and money.', 'money'], // support-for-pla-new
  ['• which can extends your playtime and saves you the expense of disposable batteries.', 'money'], // extra-rechargeable-battery-upgrade-kit
  ['Purchasing H2S/H2D first and upgrading later will incur extra cost.', 'money'], // h2c
  ['When combined with a gearbox, it offers lower costs compared to the N20 series and smaller size and more flexible control options compared to TT motors.', 'money'], // multi-ratio-motorized-system-kit
  ['This reduces the cost of components but still includes a motorized river and lava flow.', 'money'], // relic-rush-board-game
  ['Recommended P1S AMS 2 Pro Combo - compared with P1S AMS Combo, P1S AMS 2 Pro Combo has better value with active filament drying function.', 'money'], // p1s
  ['For the best value and added convenience, choose the cutter set, which includes 10 PCS replacement blades.', 'money'], // maker-s-supply-precision-cutter
  ['Is The A1 Worth It?', 'money'], // a1
  ['Absolutely worth it!', 'money'], // vision-encoder
  ['• All-in-One Experience: Purchase a mini tank and get screwdriver tools for free, so even beginners can assemble it easily.', 'promotion'], // cyberbrick-mini-tank
  ['A free replacement blade ensures long-lasting sharpness and a smooth, safe removal experience.', 'promotion'], // mag-alloy-scraper
  ['Buy Now >', 'promotion'], // petg-hf
  ['• Looking to buy multiple hotend sizes?', 'promotion'], // bambu-hotend-a1-a2 (the lead-in of a removed bundle discount)
  ['Packaging is now updating, new and old designs may be shipped randomly.', 'shipping_policy'], // h2s
  ["Orders can be placed at Maker's Supply.", 'shipping_policy'], // m2-button-head-cap-machine-screws-bhcs and 6 more
  ['If you require a filament buffer, you can add it to your shopping cart below.', 'shipping_policy'], // p2s
  ['* High-flow Hotends are optional equipments, buy at official store.', 'shipping_policy'], // h2c
];
const WITHHELD = [
  'The warranty will only cover manufacturing defects, not cosmetic damage like scratches, dents, or cracks.',
  'Defective sheets upon arrival are the only ones covered by the warranty.',
  '2-year warranty & 30-day returns.',
  'Refunds are processed within 14 days.',
  'Enjoy 14 days returns at Bambu Lab Official Store.', // ams-2-pro short description
];

test('golden sentences: kept, removed, withheld', () => {
  for (const s of KEPT) assert.equal(classifySentence(s), 'keep', s);
  for (const [s, c] of REMOVED) assert.equal(classifySentence(s), c, s);
  for (const s of WITHHELD) assert.equal(classifySentence(s), 'warranty', s);
  for (const [s, c] of CORPUS_REMOVED) assert.equal(classifySentence(s), c, s);
  for (const [s, c] of CORPUS_REMOVED_2) assert.equal(classifySentence(s), c, s);
  assert.equal(classifySentence("Please purchase the version corresponding to your region's voltage."), 'region');
});

/**
 * Two places a refused sentence used to pass whole: a comparison table's
 * "Price" column (bearing pages grade each material "Very affordable" …
 * "Expensive"), and a relation's evidence, which quotes the source sentence it
 * came from — there a store word refused the WHOLE payload at the validator
 * (p2s: "If you require a filament buffer, you can add it to your shopping
 * cart below."). The column goes; the relation stays, without the words.
 */
test('a comparison table loses its price column; relation evidence is scrubbed, so the payload passes', async () => {
  const { assertImportPayload, withoutMoneyColumns } = await import('../packages/catalog/src/bambuImport/payload');
  assert.deepEqual(
    withoutMoneyColumns([
      ['Material', 'Price', 'Rotational Noise'],
      ['Bronze', 'Very affordable', 'Low'],
      ['Ceramic Ball', 'Expensive', 'Moderate'],
    ]),
    [
      ['Material', 'Rotational Noise'],
      ['Bronze', 'Low'],
      ['Ceramic Ball', 'Moderate'],
    ]
  );
  assert.deepEqual(withoutMoneyColumns([['Weight', '30 g'], ['Unit price', '$4'], ['Colour', 'Black']]), [['Weight', '30 g'], ['Colour', 'Black']]);
  assert.deepEqual(withoutMoneyColumns([['Priced in', 'Model'], ['a', 'b']]), [['Priced in', 'Model'], ['a', 'b']], 'only a header that IS a money word');

  const x = sample('bambu-textured-pei-plate');
  const html =
    '<h3>Comparison of Bearing Materials</h3><table><tr><td>Material</td><td>Price</td><td>Rotational Noise</td></tr>' +
    '<tr><td>Bronze</td><td>Very affordable</td><td>Low</td></tr><tr><td>Ceramic Ball</td><td>Expensive</td><td>Moderate</td></tr></table>' +
    '<h3>Compatibility</h3><p>Compatible with the Bambu Lab AMS 2 Pro, which you can add to your shopping cart below.</p>';
  const y = { ...x, description: { kind: 'legacy_html' as const, html } };
  const targets = { version: 1, labels: { 'AMS 2 Pro': { kind: 'ams', to: { source_handle: 'ams-2-pro' } } } };
  const p = buildImportPayload({ extraction: y, writeMode: 'create', extractionSha256: extractionFingerprint(y), targets: targets as never, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
  const table = p.content_blocks.find((b) => b.body_en.includes('Bronze'));
  assert.ok(table, 'the comparison table is kept');
  assert.ok(!/price|affordable|expensive/i.test(table!.body_en), table!.body_en);
  assert.match(table!.body_en, /Bronze \| Low/);
  const ams = p.relations.find((r) => r.target_source_handle === 'ams-2-pro');
  assert.ok(ams, 'the compatibility relation is still made from that sentence');
  assert.ok(!/cart/i.test(ams!.evidence_text), ams!.evidence_text);
  assert.doesNotThrow(() => assertImportPayload(JSON.parse(JSON.stringify(p))));
});

test('sentences split at boundaries, not at decimals or inside a sentence', () => {
  assert.deepEqual(splitSentences('Diameter 1.75 mm. Tolerance 0.03 mm! Done'), ['Diameter 1.75 mm.', 'Tolerance 0.03 mm!', 'Done']);
  assert.deepEqual(splitSentences('Line one\nLine two.'), ['Line one', 'Line two.']);
  // A sentence glued to the next (m2-socket-head-shoulder-machine-screws-shss): the store's line goes, the facts stay.
  const glued = "Using a shoulder section as a bare shaft for easy mounting of bearings or other components.Orders can be placed at Maker's Supply.";
  const r = scrubProse(glued);
  assert.equal(r.kept, 'Using a shoulder section as a bare shaft for easy mounting of bearings or other components.');
  assert.equal(r.counts.shipping_policy, 1);
  // Glued parts that are all kept stay exactly as written: a creator's name, an abbreviation, a host, a decimal.
  for (const s of ['Cute and Simple Ghost | Chingoo.Jeesoo | Cute and Simple Ghost', 'Use e.g.PLA or 4.8 Strength grade.', 'See wiki.bambulab.com for details.']) {
    assert.equal(scrubProse(s).kept, s);
  }
});

test('scrubProse keeps the technical sentences, counts the rest and withholds warranty text', () => {
  const text =
    'Full-size multi-color 3D printer. Print-ready, no tuning. 2M+ free models. 30-day price protection, 2-year warranty & 30-day returns at official store.\n' +
    'The warranty will only cover manufacturing defects, not cosmetic damage like scratches, dents, or cracks. Prints come off easily when cooled.';
  const r = scrubProse(text);
  assert.equal(r.kept, 'Full-size multi-color 3D printer. Print-ready, no tuning. 2M+ free models.\nPrints come off easily when cooled.');
  assert.deepEqual(r.counts, { money: 1, promotion: 0, shipping_policy: 0, warranty: 1, region: 0 });
  assert.equal(r.withheld.length, 1);
  assert.equal(refusedClassOf(r.kept), null);
  assert.equal(refusedClassOf(text), 'money');
});

test('on the fixtures: removed sentences never reach the payload, withheld ones only an owner row', () => {
  const build = (h: SampleHandle) => {
    const x = sample(h);
    return buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: null, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
  };
  const checks: Array<[SampleHandle, string[]]> = [
    ['a1', ['price protection']],
    ['h2d', ['price protection', 'Packaging may vary', 'shipping costs']],
    ['bambu-hotend-a1-a2', ['exclusive bundle discount']],
    ['refurbished-bambu-lab-h2d-3d-printer', ['Save on officially refurbished']],
  ];
  for (const [h, gone] of checks) {
    const json = JSON.stringify(build(h));
    for (const g of gone) assert.ok(!json.includes(g), `${h}: "${g}" reached the payload`);
  }
  const plate = build('bambu-textured-pei-plate');
  const publicText = JSON.stringify({ ...plate, specs: plate.specs.filter((s) => s.visibility === 'public') });
  assert.ok(publicText.includes('Prints come off easily'), 'the technical sentence is kept');
  assert.ok(!publicText.includes('The warranty will only cover'), 'the warranty sentence is not public');
  const note = plate.specs.find((s) => s.key === 'manufacturer_terms.warranty_note');
  assert.ok(note && note.visibility === 'owner' && note.value_text.includes('The warranty will only cover'), 'withheld, owner-only (L-19)');
  assert.ok(plate.notes.some((n) => n.kind === 'sentence_withheld'));
});
