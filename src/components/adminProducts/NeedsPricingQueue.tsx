/**
 * «منتجات تحتاج تسعيرًا» — THE CLEAN START'S QUEUE (addendum A.8, DECISIONS
 * row 222). Every product that customers cannot see until its first complete
 * V2 write: one card per product with its state, the grouped missing line and
 * «سعّره الآن», which opens the form at section ٣. No bulk publish exists: the
 * owner's words — every product is opened, reviewed in the one sheet and
 * published.
 *
 * The server projects what a reader may see (codes, counts, names and field
 * NAMES only; a price editor never reads a cost code's name or the owner-only
 * filters). Phone: one card per product, 16px gutters, no horizontal scroll.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, ImageOff, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import * as T from './theme';
import { NEEDS_PRICING as S, tri, type QueueLang } from './needsPricingStrings';

type Filter = 'all' | 'ready' | 'saved' | 'usd' | 'cost' | 'below_min_profit' | 'purchase_review';
type State = 'needs_pricing' | 'saved' | 'ready' | 'composition_pending' | 'published';

interface Names {
  ar: string;
  en: string;
  ckb: string;
}

interface Missing {
  code: string;
  field: string | null;
  level: string | null;
  count: number;
  first_name: Names | null;
}

interface QueueProduct {
  id: string;
  slug: string;
  names: Names;
  image: string;
  status: string;
  composition: string;
  state: State;
  method: 'cost' | 'usd' | null;
  default_method: 'cost' | 'usd';
  can_finish: boolean;
  sellable_skus: number;
  channels: string[];
  missing: Missing[];
  below_min_profit?: boolean;
  purchase_review?: boolean;
  link: string;
}

interface QueueAnswer {
  rate_ready: boolean;
  filter: Filter;
  counts: Record<string, number>;
  products: QueueProduct[];
  page: number;
  pages: number;
}

const OWNER_FILTERS: ReadonlySet<Filter> = new Set(['cost', 'below_min_profit', 'purchase_review']);
const FILTERS: readonly Filter[] = ['all', 'ready', 'saved', 'usd', 'cost', 'below_min_profit', 'purchase_review'];
const COUNT_OF: Record<Filter, string> = {
  all: 'hidden',
  ready: 'ready',
  saved: 'saved',
  usd: 'editor_can_finish',
  cost: 'owner_only',
  below_min_profit: 'below_min_profit',
  purchase_review: 'purchase_review',
};

const nameIn = (n: Names, lang: QueueLang) => (lang === 'en' ? n.en || n.ar : lang === 'ckb' ? n.ckb || n.ar || n.en : n.ar || n.en) || '—';

/** «ناقص: تكلفة المورد (المنتج)» — the grouped line, names only. */
function missingLine(m: Missing[], lang: QueueLang): string {
  if (!m.length) return '';
  const parts = m.slice(0, 3).map((x) => {
    const label = x.code === 'OWNER_DATA' ? tri(S.ownerData, lang) : x.field ? `${x.code} · ${x.field}` : x.code;
    const where = x.first_name ? ` (${nameIn(x.first_name, lang)})` : '';
    return `${label}${where}${x.count > 1 ? ` ×${x.count}` : ''}`;
  });
  return `${tri(S.missingPrefix, lang)}: ${parts.join('، ')}${m.length > 3 ? ` +${m.length - 3}` : ''}`;
}

