/**
 * A VARIANT'S PRICE TIERS — `PUT /variants/{id}/price-tiers` (money scope),
 * which REPLACES the active set (the old rows are deactivated, never deleted,
 * and the change is written to the price log).
 *
 * THE TWO KINDS OF TIER (worker/lib/printCloud/pricing.ts `priceMaterial`):
 *
 *   pack     an exact quantity at a fixed price — «1,000 g = 24,250 IQD»;
 *   bracket  every unit of any quantity at or above its from-quantity, in
 *            MILLI-dinars per unit — 29,000 = 29 IQD a gram; the highest
 *            bracket a quantity reaches prices the whole purchase, which is
 *            then rounded UP to the configured step and, with the cap on,
 *            never costs more than the smallest pack that covers it.
 *
 * WHERE THE CURRENT SET COMES FROM. The admin API has no read of a variant's
 * active tiers, so the editor starts from what customers are shown
 * (`GET /store/products`, active variants only) and, for a variant that is
 * not on sale, from the newest entry of the price log (`GET /price-changes`,
 * the same money scope this editor needs). When neither has it the editor
 * says so and starts empty — it never pretends a variant has no price.
 *
 * The preview beside the rows runs pricePreview.ts — the server's arithmetic —
 * on what is typed, and is labelled a preview: the price a customer pays is
 * always the server's, frozen in their quote.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Sheet } from '../../../ui/Sheet';
import { Money } from '../../../ui/Money';
import { toast } from '../../../../lib/toastStore';
import { pc, parseJsonColumn, type PriceChange, type PriceTier, type Row, type SettingsAnswer, type StoreVariant } from '../../api';
import { tri, type Tri } from '../../i18n';
import { num, qty as qtyText } from '../../format';
import { previewMaterialPrice } from '../../pricePreview';
import { pcRefusal } from '../../refusal';
import { Act, IntField, Note, SelectField, T, W, usePcLang } from '../../ui';

const S = {
  title: tri('شرائح السعر', 'Price tiers', 'پلەکانی نرخ'),
  explain: tri(
    'نوعان: «عبوة» تسعّر كمية مضبوطة بسعر ثابت (مثلاً 1000 غ = 24,250 د.ع). «شريحة كمية» تسعّر كل وحدة من أي كمية تبلغ «من كمية» أو أكثر، بالملّي دينار للوحدة (29,000 = 29 د.ع للغرام)، وأعلى شريحة تبلغها الكمية تسعّر الشراء كله. سعر الكمية غير القياسية يُقرَّب للأعلى إلى خطوة التقريب، ولا يتجاوز سعر أصغر عبوة تغطيها إن كان ذلك مفعّلاً. الحفظ يستبدل الشرائح الحالية كلها ويُسجَّل في سجل الأسعار؛ ما بيع سابقاً يبقى بسعره.',
    'Two kinds: a “pack” prices one exact quantity at a fixed price (e.g. 1,000 g = 24,250 IQD). A “bracket” prices every unit of any quantity at or above its from-quantity, in milli-dinars per unit (29,000 = 29 IQD a gram), and the highest bracket a quantity reaches prices the whole purchase. A non-pack quantity is rounded UP to the rounding step and, when the cap is on, never costs more than the smallest pack that covers it. Saving replaces every current tier and is recorded in the price log; what was already sold keeps its price.',
    'دوو جۆر: «پاکەت» نرخی بڕێکی دیاریکراو بە نرخێکی جێگیر دادەنێت (بۆ نموونە 1000 گرام = 24,250 د.ع). «پلەی بڕ» نرخی هەر یەکەیەک لە هەر بڕێک کە بگاتە «لە بڕی» یان زیاتر دادەنێت، بە میلی دینار بۆ هەر یەکەیەک (29,000 = 29 د.ع بۆ هەر گرامێک)، و بەرزترین پلە کە بڕەکە پێی بگات نرخی هەموو کڕینەکە دادەنێت. بڕێکی جگە لە پاکەت بەرەو سەر بۆ هەنگاوی خڕکردنەوە خڕ دەکرێتەوە و، ئەگەر سنوورەکە چالاک بێت، هەرگیز لە بچووکترین پاکەتێک کە دایدەپۆشێت گرانتر نابێت. پاشەکەوتکردن هەموو پلە ئێستاییەکان دەگۆڕێت و لە تۆماری نرخەکاندا تۆمار دەکرێت؛ ئەوەی پێشتر فرۆشراوە نرخی خۆی دەمێنێتەوە.'
  ),
  fromStore: tri('الشرائح الحالية كما يراها العملاء.', 'The current tiers, as customers see them.', 'پلە ئێستاییەکان، وەک کڕیاران دەیبینن.'),
  fromLog: tri('الصنف ليس معروضاً للبيع: الشرائح من آخر تغيير في سجل الأسعار', 'The variant is not on sale: tiers from the latest price-log entry of', 'ئەم جۆرە بۆ فرۆشتن نییە: پلەکان لە دوایین تۆماری نرخەکانن لە'),
  unknown: tri(
    'تعذّرت قراءة الشرائح الحالية (الصنف غير معروض وآخر تغيير خارج السجل المقروء). ما تحفظه هنا يستبدل أي شرائح نشطة.',
    'The current tiers could not be read (the variant is not on sale and its last change is outside the log read). What you save here replaces any active tiers.',
    'پلە ئێستاییەکان نەخوێنرانەوە (ئەم جۆرە بۆ فرۆشتن نییە و دوایین گۆڕینی لە دەرەوەی تۆمارە خوێندراوەکەیە). ئەوەی لێرە پاشەکەوتی دەکەیت هەر پلەیەکی چالاک دەگۆڕێت.'
  ),
  none: tri('لا شرائح سعر بعد: لا يمكن بيع هذا الصنف حتى تُضاف.', 'No price tiers yet: this variant cannot be sold until some are added.', 'هێشتا هیچ پلەیەکی نرخ نییە: ئەم جۆرە ناتوانرێت بفرۆشرێت تا زیاد بکرێن.'),
  mode: tri('النوع', 'Kind', 'جۆر'),
  pack: tri('عبوة (كمية مضبوطة)', 'Pack (exact quantity)', 'پاکەت (بڕی دیاریکراو)'),
  bracket: tri('شريحة كمية (سعر الوحدة)', 'Bracket (unit price)', 'پلەی بڕ (نرخی یەکە)'),
  packQty: tri('كمية العبوة', 'Pack quantity', 'بڕی پاکەت'),
  fromQty: tri('من كمية', 'From quantity', 'لە بڕی'),
  packPrice: tri('سعر العبوة (د.ع)', 'Pack price (IQD)', 'نرخی پاکەت (د.ع)'),
  unitPrice: tri('سعر الوحدة بالملّي دينار', 'Unit price in milli-dinars', 'نرخی یەکە بە میلی دینار'),
  perUnit: tri('للوحدة', 'per unit', 'بۆ هەر یەکەیەک'),
  add: tri('إضافة شريحة', 'Add a tier', 'زیادکردنی پلە'),
  remove: tri('حذف الشريحة', 'Remove the tier', 'سڕینەوەی پلە'),
  preview: tri('معاينة: كم تكلّف كمية ما بهذه الشرائح', 'Preview: what a quantity would cost with these tiers', 'پێشبینین: بڕێک بەم پلانە چەند تێدەچێت'),
  previewQty: tri('الكمية', 'Quantity', 'بڕ'),
  noPrice: tri('لا شريحة تسعّر هذه الكمية.', 'No tier prices this quantity.', 'هیچ پلەیەک نرخی ئەم بڕە دانانێت.'),
  byPack: tri('سعر العبوة', 'the pack price', 'نرخی پاکەت'),
  byBracket: tri('شريحة من', 'bracket from', 'پلەی لە'),
  capped: tri('محدود بسعر عبوة', 'capped at the pack of', 'سنووردارکراو بە پاکەتی'),
  previewNote: tri('معاينة فقط؛ السعر الحقيقي يحسبه الخادم ويُثبَّت في عرض السعر.', 'A preview only; the real price is the server’s, frozen in the quote.', 'تەنها پێشبینینە؛ نرخی ڕاستەقینە هی ڕاژەکارە و لە نرخداندا جێگیر دەکرێت.'),
  rounding: tri('خطوة التقريب', 'Rounding step', 'هەنگاوی خڕکردنەوە'),
  capOn: tri('الحد بسعر العبوة التالية: مفعّل', 'Cap at the next pack: on', 'سنوور بە نرخی پاکەتی دواتر: چالاک'),
  capOff: tri('الحد بسعر العبوة التالية: متوقف', 'Cap at the next pack: off', 'سنوور بە نرخی پاکەتی دواتر: کوژاوە'),
  saved: tri('حُفظت شرائح السعر.', 'Price tiers saved.', 'پلەکانی نرخ پاشەکەوت کران.'),
  invalid: tri('كل شريحة تحتاج كمية وسعراً صحيحين، بلا تكرار.', 'Every tier needs a valid quantity and price, with no duplicates.', 'هەر پلەیەک پێویستی بە بڕ و نرخێکی دروست هەیە، بێ دووبارەبوونەوە.'),
  atLeastOne: tri('شريحة واحدة على الأقل.', 'At least one tier.', 'لانیکەم یەک پلە.'),
} satisfies Record<string, Tri>;

interface Line {
  mode: 'pack' | 'bracket';
  min_qty: number | null;
  price: number | null;
}

type Source = { kind: 'store' } | { kind: 'log'; at: string } | { kind: 'unknown' };

const toLines = (tiers: PriceTier[]): Line[] =>
  tiers
    .map((t) => ({ mode: t.mode, min_qty: t.min_qty, price: (t.mode === 'pack' ? t.pack_price_iqd : t.unit_price_milli_iqd) ?? null }))
    .sort((a, b) => (a.mode === b.mode ? (a.min_qty ?? 0) - (b.min_qty ?? 0) : a.mode === 'pack' ? -1 : 1));

/** The variant's current tiers: the store's answer, else the newest price-log entry, else unknown. */
async function currentTiers(variantId: string): Promise<{ lines: Line[]; source: Source }> {
  const store = await pc.public<StoreVariant[]>('/store/products').catch(() => [] as StoreVariant[]);
  const onSale = store.find((v) => v.id === variantId);
  if (onSale) return { lines: toLines(onSale.price_tiers), source: { kind: 'store' } };
  const log = await pc.get<PriceChange[]>('/price-changes?limit=500').catch(() => [] as PriceChange[]);
  const last = log.find((c) => c.entity_type === 'price_tiers' && c.entity_id === variantId);
  if (last) return { lines: toLines(parseJsonColumn<{ tiers?: PriceTier[] }>(last.after_json, {}).tiers ?? []), source: { kind: 'log', at: last.created_at } };
  return { lines: [], source: { kind: 'unknown' } };
}

