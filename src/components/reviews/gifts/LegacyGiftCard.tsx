/**
 * A LEGACY REVIEW BOX — read and opened exactly as before 0175
 * (docs/GIFTS_QUICK_BUY.md D1, D4): a quality score of N unlocks a choice of
 * ONE box of levels 1..N; the contents are drawn server-side from the label
 * pool and persisted once, and the box is handed over outside the order
 * system. New gifts never take this path; an admin may convert an unopened box
 * into a level gift of the new flow, after which it renders as a GiftCard.
 */
import { useId, useState } from 'react';
import { Gift, Lock, AlertTriangle } from 'lucide-react';
import { Button } from '../../ui/Button';
import { StatusChip, type Tone } from '../../ui/Badge';
import { formatDate } from '../../orders/format';
import type { GiftLang } from './giftStrings';

const STRINGS = {
  ar: {
    score: 'درجة الجودة',
    unlocked: (n: number) => `درجتك تفتح الصناديق من 1 إلى ${n} — اختر صندوقًا واحدًا فقط.`,
    level: 'صندوق',
    levelDesc: {
      1: 'إكسسوارات Bambu Lab (مغناطيسات، حلقات، أطقم) من المخزون المعتمد',
      2: 'فلامنت عشوائي (اللون/النوع من المخزون المعتمد)',
      3: 'فلامنت عشوائي + إكسسوار Bambu من المخزون المعتمد',
      4: 'نوزل بمقاس تختاره أنت',
      5: 'نوزل + لوح طباعة (Plate)',
    } as Record<number, string>,
    stateAvailable: 'متاحة — اختر صندوقك',
    stateSelected: 'قيد التجهيز',
    stateFulfilled: 'سُلِّمت',
    stateCancelled: 'أُلغيت',
    poolUnconfigured: 'مخزون هذا الصندوق غير مُعدّ/نافد حاليًا',
    compatUnconfigured: 'توافق القطع مع طابعتك غير مُعدّ بعد',
    nozzleSize: 'مقاس النوزل',
    choosePlate: 'اختر اللوح',
    chooseSize: 'اختر المقاس',
    redeem: 'تأكيد الاختيار',
    redeeming: 'جارٍ التأكيد...',
    confirm: 'سيتم اختيار محتوى الصندوق نهائيًا ولا يمكن تغييره لاحقًا. متابعة؟',
    contents: 'محتوى هديتك',
    forProduct: 'عن مراجعة',
    grantedAt: 'مُنحت في',
    selectedAt: 'اختيرت في',
    fulfilledAt: 'سُلِّمت في',
  },
  en: {
    score: 'Quality score',
    unlocked: (n: number) => `Your score unlocks boxes 1 to ${n} — pick exactly ONE box.`,
    level: 'Box',
    levelDesc: {
      1: 'Bambu Lab accessories (magnets, rings, kits) from the approved stock',
      2: 'Random filament (color/material from the approved stock)',
      3: 'Random filament + a Bambu accessory from the approved stock',
      4: 'A nozzle in a size YOU choose',
      5: 'A nozzle + a build plate',
    } as Record<number, string>,
    stateAvailable: 'Available — choose your box',
    stateSelected: 'Being prepared',
    stateFulfilled: 'Delivered',
    stateCancelled: 'Cancelled',
    poolUnconfigured: 'This box is not stocked/configured right now',
    compatUnconfigured: 'Part compatibility for your printer is not configured yet',
    nozzleSize: 'Nozzle size',
    choosePlate: 'Choose plate',
    chooseSize: 'Choose size',
    redeem: 'Confirm choice',
    redeeming: 'Confirming...',
    confirm: 'The box contents will be finalized and cannot be changed later. Continue?',
    contents: 'Your gift contents',
    forProduct: 'For your review of',
    grantedAt: 'Granted',
    selectedAt: 'Selected',
    fulfilledAt: 'Delivered',
  },
  ckb: {
    score: 'نمرەی کوالیتی',
    unlocked: (n: number) => `نمرەکەت سندوقەکانی 1 بۆ ${n} دەکاتەوە — تەنها یەک سندوق هەڵبژێرە.`,
    level: 'سندوق',
    levelDesc: {
      1: 'ئێکسسواری Bambu Lab (موگناتیس، ئەڵقە، کیت) لە کۆگای پەسەندکراو',
      2: 'فیلامێنتی هەڕەمەکی (ڕەنگ/جۆر لە کۆگای پەسەندکراو)',
      3: 'فیلامێنتی هەڕەمەکی + ئێکسسواری Bambu لە کۆگای پەسەندکراو',
      4: 'نۆزڵ بەو قەبارەیەی خۆت هەڵیدەبژێریت',
      5: 'نۆزڵ + پلێتی چاپکردن',
    } as Record<number, string>,
    stateAvailable: 'بەردەستە — سندوقەکەت هەڵبژێرە',
    stateSelected: 'ئامادە دەکرێت',
    stateFulfilled: 'گەیەنرا',
    stateCancelled: 'هەڵوەشێنرایەوە',
    poolUnconfigured: 'کۆگای ئەم سندوقە ئێستا ڕێکنەخراوە/تەواو بووە',
    compatUnconfigured: 'گونجانی پارچەکان لەگەڵ پرینتەرەکەت هێشتا ڕێکنەخراوە',
    nozzleSize: 'قەبارەی نۆزڵ',
    choosePlate: 'پلێت هەڵبژێرە',
    chooseSize: 'قەبارە هەڵبژێرە',
    redeem: 'پشتڕاستکردنەوەی هەڵبژاردن',
    redeeming: 'پشتڕاستدەکرێتەوە...',
    confirm: 'ناوەڕۆکی سندوقەکە بە شێوەی کۆتایی دیاری دەکرێت و دواتر ناگۆڕدرێت. بەردەوام بیت؟',
    contents: 'ناوەڕۆکی دیارییەکەت',
    forProduct: 'بۆ پێداچوونەوەکەت لەسەر',
    grantedAt: 'بەخشرا',
    selectedAt: 'هەڵبژێردرا',
    fulfilledAt: 'گەیەنرا',
  },
};

