import { useId } from 'react';
import { Check } from 'lucide-react';
import OccasionTag from '../../ui/OccasionTag';
import { OFFER_OCCASION_PRESETS, OCCASION_NAME_MAX, occasionWords } from '../../../../packages/contracts/src/offerOccasions';
import { Grid, TextInput } from './formUi';
import { V2Field } from './v2/v2Ui';
import { discountStrings, type DiscountLang } from './productDiscountStrings';
import type { OccasionDraft } from './productDiscountWire';

/**
 * «المناسبة» — WHICH OCCASION A SALE IS FOR (DECISIONS row 294; docs/ux/PRODUCT-DISCOUNT.md §16.3).
 *
 * The owner names the sale's occasion from a compact grid — every preset beside its ribbon in miniature,
 * the corner band in its own colours a shopper will see on the photograph — or types his own name («اسم
 * آخر»: Arabic required, English and Sorani optional), previewed on the real card ribbon in all three
 * languages at once: the generic words where he left a language empty, and an ellipsis where a name is
 * longer than the band holds (about a dozen letters; the hint says so). It is saved with the discount,
 * through the same door and the same stamp (productDiscountWire.ts `occasionBodyOf`); the card and the
 * «العروض الخاصة» tab both mount it.
 *
 * A radiogroup of pressable tiles (the card's Segmented recipe: flush at rest, pressed into a well when
 * on, with a check as the one secondary cue). Each tile's name is the occasion's name in the reader's
 * language; the swatch beside it is decoration.
 */
export default function OccasionPicker({
  value,
  onChange,
  lang,
  disabled = false,
}: {
  value: OccasionDraft;
  onChange: (next: OccasionDraft) => void;
  lang: DiscountLang;
  disabled?: boolean;
}) {
  const s = discountStrings(lang);
  const labelId = useId();
  const tile = (on: boolean) =>
    `lv-hit relative inline-flex min-h-[44px] min-w-0 items-center justify-center gap-1 rounded-lg border border-border-subtle px-2 py-1.5 text-[12px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
      on ? 'bg-[var(--clay-well-bg)] shadow-press text-text-primary' : 'bg-surface-raised shadow-xs text-text-secondary hover:text-text-primary'
    }`;
  const pick = (badge: string) => onChange({ ...value, badge });
  const mark = (on: boolean) => (on ? <Check aria-hidden className="h-3.5 w-3.5 shrink-0" /> : null);
  const custom = value.badge === 'custom';
  return (
    <div className="min-w-0 space-y-2" data-occasion-picker>
      <div id={labelId} className="text-[12px] font-bold text-text-secondary">
        {s.occasion}
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className="grid min-w-0 grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
        <button type="button" role="radio" aria-checked={value.badge === ''} disabled={disabled} onClick={() => pick('')} className={tile(value.badge === '')} data-occasion-option="">
          {mark(value.badge === '')}
          <span className="min-w-0 truncate">{s.occasionNone}</span>
        </button>
        {OFFER_OCCASION_PRESETS.map((key) => {
          const on = value.badge === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={occasionWords(key, null, lang)?.name}
              disabled={disabled}
              onClick={() => pick(key)}
              className={tile(on)}
              data-occasion-option={key}
            >
              {mark(on)}
              <OccasionTag badge={key} lang={lang} size="picker" />
            </button>
          );
        })}
        <button type="button" role="radio" aria-checked={custom} disabled={disabled} onClick={() => pick('custom')} className={tile(custom)} data-occasion-option="custom">
          {mark(custom)}
          <span className="min-w-0 truncate">{s.occasionCustom}</span>
        </button>
      </div>
      {custom ? (
        <div className="min-w-0 space-y-2" data-occasion-custom>
          <Grid cols={3}>
            <V2Field label={s.occasionNameAr}>
              {(id) => (
                <TextInput id={id} dir="rtl" lang="ar" maxLength={OCCASION_NAME_MAX} value={value.ar} disabled={disabled} onChange={(e) => onChange({ ...value, ar: e.target.value })} />
              )}
            </V2Field>
            <V2Field label={s.occasionNameEn}>
              {(id) => (
                <TextInput id={id} dir="ltr" lang="en" maxLength={OCCASION_NAME_MAX} value={value.en} disabled={disabled} onChange={(e) => onChange({ ...value, en: e.target.value })} />
              )}
            </V2Field>
            <V2Field label={s.occasionNameCkb}>
              {(id) => (
                <TextInput id={id} dir="rtl" lang="ckb" maxLength={OCCASION_NAME_MAX} value={value.ckb} disabled={disabled} onChange={(e) => onChange({ ...value, ckb: e.target.value })} />
              )}
            </V2Field>
          </Grid>
          <p className="text-[11px] text-text-muted">{s.occasionNameHint}</p>
          {/* The owner's name on the real card ribbon, as each language's shopper will read it — the generic
              words where a language is empty, an ellipsis where a name is longer than the band — on a tile
              the size and shape of the home rail's card (the band is laid from the corner, as on any card). */}
          {value.ar.trim() ? (
            <div aria-hidden className="flex flex-wrap gap-2" data-occasion-custom-preview>
              {(['ar', 'en', 'ckb'] as const).map((l) => (
                <div key={l} lang={l} dir={l === 'en' ? 'ltr' : 'rtl'} className="relative aspect-[6/5] w-[148px] overflow-hidden rounded-lg bg-surface-selected shadow-well">
                  <OccasionTag badge="custom" name={{ ar: value.ar, en: value.en, ckb: value.ckb }} lang={l} size="card" />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {value.badge ? (
        <p className="text-[11px] leading-relaxed text-text-muted" data-occasion-hint>
          {s.occasionHint} {s.occasionOneSale}
        </p>
      ) : null}
    </div>
  );
}
