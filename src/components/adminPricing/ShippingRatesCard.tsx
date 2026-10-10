/**
 * «أسعار الشحن المركزية» — THE THREE CENTRAL SHIPPING RATES (FX programme
 * plan §12, brief §21).
 *
 * Germany land and China air in dinars per kg, China sea in dinars per CBM.
 * They are IQD and stay IQD: no exchange rate ever converts them. The value
 * the purchase screens hold is offered as a one-tap suggestion — it fills the
 * field, it never saves by itself. Each save carries the row's version, so a
 * card left open across another save answers 409 instead of overwriting it.
 * FX-5: a saved rate reprices the engine products on that route on the
 * server, through the engine's own writer, within the request's budget; the
 * rest follow on the quarter-hour sweep. Once a product is engine-priced the
 * save is previewed first (§7.8): the panel's preview sheet shows each
 * product's price today → after, and applies the rate with the preview's hash.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import type { Language } from '../../translations';
import { iqdUnit } from '../../lib/money';
import { previewShippingRate, saveShippingRate, type FxRatesAnswer, type FxShippingDto } from './api';
import type { RateActRequest } from './RatePreview';
import type { FxStrings } from './fxStrings';
import { shippingRateInput } from './fxInput';
import { FxFigure, FxMessage, fxDate, useFxAct } from './fxParts';
import { fxFigure } from './format';

export interface ShippingRatesCardProps {
  shipping: FxShippingDto[];
  lang: Language;
  s: FxStrings;
  onAnswer: (answer: FxRatesAnswer) => void;
  onStale: () => void;
  /** How many products the engine prices: above 0, a save is previewed first (FX-5, §7.8). */
  engineProducts?: number;
  onPreviewAct?: (request: RateActRequest) => void;
}

export default function ShippingRatesCard({ shipping, lang, s, onAnswer, onStale, engineProducts = 0, onPreviewAct }: ShippingRatesCardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} data-fx-shipping className="lv-surface-raised min-w-0 p-4">
      <h4 id={titleId} className="text-[15px] font-bold leading-snug text-text-primary">
        {s.shipTitle}
      </h4>
      <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">{s.shipIntro}</p>
      <ul className="mt-3 divide-y divide-border-subtle/60">
        {shipping.map((row) => (
          <ShippingRow
            key={row.profile}
            row={row}
            lang={lang}
            s={s}
            onAnswer={onAnswer}
            onStale={onStale}
            onPreviewAct={engineProducts > 0 ? onPreviewAct : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

function ShippingRow({
  row,
  lang,
  s,
  onAnswer,
  onStale,
  onPreviewAct,
}: {
  row: FxShippingDto;
  lang: Language;
  s: FxStrings;
  onAnswer: (a: FxRatesAnswer) => void;
  onStale: () => void;
  onPreviewAct?: (request: RateActRequest) => void;
}) {
  const { busy, message, run } = useFxAct({ lang, s, onAnswer, onStale });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const label = s.ship[row.profile];
  const suggestion = row.procurement_suggestion && row.procurement_suggestion !== row.rate_iqd ? row.procurement_suggestion : null;
  // Focus goes back to «تعديل» when the editor closes, never to <body> (UX review #7).
  const editRef = useRef<HTMLButtonElement>(null);
  const [focusEdit, setFocusEdit] = useState(false);
  useEffect(() => {
    if (!focusEdit) return;
    editRef.current?.focus();
    setFocusEdit(false);
  }, [focusEdit]);

  const save = async () => {
    const rate_iqd = shippingRateInput(draft);
    if (!rate_iqd) {
      setError(s.invalidRate);
      return;
    }
    setError(null);
    const done = () => {
      setEditing(false);
      setFocusEdit(true);
    };
    if (onPreviewAct) {
      onPreviewAct({
        label: label,
        load: () => previewShippingRate(row.profile, rate_iqd),
        commit: (preview_hash, confirm) =>
          saveShippingRate(row.profile, { version: row.version, rate_iqd, preview_hash, ...(confirm ? { confirm_large_change: true } : {}) }),
        onDone: done,
      });
      return;
    }
    const ok = await run('save', (confirm_large_change) =>
      saveShippingRate(row.profile, { version: row.version, rate_iqd, ...(confirm_large_change ? { confirm_large_change: true } : {}) })
    );
    if (ok) done();
  };

  return (
    <li className="py-3" data-shipping-rate={row.profile}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 text-[14px] font-semibold text-text-primary">{label}</span>
        <span className="flex items-center gap-2">
          {row.rate_iqd ? (
            <span className="text-[14px] font-semibold text-text-primary">
              <FxFigure rate={row.rate_iqd} /> {iqdUnit(lang)}
            </span>
          ) : (
            <span className="text-[13px] font-semibold text-warning">{s.shipNotSet}</span>
          )}
          {!editing && (
            <Button
              ref={editRef}
              size="sm"
              variant="ghost"
              icon={<Pencil aria-hidden="true" className="h-3.5 w-3.5" />}
              aria-label={`${s.shipEdit} — ${label}`}
              onClick={() => {
                setDraft(row.rate_iqd ?? '');
                setEditing(true);
              }}
            >
              {s.shipEdit}
            </Button>
          )}
        </span>
      </div>
      {row.updated_at && !editing && <p className="mt-0.5 text-[12px] text-text-muted">{`${s.lastUpdate}: ${fxDate(row.updated_at, lang)}`}</p>}
      {editing && (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={s.shipRateLabel} error={error}>
            <Input autoFocus ltr inputMode="decimal" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} />
          </Field>
          {suggestion && (
            <button
              type="button"
              onClick={() => setDraft(suggestion)}
              className="min-h-[44px] rounded-md text-start text-[13px] font-semibold text-text-secondary underline decoration-border-subtle underline-offset-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              data-shipping-suggestion
            >
              {s.shipUseSuggestion(fxFigure(suggestion))}
            </button>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy === 'save'}>
              {s.save}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setError(null);
                setFocusEdit(true);
              }}
            >
              {s.cancel}
            </Button>
          </div>
        </form>
      )}
      <FxMessage message={message} s={s} />
    </li>
  );
}
