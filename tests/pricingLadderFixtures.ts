/**
 * ONE FIXTURE LIST FOR THE WHOLE LADDER.
 *
 * The same products are fed to the resolver (tests/pricingLadder.test.ts),
 * the Quick Edit grid (tests/priceGridAgreement.test.ts), the four write-time
 * validators plus the form's client mirror (tests/productModelLadder.test.ts)
 * and the Quick Edit routes (tests/adminPriceGridRoute.test.ts). One list,
 * so a rule that one surface learns and another does not shows up as a
 * disagreement here rather than as a customer charged a number the admin
 * never saw.
 *
 * Not a test file itself: `npm run test:unit` matches `tests/*.test.ts`.
 */
import type { ColorV2, OptionV2, PricingProduct } from '../worker/lib/pricing';

export const NO_PRICES = {
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  regular_adjust_iqd: null,
  prime_adjust_iqd: null,
  pro_adjust_iqd: null,
  cost_adjust_iqd: null,
} as const;

export function opt(id: string, p: Partial<OptionV2> = {}): OptionV2 {
  return { id, name_ar: id, name_en: id, name_ckb: '', image: '', order: 0, active: true, ...NO_PRICES, ...p };
}

export function col(id: string, p: Partial<ColorV2> = {}): ColorV2 {
  return { id, name_ar: id, name_en: id, name_ckb: '', hex: '#000000', image: '', option_id: null, order: 0, active: true, ...NO_PRICES, ...p };
}

/** The owner's example: Regular 150,000 / PRIME 125,000 / PRO 100,000. */
export function product(p: Partial<PricingProduct> = {}): PricingProduct {
  return {
    price_iqd: 150_000,
    prime_price_iqd: 125_000,
    pro_price_iqd: 100_000,
    product_cost_iqd: null,
    selling_type: 'direct_sale',
    sale_types: ['direct_sale'],
    options: [],
    colors: [],
    preorder_transports: [],
    warranty_plans: [],
    ...p,
  };
}

export interface LadderFixture {
  name: string;
  product: PricingProduct;
  verdict: 'accept' | 'refuse';
  /** Names every refusal must carry — the row, and the option a colour was judged under. */
  names?: string[];
}

