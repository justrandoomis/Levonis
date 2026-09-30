/**
 * «من ليفونيس» — PICK A LEVONIS ITEM, MAKE IT ONE OF YOUR PARTS
 * (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.3 row «From
 * Levonis»).
 *
 * A Sheet v2 (large detent on a phone, a centred window from `sm`; list and
 * detail side by side from `lg`): the kind chips and a search over the
 * Levonis items marked for use inside printed products, one row per item
 * with its words and the Levonis price; picking one shows its options —
 * every option as variants, or one of them — and «أضف إلى قطعي» creates the
 * part, HIDDEN, in the merchant's own store (the server copies its pictures
 * and keeps its source). The stock starts at zero and the price at the
 * Levonis price: both are the merchant's from then on, in the editor this
 * sheet hands the new part to.
 *
 * A second import of the same item is refused by the server with the part
 * that exists (PART_ALREADY_IMPORTED {product_id}); the toast offers to open it.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Package, Search } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { Sheet } from '../../../ui/Sheet';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { Money } from '../../../ui/Money';
import { Skeleton } from '../../../ui/Skeleton';
import { useToast } from '../../../ui/Toast';
import { ApiError } from '../../../../lib/api';
import { apiRefusal } from '../../../../lib/refusalStrings';
import { PART_KINDS, partKindWord, type PartKind } from '../../../../../packages/catalog/src/personalize/parts';
import { partsApi, type PrintPart } from './api';
import { fromLevonisStrings, type PartsLang } from './strings';

export interface FromLevonisSheetProps {
  open: boolean;
  onClose: () => void;
  /** A part was made (or already existed): open it in the editor. */
  onOpen: (productId: string) => void;
  /** The list changed. */
  onImported: () => void;
}

const nameOf = (p: { name: string; name_ar: string; name_ckb: string }, lang: PartsLang) =>
  (lang === 'en' ? p.name : lang === 'ckb' ? p.name_ckb || p.name_ar : p.name_ar) || p.name;

