/**
 * SCREEN 4's sheet — «الجهاز الجديد» (trade-in design B.2, spec §10.1.4, G19): a SEARCH over the
 * devices a credit can buy, not a catalogue wall. The server answers only LISTED, V2-priced
 * devices sold directly, each with THIS customer's lowest direct-sale price (GET
 * /api/trade-in/targets, twenty a page, «المزيد» for the next); the model and colour are priced
 * by the server too (POST /api/trade-in/target-quote). A device that stopped being sold answers
 * TRADE_IN_TARGET_NOT_LISTED: its sentence is read here and the sheet stays open.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { Money } from '../ui/Money';
import SafeImage from '../ui/SafeImage';
import Spinner from '../ui/Spinner';
import { FAMILY_LABELS } from '../../../packages/pricing/src/tradeIn';
import { useT } from './useT';
import { Choice, ErrorLine, useErrText } from './parts';
import { labelOf, nameOf, type TargetOption, type TargetView } from './model';

export interface Picked {
  product_id: string;
  values: Record<string, string>;
  color_id: string | null;
}

/** A selection is complete when every group with a choice and the colour (if any) are chosen. */
const complete = (t: TargetOption, p: Picked) => t.groups.every((g) => !!p.values[g.id]) && (t.colors.length === 0 || !!p.color_id);
/** The answers a device needs from the customer (a single-value group or colour needs none). */
export const needsChoice = (t: TargetOption) => t.groups.some((g) => g.values.length > 1) || t.colors.length > 1;
export const firstPick = (t: TargetOption): Picked => ({
  product_id: t.product_id,
  values: Object.fromEntries(t.groups.filter((g) => g.values.length === 1).map((g) => [g.id, g.values[0].id])),
  color_id: t.colors.length === 1 ? t.colors[0].id : null,
});

/** The server's price for one selection. */
export async function quoteTarget(t: TargetOption, p: Picked): Promise<TargetView> {
  const d = await api.post<{ target: TargetView }>('/api/trade-in/target-quote', {
    target: {
      product_id: t.product_id,
      option_value_ids: t.groups.map((g) => p.values[g.id]).filter(Boolean),
      color_id: p.color_id,
    },
  });
  return d.target;
}