export function PriceTiersSheet({ variant, open, onClose }: { variant: Row; open: boolean; onClose: () => void }) {
  const { t, lang } = usePcLang();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [settings, setSettings] = useState<SettingsAnswer['config'] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [probe, setProbe] = useState<number | null>(null);
  const variantId = String(variant.id);
  const unit = String(variant.unit_code ?? '');

  useEffect(() => {
    let alive = true;
    currentTiers(variantId).then(
      (out) => {
        if (!alive) return;
        setLines(out.lines);
        setSource(out.source);
      },
      (e: unknown) => alive && setLoadError(pcRefusal(e, lang, t(W.loadFailed)))
    );
    pc.get<SettingsAnswer>('/settings').then(
      (s) => alive && setSettings(s.config),
      () => undefined
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantId]);

  const tiers = useMemo(
    () =>
      (lines ?? [])
        .filter((l) => l.min_qty !== null && l.price !== null)
        .map((l) => (l.mode === 'pack' ? { mode: 'pack' as const, min_qty: l.min_qty as number, pack_price_iqd: l.price as number } : { mode: 'bracket' as const, min_qty: l.min_qty as number, unit_price_milli_iqd: l.price as number })),
    [lines]
  );
  const valid =
    !!lines &&
    lines.length > 0 &&
    lines.length <= 30 &&
    lines.every((l) => l.min_qty !== null && l.min_qty >= 1 && l.min_qty <= 100_000_000 && l.price !== null && l.price >= 0 && l.price <= 1_000_000_000) &&
    new Set(lines.map((l) => `${l.mode}:${l.min_qty}`)).size === lines.length;
  const preview = probe !== null && settings ? previewMaterialPrice(probe, tiers, { rounding: settings.material_price_rounding_iqd, capAtNextPack: settings.cap_custom_price_at_next_pack }) : null;

  const save = async () => {
    setFailure(null);
    if (!lines?.length) {
      setFailure(t(S.atLeastOne));
      return;
    }
    if (!valid) {
      setFailure(t(S.invalid));
      return;
    }
    try {
      const out = await pc.put<{ tiers: PriceTier[] }>(`/variants/${encodeURIComponent(variantId)}/price-tiers`, { tiers });
      setLines(toLines(out.tiers));
      toast.success(t(S.saved));
      onClose();
    } catch (e) {
      setFailure(pcRefusal(e, lang, t(W.failed)));
    }
  };

  const set = (i: number, p: Partial<Line>) => setLines((cur) => (cur ?? []).map((l, j) => (j === i ? { ...l, ...p } : l)));
  const name = String(variant[`name_${lang}`] || variant.name_en || variant.sku || variantId);
  const titleId = `pc-tiers-${variantId}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['large']}
      panelClassName="ap w-full sm:max-w-2xl"
      header={
        <div className="px-5 pb-2 pt-1">
          <h2 id={titleId} className={`text-[16px] font-bold ${T.text1}`}>
            {t(S.title)} — {name}
          </h2>
          <p className={`mt-0.5 text-[11px] ${T.text3}`}>
            <bdi dir="ltr" className="font-mono">{String(variant.sku ?? variantId)}</bdi> · {unit}
          </p>
        </div>
      }
      footer={
        <div className="space-y-2">
          {failure && <p className="lv-field-error">{failure}</p>}
          <div className="flex flex-wrap gap-2">
            <Act kind="primary" onClick={save} disabled={!lines}>
              {t(W.save)}
            </Act>
            <Act kind="ghost" onClick={onClose}>
              {t(W.cancel)}
            </Act>
          </div>
        </div>
      }
    >
      <div className="space-y-4 px-5 pb-5">
        <Note tone="info">{t(S.explain)}</Note>
        {loadError && <Note tone="danger">{loadError}</Note>}
        {source?.kind === 'store' && <p className={`text-[12px] ${T.text3}`}>{t(S.fromStore)}</p>}
        {source?.kind === 'log' && (
          <p className={`text-[12px] ${T.text3}`}>
            {t(S.fromLog)} <bdi dir="ltr">{source.at}</bdi>
          </p>
        )}
        {source?.kind === 'unknown' && <Note tone="warning">{t(S.unknown)}</Note>}
        {lines && lines.length === 0 && source?.kind !== 'unknown' && <Note tone="warning">{t(S.none)}</Note>}

        {lines?.map((l, i) => (
          <div key={i} className={`${T.surface} flex flex-wrap items-end gap-2 p-3`}>
            <SelectField
              className="w-40"
              label={t(S.mode)}
              value={l.mode}
              options={[
                { value: 'pack', label: t(S.pack) },
                { value: 'bracket', label: t(S.bracket) },
              ]}
              onChange={(v) => set(i, { mode: v === 'bracket' ? 'bracket' : 'pack' })}
            />
            <IntField className="w-40" label={t(l.mode === 'pack' ? S.packQty : S.fromQty)} unit={unit} value={l.min_qty} onChange={(v) => set(i, { min_qty: v })} />
            <IntField
              className="min-w-[12rem] flex-1"
              label={t(l.mode === 'pack' ? S.packPrice : S.unitPrice)}
              value={l.price}
              onChange={(v) => set(i, { price: v })}
              hint={
                l.mode === 'bracket' && l.price !== null ? (
                  <bdi dir="ltr">
                    = {(l.price / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} IQD {t(S.perUnit)}
                  </bdi>
                ) : l.mode === 'pack' && l.price !== null ? (
                  <Money iqd={l.price} />
                ) : undefined
              }
            />
            <button type="button" className={T.btnIconDanger} aria-label={`${t(S.remove)} #${i + 1}`} onClick={() => setLines((cur) => (cur ?? []).filter((_, j) => j !== i))}>
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        ))}
        {lines && lines.length < 30 && (
          <Act icon={<Plus size={14} aria-hidden />} onClick={() => setLines((cur) => [...(cur ?? []), { mode: 'pack', min_qty: null, price: null }])}>
            {t(S.add)}
          </Act>
        )}

        <div className={`${T.surface} space-y-2 p-3`}>
          <p className={`text-[12.5px] font-bold ${T.text2}`}>{t(S.preview)}</p>
          {settings && (
            <p className={`text-[11.5px] ${T.text3}`}>
              {t(S.rounding)}: <Money iqd={settings.material_price_rounding_iqd} /> · {t(settings.cap_custom_price_at_next_pack ? S.capOn : S.capOff)}
            </p>
          )}
          <IntField className="max-w-xs" label={t(S.previewQty)} unit={unit} value={probe} onChange={setProbe} />
          {probe !== null &&
            settings &&
            (preview ? (
              <p className={`text-[13px] ${T.text1}`}>
                {qtyText(probe, unit, lang)} = <Money iqd={preview.price_iqd} className="font-bold" />{' '}
                <span className={T.text3}>
                  ({preview.rule === 'pack' ? t(S.byPack) : `${t(S.byBracket)} ${num(preview.tier_qty)}`}
                  {preview.capped_by_pack_qty !== null && ` · ${t(S.capped)} ${num(preview.capped_by_pack_qty)}`})
                </span>
              </p>
            ) : (
              <p className={`text-[13px] ${T.text3}`}>{t(S.noPrice)}</p>
            ))}
          <p className={`text-[11px] ${T.text3}`}>{t(S.previewNote)}</p>
        </div>
      </div>
    </Sheet>
  );
}

/** The editor's name, for the row action that opens it. */
export const PRICE_TIERS_LABEL: Tri = S.title;
