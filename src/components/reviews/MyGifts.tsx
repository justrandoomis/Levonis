import React, { useCallback, useEffect, useState } from 'react';
import { Gift, Lock, CheckCircle, Truck, XCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

/**
 * My printer-review gift entitlements (mandate §5): a quality score of N
 * unlocks a choice of exactly ONE box from levels 1..N. Contents are picked
 * server-side from real stock and persisted once — this UI only displays the
 * persisted result and never shows success before the server confirms.
 */

const STRINGS = {
  ar: {
    title: 'هداياي',
    loading: 'جارٍ التحميل...',
    loadError: 'تعذّر تحميل الهدايا.',
    retry: 'إعادة المحاولة',
    empty: 'لا توجد هدايا بعد. هدايا الطابعات تُمنح بعد اعتماد مراجعة مؤهلة من الإدارة.',
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
    optionsLabel: 'خياراتك',
    forProduct: 'عن مراجعة',
    grantedAt: 'مُنحت في',
    selectedAt: 'اختيرت في',
    fulfilledAt: 'سُلِّمت في',
    compatNote: 'توافق النوزل/اللوح مرتبط بموديل الطابعة في طلبك، وليس بأي مخزون عشوائي.',
  },
  en: {
    title: 'My Gifts',
    loading: 'Loading...',
    loadError: 'Could not load your gifts.',
    retry: 'Retry',
    empty: 'No gifts yet. Printer gifts appear after an eligible review is approved by the store.',
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
    optionsLabel: 'Your options',
    forProduct: 'For your review of',
    grantedAt: 'Granted',
    selectedAt: 'Selected',
    fulfilledAt: 'Delivered',
    compatNote: 'Nozzle/plate compatibility is tied to the printer model in your order, not arbitrary inventory.',
  },
  ckb: {
    title: 'دیارییەکانم',
    loading: 'باردەکرێت...',
    loadError: 'دیارییەکان بار نەبوون.',
    retry: 'هەوڵدانەوە',
    empty: 'هێشتا هیچ دیارییەک نییە. دیاری پرینتەرەکان دوای پەسەندکردنی پێداچوونەوەیەکی شایستە دەردەکەون.',
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
    optionsLabel: 'هەڵبژاردنەکانت',
    forProduct: 'بۆ پێداچوونەوەکەت لەسەر',
    grantedAt: 'بەخشرا',
    selectedAt: 'هەڵبژێردرا',
    fulfilledAt: 'گەیەنرا',
    compatNote: 'گونجانی نۆزڵ/پلێت بە مۆدێلی پرینتەرەکەی داواکارییەکەتەوە بەستراوەتەوە، نەک بە هەر کۆگایەکی هەڕەمەکی.',
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
interface GiftEntitlement {
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

export default function MyGifts() {
  const { lang, dir, loc } = useLanguage();
  const S = STRINGS[lang] ?? STRINGS.ar;

  const [gifts, setGifts] = useState<GiftEntitlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Per-entitlement selection state
  const [pickedLevel, setPickedLevel] = useState<Record<string, number>>({});
  const [pickedSize, setPickedSize] = useState<Record<string, string>>({});
  const [pickedPlate, setPickedPlate] = useState<Record<string, string>>({});
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await api.get<{ gifts: GiftEntitlement[] }>('/api/reviews/gifts');
      setGifts(res.gifts);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const itemLabel = (i: ContentItem) => {
    const base = loc(i.label_ar, i.label_en || i.label_ar, i.label_ckb || undefined);
    const extras = [i.brand, i.material, i.color, i.option_value].filter(Boolean).join(' · ');
    return extras ? `${base} (${extras})` : base;
  };

  const redeem = async (gift: GiftEntitlement) => {
    const level = pickedLevel[gift.id];
    if (!level || redeemingId) return;
    if (!window.confirm(S.confirm)) return;
    setRowError(null);
    setRedeemingId(gift.id);
    try {
      const options: Record<string, string> = {};
      if (level >= 4 && pickedSize[gift.id]) options.nozzleSize = pickedSize[gift.id];
      if (level === 5 && pickedPlate[gift.id]) options.plateItemId = pickedPlate[gift.id];
      await api.post(`/api/reviews/gifts/${gift.id}/redeem`, { level, options });
      await load();
    } catch (e) {
      setRowError({ id: gift.id, message: e instanceof ApiError ? e.message : 'Redemption failed' });
    } finally {
      setRedeemingId(null);
    }
  };

  const stateBadge = (g: GiftEntitlement) => {
    const map = {
      available: { label: S.stateAvailable, cls: 'bg-iris/10 text-violet-400 border-iris/30', Icon: Gift },
      selected: { label: S.stateSelected, cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30', Icon: Truck },
      fulfilled: { label: S.stateFulfilled, cls: 'bg-green-500/10 text-green-400 border-green-500/30', Icon: CheckCircle },
      cancelled: { label: S.stateCancelled, cls: 'bg-red-500/10 text-red-400 border-red-500/30', Icon: XCircle },
    }[g.state];
    const Icon = map.Icon;
    return (
      <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full border ${map.cls}`}>
        <Icon className="w-3.5 h-3.5" /> {map.label}
      </span>
    );
  };

  return (
    <div dir={dir} className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-black text-white flex items-center gap-2">
          <Gift className="w-5 h-5 text-iris" /> {S.title}
        </h2>
        <button
          onClick={load}
          className="p-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-xl text-zinc-400 hover:text-white transition-colors"
          aria-label={S.retry}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading && gifts.length === 0 && <div className="text-center text-zinc-500 text-sm py-10">{S.loading}</div>}
      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[13px] rounded-xl p-3 text-center">
          {loadError}{' '}
          <button onClick={load} className="underline font-bold">
            {S.retry}
          </button>
        </div>
      )}
      {!loading && !loadError && gifts.length === 0 && (
        <div className="text-center text-zinc-500 text-[13px] py-10 px-4">{S.empty}</div>
      )}

      {gifts.map((gift) => {
        const chosen = pickedLevel[gift.id] ?? 0;
        const chosenInfo = gift.levels.find((l) => l.level === chosen);
        const needsSize = chosen >= 4;
        const needsPlate = chosen === 5 && (chosenInfo?.plates.length ?? 0) > 1;
        const readyToRedeem =
          chosen >= 1 &&
          !!chosenInfo?.available &&
          (!needsSize || !!pickedSize[gift.id]) &&
          (!needsPlate || !!pickedPlate[gift.id]);
        return (
          <div key={gift.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="text-sm font-bold text-white">
                  {S.score}: {gift.max_level}/5
                </div>
                {gift.product.name && (
                  <div className="text-[11px] text-zinc-500">
                    {S.forProduct} {loc(gift.product.name_ar || gift.product.name, gift.product.name)}
                  </div>
                )}
              </div>
              {stateBadge(gift)}
            </div>

            {gift.state === 'available' && (
              <>
                <p className="text-[12px] text-zinc-400">{S.unlocked(gift.max_level)}</p>
                <div className="space-y-2">
                  {gift.levels.map((lv) => {
                    const selected = chosen === lv.level;
                    return (
                      <button
                        key={lv.level}
                        type="button"
                        disabled={!lv.available}
                        onClick={() => {
                          setPickedLevel((m) => ({ ...m, [gift.id]: lv.level }));
                          setPickedSize((m) => ({ ...m, [gift.id]: '' }));
                          setPickedPlate((m) => ({ ...m, [gift.id]: '' }));
                        }}
                        className={`w-full text-start rounded-xl border p-3 transition-colors ${
                          selected
                            ? 'border-iris bg-iris/10'
                            : lv.available
                              ? 'border-zinc-700 bg-zinc-950 hover:border-zinc-500'
                              : 'border-zinc-800 bg-zinc-950/50 opacity-60'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[13px] font-bold text-white">
                            {S.level} {lv.level}
                          </span>
                          {!lv.available && (
                            <span className="flex items-center gap-1 text-[10px] text-amber-400">
                              <AlertTriangle className="w-3 h-3" />
                              {lv.reason === 'compat_unconfigured' ? S.compatUnconfigured : S.poolUnconfigured}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-zinc-400 mt-0.5">{S.levelDesc[lv.level]}</p>
                      </button>
                    );
                  })}
                  {/* Locked levels above the score are not rendered as pickable
                      — the score is the hard server-side gate anyway. */}
                  {gift.max_level < 5 && (
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 px-1">
                      <Lock className="w-3 h-3" />
                      {S.level} {gift.max_level + 1}–5
                    </div>
                  )}
                </div>

                {needsSize && chosenInfo && (
                  <div>
                    <label className="block text-[12px] font-bold text-zinc-400 mb-1">{S.nozzleSize}</label>
                    <select
                      value={pickedSize[gift.id] ?? ''}
                      onChange={(e) => setPickedSize((m) => ({ ...m, [gift.id]: e.target.value }))}
                      className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-iris outline-none"
                    >
                      <option value="">{S.chooseSize}</option>
                      {chosenInfo.nozzle_sizes.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {chosen === 5 && chosenInfo && chosenInfo.plates.length > 0 && (
                  <div>
                    <label className="block text-[12px] font-bold text-zinc-400 mb-1">{S.choosePlate}</label>
                    <select
                      value={pickedPlate[gift.id] ?? ''}
                      onChange={(e) => setPickedPlate((m) => ({ ...m, [gift.id]: e.target.value }))}
                      className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-iris outline-none"
                    >
                      <option value="">{S.choosePlate}</option>
                      {chosenInfo.plates.map((p) => (
                        <option key={p.id} value={p.id}>
                          {loc(p.label_ar, p.label_en || p.label_ar, p.label_ckb || undefined)}
                          {p.brand ? ` — ${p.brand}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <p className="text-[11px] text-zinc-600">{S.compatNote}</p>

                {rowError?.id === gift.id && (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-[12px] rounded-xl p-3">
                    {rowError.message}
                  </div>
                )}

                <button
                  onClick={() => redeem(gift)}
                  disabled={!readyToRedeem || redeemingId === gift.id}
                  className="w-full bg-[#6B46FF] hover:bg-iris-deep disabled:opacity-40 text-snow text-sm font-bold py-2.5 rounded-full transition-colors"
                >
                  {redeemingId === gift.id ? S.redeeming : S.redeem}
                </button>
              </>
            )}

            {(gift.state === 'selected' || gift.state === 'fulfilled') && (
              <div className="space-y-2">
                <div className="text-[12px] font-bold text-zinc-300">
                  {S.contents} ({S.level} {gift.chosen_level}):
                </div>
                <ul className="space-y-1">
                  {gift.contents.map((it) => (
                    <li key={it.item_id} className="flex items-center gap-2 text-[13px] text-zinc-200">
                      <Gift className="w-3.5 h-3.5 text-iris shrink-0" />
                      {itemLabel(it)}
                    </li>
                  ))}
                </ul>
                {(gift.chosen_options.nozzle_size || gift.chosen_options.plate_item_id) && (
                  <div className="text-[11px] text-zinc-500">
                    {S.optionsLabel}: {gift.chosen_options.nozzle_size ? `${S.nozzleSize} ${gift.chosen_options.nozzle_size}` : ''}
                  </div>
                )}
                <div className="text-[11px] text-zinc-500 space-x-2 rtl:space-x-reverse">
                  <span>
                    {S.grantedAt}: {new Date(gift.created_at).toLocaleDateString()}
                  </span>
                  {gift.selected_at && (
                    <span>
                      {S.selectedAt}: {new Date(gift.selected_at).toLocaleDateString()}
                    </span>
                  )}
                  {gift.fulfilled_at && (
                    <span>
                      {S.fulfilledAt}: {new Date(gift.fulfilled_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