export default function FromLevonisSheet({ open, onClose, onOpen, onImported }: FromLevonisSheetProps) {
  const { lang } = useLanguage();
  const l = lang as PartsLang;
  const t = fromLevonisStrings(lang);
  const toast = useToast();
  const titleId = useId();
  const [kind, setKind] = useState<'' | PartKind>('');
  const [qLive, setQLive] = useState('');
  const [q, setQ] = useState('');
  const [parts, setParts] = useState<PrintPart[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);
  const [picked, setPicked] = useState<PrintPart | null>(null);
  const [option, setOption] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => setQ(qLive.trim()), 300);
    return () => clearTimeout(id);
  }, [qLive]);

  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    setError(false);
    setParts(null);
    partsApi
      .printParts({ kind, q })
      .then((d) => {
        if (n !== seq.current) return;
        setParts(d.parts);
        setCursor(d.next_cursor);
      })
      .catch(() => n === seq.current && setError(true));
  }, [open, kind, q]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    const n = seq.current;
    try {
      const d = await partsApi.printParts({ kind, q, cursor });
      if (n !== seq.current) return;
      setParts((p) => [...(p ?? []), ...d.parts.filter((x) => !(p ?? []).some((y) => y.id === x.id))]);
      setCursor(d.next_cursor);
    } catch {
      toast.error(t.loadFailed);
    } finally {
      setMore(false);
    }
  }

  function pick(p: PrintPart) {
    setPicked(p);
    setOption('');
  }

  async function add() {
    if (!picked || busy) return;
    setBusy(true);
    try {
      const r = await partsApi.fromLevonis(picked.id, option || null);
      toast.success(t.added);
      onImported();
      onOpen(r.product.id);
    } catch (e) {
      const existing = e instanceof ApiError && e.code === 'PART_ALREADY_IMPORTED' ? String(e.details?.product_id ?? '') : '';
      toast.error(apiRefusal(e, l, t.addFailed), existing ? { action: { label: t.open, onClick: () => onOpen(existing) } } : undefined);
    } finally {
      setBusy(false);
    }
  }

  const chosen = picked && option ? picked.options.find((o) => o.key === option) : undefined;

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="w-full sm:max-w-3xl"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary">{t.title}</h2>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-muted">{t.lead}</p>
        </div>
      }
      footer={
        <div className="flex items-center gap-2 px-5 py-3">
          {picked && (
            <Button variant="ghost" onClick={() => setPicked(null)} className="lg:hidden" disabled={busy}>
              {t.back}
            </Button>
          )}
          <Button variant="primary" onClick={add} loading={busy} disabled={!picked} className="flex-1" data-from-levonis-add>
            {t.add}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 px-5 pb-6 pt-1 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0" data-from-levonis>
        <div className={`space-y-3 ${picked ? 'hidden lg:block' : ''}`}>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
            <Input type="search" value={qLive} onChange={(e) => setQLive(e.target.value)} placeholder={t.search} aria-label={t.search} className="ps-9" enterKeyHint="search" />
          </div>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 hide-scrollbar" role="group" aria-label={t.kind}>
            <button type="button" className="lv-choice shrink-0 px-3 text-[13px]" aria-pressed={kind === ''} onClick={() => setKind('')}>
              {t.all}
            </button>
            {PART_KINDS.filter((k) => k !== 'other').map((k) => (
              <button key={k} type="button" className="lv-choice shrink-0 px-3 text-[13px]" aria-pressed={kind === k} onClick={() => setKind(kind === k ? '' : k)} data-kind={k}>
                {partKindWord(k, l)}
              </button>
            ))}
          </div>
          {error ? (
            <p className="py-6 text-center text-[13px] text-text-muted" role="alert">{t.loadFailed}</p>
          ) : parts === null ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : parts.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-text-muted">{t.empty}</p>
          ) : (
            <ul className="space-y-2" aria-label={t.title}>
              {parts.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="lv-choice flex w-full items-center gap-3 p-2 text-start"
                    aria-pressed={picked?.id === p.id}
                    onClick={() => pick(p)}
                    data-print-part={p.id}
                  >
                    <span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised">
                      {p.image ? <img src={p.image} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Package className="m-3 h-5 w-5 text-text-muted" aria-hidden="true" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-text-primary">{nameOf(p, l)}</span>
                      <span className="block truncate text-[12px] text-text-muted">{p.words[l]}</span>
                    </span>
                    <span className="shrink-0 text-end text-[12.5px] text-text-secondary">
                      <Money iqd={p.price_iqd} />
                      {!p.in_stock && <span className="block text-[11.5px] text-warning">{t.outOfStock}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {cursor && parts && (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" onClick={loadMore} loading={more}>{t.more}</Button>
            </div>
          )}
        </div>

        <div className={picked ? '' : 'hidden lg:block'} data-from-levonis-detail>
          {!picked ? (
            <p className="rounded-2xl border border-border-subtle p-4 text-[13px] leading-relaxed text-text-muted">{t.pick}</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-surface-raised">
                  {picked.image ? <img src={picked.image} alt="" className="h-full w-full object-cover" /> : <Package className="h-6 w-6 text-text-muted" aria-hidden="true" />}
                </span>
                <div className="min-w-0">
                  <p className="text-[15px] font-bold text-text-primary">{nameOf(picked, l)}</p>
                  <p className="text-[12.5px] text-text-muted">{(chosen ?? picked).words[l]}</p>
                  <p className="mt-1 text-[12.5px] text-text-secondary">
                    {t.levonisPrice}: <Money iqd={(chosen ?? picked).price_iqd} />
                    {' · '}
                    <span className={(chosen ?? picked).in_stock ? 'text-success' : 'text-warning'}>{(chosen ?? picked).in_stock ? t.inStock : t.outOfStock}</span>
                  </p>
                </div>
              </div>
              {picked.options.length > 0 && (
                <div role="radiogroup" aria-label={t.which} className="space-y-2">
                  <p className="text-[12.5px] font-semibold text-text-secondary">{t.which}</p>
                  {[{ key: '', label: t.allOptions, words: '', price: null as number | null }, ...picked.options.map((o) => ({ key: o.key, label: nameOf(o, l), words: o.words[l], price: o.price_iqd }))].map((o) => (
                    <button
                      key={o.key || 'all'}
                      type="button"
                      role="radio"
                      aria-checked={option === o.key}
                      className="lv-choice flex w-full items-center justify-between gap-3 px-3 py-2 text-start"
                      onClick={() => setOption(o.key)}
                      data-option={o.key || 'all'}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-text-primary">{o.label}</span>
                        {o.words && <span className="block truncate text-[12px] text-text-muted">{o.words}</span>}
                      </span>
                      {o.price !== null && <span className="shrink-0 text-[12.5px] text-text-secondary"><Money iqd={o.price} /></span>}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[12px] leading-relaxed text-text-muted">{t.priceNote}</p>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
