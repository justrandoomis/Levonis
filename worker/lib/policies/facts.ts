import type { PolicyLang, PolicyText } from './types';

/**
 * THE FACTS THE CORPUS WAS WAITING FOR — the values that fill a `{{TOKEN}}`.
 *
 * The owner, on the policies page: «فراغات مثل "يسري ... government law" و
 * {{BREACH_NOTIFICAYION_HOURS}} يجب ملؤها». ./render.ts had already stopped a
 * token from reaching a customer as literal braces, but it did so by
 * WITHHOLDING every line that carried one, and a withheld line is silence:
 * the Terms lost their governing law, their court and the PRO / PREMIUM
 * delivery exception (8.4) that 8.3 still pointed at. This table is the other
 * half of that design — ./index.ts substitutes these values into the source
 * BEFORE the render pass runs, so only a token with no entry here is still
 * withheld.
 *
 * WHAT IS ALLOWED IN HERE. A value is either something the owner has decided
 * or something the code itself enforces; nothing is inferred and nothing is
 * borrowed from another shop. The legal name beyond «Levonis», the
 * registration number, the street address, the retention periods and every
 * other token the code does not hold are deliberately ABSENT, and stay
 * withheld until the owner gives them.
 *
 * ONE TEXT PER VERSION. A value is a constant, never a read of
 * `admin_settings` at request time: ./types.ts hashes the exact bytes a
 * customer accepted, and a body that moved whenever an admin edited a setting
 * could not be hashed once. So CHANGING A VALUE HERE IS A PUBLICATION: bump
 * the `version` of every document that uses the token, exactly as for any
 * other correction, and the archive keeps the previous text.
 *
 * HOW A VALUE READS IN ITS SENTENCE. Each value is written to be dropped into
 * the sentences the corpus already has — the sentences were normalised once
 * so that the token stands for the WHOLE phrase («تخضع هذه الوثيقة
 * ل{{GOVERNING_LAW_JURISDICTION}}», 'governed by {{…}}'), and numeric tokens
 * stand for the bare figure with the unit written after them in the source,
 * the same convention every other `_HOURS` / `_DAYS` token already follows.
 */

/** A value that is the same in all three languages (a figure, a URL). */
const same = (value: string): PolicyText => ({ ar: value, en: value, ckb: value });

/** Grouped thousands, the way the checkout and the product pages print dinars. */
const iqd = (amount: number): string => amount.toLocaleString('en-US');

/**
 * THE MEMBERSHIP FREE-DELIVERY THRESHOLDS, as the checkout applies them today.
 *
 * The checkout decides the waiver from `membership_benefit_rules`
 * (worker/lib/membershipBenefits.ts `selectRule`), and falls back to the
 * `shippingPolicy` setting only where no rule exists. Migration 0074 seeds
 * those rules — PRO strictly above 75,000 on standard and personal delivery,
 * PREMIUM strictly above 100,000 on standard delivery — and they are what
 * the subscription page shows. The PRO figure also matches
 * `shippingPolicy.pro_threshold_iqd`. tests/policyCorpus.test.ts reads the
 * seed back so a new seed cannot leave the documents promising the old one.
 *
 * `PRIME_` is the historical database name of the same tier the customer
 * reads as PREMIUM (membership article 2.4), so both tokens carry one figure.
 */
export const PRO_FREE_DELIVERY_MIN_IQD = 75000;
export const PREMIUM_FREE_DELIVERY_MIN_IQD = 100000;

export const POLICY_FACTS: Readonly<Record<string, PolicyText>> = {
  GOVERNING_LAW_JURISDICTION: {
    ar: 'قوانين جمهورية العراق',
    en: 'the laws of the Republic of Iraq',
    ckb: 'یاساکانی کۆماری عێراق',
  },
  COMPETENT_COURT: {
    ar: 'محاكم بغداد المختصة',
    en: 'the competent courts of Baghdad',
    ckb: 'دادگا تایبەتمەندەکانی بەغدا',
  },
  BREACH_NOTIFICATION_HOURS: same('72'),
  MIN_PURCHASE_AGE_YEARS: same('18'),
  /**
   * The in-app support page is the one channel the shop really runs: tickets,
   * messages and complaints all land in the admin support console from
   * there. No phone number is invented; LEVONIS_SUPPORT_HOURS stays withheld.
   */
  LEVONIS_SUPPORT_CONTACT: {
    ar: 'صفحة الدعم (levonis-iq.com/support)',
    en: 'the Support page (levonis-iq.com/support)',
    ckb: 'پەڕەی پشتگیری (levonis-iq.com/support)',
  },
  PRO_FREE_DELIVERY_MIN_IQD: same(iqd(PRO_FREE_DELIVERY_MIN_IQD)),
  PREMIUM_FREE_DELIVERY_MIN_IQD: same(iqd(PREMIUM_FREE_DELIVERY_MIN_IQD)),
  PRIME_FREE_DELIVERY_MIN_IQD: same(iqd(PREMIUM_FREE_DELIVERY_MIN_IQD)),
};

const TOKEN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/**
 * The source body with every token that has a value replaced by it. A token
 * with no entry is left exactly as written, for ./render.ts to withhold.
 */
export function fillPolicyFacts(body: string, lang: PolicyLang): string {
  return body.replace(TOKEN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(POLICY_FACTS, name) ? POLICY_FACTS[name][lang] : whole
  );
}
