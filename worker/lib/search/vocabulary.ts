/**
 * THE WORDS THIS SHOP IS SEARCHED WITH, IN THE THREE LANGUAGES ITS CUSTOMERS
 * USE.
 *
 * WHY A DICTIONARY IS UNAVOIDABLE. `./translit.ts` gets «بامبو» to "bambu",
 * because that IS a spelling of "bambu". It gets «طابعة» to "tabah", which is
 * nothing like "printer" — because «طابعة» is not a spelling of "printer", it
 * is the Arabic word for it. No string algorithm discovers that. Somebody has
 * to write it down.
 *
 * SO THE TWO ARE KEPT APART, and that separation is the design. Romanisation
 * handles spellings; this handles meanings. Mixing them would let a
 * transliteration produce a confident match on a word it does not know, which
 * is worse than no match — a shopper who searches «نوزل» and is shown resin
 * has been actively misled.
 *
 * DATA, NOT CODE — but seeded here. The rows live in the `search_synonyms`
 * table so the owner can add «بمبو» or a new brand without a deploy, and this
 * file is the SEED the migration inserts. A constant map would have meant a
 * code change every time the shop learned a new word its customers use, which
 * for a shop in Iraq selling foreign hardware is constantly.
 *
 * EACH ROW IS `term → canonical`. The canonical side is what gets indexed and
 * what a query is rewritten to, so every spelling of a thing collapses onto
 * one token. Both sides are stored NORMALISED (see ./normalize.ts), so the
 * table never has to hold every hamza variant of a word.
 */

import { normalizeText } from './normalize';

export interface SynonymSeed {
  /** What somebody types. Any language, any spelling. */
  term: string;
  /** The token it means. Usually the English word the catalogue uses. */
  canonical: string;
}

/**
 * The seed, grouped by what it is for. Deliberately NOT exhaustive: it covers
 * the vocabulary this shop's own catalogue and the owner's own examples use.
 * The table is there so it grows from real searches rather than from guesses.
 */
