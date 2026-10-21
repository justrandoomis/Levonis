/**
 * «مناسب لي» — THE REQUESTS THIS WORKSHOP CAN MAKE (stream W5-B).
 *
 * Self-contained: it reads `GET /api/merchant/workshop/board` — the verdicts
 * the server keeps per request revision (worker/lib/eligibility.ts) — and
 * renders them newest first, with the three filters a workshop narrows by
 * (technology, material, governorate), a cursor «المزيد», the job's first
 * picture as a thumbnail (a sized copy read through the file route, which
 * re-derives this workshop's right to it, R12) and the pasted model link as
 * its link card (R1). Mounted on the request board (src/pages/
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
import { offersLabel } from '../../community/hub/copy';
import { iqdUnit } from '../../../lib/money';
import { boardEstimateLabel, boardJobFacts, workshopApi, type BoardFilters, type BoardRequest } from './api';
import { approvalGateText } from '../../../lib/approvalGate';
import { RequestThumb } from '../../community/requests/RequestFileThumbs';
import { jobCountWords, localMaterial } from '../../community/requests/mirrors';
import { SourceLinkCard } from '../../community/links/LinkCard';

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
    return localMaterial(id, lang === 'en' || lang === 'ckb' ? lang : 'ar', materials);
  };
  const L = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  // The materials the parts named, and «any material» when a part left it open beside them (P1-05 review 5).
  const matLabel = (r: BoardRequest) => {
    const f = boardJobFacts(r);
    return [...f.materials.map(matName), ...(f.anyMaterial ? [loc('المادة مفتوحة', 'Any material', 'هەر کەرەستەیەک')] : [])].join(' + ');
  };
  const techLabel = (r: BoardRequest) => {
    const f = boardJobFacts(r);
    const words = f.processes.map((x) => (x === 'resin' ? loc('ريزن', 'Resin', 'ڕێزن') : 'FDM'));
    if (f.anyTechnology) words.push(loc('التقنية مفتوحة', 'Any technology', 'هەر تەکنەلۆژیایەک'));
    return words.join(' + ');
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
          {loc('طلبات تستطيع ورشتك تنفيذها بطابعاتها ومخزونها وتوصيلها.', 'Requests your workshop can make with its printers, stock and delivery.', 'ئەو داواکارییانەی وۆرکشۆپەکەت دەتوانێت بە چاپکەر و کۆگا و گەیاندنەکەی جێبەجێیان بکات.')}
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
          {loc('تصفية', 'Filter', 'پاڵاوتن')}
          {active > 0 && <span className="ms-1 tabular-nums">({formatFigure(active, lang)})</span>}
        </Button>
      </div>

      {showFilters && (
        <div id={`${filterId}-panel`} className="lv-surface mb-3 grid grid-cols-1 gap-3 p-3 sm:grid-cols-3" data-board-filters>
          <label className="block text-[12px] font-semibold text-text-secondary">
            {loc('التقنية', 'Technology', 'تەکنەلۆژیا')}
            <Select className="mt-1" value={filters.process ?? ''} onChange={(e) => set('process', e.target.value)} data-board-filter="process">
              <option value="">{loc('الكل', 'All', 'هەموو')}</option>
              <option value="fdm">FDM</option>
              <option value="resin">{loc('ريزن', 'Resin', 'ڕێزن')}</option>
            </Select>
          </label>
          <label className="block text-[12px] font-semibold text-text-secondary">
            {loc('الخامة', 'Material', 'ماددە')}
            <Select className="mt-1" value={filters.material ?? ''} onChange={(e) => set('material', e.target.value)} data-board-filter="material">
              <option value="">{loc('الكل', 'All', 'هەموو')}</option>
              {materials
                .filter((m) => !filters.process || m.process === filters.process)
                .map((m) => (
                  <option key={m.id} value={m.id}>{localMaterial(m.id, lang === 'en' || lang === 'ckb' ? lang : 'ar', materials)}</option>
                ))}
            </Select>
          </label>
          <label className="block text-[12px] font-semibold text-text-secondary">
            {loc('المحافظة', 'Governorate', 'پارێزگا')}
            <Select className="mt-1" value={filters.governorate ?? ''} onChange={(e) => set('governorate', e.target.value)} data-board-filter="governorate">
              <option value="">{loc('الكل', 'All', 'هەموو')}</option>
              {GOVERNORATES.map((g) => (
                <option key={g.id} value={g.id}>{govName(g.id)}</option>
              ))}
            </Select>
          </label>
          {active > 0 && (
            <div className="sm:col-span-3">
              <Button size="sm" variant="ghost" onClick={() => setFilters({ process: '', material: '', governorate: '' })}>
                {loc('إزالة التصفية', 'Clear filters', 'سڕینەوەی پاڵاوتنەکان')}
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
            blocked === 'MERCHANT_NOT_APPROVED'
              ? approvalGateText(loc)
              : blocked === 'NOT_TAKING_REQUESTS'
              ? loc('متجرك لا يستقبل الطلبات المخصصة', 'Your store is not taking custom requests', 'فرۆشگاکەت داواکاریی تایبەت وەرناگرێت')
              : blocked
                ? loc('ورشتك لا تستقبل عملًا جديدًا الآن', 'Your workshop is not taking new work right now', 'وۆرکشۆپەکەت ئێستا کاری نوێ وەرناگرێت')
                : active
                  ? loc('لا طلبات بهذه التصفية', 'No requests with these filters', 'هیچ داواکارییەک بەم پاڵاوتنانە نییە')
                  : loc('لا طلبات تناسب ورشتك الآن', 'No requests fit your workshop right now', 'ئێستا هیچ داواکارییەک لەگەڵ وۆرکشۆپەکەت ناگونجێت')
          }
          description={
            // Approval (review finding 8): what the board will show — never «open your store / renew».
            blocked === 'MERCHANT_NOT_APPROVED'
              ? loc(
                  'تظهر هنا طلبات الزبائن التي تناسب ورشتك بعد اعتماد متجرك.',
                  'Customer requests that fit your workshop appear here once your store is approved.',
                  'دوای پەسەندکردنی فرۆشگاکەت، داواکارییەکانی کڕیاران کە لەگەڵ کارگەکەت دەگونجێن لێرە دەردەکەون.'
                )
              : blocked
              ? loc('افتح المتجر وفعّل الطلبات المخصصة من إعدادات المتجر، وتأكد أن اشتراكك ساري.', 'Open your store, turn on custom requests in store settings, and check your plan is active.', 'فرۆشگاکەت بکەرەوە، داواکاریی تایبەت لە ڕێکخستنەکانی فرۆشگا چالاک بکە، و دڵنیابە کە پلانەکەت چالاکە.')
              : loc('تظهر هنا الطلبات التي تستطيع طابعاتك ومخزونك وتوصيلك تنفيذها — أضف طابعة أو خامة لتتسع.', 'Requests your printers, stock and delivery can serve appear here — add a printer or a material to see more.', 'ئەو داواکارییانەی چاپکەر و کۆگا و گەیاندنەکەت دەتوانن خزمەتیان بکەن لێرە دەردەکەون — چاپکەرێک یان ماددەیەک زیاد بکە بۆ بینینی زیاتر.')
          }
          action={
            workshopHref && !blocked ? (
              <a href={workshopHref} className="inline-flex min-h-11 items-center rounded-xl px-3 text-[13px] font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {loc('طابعاتي ومخزوني', 'My printers and stock', 'چاپکەر و کۆگاکەم')}
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
                  <span className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-raised">
                    {r.thumb_url ? (
                      <RequestThumb url={r.thumb_url} size={64} className="h-full w-full rounded-none" />
                    ) : (
                      <Box aria-hidden="true" className="h-6 w-6 text-text-muted" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className="line-clamp-2 block text-[14px] font-semibold leading-snug text-text-primary">{r.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-muted">
                      {/* A job of parts names the technologies and materials of its parts (P1-05 review 3). */}
                      <span data-board-tech>{techLabel(r)}</span>
                      {boardJobFacts(r).materials.length > 0 && <span aria-hidden="true">·</span>}
                      {boardJobFacts(r).materials.length > 0 && <span data-board-materials>{matLabel(r)}</span>}
                      {/* A job of parts (P1-05): the parts and the pieces a set (review 5), and its quantity is the sets. */}
                      {r.summary && jobCountWords(r.summary, L).map((w) => (
                        <span key={w} className="tabular-nums" data-board-count>{w}</span>
                      ))}
                      {r.quantity > 1 && (
                        <span className="tabular-nums" dir="ltr">
                          {r.summary && (r.summary.parts_count > 1 || r.summary.pieces_per_set > 1) ? `${loc('الأطقم', 'Sets', 'سێت')} ` : ''}×{r.quantity}
                        </span>
                      )}
                      {r.summary?.review_state === 'needs_technical_review' && (
                        <span className="text-warning" data-board-review>
                          {loc('تحتاج مراجعة فنية', 'Needs a technical review', 'پێویستی بە پێداچوونەوەی تەکنیکی هەیە')}
                        </span>
                      )}
                      {r.governorate && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin aria-hidden="true" className="h-3 w-3" />
                          {govName(r.governorate)}
                        </span>
                      )}
                      {r.has_preview && (
                        <span className="inline-flex items-center gap-1">
                          <Box aria-hidden="true" className="h-3 w-3" />
                          {loc('معاينة ثلاثية الأبعاد', '3D preview', 'پێشبینینی سێ ڕەهەندی')}
                        </span>
                      )}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <span className="text-text-secondary">
                        {r.budget_iqd !== null ? (
                          <>
                            {loc('الميزانية', 'Budget', 'بودجە')} <Money iqd={r.budget_iqd} />
                          </>
                        ) : r.estimate_low_iqd !== null && r.estimate_high_iqd !== null ? (
                          <>
                            {boardEstimateLabel(r.estimate_complete, L)}{' '}
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
                              ? loc('أكّد عرضك', 'Re-confirm your offer', 'ئۆفەرەکەت دووبارە پشتڕاست بکەرەوە')
                              : r.my_offer === 'accepted'
                                ? loc('قُبل عرضك', 'Your offer won', 'ئۆفەرەکەت هەڵبژێردرا')
                                : loc('قدّمت عرضًا', 'You offered', 'ئۆفەرت پێشکەش کرد')}
                          </StatusChip>
                        )}
                        <span className="whitespace-nowrap tabular-nums text-text-muted">
                          {offersLabel(r.offer_count, lang, (n) => formatFigure(n, lang))}
                        </span>
                      </span>
                    </span>
                  </span>
                </button>
                {/* Outside the row button: a link inside a button is neither valid nor reachable. */}
                {r.source_url && <SourceLinkCard url={r.source_url} className="mt-1.5" />}
              </li>
            ))}
          </ul>
          {cursor && (
            <div className="mt-3">
              <Button block variant="secondary" loading={loadingMore} onClick={more} data-board-more>
                {loc('المزيد', 'Load more', 'زیاتر باربکە')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
