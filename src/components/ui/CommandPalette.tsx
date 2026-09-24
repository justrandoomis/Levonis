/**
 * COMMANDPALETTE — ⌘K / Ctrl+K: go anywhere, do anything, by typing.
 *
 * The primitive only; the DATA is the caller's (the workspace's nav table,
 * its quick actions, and — through `onQueryChange` — server search results).
 *
 * THE SHORTCUT MATCHES THE KEY'S POSITION, NOT ITS LETTER. `e.key === 'k'`
 * dies on an Arabic or a Kurdish layout, where that key types «ن» / «ک»; the
 * merchant dashboard's quick find had exactly this bug, and AdminProducts
 * fixed the same one with `e.code === 'KeyK'` (DECISIONS row 82). So does this.
 *
 * A COMBOBOX, SAID OUT LOUD (the mechanics of LiveSearch): the input is
 * `role="combobox"` controlling a `listbox`; ↑/↓ move a highlight announced
 * through `aria-activedescendant` while focus stays in the field, so typing
 * never stops; Enter opens the highlighted row. Groups are real `group`s with
 * their names. An IME composition is never interrupted.
 *
 * ESCAPE IS TWO-STAGE: with text in the field it clears the text; on an empty
 * field it closes the palette (through the overlay stack, so a palette opened
 * over a sheet closes alone). Focus returns to wherever it was.
 *
 * SEARCH folds the letter variants of Arabic and Kurdish keyboards, diacritics
 * and digits (`normalizeSearchText`), so «اسعار» finds «أسعار» and «١٢» finds
 * «12»; a label that starts with the query ranks above one that merely
 * contains it. With an empty query the most recent choices come first —
 * stored per `recentKey`, in this browser only, and never required.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { filterByQuery } from '../../lib/listNav';
import { Overlay } from './Overlay';
import Spinner from './Spinner';

export interface CommandItem {
  id: string;
  label: string;
  /** Quieter text after the label: the section, an order number. Searched too. */
  hint?: string;
  icon?: React.ReactNode;
  /** More words that should find it, e.g. the other languages' names of a page. */
  keywords?: string[];
  /** Go somewhere (in-app path)… */
  href?: string;
  /** …or do something. */
  onSelect?: () => void;
}

export interface CommandGroup {
  id: string;
  label: string;
  items: CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandGroup[];
  /** Remember recent choices under this key (per merchant, say). Omit: no recents. */
  recentKey?: string;
  placeholder?: string;
  /** The dialog's accessible name. */
  label?: string;
  /** The query as typed, for callers that also search the server (debounce there). */
  onQueryChange?: (query: string) => void;
  /** A server search is in flight. */
  loading?: boolean;
}

const RECENT_MAX = 5;

