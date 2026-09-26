/**
 * THE PRINTER FINDER'S ANSWERS IN THE URL (docs/ux/CATALOG_DISCOVERY.md §8).
 *
 *   /printer-finder?use=business&tech=fdm&budget=1250000-2500000&sale=any
 *     &prio=speed,colors&level=intermediate
 *
 * Each answer `replaceState`s the query string, so a refresh never loses
 * progress, and with all six present the page opens on its results. A skipped
 * step is an answer too (`tech=any`, `budget=any`, `prio=none`).
 *
 * The grammar lives in packages/catalog/src/discovery.ts, which the Worker's
 * `/api/printer-finder` parses with — one reading of every value.
 */
import {
  EMPTY_FINDER,
  encodePairs,
  finderParamPairs,
  parseFinderParams,
  type FinderAnswers,
} from '../../../packages/catalog/src/discovery';

export {
  EMPTY_FINDER,
  FINDER_BUDGETS,
  FINDER_BUDGET_IDS,
  FINDER_KEYS,
  FINDER_LEVELS,
  FINDER_PRIORITIES,
  FINDER_SALES,
  FINDER_TECHS,
  FINDER_USES,
  MAX_FINDER_PRIORITIES,
  finderBudgetRange,
  finderComplete,
} from '../../../packages/catalog/src/discovery';

/** A query string (with or without `?`) → answers; unknown values dropped. */
export function parseAnswers(search: string | URLSearchParams): FinderAnswers {
  const p = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  return parseFinderParams((k) => p.get(k));
}

/** Answers → a query string WITHOUT `?`; '' when nothing is answered. */
export function serializeAnswers(a: FinderAnswers): string {
  return encodePairs(finderParamPairs(a));
}

/** A fresh, unanswered state. */
export const emptyAnswers = (): FinderAnswers => ({ ...EMPTY_FINDER });
