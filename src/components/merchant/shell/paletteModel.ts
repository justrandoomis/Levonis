/**
 * WHAT THE COMMAND PALETTE LISTS — pure, so the tests can hold it.
 *
 * The palette primitive (src/components/ui/CommandPalette.tsx) owns the
 * keyboard, the combobox semantics, the fuzzy local filter and the recents.
 * The workspace hands it three kinds of rows:
 *
 *   «الانتقال إلى»  every destination of the ONE nav table (./nav.ts) — the
 *                   same list the sidebar, the rail and the bottom tabs read,
 *                   with the other languages' names as keywords, so typing
 *                   «orders» in Arabic chrome still finds «الطلبات»;
 *   «إجراءات»        the quick actions (new product / coupon / section,
 *                   view the store) — real routes only;
 *   results         the server's search (GET /api/merchant/search), shown
 *                   ONLY for the query they answer. Each carries that query
 *                   as a keyword: the server matched it on a field the label
 *                   may not show (an SKU, a phone number), and the local
 *                   filter must not throw the row away for that.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { CommandGroup, CommandItem } from '../../ui/CommandPalette';
import { visibleNav, sectionPath, type NavEntry } from './nav';
import { W, orderStatusLabel, say, type Loc } from './strings';

/** The server wants 2–60 characters; the palette asks nothing below 2. */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 60;
/** How long typing must pause before the server is asked. */
export const SEARCH_DEBOUNCE_MS = 250;

export function searchable(query: string): boolean {
  const n = [...query.trim()].length;
  return n >= SEARCH_MIN && n <= SEARCH_MAX;
}

export interface SearchResults {
  /** The query these rows answer, as sent. */
  q: string;
  orders: Array<{ id: string; status: string; total_iqd: number; link: string }>;
  products: Array<{ id: string; name: string; name_ar: string; publish_state: string; price_iqd: number; link: string }>;
  customers: Array<{ name: string; order_count: number; link: string }>;
}

export interface QuickAction {
  id: string;
  label: string;
  hint?: string;
  href?: string;
  onSelect?: () => void;
  icon?: ReactNode;
}

export interface PaletteInput {
  loc: Loc;
  lang: 'ar' | 'en' | 'ckb';
  base: string;
  query: string;
  results: SearchResults | null;
  actions: QuickAction[];
  /** Formats a dinar figure (the palette shows it as text). */
  money: (iqd: number) => string;
  /** A workspace link as this host serves it. */
  href: (link: string) => string;
  icon?: (Icon: LucideIcon) => ReactNode;
  entries?: readonly NavEntry[];
}

/** Every language's name for an entry, so any of them finds it. */
function keywordsOf(e: NavEntry): string[] {
  return [e.label[0], e.label[1], ...(e.label[2] ? [e.label[2]] : []), ...(e.keywords ?? [])];
}

export function paletteGroups(input: PaletteInput): CommandGroup[] {
  const { loc, lang, base, query, results, actions, money, href, icon } = input;
  const entries = input.entries ?? visibleNav();
  const groups: CommandGroup[] = [];

  groups.push({
    id: 'nav',
    label: say(loc, W.goTo),
    items: entries.map(
      (e): CommandItem => ({
        id: `nav:${e.id}`,
        label: say(loc, e.label),
        keywords: keywordsOf(e),
        href: sectionPath(e.id, base),
        ...(icon ? { icon: icon(e.icon) } : {}),
      })
    ),
  });

  if (actions.length) {
    groups.push({
      id: 'actions',
      label: say(loc, W.actions),
      items: actions.map((a) => ({ id: `action:${a.id}`, label: a.label, hint: a.hint, href: a.href, onSelect: a.onSelect, icon: a.icon })),
    });
  }

  // Results belong to the query they answer; a stale answer is not shown.
  const q = query.trim();
  if (results && q && results.q === q) {
    const kw = [q];
    const items: CommandItem[] = [
      ...results.orders.map((o) => ({
        id: `order:${o.id}`,
        label: o.id,
        hint: `${orderStatusLabel(o.status, loc)} · ${money(o.total_iqd)}`,
        keywords: kw,
        href: href(o.link),
      })),
      ...results.products.map((p) => ({
        id: `product:${p.id}`,
        label: (lang === 'en' ? p.name || p.name_ar : p.name_ar || p.name) || p.id,
        hint: money(p.price_iqd),
        keywords: [...kw, p.name, p.name_ar].filter(Boolean),
        href: href(p.link),
      })),
      ...results.customers.map((c, i) => ({
        id: `customer:${i}:${c.link}`,
        label: c.name || '—',
        // CustomersTab's own line, verbatim.
        hint: loc(`${c.order_count} طلب`, `${c.order_count} orders`, `${c.order_count} داواکاری`),
        keywords: kw,
        href: href(c.link),
      })),
    ];
    if (items.length) groups.push({ id: 'results', label: say(loc, W.results), items });
  }
  return groups;
}

/**
 * ⌘K / Ctrl+K by the key's POSITION (`code`), so it works on an Arabic or a
 * Kurdish layout where that key types «ن» / «ک» — the same rule as the
 * palette primitive's `isPaletteShortcut`, repeated here so the shell can
 * listen for it without downloading the palette before it is first opened.
 */
export function isPaletteKey(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return e.code === 'KeyK' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}
