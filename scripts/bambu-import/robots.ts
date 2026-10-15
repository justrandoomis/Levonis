/**
 * robots.txt OF THE STORE (Bambu import spec §J.1, §B.5 ACCESS_CHALLENGE).
 *
 * Re-read once per job. A `Disallow` that matches a planned URL (a product
 * page, a sitemap) stops that item: BLOCKED ACCESS_CHALLENGE (policy). The
 * rules are read the way RFC 9309 says: the group of the most specific
 * matching user agent (ours, `LevonisCatalogImport`, else `*`), the longest
 * matching pattern wins, `Allow` wins a tie, `*` matches any run of
 * characters and a trailing `$` anchors the end.
 */

export const OUR_AGENT = 'levoniscatalogimport';

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  rules: RobotsRule[];
  /** True when the file could not be read as robots.txt (4xx: everything allowed, RFC 9309 §2.3.1.3). */
  missing: boolean;
}

/** Parses robots.txt and keeps the group that applies to us. */
export function parseRobots(text: string, agent = OUR_AGENT): Robots {
  type Group = { agents: string[]; rules: RobotsRule[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow allows everything: it is no rule.
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a.replace(/\/.*$/, ''))));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules), missing: false };
}

export const NO_ROBOTS: Robots = { rules: [], missing: true };

function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Is this path (with its query) allowed for us? */
export function robotsAllows(robots: Robots, pathAndQuery: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of robots.rules) {
    if (!patternRegex(rule.pattern).test(pathAndQuery)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { length, allow: rule.allow };
  }
  return best ? best.allow : true;
}

/** The store paths the import plans to read (§J.1): product pages, the three sitemaps, robots.txt. */
export function productPath(handle: string): string {
  return `/products/${encodeURIComponent(handle)}`;
}
export const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_products_1.xml', '/sitemap_collections_1.xml'] as const;
