/**
 * PICK A CATALOGUE PRODUCT AT CATALOGUE SIZE.
 *
 * Every panel that has to name a product — a bundle component, an offer
 * subject, a mystery pool entry — used to do it with a plain `<select>` over
 * the FIRST 100 products, unsearchable and unpaginated, or with a text field
 * asking the owner to paste `prd_…`. `worker/routes/adminProducts.ts` caps
 * `limit` at 100, so the dropdown could not be widened, and on a real Levonis
 * catalogue the product an owner wants is simply not in the list. That is the
 * concrete failure of "the admin can configure a bundle at catalogue size".
 *
 * The route already accepts `search` and `offset`. This is the debounced
 * type-to-search idiom that uses them, in ONE component, so the three panels
 * cannot drift apart:
 *
 *  - it shows name, SKU and status, so two similarly named products are
 *    distinguishable before they are chosen;
 *  - it resolves the CURRENT value by id on mount, so an existing row renders
 *    its product's name even when that product is on no page of the current
 *    search results;
 *  - `excludeComposition` keeps bundles and mystery offers out of the list
 *    where nesting is refused server-side anyway (§4.7), so the refusal is
 *    never the first time the owner learns it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import * as T from '../theme';
import { api } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';

export interface PickerProduct {
  id: string;
  name_en: string;
  name_ar: string;
  sku?: string | null;
  price_iqd: number;
  status: string;
  composition: string;
}

interface Props {
  value: string;
  onChange: (id: string, product: PickerProduct | null) => void;
  /** Bundles and mystery offers are never components or pool entries (§4.7). */
  excludeComposition?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** A picker that stays open after a pick, for building a list. */
  keepOpen?: boolean;
}

const label = (p: PickerProduct, ar: boolean) => (ar ? p.name_ar || p.name_en : p.name_en || p.name_ar) || p.id;

export default function ProductPicker({
  value,
  onChange,
  excludeComposition = true,
  placeholder,
  ariaLabel,
  disabled = false,
  keepOpen = false,
}: Props) {
  const { lang, dir } = useLanguage();
  const loc = (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar);

  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<PickerProduct[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<PickerProduct | null>(null);
  const seq = useRef(0);

  /** The current value, resolved by id — so an existing row is legible even
   *  when its product is not in any result page the owner has searched. */
  useEffect(() => {
    if (!value) {
      setChosen(null);
      return;
    }
    if (chosen?.id === value) return;
    let cancelled = false;
    api
      .get<{ product: PickerProduct }>(`/api/admin/products-v2/${encodeURIComponent(value)}`)
      .catch(() =>
        // A COMPOSITION row is refused by the product editor with a 409 that
        // names the panel owning it (§16), so a bundle chosen as an OFFER
        // subject resolves through the bundles reader instead of showing as a
        // bare `prd_…`.
        api.get<{ product: PickerProduct }>(`/api/admin/bundles/${encodeURIComponent(value)}`)
      )
      .then((res) => {
        if (!cancelled && res.product) setChosen(res.product);
      })
      .catch(() => {
        // A product that no longer resolves is shown as its raw id rather than
        // silently blanked — blanking would look like the row lost its product.
        if (!cancelled) setChosen(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const search = useCallback(
    async (q: string) => {
      const mine = ++seq.current;
      setBusy(true);
      try {
        const params = new URLSearchParams({ limit: '30' });
        if (q.trim()) params.set('search', q.trim());
        const res = await api.get<{ products: PickerProduct[] }>(`/api/admin/products-v2?${params}`);
        if (mine !== seq.current) return;
        const list = res.products ?? [];
        setRows(excludeComposition ? list.filter((p) => !p.composition) : list);
      } catch {
        if (mine === seq.current) setRows([]);
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    },
    [excludeComposition]
  );

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void search(term), 220);
    return () => clearTimeout(t);
  }, [term, open, search]);

  const pick = (p: PickerProduct) => {
    setChosen(p);
    onChange(p.id, p);
    if (!keepOpen) {
      setOpen(false);
      setTerm('');
    }
  };

  return (
    <div className="min-w-0" dir={dir}>
      {!open ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setOpen(true);
            void search('');
          }}
          className={`${T.input} flex items-center justify-between gap-2 w-full text-start disabled:opacity-50`}
          aria-label={ariaLabel ?? loc('اختر منتجًا', 'Choose a product', 'بەرهەمێک هەڵبژێرە')}
        >
          <span className="truncate" dir="ltr">
            {chosen ? label(chosen, lang !== 'en') : value || placeholder || loc('اختر منتجًا', 'Choose a product', 'بەرهەمێک هەڵبژێرە')}
          </span>
          <Search className="w-4 h-4 shrink-0 text-[var(--ap-text-3)]" aria-hidden />
        </button>
      ) : (
        <div className="rounded-lg border border-[var(--ap-border)] bg-[var(--ap-surface-1)] p-2 space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 start-2.5 text-[var(--ap-text-3)]" aria-hidden />
            <input
              autoFocus
              className={`${T.input} ps-8 pe-8`}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={loc('ابحث بالاسم أو الرمز', 'Search by name or SKU', 'گەڕان بە ناو یان کۆد')}
              aria-label={ariaLabel ?? loc('بحث عن منتج', 'Search products', 'گەڕان بۆ بەرهەم')}
            />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTerm('');
              }}
              className="absolute top-1/2 -translate-y-1/2 end-1.5 p-1 text-[var(--ap-text-3)]"
              aria-label={loc('إغلاق', 'Close', 'داخستن')}
            >
              <X className="w-4 h-4" aria-hidden />
            </button>
          </div>
          <ul className="max-h-56 overflow-y-auto space-y-1" role="listbox">
            {busy && rows.length === 0 && (
              <li className="px-2 py-1.5 text-[12px] text-[var(--ap-text-3)]">{loc('جارٍ البحث…', 'Searching…', 'گەڕان…')}</li>
            )}
            {!busy && rows.length === 0 && (
              <li className="px-2 py-1.5 text-[12px] text-[var(--ap-text-3)]">
                {loc('لا نتائج', 'No results', 'هیچ ئەنجامێک نییە')}
              </li>
            )}
            {rows.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={p.id === value}
                  onClick={() => pick(p)}
                  className="w-full text-start px-2 py-1.5 rounded-md hover:bg-[var(--ap-surface-2)] flex items-center justify-between gap-2"
                >
                  <span className="min-w-0 truncate text-[13px] text-[var(--ap-text-1)]" dir="ltr">
                    {label(p, lang !== 'en')}
                    {p.sku ? <span className="text-[var(--ap-text-3)]"> · {p.sku}</span> : null}
                  </span>
                  <span
                    className={`shrink-0 text-[10.5px] font-bold rounded px-1.5 py-0.5 ${
                      p.status === 'active' ? 'text-emerald-300 bg-emerald-500/10' : 'text-amber-300 bg-amber-500/10'
                    }`}
                  >
                    {p.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