export const LADDER_FIXTURES: LadderFixture[] = [
  // ------------------------------------------------------------ accepted
  { name: 'base only', product: product(), verdict: 'accept' },
  { name: 'option +25,000 (adjust)', product: product({ options: [opt('o1', { regular_adjust_iqd: 25_000 })] }), verdict: 'accept' },
  { name: 'option fixed 175,000', product: product({ options: [opt('o1', { regular_price_iqd: 175_000 })] }), verdict: 'accept' },
  {
    name: 'option +25,000 and a colour +10,000 on it',
    product: product({ options: [opt('o1', { regular_adjust_iqd: 25_000 })], colors: [col('c1', { option_id: 'o1', option_ids: ['o1'], regular_adjust_iqd: 10_000 })] }),
    verdict: 'accept',
  },
  { name: 'colour without options (+10,000)', product: product({ colors: [col('c1', { regular_adjust_iqd: 10_000 })] }), verdict: 'accept' },
  { name: 'PRO-only base, option +25,000', product: product({ prime_price_iqd: null, options: [opt('o1', { regular_adjust_iqd: 25_000 })] }), verdict: 'accept' },
  { name: 'PRIME-only base, option +25,000', product: product({ pro_price_iqd: null, options: [opt('o1', { regular_adjust_iqd: 25_000 })] }), verdict: 'accept' },
  {
    name: 'option with its own member prices',
    product: product({ options: [opt('o1', { regular_adjust_iqd: 25_000, prime_price_iqd: 160_000, pro_price_iqd: 130_000 })] }),
    verdict: 'accept',
  },
  {
    name: 'option with member adjusts',
    product: product({ options: [opt('o1', { regular_adjust_iqd: 25_000, prime_adjust_iqd: -5_000, pro_adjust_iqd: -5_000 })] }),
    verdict: 'accept',
  },
  {
    name: 'zero adjusts everywhere',
    product: product({ options: [opt('o1', { regular_adjust_iqd: 0, prime_adjust_iqd: 0, pro_adjust_iqd: 0 })], colors: [col('c1', { regular_adjust_iqd: 0 })] }),
    verdict: 'accept',
  },
  { name: 'a reduction that leaves the member price standing', product: product({ options: [opt('o1', { regular_adjust_iqd: -20_000 })] }), verdict: 'accept' },
  {
    name: 'a reduction that swallows PRO but states its own',
    product: product({ price_iqd: 100_000, prime_price_iqd: null, pro_price_iqd: 90_000, options: [opt('o1', { regular_adjust_iqd: -95_000, pro_price_iqd: 4_000 })] }),
    verdict: 'accept',
  },
  {
    // The colour's own PRO (58,000) is above option a's regular (50,000). The
    // resolver caps it there; that CAP is deliberately not a refusal under the
    // option (cheapestBase.ts relies on colours being measured against the
    // base for that rule). Only a swallowed member price or a PRIME below PRO
    // under an option is refused.
    name: 'colour with own PRO above one option\'s regular (cap, not refusal)',
    product: product({ price_iqd: 60_000, prime_price_iqd: null, pro_price_iqd: null, options: [opt('a', { regular_price_iqd: 50_000 }), opt('b')], colors: [col('k', { pro_price_iqd: 58_000 })] }),
    verdict: 'accept',
  },
  {
    // Colour with its own PRIME 135,000 linked to the option that has NO PRO
    // of its own: under it PRO is carried 125,000 ≤ 135,000. Fine.
    name: 'colour own PRIME under an option without its own PRO',
    product: product({
      options: [opt('o1', { regular_adjust_iqd: 25_000 }), opt('o2', { regular_adjust_iqd: 25_000, pro_price_iqd: 140_000 })],
      colors: [col('c1', { option_id: 'o1', option_ids: ['o1'], prime_price_iqd: 135_000 })],
    }),
    verdict: 'accept',
  },
  {
    // The M3 colour, linked ONLY to the harmless option: nothing is swallowed.
    name: 'fixed colour 130,000 linked only to the +25,000 option',
    product: product({
      options: [opt('o1', { regular_adjust_iqd: 25_000 }), opt('o2', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })],
      colors: [col('c1', { option_id: 'o1', option_ids: ['o1'], regular_price_iqd: 130_000 })],
    }),
    verdict: 'accept',
  },
  {
    // An option switched off is not one the colour can be sold with.
    name: 'fixed colour 130,000 with the swallowing option switched off',
    product: product({
      options: [opt('o1', { regular_adjust_iqd: 25_000 }), opt('o2', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000, active: false })],
      colors: [col('c1', { regular_price_iqd: 130_000 })],
    }),
    verdict: 'accept',
  },

  // ------------------------------------------------------------- refused
  {
    name: 'H1: option +25,000 with its own PRIME 120,000 under carried PRO 125,000',
    product: product({ options: [opt('o1', { regular_adjust_iqd: 25_000, prime_price_iqd: 120_000 })] }),
    verdict: 'refuse',
    names: ['o1'],
  },
  {
    name: 'H1 via prime_adjust −30,000',
    product: product({ options: [opt('o1', { regular_adjust_iqd: 25_000, prime_adjust_iqd: -30_000 })] }),
    verdict: 'refuse',
    names: ['o1'],
  },
  {
    name: 'M1a: no base members, option +25,000 with pro_adjust +10,000',
    product: product({ prime_price_iqd: null, pro_price_iqd: null, options: [opt('o1', { regular_adjust_iqd: 25_000, pro_adjust_iqd: 10_000 })] }),
    verdict: 'refuse',
    names: ['o1'],
  },
  {
    name: 'M1b: option with no regular of its own and fixed PRO 180,000',
    product: product({ prime_price_iqd: null, pro_price_iqd: null, options: [opt('o1', { pro_price_iqd: 180_000 })] }),
    verdict: 'refuse',
    names: ['o1'],
  },
  {
    name: 'M3: option +100,000 with own PRO 40,000; colour fixed 130,000 on it',
    product: product({ options: [opt('o1', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })], colors: [col('c1', { option_id: 'o1', option_ids: ['o1'], regular_price_iqd: 130_000 })] }),
    verdict: 'refuse',
    names: ['c1', 'o1'],
  },
  {
    name: 'M3 with the colour linked to BOTH options',
    product: product({
      options: [opt('o1', { regular_adjust_iqd: 25_000 }), opt('o2', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })],
      colors: [col('c1', { option_ids: ['o1', 'o2'], regular_price_iqd: 130_000 })],
    }),
    verdict: 'refuse',
    names: ['c1', 'o2'],
  },
  {
    name: 'M3 with an unlinked colour (sold with every option)',
    product: product({
      options: [opt('o1', { regular_adjust_iqd: 25_000 }), opt('o2', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 })],
      colors: [col('c1', { regular_price_iqd: 130_000 })],
    }),
    verdict: 'refuse',
    names: ['c1', 'o2'],
  },
  {
    name: 'U2 shape: base 100,000 / PRO 90,000, option −95,000 with no PRO of its own',
    product: product({ price_iqd: 100_000, prime_price_iqd: null, pro_price_iqd: 90_000, options: [opt('o1', { regular_adjust_iqd: -95_000 })] }),
    verdict: 'refuse',
    names: ['o1'],
  },
  {
    name: 'derived PRIME above the row\'s regular (prime_adjust +100,000)',
    product: product({ options: [opt('o1', { regular_adjust_iqd: 25_000, prime_adjust_iqd: 100_000 })] }),
    verdict: 'refuse',
    names: ['o1'],
  },
  {
    // Fine against the base (PRO carried 100,000 ≤ PRIME 135,000 ≤ 150,000);
    // inverted only under o2, whose own PRO of 140,000 the colour carries.
    name: 'colour own PRIME 135,000 under an option with its own PRO 140,000',
    product: product({
      options: [opt('o1', { regular_adjust_iqd: 25_000 }), opt('o2', { regular_adjust_iqd: 25_000, pro_price_iqd: 140_000 })],
      colors: [col('c1', { option_id: 'o2', option_ids: ['o2'], prime_price_iqd: 135_000 })],
    }),
    verdict: 'refuse',
    names: ['c1', 'o2'],
  },
  {
    name: 'stored inversion on a row: PRIME 120,000, PRO 130,000',
    product: product({ options: [opt('o1', { prime_price_iqd: 120_000, pro_price_iqd: 130_000 })] }),
    verdict: 'refuse',
    names: ['o1'],
  },
  {
    name: 'product-level inversion: PRIME 125,000, PRO 130,000',
    product: product({ pro_price_iqd: 130_000 }),
    verdict: 'refuse',
  },
];

export const ACCEPTED = LADDER_FIXTURES.filter((f) => f.verdict === 'accept');
export const REFUSED = LADDER_FIXTURES.filter((f) => f.verdict === 'refuse');

/** Every selection the resolver could be asked to price on this product. */
export function selectionsOf(p: PricingProduct): Array<{ optionId: string | null; colorId: string | null }> {
  const out: Array<{ optionId: string | null; colorId: string | null }> = [{ optionId: null, colorId: null }];
  for (const o of p.options) out.push({ optionId: o.id, colorId: null });
  for (const c of p.colors) {
    if (!c.option_id) out.push({ optionId: null, colorId: c.id });
    for (const o of p.options) {
      if (!c.option_id || c.option_id === o.id) out.push({ optionId: o.id, colorId: c.id });
    }
  }
  return out;
}