function readRecent(key?: string): string[] {
  if (!key) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(key: string | undefined, id: string): void {
  if (!key) return;
  try {
    const next = [id, ...readRecent(key).filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* storage unavailable: recents are a convenience, not a requirement */
  }
}

/** ⌘K (Mac) / Ctrl+K elsewhere, matched by key POSITION so every layout works. */
export function isPaletteShortcut(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return e.code === 'KeyK' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** Opens the palette on ⌘K / Ctrl+K anywhere on the page. */
export function useCommandPaletteShortcut(onOpen: () => void, enabled = true): void {
  const latest = useRef(onOpen);
  useEffect(() => {
    latest.current = onOpen;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPaletteShortcut(e)) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

interface Row {
  item: CommandItem;
  group: string;
  groupLabel: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  recentKey,
  placeholder,
  label,
  onQueryChange,
  loading = false,
}: CommandPaletteProps) {
  const { loc } = useLanguage();
  const navigate = useNavigate();
  const uid = useId();
  const listId = `${uid}-list`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);

  // Every opening starts clean, with the recents as stored now.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setRecent(readRecent(recentKey));
  }, [open, recentKey]);

  // OWNER: Sorani to be written by hand.
  const recentLabel = loc('الأخيرة', 'Recent');

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (!query.trim()) {
      const byId = new Map(groups.flatMap((g) => g.items).map((it) => [it.id, it] as const));
      const recents = recent.map((id) => byId.get(id)).filter((x): x is CommandItem => !!x);
      for (const item of recents) out.push({ item, group: '__recent', groupLabel: recentLabel });
      const shown = new Set(recents.map((r) => r.id));
      for (const g of groups) for (const item of g.items) if (!shown.has(item.id)) out.push({ item, group: g.id, groupLabel: g.label });
      return out;
    }
    for (const g of groups) for (const item of filterByQuery(g.items, query)) out.push({ item, group: g.id, groupLabel: g.label });
    return out;
  }, [groups, query, recent, recentLabel]);

  const current = rows.length ? Math.min(active, rows.length - 1) : -1;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => {
    if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
    // optionId derives from a stable useId value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const choose = (row: Row) => {
    writeRecent(recentKey, row.item.id);
    onOpenChange(false);
    if (row.item.href) navigate(row.item.href);
    row.item.onSelect?.();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (Math.min(a, rows.length - 1) + delta + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      if (current < 0) return;
      e.preventDefault();
      choose(rows[current]);
    } else if (e.key === 'Escape' && query) {
      // First Escape clears; the overlay stack sees a handled key and stays open.
      e.preventDefault();
      setQuery('');
      setActive(0);
      onQueryChange?.('');
    }
  };

  // The flat list is what ↑/↓ walk; the sections are how it is read.
  const sections: Array<{ key: string; label: string; rows: Array<{ row: Row; index: number }> }> = [];
  rows.forEach((row, index) => {
    const last = sections[sections.length - 1];
    if (!last || last.key !== row.group) sections.push({ key: row.group, label: row.groupLabel, rows: [] });
    sections[sections.length - 1].rows.push({ row, index });
  });

  return (
    <Overlay
      open={open}
      onClose={() => onOpenChange(false)}
      label={label ?? loc('بحث', 'Search', 'گەڕان')}
      placement="top"
      initialFocus={inputRef}
      testId="command-palette"
      className="sm:pt-[12vh]"
      panelClassName="flex w-full max-w-xl flex-col overflow-hidden"
    >
      {/* The field's focus is shown on its whole row: the caret alone is not a focus indicator. */}
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 focus-within:border-focus" data-command-field>
        <Search aria-hidden="true" className="h-[18px] w-[18px] shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-label={label ?? loc('بحث', 'Search', 'گەڕان')}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={placeholder ?? loc('بحث…', 'Search…', 'گەڕان…')}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
            onQueryChange?.(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          className="min-h-14 min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-muted"
        />
        {loading && <Spinner size="sm" delayMs={0} />}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={label ?? loc('بحث', 'Search', 'گەڕان')}
        className="max-h-[min(60dvh,26rem)] overflow-y-auto overscroll-contain p-2"
      >
        {rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-text-muted" role="status">
            {loc('لا توجد نتائج', 'No results', 'هیچ ئەنجامێک نییە')}
          </p>
        ) : (
          sections.map((section) => {
            const headingId = `${uid}-g-${section.key}`;
            return (
              <div key={section.key} role="group" aria-labelledby={headingId} data-command-group={section.key}>
                <div id={headingId} aria-hidden="true" className="px-3 pb-1 pt-3 text-[12px] font-semibold text-text-muted">
                  {section.label}
                </div>
                {section.rows.map(({ row, index }) => {
                  const selected = index === current;
                  return (
                    <div
                      key={row.item.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={selected}
                      data-command={row.item.id}
                      onPointerDown={(e) => e.preventDefault()}
                      onPointerMove={() => {
                        if (!selected) setActive(index);
                      }}
                      onClick={() => choose(row)}
                      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-sm ${
                        selected ? 'bg-white/[0.07] text-text-primary' : 'text-text-secondary'
                      }`}
                    >
                      {row.item.icon && (
                        <span aria-hidden="true" className="shrink-0 text-text-muted">
                          {row.item.icon}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{row.item.label}</span>
                      {row.item.hint && <span className="max-w-[40%] shrink-0 truncate text-[12px] text-text-muted">{row.item.hint}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
      <div aria-hidden="true" className="hidden items-center gap-3 border-t border-border-subtle px-4 py-2 text-[12px] text-text-muted sm:flex" dir="ltr">
        <span className="flex items-center gap-1">
          <kbd className="rounded border border-border-subtle px-1.5 font-sans">↑</kbd>
          <kbd className="rounded border border-border-subtle px-1.5 font-sans">↓</kbd>
        </span>
        <kbd className="rounded border border-border-subtle px-1.5 font-sans">↵</kbd>
        <kbd className="rounded border border-border-subtle px-1.5 font-sans">Esc</kbd>
      </div>
    </Overlay>
  );
}
