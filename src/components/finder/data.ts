/**
 * The finder's two calls (docs/ux/CATALOG_DISCOVERY.md §11–12): `/meta` once
 * per visit (viewer-independent, cached at the edge), and the results once per
 * answer set. All six questions are local; nothing else touches the network.
 */
import { api, type RequestOptions } from '../../lib/api';
import { serializeAnswers } from '../../lib/finder/answers';
import type { FinderAnswers } from '../../../packages/catalog/src/discovery';
import type { FinderMeta } from '../../../packages/catalog/src/discoveryTypes';
import type { FinderResponse } from '../../lib/catalog/types';

let metaPromise: Promise<FinderMeta> | null = null;

/** The live counts behind questions 2 and 3. One request per visit; a failure is retried on the next ask. */
export function fetchFinderMeta(): Promise<FinderMeta> {
  if (!metaPromise) {
    metaPromise = api.get<FinderMeta>('/api/printer-finder/meta', { mascot: 'silent' }).catch((err) => {
      metaPromise = null;
      throw err;
    });
  }
  return metaPromise;
}

export function fetchFinderResults(a: FinderAnswers, opts?: RequestOptions): Promise<FinderResponse> {
  return api.get<FinderResponse>(`/api/printer-finder?${serializeAnswers(a)}`, opts);
}

/** «تحدث معنا» — the support intake, carrying the answers (S8 echoes them as the first message). */
export function supportHref(a: FinderAnswers): string {
  const answers = serializeAnswers(a);
  return `/support?ask=choose_printer${answers ? `&finder=${encodeURIComponent(answers)}` : ''}`;
}
