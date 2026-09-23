import type { PolicyDocument, PolicyText } from './types';
import { publishedPolicyBody } from './render';
import { fillPolicyFacts } from './facts';

import { purchase } from './purchase';
import { selling } from './selling';
import { payment } from './payment';
import { price_protection } from './price_protection';
import { delivery } from './delivery';
import { warranty } from './warranty';
import { extended_warranty } from './extended_warranty';
import { returns } from './returns';
import { after_sale } from './after_sale';
import { community } from './community';
import { registration } from './registration';
import { membership } from './membership';
import { rewards } from './rewards';
import { terms } from './terms';
import { site_terms } from './site_terms';
import { privacy } from './privacy';
import { support } from './support';
import { faq } from './faq';

/**
 * THE REGISTRY — the only author of store policy.
 *
 * Adding a document is: write ./<key>.ts, import it here, list it in MODULES
 * and place it in a section. Correcting one is: bump its `version` in its own
 * module. Nothing else publishes, and nothing in the admin panel can write a
 * word of this text.
 */

/**
 * The map is the registry's identity: its literal keys are what PolicyKey is
 * derived from, so the union can never drift from what is actually imported.
 * Declaration order is the reading order of the flat list.
 */
const MODULES = {
  purchase,
  selling,
  payment,
  price_protection,
  delivery,
  warranty,
  extended_warranty,
  returns,
  after_sale,
  community,
  registration,
  membership,
  rewards,
  terms,
  site_terms,
  privacy,
  support,
  faq,
} as const;

export type PolicyKey = keyof typeof MODULES;

export const POLICY_KEYS = Object.keys(MODULES) as readonly PolicyKey[];

/**
 * The corpus AS AUTHORED, placeholders and all. It exists for one reader:
 * tests/policyCorpus.test.ts, which asserts that the unknowns are still named
 * `{{LIKE_THIS}}` and still trilingual, so the owner's to-do list cannot rot.
 * Nothing that serves, archives or hashes a document may read it — see
 * ./render.ts for why the published text is a different string.
 */
export const POLICY_SOURCE_DOCUMENTS: readonly PolicyDocument[] = POLICY_KEYS.map((key) => MODULES[key]);

/**
 * The PUBLISHED text: the source with every known fact filled in from
 * ./facts.ts and every clause that still states an unknown withheld. ./render.ts carries the reasoning; what matters here is
 * that this is the only corpus the rest of the worker can see, so the bytes
 * that are rendered, archived, hashed and accepted are one and the same.
 *
 * The body is a memoised GETTER, not a computed value, because the listing
 * endpoint and policySync's presence check read `key`, `version` and `title`
 * and never a body — and paying twelve milliseconds of every isolate's
 * startup to render eighteen trilingual documents that the request may not
 * even ask for is a cost with nothing on the other side of it.
 */
function publishedDocument(doc: PolicyDocument): PolicyDocument {
  let body: PolicyText | null = null;
  return {
    key: doc.key,
    version: doc.version,
    effective_at: doc.effective_at,
    title: doc.title,
    get body(): PolicyText {
      if (!body) {
        // Fill first, withhold second: a token ./facts.ts has a value for
        // is stated, and only one with no value is left for the render pass
        // to hold back.
        body = {
          ar: publishedPolicyBody(fillPolicyFacts(doc.body.ar, 'ar')),
          en: publishedPolicyBody(fillPolicyFacts(doc.body.en, 'en')),
          ckb: publishedPolicyBody(fillPolicyFacts(doc.body.ckb, 'ckb')),
        };
      }
      return body;
    },
  };
}

const PUBLISHED = Object.fromEntries(
  POLICY_KEYS.map((key) => [key, publishedDocument(MODULES[key])])
) as Record<PolicyKey, PolicyDocument>;

export const POLICY_DOCUMENTS: readonly PolicyDocument[] = POLICY_KEYS.map((key) => PUBLISHED[key]);

/**
 * Sections exist so the reader can present a corpus this size as a structured
 * table of contents instead of eighteen undifferentiated rows. A customer
 * hunting for the transit-damage clause looks under delivery, not under "D".
 */
export const POLICY_SECTIONS = [
  {
    id: 'ordering',
    title: {
      ar: 'الطلب والشراء والدفع',
      en: 'Ordering, Purchase and Payment',
      ckb: 'داواکاری و کڕین و پارەدان',
    },
    keys: ['purchase', 'selling', 'payment', 'price_protection'],
  },
  {
    id: 'delivery',
    title: {
      ar: 'التوصيل والشحن',
      en: 'Delivery and Shipping',
      ckb: 'گەیاندن و ناردن',
    },
    keys: ['delivery'],
  },
  {
    id: 'warranty',
    title: {
      ar: 'الضمان والإرجاع وما بعد البيع',
      en: 'Warranty, Returns and After-Sale',
      ckb: 'گەرەنتی و گەڕاندنەوە و دوای فرۆشتن',
    },
    keys: ['warranty', 'extended_warranty', 'returns', 'after_sale'],
  },
  {
    id: 'community',
    title: {
      ar: 'مجتمع ليفو والعضويات',
      en: 'Levo Community and Memberships',
      ckb: 'کۆمەڵگەی لێڤۆ و ئەندامێتییەکان',
    },
    keys: ['community', 'registration', 'membership', 'rewards'],
  },
  {
    id: 'legal',
    title: {
      ar: 'الشروط القانونية والخصوصية',
      en: 'Legal Terms and Privacy',
      ckb: 'مەرجە یاساییەکان و تایبەتمەندێتی',
    },
    keys: ['terms', 'site_terms', 'privacy'],
  },
  {
    id: 'help',
    title: {
      ar: 'الدعم والأسئلة الشائعة',
      en: 'Support and FAQ',
      ckb: 'پشتگیری و پرسیارە باوەکان',
    },
    keys: ['support', 'faq'],
  },
] as const satisfies readonly { id: string; title: PolicyText; keys: readonly PolicyKey[] }[];

export type PolicySection = (typeof POLICY_SECTIONS)[number];

/**
 * Compile-time proof that every registered document is placed in a section:
 * add a module to MODULES and forget the section, and this line stops
 * typechecking with the orphaned key named in the error.
 */
type SectionedKey = (typeof POLICY_SECTIONS)[number]['keys'][number];
type UnsectionedKey = Exclude<PolicyKey, SectionedKey>;
const _everyDocumentIsInASection: [UnsectionedKey] extends [never] ? true : UnsectionedKey = true;
void _everyDocumentIsInASection;

export function isPolicyKey(value: unknown): value is PolicyKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MODULES, value);
}

/** The registry answer for one key, or null — never a database round trip. */
export function getPolicyDocument(key: string): PolicyDocument | null {
  return isPolicyKey(key) ? PUBLISHED[key] : null;
}

/** Which section a key belongs to, for the reader's table of contents. */
export function policySectionOf(key: string): PolicySection['id'] | null {
  for (const section of POLICY_SECTIONS) {
    if ((section.keys as readonly string[]).includes(key)) return section.id;
  }
  return null;
}