interface LevelInfo {
  level: number;
  available: boolean;
  reason: 'ok' | 'pool_unconfigured' | 'compat_unconfigured';
  nozzle_sizes: string[];
  plates: Array<{ id: string; label_ar: string; label_en: string; label_ckb: string; brand: string }>;
}
interface ContentItem {
  item_id: string;
  kind: string;
  label_ar: string;
  label_en: string;
  label_ckb: string;
  brand: string;
  material: string;
  color: string;
  option_value: string;
}
export interface LegacyGift {
  id: string;
  max_level: number;
  chosen_level: number | null;
  chosen_options: { nozzle_size?: string | null; plate_item_id?: string | null };
  contents: ContentItem[];
  state: 'available' | 'selected' | 'fulfilled' | 'cancelled';
  created_at: string;
  selected_at: string | null;
  fulfilled_at: string | null;
  product: { id: string | null; name: string | null; name_ar: string | null };
  levels: LevelInfo[];
}

const TONE: Record<LegacyGift['state'], Tone> = { available: 'accent', selected: 'warning', fulfilled: 'success', cancelled: 'neutral' };

export default function LegacyGiftCard({
  lang,
  gift,
  busy,
  error,
  onRedeem,
}: {
  lang: GiftLang;
  gift: LegacyGift;
  busy: boolean;
  error?: string;
  onRedeem: (gift: LegacyGift, level: number, options: Record<string, string>) => unknown;
}) {
  const S = STRINGS[lang];
  const titleId = useId();
  const [level, setLevel] = useState(0);
  const [size, setSize] = useState('');
  const [plate, setPlate] = useState('');
  const loc = (ar: string, en: string, ckb: string) => (lang === 'en' ? en || ar : lang === 'ckb' ? ckb || ar : ar);
  const info = gift.levels.find((l) => l.level === level);
  const needsSize = level >= 4;
  const needsPlate = level === 5 && (info?.plates.length ?? 0) > 1;
  const ready = level >= 1 && !!info?.available && (!needsSize || !!size) && (!needsPlate || !!plate);
  const stateLabel = { available: S.stateAvailable, selected: S.stateSelected, fulfilled: S.stateFulfilled, cancelled: S.stateCancelled }[gift.state];
  const itemLabel = (i: ContentItem) => {
    const base = loc(i.label_ar, i.label_en, i.label_ckb);
    const extras = [i.brand, i.material, i.color, i.option_value].filter(Boolean).join(' · ');
    return extras ? `${base} (${extras})` : base;
  };

  return (
    <article aria-labelledby={titleId} data-gift-card={gift.id} data-gift-status="LEGACY" className="rounded-2xl border border-border-subtle bg-surface p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[15px] font-bold text-text-primary">
            {S.score}: {gift.max_level}/5
          </h2>
          {gift.product.name && (
            <p className="text-[12px] text-text-muted">
              {S.forProduct} {gift.product.name || gift.product.name_ar}
            </p>
          )}
        </div>
        <StatusChip tone={TONE[gift.state]}>{stateLabel}</StatusChip>
      </div>

      {gift.state === 'available' && (
        <>
          <p className="text-[12.5px] leading-relaxed text-text-secondary">{S.unlocked(gift.max_level)}</p>
          <div role="radiogroup" aria-labelledby={titleId} className="grid gap-2">
            {gift.levels.map((lv) => {
              const selected = level === lv.level;
              return (
                <button
                  key={lv.level}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!lv.available || busy}
                  onClick={() => {
                    setLevel(lv.level);
                    setSize('');
                    setPlate('');
                  }}
                  className={`w-full text-start rounded-xl border p-3 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${
                    selected ? 'border-gold/40 bg-surface-selected' : 'border-border-subtle bg-surface-raised'
                  } ${lv.available ? '' : 'opacity-60 cursor-not-allowed'}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-bold text-text-primary">
                      {S.level} {lv.level}
                    </span>
                    {!lv.available && (
                      <span className="flex items-center gap-1 text-[11.5px] text-warning">
                        <AlertTriangle aria-hidden="true" className="w-3 h-3" />
                        {lv.reason === 'compat_unconfigured' ? S.compatUnconfigured : S.poolUnconfigured}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-text-secondary">{S.levelDesc[lv.level]}</span>
                </button>
              );
            })}
            {gift.max_level < 5 && (
              <p className="flex items-center gap-1.5 px-1 text-[12px] text-text-muted">
                <Lock aria-hidden="true" className="w-3 h-3" />
                {S.level} {gift.max_level + 1}–5
              </p>
            )}
          </div>
          {needsSize && info && (
            <label className="block">
              <span className="block mb-1 text-[12px] font-bold text-text-secondary">{S.nozzleSize}</span>
              <select className="lv-input" value={size} onChange={(e) => setSize(e.target.value)}>
                <option value="">{S.chooseSize}</option>
                {info.nozzle_sizes.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          )}
          {level === 5 && info && info.plates.length > 0 && (
            <label className="block">
              <span className="block mb-1 text-[12px] font-bold text-text-secondary">{S.choosePlate}</span>
              <select className="lv-input" value={plate} onChange={(e) => setPlate(e.target.value)}>
                <option value="">{S.choosePlate}</option>
                {info.plates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {loc(p.label_ar, p.label_en, p.label_ckb)}
                    {p.brand ? ` — ${p.brand}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
          <Button
            variant="primary"
            block
            disabled={!ready}
            loading={busy}
            loadingLabel={S.redeeming}
            onClick={() => {
              if (!window.confirm(S.confirm)) return;
              const options: Record<string, string> = {};
              if (needsSize && size) options.nozzleSize = size;
              if (level === 5 && plate) options.plateItemId = plate;
              return onRedeem(gift, level, options);
            }}
          >
            {S.redeem}
          </Button>
        </>
      )}

      {(gift.state === 'selected' || gift.state === 'fulfilled') && (
        <div className="space-y-2">
          <p className="text-[12.5px] font-bold text-text-secondary">
            {S.contents} ({S.level} {gift.chosen_level}):
          </p>
          <ul className="space-y-1">
            {gift.contents.map((it) => (
              <li key={it.item_id} className="flex items-center gap-2 text-[13px] text-text-primary">
                <Gift aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-gold" />
                {itemLabel(it)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-text-muted">
        <span>
          {S.grantedAt} {formatDate(gift.created_at, lang)}
        </span>
        {gift.selected_at && (
          <span>
            {S.selectedAt} {formatDate(gift.selected_at, lang)}
          </span>
        )}
        {gift.fulfilled_at && (
          <span>
            {S.fulfilledAt} {formatDate(gift.fulfilled_at, lang)}
          </span>
        )}
      </p>
    </article>
  );
}