export const SYNONYM_SEED: readonly SynonymSeed[] = [
  // ---- What the shop sells, by category. The owner's first example was
  // «طابعه» finding the X2D, and «طابعات» is the plural.
  { term: 'طابعة', canonical: 'printer' },
  { term: 'طابعه', canonical: 'printer' },
  { term: 'طابعات', canonical: 'printer' },
  { term: 'طباعه', canonical: 'printer' },
  /**
   * «طبعات» AND «طبعه» — «طابعات» and «طابعه» with the alif dropped, which is
   * how the word is actually typed in a hurry, and the owner's own example.
   *
   * They are here rather than left to the typo pass because the typo pass
   * cannot reach them: the candidate vocabulary is fetched by the token's first
   * TWO characters, and «طب» is not «طا». A misspelling INSIDE the first two
   * letters is invisible to a prefix scan however generous the edit budget is —
   * which is precisely the case the owner's table exists to answer, one row at
   * a time, without a deploy.
   */
  { term: 'طبعات', canonical: 'printer' },
  { term: 'طبعه', canonical: 'printer' },
  { term: 'برنتر', canonical: 'printer' },
  { term: 'چاپکەر', canonical: 'printer' },
  { term: 'چاپکەرەکان', canonical: 'printer' },
  { term: 'printers', canonical: 'printer' },

  { term: 'فلمنت', canonical: 'filament' },
  { term: 'فيلمنت', canonical: 'filament' },
  { term: 'فلامنت', canonical: 'filament' },
  { term: 'خيط', canonical: 'filament' },
  { term: 'خيوط', canonical: 'filament' },
  { term: 'بكرة', canonical: 'filament' },
  { term: 'فیلامێنت', canonical: 'filament' },
  { term: 'filaments', canonical: 'filament' },
  { term: 'spool', canonical: 'filament' },

  { term: 'نوزل', canonical: 'nozzle' },
  { term: 'نوزلين', canonical: 'nozzle' },
  { term: 'نوزلات', canonical: 'nozzle' },
  { term: 'فوهة', canonical: 'nozzle' },
  { term: 'فوهه', canonical: 'nozzle' },
  { term: 'راس', canonical: 'nozzle' },
  { term: 'nozzles', canonical: 'nozzle' },

  { term: 'راتنج', canonical: 'resin' },
  { term: 'ريزن', canonical: 'resin' },
  { term: 'رزن', canonical: 'resin' },

  { term: 'قطع', canonical: 'parts' },
  { term: 'ملحقات', canonical: 'accessories' },
  { term: 'اكسسوارات', canonical: 'accessories' },
  { term: 'قطع غيار', canonical: 'parts' },
  { term: 'صيانة', canonical: 'maintenance' },
  { term: 'ضمان', canonical: 'warranty' },
  { term: 'مستعمل', canonical: 'used' },
  { term: 'مجدد', canonical: 'refurbished' },
  { term: 'باقة', canonical: 'bundle' },
  { term: 'كومبو', canonical: 'combo' },

  // ---- Materials. A shopper types the plastic, not the product name.
  { term: 'بي ال اي', canonical: 'pla' },
  { term: 'بلا', canonical: 'pla' },
  { term: 'بيتج', canonical: 'petg' },
  { term: 'بي تي جي', canonical: 'petg' },
  { term: 'ابس', canonical: 'abs' },
  { term: 'تي بي يو', canonical: 'tpu' },
  { term: 'مطاط', canonical: 'tpu' },
  { term: 'نايلون', canonical: 'nylon' },
  { term: 'كاربون', canonical: 'carbon' },
  { term: 'كربون', canonical: 'carbon' },
  { term: 'حرير', canonical: 'silk' },
  { term: 'شفاف', canonical: 'clear' },
  { term: 'اساسي', canonical: 'basic' },
  { term: 'بيسك', canonical: 'basic' },

  // ---- Technologies.
  { term: 'اف دي ام', canonical: 'fdm' },
  { term: 'ثلاثي الابعاد', canonical: '3d' },
  { term: 'ثري دي', canonical: '3d' },
  { term: 'سلا', canonical: 'sla' },

  // ---- The brands this shop actually carries, as Iraqi customers spell them.
  { term: 'بامبو', canonical: 'bambu' },
  { term: 'بمبو', canonical: 'bambu' },
  { term: 'بامبولاب', canonical: 'bambu' },
  { term: 'بامبو لاب', canonical: 'bambu' },
  { term: 'بانبو', canonical: 'bambu' },
  { term: 'bambulab', canonical: 'bambu' },

  { term: 'كريالتي', canonical: 'creality' },
  { term: 'كرياليتي', canonical: 'creality' },
  { term: 'كريلتي', canonical: 'creality' },

  { term: 'اي سن', canonical: 'esun' },
  { term: 'ايسن', canonical: 'esun' },

  { term: 'سناب ميكر', canonical: 'snapmaker' },
  { term: 'سنابميكر', canonical: 'snapmaker' },

  { term: 'كيدي', canonical: 'qidi' },
  { term: 'كيوداي', canonical: 'qidi' },

  { term: 'بيكو', canonical: 'biqu' },
  { term: 'بيك يو', canonical: 'biqu' },

  { term: 'بيج تري تك', canonical: 'bigtreetech' },
  { term: 'بيجتري', canonical: 'bigtreetech' },
  { term: 'btt', canonical: 'bigtreetech' },

  { term: 'انتنسكي', canonical: 'antinsky' },
  { term: 'أنتينسكي', canonical: 'antinsky' },

  // ---- Model names customers spell out. `./translit.ts` collapses
  // «اكس تو دي» mechanically; these are the ones that are written as a word.
  { term: 'اكس2دي', canonical: 'x2d' },
  { term: 'اكستودي', canonical: 'x2d' },
  { term: 'اي1', canonical: 'a1' },
  { term: 'ايه1', canonical: 'a1' },
  { term: 'بي1', canonical: 'p1' },
  { term: 'اتش2دي', canonical: 'h2d' },
  { term: 'يو1', canonical: 'u1' },
  { term: 'ايه ام اس', canonical: 'ams' },
  { term: 'امس', canonical: 'ams' },

  // ---- Attributes a shopper searches by.
  { term: 'مزدوج', canonical: 'dual' },
  { term: 'دبل', canonical: 'dual' },
  { term: 'ملون', canonical: 'color' },
  { term: 'الوان', canonical: 'color' },
  { term: 'سريع', canonical: 'fast' },
  { term: 'صغير', canonical: 'mini' },
  { term: 'ميني', canonical: 'mini' },
  { term: 'كبير', canonical: 'large' },
  { term: 'رخيص', canonical: 'cheap' },
  { term: 'عرض', canonical: 'offer' },
  { term: 'خصم', canonical: 'discount' },
];

/**
 * The seed, normalised and de-duplicated, as the table will hold it.
 *
 * NORMALISATION COLLAPSES ROWS, and it has to: «طابعة» and «طابعه» are written
 * separately above because both are typed, and `normalizeText` folds ta marbuta
 * onto ha so they become one term. The table's key is the normalised term, so
 * the duplicate has to go before the insert rather than fail it.
 *
 * A COLLISION THAT DISAGREES IS AN ERROR, not something to resolve silently. If
 * two spellings normalise to the same term but claim different meanings, one of
 * them is wrong and the person who added it needs to know — `tests/search.test.ts`
 * is what tells them.
 */
export function normalizedSynonymSeed(): { term: string; canonical: string }[] {
  const byTerm = new Map<string, string>();
  for (const row of SYNONYM_SEED) {
    const term = normalizeText(row.term);
    const canonical = normalizeText(row.canonical);
    if (!term || !canonical || term === canonical) continue;
    const have = byTerm.get(term);
    if (have !== undefined && have !== canonical) {
      throw new Error(
        `search vocabulary: "${term}" is mapped to both "${have}" and "${canonical}" — ` +
          'two spellings normalise to one term and claim different meanings.'
      );
    }
    byTerm.set(term, canonical);
  }
  return [...byTerm.entries()].map(([term, canonical]) => ({ term, canonical }));
}

/**
 * The seed as SQL VALUES rows, for the migration that creates the table.
 *
 * Emitted from the same constant the tests read, so the table and the code can
 * never describe different vocabularies. Terms are single-quote-escaped; there
 * is no user input here, and there never will be — the owner's additions go
 * through the admin API, which binds parameters.
 */
export function synonymSeedValues(): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  return normalizedSynonymSeed()
    .map((r) => `('${esc(r.term)}', '${esc(r.canonical)}')`)
    .join(',\n  ');
}
