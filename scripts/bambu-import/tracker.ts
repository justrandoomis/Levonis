/**
 * TRACKER LINKS (Bambu import spec §C.5, §J.2).
 *
 * A store description links some documents through `https://e.bambulab.com/t?c=…`.
 * Each is resolved during ENRICH by ONE `HEAD` with `redirect: 'manual'`,
 * reading `Location` and never following it. The target is kept only when its
 * host is allow-listed (wiki.bambulab.com, store.bblcdn.com, www.youtube.com,
 * youtube.com, makerworld.com); it becomes a document whose `tracker_source`
 * is the tracker URL. A challenge, an error, no redirect or another host is
 * `tracker_unresolved` and gives no document. A challenge is never bypassed.
 */
import { TRACKER_TARGET_HOSTS } from '@levonis/catalog/bambuImport/registry/documents';
import { hostOf, keptLinkUrl } from '@levonis/catalog/bambuImport/normalize';
import { HostFetcher, ImportStop, isChallenge } from './fetch';

export type TrackerOutcome = 'resolved' | 'host_not_allowed' | 'challenge' | 'no_redirect' | 'error';

export interface TrackerResult {
  /** The tracker URL (owner-only provenance: never logged). */
  tracker: string;
  text: string;
  outcome: TrackerOutcome;
  /** The kept target URL (query stripped), when resolved. */
  target: string;
  status: number;
}

export const MAX_TRACKERS_PER_PRODUCT = 5;

export async function resolveTracker(fetcher: HostFetcher, link: { url: string; text: string }, afterMs: number): Promise<TrackerResult> {
  const base = { tracker: link.url, text: link.text, target: '', status: 0 };
  let res;
  try {
    res = await fetcher.request(link.url, { method: 'HEAD', redirect: 'manual' }, afterMs);
  } catch (err) {
    if (err instanceof ImportStop && err.kind === 'deadline') throw err;
    return { ...base, outcome: 'error' };
  }
  if (isChallenge(res.status, res.headers, '')) return { ...base, status: res.status, outcome: 'challenge' };
  if (res.status < 300 || res.status >= 400) return { ...base, status: res.status, outcome: 'no_redirect' };
  const location = res.headers.get('location') ?? '';
  let target = '';
  try {
    target = keptLinkUrl(new URL(location, link.url).toString()).replace(/^http:/i, 'https:');
  } catch {
    return { ...base, status: res.status, outcome: 'error' };
  }
  if (!target.startsWith('https://') || !TRACKER_TARGET_HOSTS.has(hostOf(target))) return { ...base, status: res.status, outcome: 'host_not_allowed' };
  return { ...base, status: res.status, target, outcome: 'resolved' };
}
