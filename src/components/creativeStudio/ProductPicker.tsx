/**
 * Choosing a product by its NAME, never by typing an internal id — the
 * archive's product filter and a service claim's products (spec §19, §22).
 * Reads the store's own listing (GET /products, read-only); a late answer
 * never replaces a newer one. A chosen id is shown by the product's name.
 */
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Field, Input } from '../ui/Field';
import type { ProductListItemDto } from '../../../packages/creativeDoc/src/api';
import { localized } from '../../../packages/creativeDoc/src/snapshot';
import { store } from './client';
import { S } from './strings';
import { failText, useText } from './shared';

export function ProductPicker({ label, hint, onPick }: { label: string; hint?: string; onPick(p: ProductListItemDto): void }) {
  const { lang, w } = useText();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductListItemDto[] | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      store.search(query.trim()).then(
        (list) => { if (seq.current === mine) { setResults(list); setError(''); } },
        (e: unknown) => { if (seq.current === mine) setError(failText(e, lang)); },
      );
    }, 300);
    return () => clearTimeout(t);
  }, [query, lang]);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-product-picker>
      <Field label={label} hint={hint}>
        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
      </Field>
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
      {results && !results.length ? <p className="text-sm text-text-muted">{w(S.newSearchEmpty)}</p> : null}
      {results && results.length ? (
        <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="min-h-11 w-full rounded-lg border border-border-subtle px-3 py-2 text-start text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                onClick={() => { onPick(p); setQuery(''); setResults(null); }}
              >
                {localized(p.name, lang)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A chosen product, by name (looked up once), with a way to remove it. */
export function ProductChip({ id, name, onRemove }: { id: string; name?: ProductListItemDto['name'] | null; onRemove?: () => void }) {
  const { lang, w } = useText();
  const [found, setFound] = useState<ProductListItemDto['name'] | null>(name ?? null);
  useEffect(() => {
    if (found) return;
    let live = true;
    store.product(id).then((p) => { if (live) setFound(p.name); }, () => undefined);
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle bg-surface ps-3 text-sm text-text-primary" data-product-chip={id}>
      <span className="min-w-0 truncate py-1" dir={found ? undefined : 'ltr'}>{found ? localized(found, lang) : id}</span>
      {onRemove ? (
        <button type="button" aria-label={`${w(S.remove)} ${found ? localized(found, lang) : id}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={onRemove}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}