function StateChip({ p, lang }: { p: QueueProduct; lang: QueueLang }) {
  const label =
    p.state === 'ready'
      ? S.ready
      : p.state === 'saved'
        ? S.saved
        : p.state === 'composition_pending'
          ? S.awaitingDecision
          : p.state === 'published'
            ? S.published
            : S.badge;
  const tone =
    p.state === 'ready' || p.state === 'published'
      ? 'lv-chip [--chip:var(--color-success)]'
      : p.state === 'saved'
        ? 'lv-chip [--chip:var(--color-info)]'
        : 'lv-chip [--chip:var(--color-warning)]';
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${tone}`} data-queue-state={p.state}>{tri(label, lang)}</span>;
}

export default function NeedsPricingQueue({ owner, onOpen, onBack }: { owner: boolean; onOpen: (id: string) => void; onBack: () => void }) {
  const { lang: rawLang, dir } = useLanguage();
  const lang: QueueLang = rawLang === 'en' || rawLang === 'ckb' ? rawLang : 'ar';
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<QueueAnswer | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(false);
      try {
        const res = await api.get<QueueAnswer>(`/api/admin/products-v2/needs-pricing?filter=${filter}&page=${page}`, { signal });
        if (!signal.aborted) setData(res);
      } catch {
        if (!signal.aborted) setError(true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [filter, page]
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, reload]);

  const filters = FILTERS.filter((f) => owner || !OWNER_FILTERS.has(f));

  return (
    <div dir={dir} data-needs-pricing-queue className={`${T.AP} mx-auto w-full max-w-[1120px] space-y-4 px-4 pb-16 sm:px-0`}>
      <div className="flex items-center gap-2">
        <button type="button" className={T.btnGhost} onClick={onBack} data-queue-back>
          <ArrowRight className="h-4 w-4 ltr:rotate-180" aria-hidden />
          {tri(S.back, lang)}
        </button>
      </div>
      <header className="space-y-1">
        <h2 className="text-[22px] font-black leading-snug sm:text-[26px]">{tri(S.title, lang)}</h2>
        <p className={`max-w-[68ch] text-[14px] leading-relaxed ${T.text2}`}>{tri(S.intro, lang)}</p>
      </header>

      {data && !data.rate_ready && (
        <div role="alert" className="lv-alert lv-alert-warning flex items-start gap-2 rounded-[var(--ap-radius-md)] p-3 text-[13px]" data-queue-rate-missing>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{tri(S.rateMissing, lang)}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label={tri(S.title, lang)}>
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            className={T.chip}
            aria-pressed={filter === f}
            data-queue-filter={f}
            onClick={() => {
              setFilter(f);
              setPage(1);
            }}
          >
            {tri(S.filters[f], lang)}
            {data?.counts[COUNT_OF[f]] !== undefined && <span className={`${T.text3} ms-1`} dir="ltr">{data.counts[COUNT_OF[f]]}</span>}
          </button>
        ))}
      </div>

      {error ? (
        <div className={`${T.surface} flex flex-col items-start gap-3 p-4`}>
          <p className="text-[14px]">{tri(S.loadFailed, lang)}</p>
          <button type="button" className={T.btnSecondary} onClick={() => setReload((n) => n + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {tri(S.retry, lang)}
          </button>
        </div>
      ) : !data || loading ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={`${T.surface} h-20 animate-pulse`} />
          ))}
        </div>
      ) : data.products.length === 0 ? (
        <p className={`${T.surface} p-4 text-[14px] ${T.text2}`} data-queue-empty>{tri(S.empty, lang)}</p>
      ) : (
        <ul className="space-y-2">
          {data.products.map((p) => {
            const line = missingLine(p.missing, lang);
            return (
              <li key={p.id} data-queue-product={p.id} className={`${T.surface} flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-center`}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[var(--ap-radius-sm)] bg-[var(--ap-surface-2)]">
                    {p.image ? <img src={p.image} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" /> : <ImageOff className={`h-5 w-5 ${T.text3}`} aria-hidden />}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-[14px] font-bold" dir="auto">{nameIn(p.names, lang)}</span>
                      <StateChip p={p} lang={lang} />
                      {p.below_min_profit && (
                        <span className="lv-chip [--chip:var(--color-danger)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{tri(S.belowMinProfit, lang)}</span>
                      )}
                      {p.purchase_review && (
                        <span className="lv-chip [--chip:var(--color-info)] shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold">{tri(S.purchaseReview, lang)}</span>
                      )}
                    </div>
                    {p.composition !== '' ? (
                      <p className={`text-[12px] ${T.text2}`}>{tri(S.composition, lang)}</p>
                    ) : !p.can_finish ? (
                      <p className={`text-[12px] ${T.text2}`}>{tri(S.ownerOnly, lang)}</p>
                    ) : line ? (
                      <p className={`text-[12px] ${T.text2} break-words`} data-queue-missing>{line}</p>
                    ) : null}
                  </div>
                </div>
                {p.composition === '' && (
                  <button type="button" className={`${T.btnPrimary} w-full sm:w-auto`} onClick={() => onOpen(p.id)} data-queue-open={p.id}>
                    {tri(S.priceNow, lang)}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {data && data.pages > 1 && (
        <nav className="flex items-center justify-center gap-2" aria-label={tri(S.page, lang)}>
          <button type="button" className={T.btnIcon} disabled={page <= 1} onClick={() => setPage((n) => Math.max(1, n - 1))} aria-label={tri(S.prev, lang)}>
            <ChevronRight className="h-4 w-4 ltr:rotate-180" aria-hidden />
          </button>
          <span className={`text-[13px] ${T.text2}`}>
            {tri(S.page, lang)} <span dir="ltr">{data.page} / {data.pages}</span>
          </span>
          <button type="button" className={T.btnIcon} disabled={page >= data.pages} onClick={() => setPage((n) => Math.min(data.pages, n + 1))} aria-label={tri(S.next, lang)}>
            <ChevronLeft className="h-4 w-4 ltr:rotate-180" aria-hidden />
          </button>
        </nav>
      )}
    </div>
  );
}
