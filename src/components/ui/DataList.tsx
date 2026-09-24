/**
 * DATALIST — a table where there is room for one, cards where there is not.
 *
 * WHAT WAS WRONG. The products manager drew a `min-w-[680px]` table inside
 * `overflow-x-auto`, so on a phone a merchant scrolled sideways to find the
 * price of the product they were looking at; its grid and compact views were a
 * manual choice, not a response to the screen. And lists everywhere started
 * from `[]`, so a failed request looked exactly like "you have none".
 *
 * WHAT THIS DOES.
 *
 *   ONE STRUCTURE MOUNTED, CHOSEN BY THE CONTAINER. A real `<table>` (with a
 *   caption, `scope="col"` headers, numbers end-aligned in tabular digits)
 *   when the CONTAINER is at least `wideAt` px, otherwise a `<ul>` of cards
 *   with the same columns re-cast as title / meta / label-value pairs. The
 *   decision is JavaScript and only one of the two is ever in the DOM (the
 *   `useIsWide` reasoning in compare/useIsWide.ts: hiding one with CSS would
 *   read every row twice to a screen reader). It measures the container, not
 *   the viewport, because the workspace has a sidebar and the builder preview
 *   is a narrow frame inside a wide window.
 *
 *   THE STATES ARE DISTINCT (`listView`, src/lib/listView.ts): not-loaded is
 *   a skeleton of the right layout, a failure is the shared `ErrorState` with
 *   retry — never the empty state — a failed refresh keeps the rows it had and
 *   says the refresh failed, and only a successful, empty answer is «empty».
 *
 *   ROW ACTIONS in the shared `Menu` (anchored on a desktop, a sheet under a
 *   thumb), from a button named for its row. On a wide table the actions
 *   column is STICKY at the inline end, so it stays reachable however far a
 *   wide table is scrolled.
 *
 *   SELECTION for bulk work: a checkbox per row, a select-all that shows
 *   "some" as indeterminate, and — only while something is selected — an
 *   in-flow bar with the count (announced politely) and the caller's bulk
 *   actions.
 *
 *   ROWS ARE OPENED BY A LINK, the title cell (`rowHref`), never by a
 *   clickable `<tr>`: a link is reachable by keyboard, announced, and opens in
 *   a new tab when asked to.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { isWideLayout, listView } from '../../lib/listView';
import { EmptyState, ErrorState } from './AsyncStates';
import { IconButton } from './Button';
import { ListRowsSkeleton, TableRowsSkeleton } from './DashboardSkeletons';
import { Menu, type MenuEntry } from './Menu';
import { Checkbox } from './Switch';

export interface DataListColumn<T> {
  id: string;
  /** Column header on the table; the field's label on a card. */
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /**
   * The column's part on a card: `title` (the row's name — one column),
   * `badge` (a status chip beside the title, at the inline end), `meta` (a
   * quiet line under the title), `field` (a label/value pair — the default),
   * or `hidden` (table only).
   */
  card?: 'title' | 'badge' | 'meta' | 'field' | 'hidden';
  /** Money, counts, dates-as-numbers: end-aligned and tabular. */
  numeric?: boolean;
  /** Table column width, e.g. '40%' or '9rem'. */
  width?: string;
}

export interface DataListSelection {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** The bulk actions, shown while anything is selected. */
  actions?: React.ReactNode;
}

export interface DataListProps<T> {
  /** What the list is: the table's caption and the card list's name. */
  label: string;
  columns: DataListColumn<T>[];
  /** undefined/null until the first answer — never `[]` for "not loaded". */
  rows: readonly T[] | null | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  /** The failure, if the last load failed (an ApiError is classified for you). */
  error?: unknown;
  onRetry?: () => void;
  /** What a successful, empty answer says. */
  empty?: { title?: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode };
  /** The row's actions; separators allowed. */
  rowActions?: (row: T) => MenuEntry[];
  /** The row's name, for the accessible names of its checkbox and actions button. */
  rowLabel?: (row: T) => string;
  /** Where the row opens; its title cell becomes that link. */
  rowHref?: (row: T) => string;
  selection?: DataListSelection;
  /** Container width, in px, at which the table replaces the cards. */
  wideAt?: number;
  skeletonRows?: number;
  className?: string;
}

