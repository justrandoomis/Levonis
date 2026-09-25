/**
 * «مناسب لي» — THE REQUESTS THIS WORKSHOP CAN MAKE (stream W5-B).
 *
 * Self-contained: it reads `GET /api/merchant/workshop/board` — the verdicts
 * the server keeps per request revision (worker/lib/eligibility.ts) — and
 * renders them newest first, with the three filters a workshop narrows by
 * (technology, material, governorate), a cursor «المزيد», and the job's first
 * picture as a thumbnail (read through the file route, which re-derives this
 * workshop's right to it). Mounted on the request board (src/pages/
 * Requests.tsx) and mountable unchanged in the Merchant Workspace.
 *
 * Nothing here decides eligibility: a request is on this list because the
 * server said so for its current revision, and the offer is still asked of
 * the server when it is sent.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Box, ChevronDown, Filter, MapPin, PackageSearch } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Field';
import { StatusChip } from '../../ui/Badge';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { Skeleton } from '../../ui/Skeleton';
import { Money } from '../../ui/Money';
import { GOVERNORATES } from '../../../lib/governorates';
import { formatFigure } from '../../../lib/localeNumber';
import { iqdUnit } from '../../../lib/money';
import { workshopApi, type BoardFilters, type BoardRequest } from './api';

export interface BoardMaterial {
  id: string;
  process: 'fdm' | 'resin';
  name_en: string;
  name_ar: string;
}

export default function RequestBoard({
  materials,
  onOpen,
  workshopHref,
}: {
  /** The catalogue, for the material filter and the row labels. */
  materials: BoardMaterial[];
  onOpen: (request: BoardRequest) => void;
  /** Where «طابعاتي» lives, for the empty state. */
  workshopHref?: string;
}) {
  const { loc, lang } = useLanguage();
  const filterId = useId();
  const [filters, setFilters] = useState<BoardFilters>({ process: '', material: '', governorate: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [rows, setRows] = useState<BoardRequest[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string>('');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback((f: BoardFilters) => {
    const mine = ++seq.current;
    setRows(null);
    setError(null);
    workshopApi
      .board({ ...f, limit: 20 })
      .then((d) => {
        if (mine !== seq.current) return;
        setRows(d.requests);
        setCursor(d.next_cursor);
        setBlocked(d.blocked ?? '');
      })
      .catch((e) => {
        if (mine === seq.current) setError(e);
      });
  }, []);
  useEffect(() => load(filters), [load, filters]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const d = await workshopApi.board({ ...filters, cursor, limit: 20 });
      setRows((r) => [...(r ?? []), ...d.requests.filter((x) => !(r ?? []).some((y) => y.id === x.id))]);
      setCursor(d.next_cursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  const matName = (id: string | null) => {
    if (!id) return '';
    const m = materials.find((x) => x.id === id);
    return m ? (lang === 'en' ? m.name_en : m.name_ar || m.name_en) : id;
  };
  const govName = (id: string) => {
    const g = GOVERNORATES.find((x) => x.id === id);
    return g ? (lang === 'en' ? g.en : lang === 'ckb' ? g.ckb : g.ar) : id;
  };
  const active = [filters.process, filters.material, filters.governorate].filter(Boolean).length;
  const set = (k: keyof BoardFilters, v: string) => setFilters((f) => ({ ...f, [k]: v, ...(k === 'process' ? { material: '' } : {}) }));

  return (
    <section aria-labelledby={`${filterId}-title`} data-workshop-board>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p id={`${filterId}-title`} className="text-[13px] text-text-muted">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('طلبات تستطيع ورشتك تنفيذها بطابعاتها ومخزونها وتوصيلها.', 'Requests your workshop can make with its printers, stock and delivery.')}
        </p>
        <Button
          size="sm"
          variant="secondary"
          icon={<Filter aria-hidden="true" className="h-4 w-4" />}
          iconEnd={<ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform motion-reduce:transition-none ${showFilters ? 'rotate-180' : ''}`} />}
          aria-expanded={showFilters}
          aria-controls={`${filterId}-panel`}
          onClick={() => setShowFilters((v) => !v)}
          data-board-filters-toggle
        >
          {loc('تصفية', 'Filter')}
          {active > 0 && <span className="ms-1 tabular-nums">({formatFigure(active, lang)})</span>}
        </Button>
      </div>

      {showFilters && (
        <div id={`${filterId}-panel`} className="lv-surface mb-3 grid grid-cols-1 gap-3 p-3 sm:grid-cols-3" data-board-filters>
          <label className="block text-[12px] font-semibold text-text-secondary">
            {loc('التقنية', 'Technology')}
            <Select className="mt-1" value={filters.process ?? ''} onChange={(e) => set('process', e.target.value)} data-board-filter="process">
              <option value="">{loc('الكل', 'All')}</option>
              <option value="fdm">FDM</option>
              <option value="resin">{loc('ريزن', 'Resin')}</option>
            </Select>
          </label>
          <label className="block text-[12px] font-semibold text-text-secondary">
            {loc('الخامة', 'Material')}
            <Select className="mt-1" value={filters.material ?? ''} onChange={(e) => set('material', e.target.value)} data-board-filter="material">
              <option value="">{loc('الكل', 'All')}</option>
              {materials
                .filter((m) => !filters.process || m.process === filters.process)
                .map((m) => (
                  <option key={m.id} value={m.id}>{lang === 'en' ? m.name_en : m.name_ar || m.name_en}</option>
                ))}
            </Select>
          </label>
          <label className="block text-[12px] font-semibold text-text-secondary">
            {loc('المحافظة', 'Governorate')}
            <Select className="mt-1" value={filters.governorate ?? ''} onChange={(e) => set('governorate', e.target.value)} data-board-filter="governorate">
              <option value="">{loc('الكل', 'All')}</option>
              {GOVERNORATES.map((g) => (
                <option key={g.id} value={g.id}>{govName(g.id)}</option>
              ))}
            </Select>
          </label>
          {active > 0 && (
            <div className="sm:col-span-3">
              <Button size="sm" variant="ghost" onClick={() => setFilters({ process: '', material: '', governorate: '' })}>
                {loc('إزالة التصفية', 'Clear filters')}
              </Button>
            </div>
          )}
        </div>
      )}

      {error ? (
        <ErrorState error={error} onRetry={() => load(filters)} />
      ) : rows === null ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="lv-surface flex gap-3 p-3">
              <Skeleton className="h-16 w-16 shrink-0 rounded-xl" />
              <div className="flex-1 space-y-2 py-1">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : !rows.length ? (
        <EmptyState
          icon={<PackageSearch aria-hidden="true" className="h-6 w-6" />}
          title={
            blocked === 'NOT_TAKING_REQUESTS'
              ? loc('متجرك لا يستقبل الطلبات المخصصة', 'Your store is not taking custom requests')
              : blocked
                ? loc('ورشتك لا تستقبل عملًا جديدًا الآن', 'Your workshop is not taking new work right now')
                : active
                  ? loc('لا طلبات بهذه التصفية', 'No requests with these filters')
                  : loc('لا طلبات تناسب ورشتك الآن', 'No requests fit your workshop right now')
          }
          description={
            blocked
              ? loc('افتح المتجر وفعّل الطلبات المخصصة من إعدادات المتجر، وتأكد أن اشتراكك ساري.', 'Open your store, turn on custom requests in store settings, and check your plan is active.')
              : loc('تظهر هنا الطلبات التي تستطيع طابعاتك ومخزونك وتوصيلك تنفيذها — أضف طابعة أو خامة لتتسع.', 'Requests your printers, stock and delivery can serve appear here — add a printer or a material to see more.')
          }
          action={
            workshopHref && !blocked ? (
              <a href={workshopHref} className="inline-flex min-h-11 items-center rounded-xl px-3 text-[13px] font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {loc('طابعاتي ومخزوني', 'My printers and stock')}
              </a>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="space-y-2" data-board-list>
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  data-board-request={r.id}
                  className="lv-surface flex w-full items-start gap-3 p-3 text-start transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus active:scale-[0.995] motion-reduce:active:scale-100"
                >
                  <span className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/[0.04]">
                    {r.thumb_url ? (
                      <img src={r.thumb_url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    ) : (
                      <Box aria-hidden="true" className="h-6 w-6 text-text-muted" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className="line-clamp-2 block text-[14px] font-semibold leading-snug text-text-primary">{r.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-muted">
                      <span>{r.process === 'resin' ? loc('ريزن', 'Resin') : r.process === 'fdm' ? 'FDM' : loc('التقنية مفتوحة', 'Any technology')}</span>
                      {r.material_id && <span aria-hidden="true">·</span>}
                      {r.material_id && <span>{matName(r.material_id)}</span>}
                      {r.quantity > 1 && <span className="tabular-nums" dir="ltr">×{r.quantity}</span>}
                      {r.governorate && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin aria-hidden="true" className="h-3 w-3" />
                          {govName(r.governorate)}
                        </span>
                      )}
                      {r.has_preview && (
                        <span className="inline-flex items-center gap-1">
                          <Box aria-hidden="true" className="h-3 w-3" />
                          {loc('معاينة ثلاثية الأبعاد', '3D preview')}
                        </span>
                      )}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <span className="text-text-secondary">
                        {r.budget_iqd !== null ? (
                          <>
                            {loc('الميزانية', 'Budget')} <Money iqd={r.budget_iqd} />
                          </>
                        ) : r.estimate_low_iqd !== null && r.estimate_high_iqd !== null ? (
                          <>
                            {loc('تقدير Levonis', 'Levonis estimate')}{' '}
                            <span className="whitespace-nowrap">
                              <span dir="ltr" className="tabular-nums">{formatFigure(r.estimate_low_iqd, lang)}–{formatFigure(r.estimate_high_iqd, lang)}</span> {iqdUnit(lang)}
                            </span>
                          </>
                        ) : null}
                      </span>
                      {/* Wraps: «Re-confirm your offer» + «5 offers» ran out of the card at 320px (W6). */}
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {r.my_offer && (
                          <StatusChip tone={r.my_offer === 'superseded' ? 'warning' : r.my_offer === 'accepted' ? 'success' : 'info'} className="whitespace-nowrap">
                            {r.my_offer === 'superseded'
                              ? loc('أكّد عرضك', 'Re-confirm your offer')
                              : r.my_offer === 'accepted'
                                ? loc('قُبل عرضك', 'Your offer won')
                                : loc('قدّمت عرضًا', 'You offered')}
                          </StatusChip>
                        )}
                        <span className="whitespace-nowrap tabular-nums text-text-muted">
                          {loc(`${formatFigure(r.offer_count, lang)} عرض`, `${formatFigure(r.offer_count, lang)} ${r.offer_count === 1 ? 'offer' : 'offers'}`)}
                        </span>
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {cursor && (
            <div className="mt-3">
              <Button block variant="secondary" loading={loadingMore} onClick={more} data-board-more>
                {loc('المزيد', 'Load more')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