export default function TargetSearchSheet({
  open,
  onClose,
  onPicked,
  initial,
  confirmLabel,
}: {
  open: boolean;
  onClose: () => void;
  /** The device chosen, priced by the server. May return a promise (the sheet stays busy). */
  onPicked: (quote: TargetView, option: TargetOption) => unknown;
  /** Open on this device's model and colour (the product page's entry). */
  initial?: TargetOption | null;
  confirmLabel?: string;
}) {
  const { t, tx } = useT();
  const { loc, dir } = useLanguage();
  const errText = useErrText();
  const titleId = useId();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  const [q, setQ] = useState('');
  const [list, setList] = useState<TargetOption[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState('');
  const [moreBusy, setMoreBusy] = useState(false);
  const [chosen, setChosen] = useState<TargetOption | null>(initial ?? null);
  const [picked, setPicked] = useState<Picked | null>(initial ? firstPick(initial) : null);
  const [quote, setQuote] = useState<TargetView | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    if (open && initial) {
      setChosen(initial);
      setPicked(firstPick(initial));
    }
  }, [open, initial]);

  const load = useCallback(
    async (term: string, after: string | null) => {
      const mine = ++seq.current;
      const params = new URLSearchParams();
      if (term.trim().length >= 2) params.set('q', term.trim());
      if (after) params.set('cursor', after);
      try {
        const d = await api.get<{
          targets: TargetOption[];
          next_cursor: string | null;
        }>(`/api/trade-in/targets?${params.toString()}`);
        if (mine !== seq.current) return;
        setListError('');
        setList((cur) => (after && cur ? [...cur, ...d.targets] : d.targets));
        setCursor(d.next_cursor ?? null);
      } catch (e) {
        if (mine === seq.current) setListError(errText(e, t('target.loadError')));
      }
    },
    [errText, t]
  );

  // Debounced 250 ms (spec §10.1.4); the first page opens at once.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => void load(q, null), list === null ? 0 : 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, load]);

  // The server prices a complete selection the moment it exists.
  useEffect(() => {
    if (!chosen || !picked || !complete(chosen, picked)) {
      setQuote(null);
      return;
    }
    let alive = true;
    setQuoteBusy(true);
    setError('');
    quoteTarget(chosen, picked)
      .then((v) => alive && setQuote(v))
      .catch((e) => {
        if (!alive) return;
        setQuote(null);
        setError(errText(e));
      })
      .finally(() => alive && setQuoteBusy(false));
    return () => {
      alive = false;
    };
  }, [chosen, picked, errText]);

  const choose = (o: TargetOption) => {
    setError('');
    setChosen(o);
    setPicked(firstPick(o));
  };

  const body = chosen ? (
    <div className="space-y-4 px-4 py-2" data-target-options={chosen.product_id}>
      <button type="button" onClick={() => setChosen(null)} className="lv-button lv-button-ghost lv-button-sm -ms-2" data-target-back>
        <Back className="h-4 w-4" aria-hidden />
        {t('target.allResults')}
      </button>
      <div className="flex items-center gap-3">
        <SafeImage sizes="64px" src={chosen.image} alt="" aspect="square" className="h-16 w-16 shrink-0 rounded-md" bgClassName="bg-surface" />
        <div className="min-w-0">
          <p className="text-[15px] font-bold leading-5 text-text-primary line-clamp-2">{nameOf(chosen, loc)}</p>
          <p className="text-[12px] text-text-muted">{loc(FAMILY_LABELS[chosen.family].ar, FAMILY_LABELS[chosen.family].en, FAMILY_LABELS[chosen.family].ckb)}</p>
        </div>
      </div>
      {chosen.groups
        .filter((g) => g.values.length > 1)
        .map((g) => (
          <fieldset key={g.id} className="min-w-0">
            <legend className="mb-2 text-[13.5px] font-semibold text-text-primary">{g.name || t('target.model')}</legend>
            <div className="flex flex-wrap gap-2">
              {g.values.map((v) => (
                <Choice
                  key={v.id}
                  on={picked?.values[g.id] === v.id}
                  onClick={() =>
                    picked &&
                    setPicked({
                      ...picked,
                      values: { ...picked.values, [g.id]: v.id },
                    })
                  }
                  className="rounded-full"
                  data-target-value={v.id}
                >
                  {labelOf(v, loc)}
                </Choice>
              ))}
            </div>
          </fieldset>
        ))}
      {chosen.colors.length > 1 ? (
        <fieldset className="min-w-0">
          <legend className="mb-2 text-[13.5px] font-semibold text-text-primary">{t('target.colour')}</legend>
          <div className="flex flex-wrap gap-2">
            {chosen.colors.map((c) => (
              <Choice
                key={c.id}
                on={picked?.color_id === c.id}
                onClick={() => picked && setPicked({ ...picked, color_id: c.id })}
                className="rounded-full"
                data-target-color={c.id}
              >
                <span className="inline-block h-3 w-3 rounded-full border border-border-subtle" style={{ background: c.hex }} aria-hidden />
                {labelOf(c, loc)}
              </Choice>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="lv-well flex items-center justify-between gap-3 rounded-md p-3" aria-live="polite">
        <span className="text-[13px] text-text-secondary">{t('target.price')}</span>
        <span className="text-[17px] font-black text-text-primary" data-target-price>
          {quoteBusy ? <Spinner size="sm" /> : quote ? <Money iqd={quote.price_iqd} /> : t('target.choose')}
        </span>
      </div>
      <ErrorLine>{error}</ErrorLine>
    </div>
  ) : (
    <div className="space-y-3 px-4 py-2">
      <p className="text-[12.5px] text-text-muted">{t('target.only')}</p>
      {listError ? (
        <div className="space-y-2">
          <ErrorLine>{listError}</ErrorLine>
          <Button variant="secondary" size="sm" onClick={() => void load(q, null)}>
            {t('retry')}
          </Button>
        </div>
      ) : list === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <p className="py-6 text-center text-[13.5px] text-text-secondary" role="status">
          {t('target.none', { q: q.trim() })}
        </p>
      ) : (
        <>
          <p className="text-[12px] font-semibold text-text-secondary" role="status">
            {q.trim().length >= 2 ? t('target.results', { n: list.length }) : t('target.featured')}
          </p>
          <ul className="space-y-2" data-target-results>
            {list.map((o) => (
              <li key={o.product_id}>
                <button type="button" onClick={() => choose(o)} data-target={o.product_id} className="lv-choice flex w-full items-center gap-3 p-2.5 text-start">
                  <SafeImage sizes="48px" src={o.image} alt="" aspect="square" className="h-12 w-12 shrink-0 rounded-md" bgClassName="bg-surface" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-bold leading-5 text-text-primary line-clamp-2">{nameOf(o, loc)}</span>
                    <span className="block text-[12px] text-text-secondary">
                      {/* «يبدأ من» — this customer's lowest direct-sale price, from the server. */}
                      {tx('target.from', {
                        x: <Money iqd={o.from_price_iqd} />,
                      })}
                    </span>
                  </span>
                  <Chevron className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          {cursor ? (
            <Button
              variant="secondary"
              block
              loading={moreBusy}
              onClick={async () => {
                setMoreBusy(true);
                await load(q, cursor);
                setMoreBusy(false);
              }}
              data-target-more
            >
              {t('target.more')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      testId="trade-in-target"
      panelClassName="sm:max-w-[520px] sm:w-[94vw]"
      header={
        <div className="space-y-2 px-4 pb-2 pt-1">
          <h2 id={titleId} className="text-center text-[16px] font-extrabold text-text-primary">
            {t('target.q')}
          </h2>
          {!chosen ? (
            <div className="relative">
              <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-text-muted" aria-hidden />
              <input
                type="text"
                inputMode="search"
                className="lv-input ps-9 pe-11 text-[14px]"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('target.search')}
                aria-label={t('target.search')}
                enterKeyHint="search"
                data-target-search
              />
              {q ? (
                <button
                  type="button"
                  onClick={() => setQ('')}
                  aria-label={t('clearSearch')}
                  className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-md text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      }
      footer={
        chosen ? (
          <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
            <Button
              variant="primary"
              block
              disabled={!quote || quoteBusy}
              onClick={async () => {
                if (!quote) return;
                setError('');
                try {
                  await onPicked(quote, chosen);
                } catch (e) {
                  setError(errText(e));
                }
              }}
              data-target-confirm
            >
              {confirmLabel ?? t('target.confirm')}
            </Button>
          </div>
        ) : undefined
      }
    >
      {body}
    </Sheet>
  );
}
