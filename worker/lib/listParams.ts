/**
 * A LIST'S QUERY FILTERS, read one way (plan B3; the closed lists are
 * packages/contracts/src/communityFilters.ts).
 *
 * A filter that is absent or empty is no filter (''). A value outside its
 * list is refused 400 with the list named, never read into SQL and never
 * silently dropped: a page that asked for something the server does not know
 * must hear so, or it would show an unfiltered list under a filter's label.
 */
import { badRequest, oneOf } from './http';
import { IRAQ_GOVERNORATES } from './iraqGovernorates';

/** '' when absent or empty, else one of `allowed` (400 otherwise). */
export function optionalOneOf<T extends string>(raw: string | undefined, name: string, allowed: readonly T[]): T | '' {
  const v = (raw ?? '').trim();
  return v === '' ? '' : oneOf(v, name, allowed);
}

const GOVERNORATE_IDS = new Set(IRAQ_GOVERNORATES.map((g) => g.id));

/**
 * A governorate filter: '' when absent, else one of the eighteen ids
 * (worker/lib/iraqGovernorates.ts). A label or a misspelling is refused, not
 * guessed: the stored column holds ids, so a label could only ever match
 * nothing.
 */
export function governorateParam(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (v === '') return '';
  if (!GOVERNORATE_IDS.has(v)) throw badRequest(`governorate must be one of: ${[...GOVERNORATE_IDS].join(', ')}`);
  return v;
}