function useWideContainer(wideAt: number): [React.RefObject<HTMLDivElement | null>, boolean | null] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured before the first paint, so the wrong layout never flashes.
    const measure = () => setWide((was) => isWideLayout(el.clientWidth, wideAt, was));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [wideAt]);
  return [ref, wide];
}

export function DataList<T>({
  label,
  columns,
  rows,
  rowKey,
  loading = false,
  error,
  onRetry,
  empty,
  rowActions,
  rowLabel,
  rowHref,
  selection,
  wideAt = 640,
  skeletonRows = 5,
  className = '',
}: DataListProps<T>) {
  const { loc } = useLanguage();
  const [ref, wide] = useWideContainer(wideAt);
  const view = listView(rows, loading, error);
  const list = rows ?? [];
  const keys = list.map(rowKey);
  const chosen = selection ? keys.filter((k) => selection.selected.has(k)) : [];
  const allChosen = keys.length > 0 && chosen.length === keys.length;
  const nameOf = (row: T) => rowLabel?.(row) ?? rowKey(row);
  const titleColumn = columns.find((c) => c.card === 'title') ?? columns[0];

  // Words. «إجراءات» / «کردارەکان» already exist, hand-written; the selection
  // phrases do not.
  const actionsFor = (row: T) => `${loc('إجراءات', 'Actions', 'کردارەکان')}: ${nameOf(row)}`;
  // OWNER: Sorani to be written by hand.
  const selectRow = (row: T) => loc(`تحديد ${nameOf(row)}`, `Select ${nameOf(row)}`);
  // OWNER: Sorani to be written by hand.
  const selectAll = loc('تحديد الكل', 'Select all');
  // OWNER: Sorani to be written by hand.
  const selectedCount = loc(`${chosen.length} محدد`, `${chosen.length} selected`);
  // OWNER: Sorani to be written by hand.
  const clearSelection = loc('إلغاء التحديد', 'Clear selection');

  const toggleRow = (key: string, on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (on) next.add(key);
    else next.delete(key);
    selection.onChange(next);
  };
  const toggleAll = (on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    selection.onChange(next);
  };

  const titleCell = (row: T) => {
    const content = titleColumn.cell(row);
    const href = rowHref?.(row);
    return href ? (
      <Link to={href} className="rounded-sm font-semibold text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {content}
      </Link>
    ) : (
      <span className="font-semibold text-text-primary">{content}</span>
    );
  };

  const actionsMenu = (row: T) => {
    const entries = rowActions?.(row) ?? [];
    if (entries.length === 0) return null;
    return (
      <Menu
        label={actionsFor(row)}
        items={entries}
        trigger={(props) => <IconButton {...props} label={actionsFor(row)} icon={<MoreHorizontal className="h-[18px] w-[18px]" />} />}
      />
    );
  };

  const table = () => (
    <div className="overflow-x-auto" data-datalist-scroll>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="text-[12px] text-text-muted">
            {selection && (
              <th scope="col" className="w-12 border-b border-border-subtle ps-2">
                <Checkbox checked={allChosen} indeterminate={chosen.length > 0 && !allChosen} onChange={toggleAll} aria-label={selectAll} />
              </th>
            )}
            {columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={`border-b border-border-subtle px-4 py-3 font-semibold ${c.numeric ? 'text-end' : 'text-start'}`}
              >
                {c.header}
              </th>
            ))}
            {rowActions && (
              <th scope="col" className="sticky end-0 w-14 border-b border-border-subtle bg-surface">
                <span className="sr-only">{loc('إجراءات', 'Actions', 'کردارەکان')}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {list.map((row) => {
            const key = rowKey(row);
            const on = !!selection?.selected.has(key);
            return (
              <tr key={key} data-row={key} aria-selected={selection ? on : undefined} className={on ? 'bg-surface-selected' : ''}>
                {selection && (
                  <td className="border-b border-border-subtle ps-2">
                    <Checkbox checked={on} onChange={(v) => toggleRow(key, v)} aria-label={selectRow(row)} />
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className={`border-b border-border-subtle px-4 py-3 align-middle ${
                      c.numeric ? 'text-end tabular-nums' : 'text-start'
                    } ${c === titleColumn ? '' : 'text-text-secondary'}`}
                  >
                    {c === titleColumn ? titleCell(row) : c.cell(row)}
                  </td>
                ))}
                {rowActions && (
                  <td className={`sticky end-0 border-b border-border-subtle px-1 ${on ? 'bg-surface-selected' : 'bg-surface'}`}>
                    {actionsMenu(row)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const cards = () => (
    <ul aria-label={label} className="divide-y divide-border-subtle">
      {list.map((row) => {
        const key = rowKey(row);
        const on = !!selection?.selected.has(key);
        const meta = columns.filter((c) => c.card === 'meta');
        const badges = columns.filter((c) => c.card === 'badge');
        const fields = columns.filter((c) => c !== titleColumn && (c.card ?? 'field') === 'field');
        return (
          <li key={key} data-row={key} aria-selected={selection ? on : undefined} className={`flex items-start gap-2 py-2 pe-1 ps-3 ${on ? 'bg-surface-selected' : ''}`}>
            {selection && (
              <Checkbox checked={on} onChange={(v) => toggleRow(key, v)} aria-label={selectRow(row)} className="-ms-2 shrink-0" />
            )}
            <div className="min-w-0 flex-1 py-2">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <div className="min-w-0 break-words text-[15px] leading-snug">{titleCell(row)}</div>
                {badges.map((c) => (
                  <div key={c.id} className="shrink-0">
                    {c.cell(row)}
                  </div>
                ))}
              </div>
              {meta.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[13px] text-text-muted">
                  {meta.map((c) => (
                    <span key={c.id} className="min-w-0">
                      {c.cell(row)}
                    </span>
                  ))}
                </div>
              )}
              {fields.length > 0 && (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
                  {fields.map((c) => (
                    <div key={c.id} className="min-w-0">
                      <dt className="text-[12px] text-text-muted">{c.header}</dt>
                      <dd className={`min-w-0 break-words text-text-primary ${c.numeric ? 'tabular-nums' : ''}`}>{c.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {rowActions && <div className="shrink-0">{actionsMenu(row)}</div>}
          </li>
        );
      })}
    </ul>
  );

  const content = () => {
    if (wide === null) return null;
    if (view === 'error') return <ErrorState error={error} onRetry={onRetry} compact />;
    if (view === 'empty') {
      return <EmptyState compact icon={empty?.icon} title={empty?.title} description={empty?.description} action={empty?.action} />;
    }
    return (
      <>
        {view === 'stale' && <ErrorState error={error} onRetry={onRetry} compact className="mb-2" />}
        <div aria-busy={view === 'skeleton' || view === 'refreshing' || undefined} className="lv-surface min-w-0 overflow-hidden">
          {view === 'skeleton' ? (
            wide ? (
              <TableRowsSkeleton rows={skeletonRows} columns={columns.length} />
            ) : (
              <ListRowsSkeleton rows={skeletonRows} thumbnail={false} />
            )
          ) : wide ? (
            table()
          ) : (
            cards()
          )}
        </div>
      </>
    );
  };

  return (
    <div ref={ref} className={`min-w-0 ${className}`} data-datalist={wide === null ? 'measuring' : wide ? 'table' : 'cards'} data-view={view}>
      {/* Always mounted, so the first selection is announced too. */}
      <p className="sr-only" aria-live="polite">
        {chosen.length > 0 ? selectedCount : ''}
      </p>
      {selection && chosen.length > 0 && (
        <div data-datalist-bulk className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface-raised px-3 py-1.5">
          <p className="me-auto text-sm font-semibold text-text-primary">{selectedCount}</p>
          {selection.actions}
          <button type="button" onClick={() => selection.onChange(new Set())} className="lv-button lv-button-ghost lv-button-sm">
            {clearSelection}
          </button>
        </div>
      )}
      {content()}
    </div>
  );
}
