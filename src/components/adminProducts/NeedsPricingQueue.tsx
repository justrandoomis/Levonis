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
import { AlertTriangle, ArrowRight, ChevronDown, ChevronLeft, ChevronRight, ImageOff, RefreshCw, Users } from 'lucide-react';
import { api } from '../../lib/api';
import VariantImg from '../ui/VariantImg';
import { useLanguage } from '../../LanguageContext';
import * as T from './theme';
import { agoText, NEEDS_PRICING as S, tri, type QueueLang } from './needsPricingStrings';
import { requestersText } from '../../../packages/contracts/src/priceRequests';
import { missingLabel } from './form/v2/missingLabel';
import { v2Strings } from './form/v2/v2Strings';

type Filter = 'all' | 'most_requested' | 'ready' | 'saved' | 'usd' | 'cost' | 'below_min_profit' | 'purchase_review';
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
  /**
   * «طلب السعر» (DECISIONS row 240): distinct signed-in requesters, the latest
   * request and the per-selection breakdown — counts only, never a requester.
   * null without migration 0193 (or with no open request).
   */
  requests?: {
    people: number;
    last_at: string | null;
    selections: Array<{ selection: string; label: Names; people: number; last_at: string }>;
  } | null;
}

interface QueueAnswer {
  rate_ready: boolean;
  filter: Filter;
  counts: Record<string, number>;
  products: QueueProduct[];
  page: number;
  pages: number;
  /** Migration 0193 is not on this database: no request counts, and the order is today's. */
  requests_unavailable?: boolean;
}

const OWNER_FILTERS: ReadonlySet<Filter> = new Set(['cost', 'below_min_profit', 'purchase_review']);
const FILTERS: readonly Filter[] = ['all', 'most_requested', 'ready', 'saved', 'usd', 'cost', 'below_min_profit', 'purchase_review'];
const COUNT_OF: Record<Filter, string> = {
  all: 'hidden',
  most_requested: 'most_requested',
  ready: 'ready',
  saved: 'saved',
  usd: 'editor_can_finish',
  cost: 'owner_only',
  below_min_profit: 'below_min_profit',
  purchase_review: 'purchase_review',
};

const nameIn = (n: Names, lang: QueueLang) => (lang === 'en' ? n.en || n.ar : lang === 'ckb' ? n.ckb || n.ar || n.en : n.ar || n.en) || '—';

/** Is any of the three name slots filled (a product without options sends an empty first name)? */
const hasName = (n: Names | null): n is Names => !!n && !!(n.ar || n.en || n.ckb);

/**
 * «ناقص: تكلفة المورد (موديل · قياسي) ×6» — the grouped line, in the reader's language: the field's own
 * label (`missingLabel`, the readiness list's words, never a raw code), the level word and the first SKU's
 * name when it has one, a separator of the language, and no consequence code beside its cause.
 */
export function missingLine(m: readonly Missing[], lang: QueueLang): string {
  const shown = m.filter((x) => !(x.code === 'PRICE_INVALID' && m.length > 1));
  if (!shown.length) return '';
  const s = v2Strings(lang);
  const levelWord = (l: string | null) =>
    l === 'model' ? s.levelModel : l === 'colour' ? s.levelColour : l === 'sku' ? s.levelSku : l === 'product' ? s.levelProduct : '';
  const parts = shown.slice(0, 3).map((x) => {
    const label = x.code === 'OWNER_DATA' ? tri(S.ownerData, lang) : missingLabel(x, lang);
    const where = [levelWord(x.level), x.level && x.level !== 'product' && hasName(x.first_name) ? nameIn(x.first_name, lang) : ''].filter(Boolean).join(' · ');
    return `${label}${where ? ` (${where})` : ''}${x.count > 1 ? ` ×${x.count}` : ''}`;
  });
  return `${tri(S.missingPrefix, lang)}: ${parts.join(lang === 'en' ? ', ' : '، ')}${shown.length > 3 ? ` +${shown.length - 3}` : ''}`;
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

/**
 * «N شخصاً طلبوا السعر · آخر طلب منذ ٣ ساعات» and, folded under it, the
 * count per option / colour (DECISIONS row 240). Counts only: no requester's
 * name or id ever reaches this screen. The queue is already ordered by these
 * numbers on the server, before the 200-row cap.
 */
export function RequestsLine({ r, lang }: { r: NonNullable<QueueProduct['requests']>; lang: QueueLang }) {
  const parts = r.selections.filter((x) => x.people > 0);
  const many = parts.length > 1 || (parts.length === 1 && parts[0].selection !== '');
  return (
    <div className="space-y-1" data-queue-requests={r.people}>
      <p className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] font-bold ${T.text1}`}>
        <Users className="h-3.5 w-3.5 shrink-0 text-[var(--ap-accent-text)]" aria-hidden />
        <span>{requestersText(r.people, lang)}</span>
        {r.last_at ? (
          <span className={`font-medium ${T.text3}`}>
            · {tri(S.lastRequest, lang)} {agoText(r.last_at, lang)}
          </span>
        ) : null}
      </p>
      {many ? (
        <details className="group text-[12px]" data-queue-selections>
          <summary className={`inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-[var(--ap-radius-sm)] font-semibold ${T.text2} hover:text-[var(--ap-text-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}>
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
            {tri(S.bySelection, lang)} <span dir="ltr" className={T.text3}>({parts.length})</span>
          </summary>
          <ul className="mt-1 space-y-1 ps-5">
            {parts.map((x) => (
              <li key={x.selection} className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-queue-selection={x.selection}>
                <span className={`min-w-0 break-words font-semibold ${T.text1}`} dir="auto">
                  {x.selection === '' ? tri(S.wholeProduct, lang) : nameIn(x.label, lang)}
                </span>
                <span className={T.text2}>{requestersText(x.people, lang)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
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

      {data?.requests_unavailable && filter === 'most_requested' && (
        <p className={`${T.surface} p-3 text-[13px] ${T.text2}`} data-queue-requests-unavailable>{tri(S.requestsUnavailable, lang)}</p>
      )}

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
            className={`${T.chip} min-h-11`}
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
                    {p.image ? <VariantImg sizes="48px" src={p.image} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" /> : <ImageOff className={`h-5 w-5 ${T.text3}`} aria-hidden />}
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
                    {p.requests && p.requests.people > 0 ? <RequestsLine r={p.requests} lang={lang} /> : null}
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
