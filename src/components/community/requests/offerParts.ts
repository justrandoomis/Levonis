/**
 * WHAT AN OFFER COVERS, ON THE CLIENT (plan P1-05, docs/DECISIONS.md row 267).
 *
 * Pure helpers the offer screens share and tests/offerCompareParts.test.ts
 * pins: whether an offer is partial or substitutes, the words for it, the
 * body acceptance sends, and the order offers are compared in. An offer from
 * an older Worker has no `coverage` and reads as the whole request with
 * nothing substituted, so every v1 screen and body is exactly as before.
 */
import type { OfferV2 } from './api';
import { fill, type RequestLang, type RequestStrings } from './strings';
import { entryColour, localMaterial, type MaterialLike } from './mirrors';

/** A part as the screens name it. */
export interface PartRef {
  id: string;
  name: string;
  position: number;
}

/** The offer makes only some of the parts. */
export const isPartialOffer = (o: Pick<OfferV2, 'coverage'>): boolean => !!o.coverage && o.coverage.covers_all === false;

/** The offer proposes another material or colour somewhere. */
export const substitutesSomething = (o: Pick<OfferV2, 'substitutions'>): boolean => (o.substitutions?.length ?? 0) > 0;

/** «القطعة 2» when a part has no name. */
export function partName(p: PartRef | undefined, s: RequestStrings): string {
  if (!p) return '';
  return p.name.trim() || fill(s.partN, { n: p.position + 1 });
}

/** The parts an offer covers and leaves out, in the request order. */
export function coverageOf(o: Pick<OfferV2, 'coverage'>, parts: PartRef[]): { covered: PartRef[]; uncovered: PartRef[] } {
  const ordered = [...parts].sort((a, b) => a.position - b.position);
  if (!isPartialOffer(o)) return { covered: ordered, uncovered: [] };
  const ids = new Set(o.coverage?.parts ?? []);
  return { covered: ordered.filter((p) => ids.has(p.id)), uncovered: ordered.filter((p) => !ids.has(p.id)) };
}

/**
 * «جزئي — القطع المشمولة 1/2», or an empty string for an offer that covers the
 * whole request. Before the parts of the request are known (fewer than it covers),
 * «جزئي» alone: never a count like 1/1 that reads as the whole job.
 */
export function partialLabel(o: Pick<OfferV2, 'coverage'>, partsTotal: number, s: RequestStrings): string {
  if (!isPartialOffer(o)) return '';
  const k = o.coverage?.parts?.length ?? 0;
  if (partsTotal <= k) return s.partialChipBare;
  return fill(s.partialChip, { k, n: partsTotal });
}

/**
 * A partial offer can be acknowledged only against the parts it leaves out,
 * named: the parts of the request are loaded, they hold every part the offer
 * covers, and at least one is left out. A whole offer needs no list. Until
 * then acceptance waits (P1-05 review 3: the parts come from a second read).
 */
export function partialAckReady(o: Pick<OfferV2, 'coverage'>, parts: PartRef[]): boolean {
  if (!isPartialOffer(o)) return true;
  const ids = new Set(parts.map((p) => p.id));
  const covered = o.coverage?.parts ?? [];
  return covered.length > 0 && covered.every((id) => ids.has(id)) && parts.some((p) => !covered.includes(p.id));
}

/** The list separator of the language: «، » in Arabic and Sorani, «, » in English. */
export const listSep = (lang: RequestLang): string => (lang === 'en' ? ', ' : '، ');

/**
 * One side of a substitution in the reader language: the catalogue name, then
 * the colours by name — «any colour» and «as in the reference» as words, so
 * a material-only substitute shows the colours that stay (P1-05 review 5).
 */
export function substitutionSide(v: { material_id: string; colors: Array<{ hex: string; label: string; mode?: string }> }, lang: RequestLang, materials: readonly MaterialLike[] = []): string {
  const colours = v.colors.map((c) => entryColour(c, lang)).filter(Boolean).join(listSep(lang));
  return [localMaterial(v.material_id, lang, materials), colours].filter(Boolean).join(' ');
}

/** One substitution in the words of the reader, each side apart, and the line they make. */
export interface SubstitutionPiece {
  to: string;
  from: string;
  part: string;
  line: string;
}

/**
 * Each substitution of an offer, its sides apart (P1-05 review 4): a screen
 * draws each side isolated (`SubstitutionText`) in the direction of the READER —
 * every common substitute starts with a Latin name (PLA, PETG, TPU), so a
 * line laid out by its first strong letter reads the swap backwards in
 * Arabic and Sorani.
 */
