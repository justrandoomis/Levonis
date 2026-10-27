/**
 * THE NAMES BEHIND THE IDS — tiers, models, products, variants, agents,
 * categories and units, read once per visit of the console and shared by
 * every section that prints an id (a stock row, a job's material, an order
 * line, a buyback). A write to the catalogue drops the entity it changed
 * (`invalidateRefs`), so the next read is fresh.
 *
 * A name the lists do not hold is printed as the id itself — never guessed.
 */
import { useEffect, useState } from 'react';
import { pc, type Agent, type Category, type Row, type Unit } from './api';
import type { RefSource } from './catalogFields';
import type { Lang } from './i18n';

const cache = new Map<RefSource, Promise<Row[]>>();
const listeners = new Set<() => void>();

function fetchRef(kind: RefSource): Promise<Row[]> {
  switch (kind) {
    case 'agents':
      return pc.get<Agent[]>('/agents') as unknown as Promise<Row[]>;
    case 'categories':
      return pc.get<Category[]>('/categories') as unknown as Promise<Row[]>;
    case 'units':
      return pc.public<Unit[]>('/units') as unknown as Promise<Row[]>;
    default:
      return pc.get<Row[]>(`/catalog/${kind}`);
  }
}

export function loadRef(kind: RefSource): Promise<Row[]> {
  let p = cache.get(kind);
  if (!p) {
    p = fetchRef(kind).catch((e: unknown) => {
      // A failed read is not cached: the next screen asks again.
      cache.delete(kind);
      throw e;
    });
    cache.set(kind, p);
  }
  return p;
}

/** Forget these lists (after a write) and tell every mounted reader. */
export function invalidateRefs(...kinds: RefSource[]): void {
  for (const k of kinds) cache.delete(k);
  for (const l of listeners) l();
}

/** The id of a row of a reference list (categories and units are keyed by code). */
export const refKey = (kind: RefSource, row: Row): string => String(kind === 'categories' || kind === 'units' ? row.code : row.id);

/** A row's name in the reader's language. */
export function refName(kind: RefSource, row: Row | undefined, lang: Lang): string {
  if (!row) return '';
  const byLang = (prefix: string) => String(row[`${prefix}_${lang}`] || row[`${prefix}_en`] || row[`${prefix}_ar`] || '');
  switch (kind) {
    case 'printer_models':
      return `${String(row.brand ?? '')} ${String(row.model_name ?? '')}`.trim() || String(row.code ?? '');
    case 'agents':
      return String(row.name ?? '');
    case 'units':
      return byLang('label');
    case 'variants':
      return byLang('name') || String(row.sku ?? '');
    default:
      return byLang('name') || String(row.code ?? '');
  }
}

export interface RefLists {
  rows: Partial<Record<RefSource, Row[]>>;
  /** The name of `id` in list `kind`, or the id itself. */
  name: (kind: RefSource, id: string | null | undefined) => string;
  /** The row of `id` in list `kind`. */
  row: (kind: RefSource, id: string | null | undefined) => Row | undefined;
  /** Options for a select over list `kind`. */
  options: (kind: RefSource) => Array<{ value: string; label: string }>;
  error: unknown;
}

/** Read the lists `kinds` (from the cache when it has them). */
export function useRefs(kinds: readonly RefSource[], lang: Lang): RefLists {
  const key = kinds.join(',');
  const [rows, setRows] = useState<Partial<Record<RefSource, Row[]>>>({});
  const [error, setError] = useState<unknown>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setEpoch((n) => n + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const list = key ? (key.split(',') as RefSource[]) : [];
    for (const k of list) {
      loadRef(k).then(
        (r) => alive && setRows((cur) => ({ ...cur, [k]: r })),
        (e: unknown) => alive && setError(e)
      );
    }
    return () => {
      alive = false;
    };
  }, [key, epoch]);
  const row = (kind: RefSource, id: string | null | undefined) => (id ? rows[kind]?.find((r) => refKey(kind, r) === id) : undefined);
  return {
    rows,
    error,
    row,
    name: (kind, id) => {
      if (!id) return '—';
      return refName(kind, row(kind, id), lang) || id;
    },
    options: (kind) =>
      (rows[kind] ?? []).map((r) => {
        const value = refKey(kind, r);
        const name = refName(kind, r, lang);
        const code = kind === 'variants' ? r.sku : kind === 'units' || kind === 'categories' ? r.code : r.code;
        return { value, label: code && name && String(code) !== name ? `${name} · ${String(code)}` : name || value };
      }),
  };
}