export function substitutionPieces(o: Pick<OfferV2, 'substitutions'>, parts: PartRef[], s: RequestStrings, lang: RequestLang, materials: readonly MaterialLike[] = []): SubstitutionPiece[] {
  return (o.substitutions ?? []).map((x) => {
    const v = {
      to: substitutionSide(x.to, lang, materials),
      from: substitutionSide(x.from, lang, materials),
      part: partName(parts.find((p) => p.id === x.part_id), s) || '—',
    };
    return { ...v, line: fill(s.substitutionRow, v) };
  });
}

/** «PETG بدل TPU (المقبض)» — each substitution of an offer in the words of the reader. */
export function substitutionLines(o: Pick<OfferV2, 'substitutions'>, parts: PartRef[], s: RequestStrings, lang: RequestLang, materials: readonly MaterialLike[] = []): string[] {
  return substitutionPieces(o, parts, s, lang, materials).map((x) => x.line);
}

/** The direction of the reader — for a line the screen writes itself, never `auto`. */
export const readerDir = (lang: RequestLang): 'ltr' | 'rtl' => (lang === 'en' ? 'ltr' : 'rtl');

/**
 * WHAT ACCEPTANCE SENDS — the total and the version on screen, and an
 * acknowledgement only for what this offer needs one for: an offer that
 * covers everything and substitutes nothing sends exactly the v1 body.
 */
export function acceptBody(
  o: Pick<OfferV2, 'total_iqd' | 'revision' | 'delivery_method' | 'coverage' | 'substitutions'>,
  addressId: string
): { expected_total_iqd: number; offer_revision: number; address_id?: string; accept_substitutions?: true; accept_partial?: true } {
  return {
    expected_total_iqd: o.total_iqd ?? 0,
    offer_revision: o.revision,
    ...(addressId && o.delivery_method !== 'pickup' ? { address_id: addressId } : {}),
    ...(substitutesSomething(o) ? { accept_substitutions: true as const } : {}),
    ...(isPartialOffer(o) ? { accept_partial: true as const } : {}),
  };
}

/** An offer the customer can still take. */
export function offerIsLive(o: OfferV2): boolean {
  return o.state === 'pending' && !o.stale && !o.expired && !o.workshop_unable;
}

/**
 * The three best-in-class picks for the quick comparison. Cheapest and
 * fastest are chosen among the COMPLETE offers when there are any: a partial
 * offer is cheaper and faster because it makes less. `completeOnly` is true
 * only when that choice left a live partial offer out — the one case the
 * screen says «among the complete offers».
 */
export function bestOffers(offers: OfferV2[]): { cheapest: OfferV2 | null; fastest: OfferV2 | null; topRated: OfferV2 | null; completeOnly: boolean } {
  const live = offers.filter(offerIsLive);
  const complete = live.filter((o) => !isPartialOffer(o));
  const pool = complete.length ? complete : live;
  const by = (key: (o: OfferV2) => number) => pool.reduce<OfferV2 | null>((best, o) => (best === null || key(o) < key(best) ? o : best), null);
  const rated = live.filter((o) => o.merchant?.rating != null);
  return {
    cheapest: by((o) => o.total_iqd ?? Number.MAX_SAFE_INTEGER),
    fastest: by((o) => o.completion_days || Number.MAX_SAFE_INTEGER),
    topRated: rated.reduce<OfferV2 | null>((best, o) => (best === null || (o.merchant!.rating ?? 0) > (best.merchant!.rating ?? 0) ? o : best), null),
    completeOnly: complete.length > 0 && live.some(isPartialOffer),
  };
}

export type OfferSort = 'price' | 'time' | 'rating';

/**
 * The accepted offer first, then the ones that can still be taken, each group
 * in the chosen order; by price or time a partial offer comes after the
 * complete ones.
 */
export function sortOffers(offers: OfferV2[], sort: OfferSort): OfferV2[] {
  const rank = (o: OfferV2) => (o.state === 'accepted' ? 0 : offerIsLive(o) ? (sort !== 'rating' && isPartialOffer(o) ? 2 : 1) : 3);
  const key = (o: OfferV2) => (sort === 'price' ? o.total_iqd ?? Number.MAX_SAFE_INTEGER : sort === 'time' ? o.completion_days || 9999 : -(o.merchant?.rating ?? 0));
  return [...offers].sort((a, b) => rank(a) - rank(b) || key(a) - key(b));
}
