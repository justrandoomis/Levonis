/**
 * THE REWARDS HUB'S SECTIONS ON /points (migration 0220; docs/DECISIONS.md
 * row 286): my reward coupons, «rate your printer» with the five gift levels,
 * the points shop and the competitions.
 *
 * ONE READ FOR ALL OF THEM (`useRewardsHub`, GET /api/rewards/program), drawn
 * where the page wants each section. The rules of src/pages/Rewards.tsx hold
 * here too: it displays and never decides — every amount, window and state is
 * the server's — and every string is written in Arabic, English and Sorani,
 * the Sorani never the Arabic copied (DECISIONS row 183).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Check, Gift, Percent, Star, Trophy, Truck, Ticket, ShoppingBag, Clock } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { formatFigure } from '../../lib/localeNumber';
import { storePromo } from '../PromoCodeField';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import SafeImage from '../ui/SafeImage';
import CompetitionCard from './CompetitionCard';
import type { RewardCoupon, RewardsHubData, ShopItem, Tri } from './types';

type Lang = 'ar' | 'en' | 'ckb';
const langOf = (l: string): Lang => (l === 'en' || l === 'ckb' ? l : 'ar');
export const tri = (t: Tri | null | undefined, lang: Lang) => (t ? t[lang] || t.ar || t.en : '');

/** The hub, read once; `reload` after anything that changes it. */
export function useRewardsHub(enabled: boolean) {
  const [data, setData] = useState<RewardsHubData | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    try {
      setData(await api.get<RewardsHubData>('/api/rewards/program'));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { data, error, reload };
}

/** The reader's day for an instant, in their own script's locale. */
function dayOf(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : lang === 'ckb' ? ['ckb-IQ-u-nu-latn', 'ar-IQ-u-nu-latn'] : 'ar-IQ-u-nu-latn', { day: 'numeric', month: 'short' });
}

/** Whole days left, from the server's own instant (never the device clock). */
const daysLeft = (expiresAt: string, serverTime: string) =>
  Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.parse(serverTime)) / 86_400_000));

export function SectionTitle({ id, icon, children }: { id: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-20 text-[17px] font-bold mb-3 px-1 text-text-primary flex items-center gap-2">
      <span aria-hidden="true" className="text-gold">{icon}</span>
      {children}
    </h2>
  );
}

// -------------------------------------------------------------- the chips

/** The page's own table of contents: a row of chips that scroll to a section. */
export function RewardsNav({ hub }: { hub: RewardsHubData | null }) {
  const { loc } = useLanguage();
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const live = hub?.coupons.filter((c) => c.state === 'active').length ?? 0;
  const chips: Array<{ id: string; label: string; badge?: number }> = [
    { id: 'coupons', label: loc('كوبوناتي', 'My coupons', 'کۆپۆنەکانم'), badge: live },
    { id: 'rate', label: loc('قيّم طابعتك', 'Rate your printer', 'چاپکەرەکەت هەڵبسەنگێنە') },
    { id: 'shop', label: loc('استبدل نقاطك', 'Spend points', 'خاڵەکانت خەرج بکە') },
    { id: 'competitions', label: loc('المسابقات', 'Competitions', 'پێشبڕکێکان') },
    { id: 'missions', label: loc('المهام', 'Missions', 'ئەرکەکان') },
  ];
  return (
    <nav aria-label={loc('أقسام المكافآت', 'Rewards sections', 'بەشەکانی خەڵات')} className="mb-6 -mx-1 px-1 overflow-x-auto hide-scrollbar">
      <div className="flex gap-2 w-max">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => go(c.id)}
            className="lv-chip [--chip:var(--color-gold)] min-h-9 px-3 rounded-full text-[13px] font-bold inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {c.label}
            {!!c.badge && <span className="min-w-5 h-5 px-1 rounded-full bg-gold text-accent-contrast text-[11px] grid place-items-center tabular-nums">{c.badge}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}

/** «X points on the way» — pending purchase points, which are not spendable yet. */
export function PendingPoints({ hub }: { hub: RewardsHubData | null }) {
  const { loc, lang } = useLanguage();
  const l = langOf(lang);
  if (!hub || hub.pending_points.points <= 0) return null;
  const n = formatFigure(hub.pending_points.points, l);
  const when = dayOf(hub.pending_points.next_available_at, l);
  return (
    <p className="text-text-secondary text-[12px] -mt-4 mb-6 flex items-center gap-1.5">
      <Clock aria-hidden="true" className="w-3.5 h-3.5" />
      {when
        ? loc(`${n} نقطة في الطريق — أولها يصير قابلًا للصرف في ${when}`, `${n} points on the way — the first become spendable on ${when}`, `${n} خاڵ لە ڕێگادان — یەکەمیان لە ${when} دەتوانرێت خەرج بکرێت`)
        : loc(`${n} نقطة في الطريق`, `${n} points on the way`, `${n} خاڵ لە ڕێگادان`)}
    </p>
  );
}

// -------------------------------------------------------------- my coupons

function CouponCard({ c, hub, onUse }: { c: RewardCoupon; hub: RewardsHubData; onUse: (code: string, shopAt: string | null) => void }) {
  const { loc, lang } = useLanguage();
  const l = langOf(lang);
  const { money } = useMoney();
  const [copied, setCopied] = useState(false);
  const ship = c.kind === 'free_shipping';
  const live = c.state === 'active';
  const left = daysLeft(c.expires_at, hub.server_time);

  const title = ship
    ? loc('توصيل مجاني', 'Free delivery', 'گەیاندنی بەخۆڕایی')
    : loc(`خصم ${c.percent}% على الفلامنت`, `${c.percent}% off filament`, `${c.percent}% داشکاندن لەسەر فیلامێنت`);

  const products = hub.program.filament.products.filter((p) => c.product_ids.includes(p.id));
  const section = hub.program.filament.section;
  /** What the filament coupon names, each one a link to go and buy it. */
  const targets: Array<{ key: string; label: string; to: string | null }> =
    c.scope === 'products'
      ? products.map((p) => ({ key: p.id, label: tri(p.name, l), to: `/product/${encodeURIComponent(p.slug)}` }))
      : section
        ? [{ key: section.id, label: tri(section.name, l), to: section.path }]
        : [{ key: 'all', label: loc('كل الفلامنت', 'all filament', 'هەموو فیلامێنتەکان'), to: null }];
  const detail = ship
    ? loc('رسوم التوصيل كاملة على طلب واحد', 'The whole delivery fee on one order', 'هەموو کرێی گەیاندن بۆ یەک داواکاری')
    : c.max_discount_iqd
      ? loc(`حتى ${money(c.max_discount_iqd)} على:`, `Up to ${money(c.max_discount_iqd)} on:`, `تا ${money(c.max_discount_iqd)} لەسەر:`)
      : loc('على:', 'On:', 'لەسەر:');
  const source =
    c.source === 'points_shop'
      ? loc(`من متجر النقاط · ${formatFigure(c.points_spent, l)} نقطة`, `From the points shop · ${formatFigure(c.points_spent, l)} pts`, `لە فرۆشگای خاڵ · ${formatFigure(c.points_spent, l)} خاڵ`)
      : c.source === 'admin'
        ? loc('من فريق Levonis', 'From the Levonis team', 'لە تیمی Levonis')
        : loc('مكافأة شراء طابعة', 'Printer purchase reward', 'خەڵاتی کڕینی چاپکەر');
  const state =
    c.state === 'active'
      ? left <= 1
        ? loc(`ينتهي ${dayOf(c.expires_at, l)} — آخر يوم`, `Ends ${dayOf(c.expires_at, l)} — last day`, `${dayOf(c.expires_at, l)} کۆتایی دێت — دوایین ڕۆژ`)
        : loc(`صالح حتى ${dayOf(c.expires_at, l)} · باقي ${left} أيام`, `Valid until ${dayOf(c.expires_at, l)} · ${left} days left`, `تا ${dayOf(c.expires_at, l)} بەکاردێت · ${left} ڕۆژ ماوە`)
      : c.state === 'used'
        ? loc('استُخدم في طلب', 'Used on an order', 'لە داواکارییەکدا بەکارهات')
        : c.state === 'expired'
          ? loc('انتهت صلاحيته', 'Expired', 'بەسەرچوو')
          : loc('أُلغي', 'Withdrawn', 'هەڵوەشێنرایەوە');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(c.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* a browser without clipboard access: the code is on screen to read */
    }
  };

  return (
    <li className={`lv-surface p-4 ${live ? '' : 'opacity-70'}`} data-testid="reward-coupon">
      <div className="flex items-start gap-3">
        <div className={`size-10 rounded-full flex items-center justify-center shrink-0 ${live ? 'bg-gold/10 text-gold' : 'lv-well text-text-secondary'}`}>
          {ship ? <Truck aria-hidden="true" className="w-5 h-5" /> : <Percent aria-hidden="true" className="w-5 h-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-text-primary font-bold text-[15px]">{title}</h3>
          <p className="text-text-secondary text-[12px] mt-0.5 leading-relaxed">
            {detail}
            {!ship &&
              targets.map((t, i) => (
                <span key={t.key}>
                  {i === 0 ? ' ' : loc('، ', ', ', '، ')}
                  {t.to ? (
                    <Link to={t.to} className="underline underline-offset-2 hover:text-text-primary">
                      {t.label}
                    </Link>
                  ) : (
                    t.label
                  )}
                </span>
              ))}
          </p>
          <p className="text-text-muted text-[11px] mt-1">{source}</p>
          <div className="flex items-center justify-between gap-2 mt-3 flex-wrap">
            <span className={`text-[12px] font-bold ${live ? (left <= 1 ? 'text-warning' : 'text-text-primary') : 'text-text-secondary'}`}>{state}</span>
            <span className="inline-flex items-center gap-1">
              <code dir="ltr" className="lv-well rounded-md px-2 py-1 text-[12px] font-bold tracking-wider">{c.code}</code>
              <button
                type="button"
                onClick={copy}
                aria-label={loc('نسخ الكود', 'Copy the code', 'کۆدەکە کۆپی بکە')}
                className="size-9 grid place-items-center rounded-full hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {copied ? <Check aria-hidden="true" className="w-4 h-4 text-sprout" /> : <Copy aria-hidden="true" className="w-4 h-4" />}
              </button>
            </span>
          </div>
          {live && (
            <button type="button" onClick={() => onUse(c.code, ship ? null : targets.find((t) => t.to)?.to ?? null)} className="lv-button lv-button-primary w-full min-h-11 mt-3 text-[14px]">
              {loc('استخدمه الآن', 'Use it now', 'ئێستا بەکاری بهێنە')}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function RewardCoupons({ hub }: { hub: RewardsHubData | null }) {
  const { loc } = useLanguage();
  const { money } = useMoney();
  const navigate = useNavigate();
  if (!hub) return null;
  const use = (code: string, shopAt: string | null) => {
    // The code rides to the checkout the way a typed promo does (the trade-in credit's door), and
    // the cart shows it in its promo box; the checkout re-validates it from scratch. A filament
    // coupon opens the filament it names, where the customer has something to spend it on.
    storePromo(code);
    navigate(shopAt ?? '/cart');
  };
  const p = hub.program;
  const how = [
    p.free_shipping.enabled ? loc('كوبون توصيل مجاني', 'a free-delivery coupon', 'کۆپۆنێکی گەیاندنی بەخۆڕایی') : '',
    p.filament.enabled
      ? p.filament.max_discount_iqd
        ? loc(
            `كوبون خصم ${p.filament.percent}% على الفلامنت المختار (حتى ${money(p.filament.max_discount_iqd)})`,
            `a ${p.filament.percent}% coupon on selected filament (up to ${money(p.filament.max_discount_iqd)})`,
            `کۆپۆنێکی ${p.filament.percent}% داشکاندن لەسەر فیلامێنتی هەڵبژێردراو (تا ${money(p.filament.max_discount_iqd)})`
          )
        : loc(`كوبون خصم ${p.filament.percent}% على الفلامنت المختار`, `a ${p.filament.percent}% coupon on selected filament`, `کۆپۆنێکی ${p.filament.percent}% داشکاندن لەسەر فیلامێنتی هەڵبژێردراو`)
      : '',
  ].filter(Boolean);
  return (
    <section className="mb-8" aria-labelledby="coupons">
      <SectionTitle id="coupons" icon={<Ticket className="w-5 h-5" />}>
        {loc('كوبوناتي', 'My coupons', 'کۆپۆنەکانم')}
      </SectionTitle>
      {p.enabled && how.length > 0 && (
        <p className="text-text-secondary text-[12px] leading-relaxed mb-3 px-1">
          {loc(
            `كل طابعة تستلمها من Levonis تمنحك ${how.join(' و')}، صالحة ${p.valid_days} أيام من الاستلام. كوبون واحد لكل طلب.`,
            `Every printer delivered to you by Levonis earns ${how.join(' and ')}, valid ${p.valid_days} days from delivery. One coupon per order.`,
            `هەر چاپکەرێک کە Levonis بۆتی دەگەیەنێت ${how.join(' و ')} پێدەبەخشێت، ${p.valid_days} ڕۆژ لە کاتی وەرگرتنەوە بەکاردێن. بۆ هەر داواکارییەک یەک کۆپۆن.`
          )}
        </p>
      )}
      {hub.coupons.length === 0 ? (
        <div className="lv-well rounded-xl p-4 text-center text-text-secondary text-[13px]">
          {loc('لا كوبونات لديك الآن.', 'You have no coupons right now.', 'ئێستا هیچ کۆپۆنێکت نییە.')}
        </div>
      ) : (
        <ul className="space-y-3">
          {hub.coupons.map((c) => (
            <CouponCard key={c.id} c={c} hub={hub} onUse={use} />
          ))}
        </ul>
      )}
    </section>
  );
}

// -------------------------------------------------------------- rate your printer

/** The five levels in the published policy's words (chapter 8) when the admin wrote none. */
function levelFallback(level: number, loc: (ar: string, en: string, ckb: string) => string): string {
  switch (level) {
    case 1: return loc('ملحق', 'An accessory', 'پاشکۆیەک');
    case 2: return loc('بكرة فلامنت', 'A filament spool', 'بکرەیەک فیلامێنت');
    case 3: return loc('فلامنت وملحق', 'Filament and an accessory', 'فیلامێنت و پاشکۆیەک');
    case 4: return loc('رأس طباعة (نوزل)', 'A print nozzle', 'نۆزڵێکی چاپ');
    default: return loc('رأس طباعة ومنصة طباعة', 'A print nozzle and a build plate', 'نۆزڵێکی چاپ و تەختەیەکی چاپ');
  }
}

export function RatePrinter({ hub }: { hub: RewardsHubData | null }) {
  const { loc, lang } = useLanguage();
  const l = langOf(lang);
  if (!hub) return null;
  const levels = hub.rating.gift_levels.filter((g) => g.active);
  const fallbackPoints = hub.rating.review_points !== null ? hub.rating.review_points * 2 : null;
  return (
    <section className="mb-8" aria-labelledby="rate">
      <SectionTitle id="rate" icon={<Star className="w-5 h-5" fill="currentColor" />}>
        {loc('قيّم طابعتك واربح هدية', 'Rate your printer, win a gift', 'چاپکەرەکەت هەڵبسەنگێنە و دیاری ببەرەوە')}
      </SectionTitle>
      <div className="lv-surface p-4">
        <ol className="space-y-2 text-[13px] text-text-secondary leading-relaxed list-decimal ps-5">
          <li>
            {loc(
              'بعد استلام طابعتك اكتب مراجعتك في صفحتها — أي تقييم من نجمة إلى خمس نجوم.',
              'Once your printer arrives, write your review on its page — any rating from one to five stars.',
              'دوای گەیشتنی چاپکەرەکەت، هەڵسەنگاندنەکەت لە پەڕەکەیدا بنووسە — هەر نمرەیەک لە یەک ئەستێرە تا پێنج.'
            )}
          </li>
          <li>
            {loc(
              'أضف صورًا واضحة (والمستويات العليا تحتاج فيديو)، وانشر ستوري على إنستغرام تشارك فيه تجربتك مع منشن ⁦@levonis_iq⁩.',
              'Add clear photos (the higher levels need a video), and post an Instagram story about your experience mentioning @levonis_iq.',
              'وێنەی ڕوون زیاد بکە (ئاستە بەرزەکان ڤیدیۆیان دەوێت)، و ستۆرییەک لە ئینستاگرام دابنێ دەربارەی ئەزموونەکەت و ⁦@levonis_iq⁩ منشن بکە.'
            )}
          </li>
          <li>
            {loc(
              'يقيّم المتجر مراجعتك من 1 إلى 5 حسب فائدتها لا حسب عدد النجوم، فتختار هديتك من مستواك أو أقل.',
              'The shop grades your review from 1 to 5 by how helpful it is — never by the stars — and you choose a gift from your level or below.',
              'فرۆشگا هەڵسەنگاندنەکەت لە ١ تا ٥ دەنرخێنێت بەپێی سوودەکەی، نەک ژمارەی ئەستێرەکان، و دیارییەکەت لە ئاستی خۆت یان خوارتر هەڵدەبژێریت.'
            )}
          </li>
        </ol>
        {levels.length > 0 && (
          <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2" aria-label={loc('مستويات الهدايا', 'Gift levels', 'ئاستەکانی دیاری')}>
            {levels.map((g) => (
              <li key={g.level} className="lv-well rounded-lg px-3 py-2 flex items-center gap-2 text-[13px]">
                <span className="size-7 rounded-full bg-gold text-accent-contrast grid place-items-center font-bold text-[12px] shrink-0 tabular-nums">{g.level}</span>
                <span className="text-text-primary font-medium">{tri(g.description, l) || levelFallback(g.level, loc)}</span>
              </li>
            ))}
          </ul>
        )}
        {fallbackPoints !== null && (
          <p className="text-text-muted text-[11px] mt-3">
            {loc(
              `مراجعة لا تبلغ مستوى هدية تمنحك ${formatFigure(fallbackPoints, l)} نقطة.`,
              `A review that does not reach a gift level earns ${formatFigure(fallbackPoints, l)} points.`,
              `هەڵسەنگاندنێک کە نەگاتە ئاستی دیاری ${formatFigure(fallbackPoints, l)} خاڵت پێدەدات.`
            )}
          </p>
        )}
      </div>

      {hub.printers.length > 0 ? (
        <ul className="space-y-2 mt-3">
          {hub.printers.map((p) => (
            <li key={p.product_id} className="lv-surface p-3 flex items-center gap-3">
              <SafeImage src={p.image} alt="" className="size-12 rounded-lg object-cover shrink-0 lv-well" />
              <div className="min-w-0 flex-1">
                <p className="text-text-primary font-bold text-[14px] truncate">{tri(p.name, l)}</p>
                <p className="text-text-secondary text-[12px]">
                  {p.state === 'to_rate'
                    ? loc('لم تقيّمها بعد', 'Not rated yet', 'هێشتا هەڵتنەسەنگاندووە')
                    : p.state === 'reward_pending'
                      ? loc('مراجعتك بانتظار قرار الهدية', 'Your review awaits the gift decision', 'هەڵسەنگاندنەکەت چاوەڕێی بڕیاری دیارییە')
                      : p.state === 'reward_approved'
                        ? loc(`قُبلت بالمستوى ${p.reward_level ?? ''} — هديتك بانتظارك`, `Approved at level ${p.reward_level ?? ''} — your gift is waiting`, `لە ئاستی ${p.reward_level ?? ''} پەسەندکرا — دیارییەکەت چاوەڕێتە`)
                        : loc(`قيّمتها ${p.stars ?? ''}★`, `You rated it ${p.stars ?? ''}★`, `${p.stars ?? ''}★ هەڵتسەنگاند`)}
                </p>
              </div>
              {p.state === 'to_rate' && p.slug && (
                <Link to={`/product/${encodeURIComponent(p.slug)}#reviews`} className="lv-button lv-button-primary min-h-10 px-3 text-[13px] shrink-0">
                  {loc('اكتب مراجعتك', 'Write a review', 'هەڵسەنگاندن بنووسە')}
                </Link>
              )}
              {p.state === 'reward_approved' && (
                <Link to="/gifts" className="lv-button lv-button-secondary min-h-10 px-3 text-[13px] shrink-0">
                  <Gift aria-hidden="true" className="w-4 h-4" />
                  {loc('هداياي', 'My gifts', 'دیارییەکانم')}
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-text-secondary text-[12px] mt-3 px-1">
          {loc('حين تستلم طابعة من Levonis تظهر هنا لتقيّمها.', 'When a printer from Levonis reaches you, it appears here to rate.', 'کاتێک چاپکەرێک لە Levonis پێت دەگات، لێرە دەردەکەوێت بۆ هەڵسەنگاندن.')}
        </p>
      )}
    </section>
  );
}

// -------------------------------------------------------------- the points shop

export function PointsShop({ hub, onChanged }: { hub: RewardsHubData | null; onChanged: () => Promise<void> | void }) {
  const { loc, lang } = useLanguage();
  const l = langOf(lang);
  const { money } = useMoney();
  const [asking, setAsking] = useState<ShopItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  if (!hub) return null;

  const name = (item: ShopItem) =>
    item.kind === 'free_shipping'
      ? loc('كوبون توصيل مجاني', 'Free-delivery coupon', 'کۆپۆنی گەیاندنی بەخۆڕایی')
      : loc(`كوبون خصم ${hub.program.filament.percent}% على الفلامنت`, `${hub.program.filament.percent}% filament coupon`, `کۆپۆنی ${hub.program.filament.percent}% داشکاندنی فیلامێنت`);

  const refusal = (code: string | undefined) =>
    code === 'INSUFFICIENT_POINTS'
      ? loc('نقاطك لا تكفي لهذه المكافأة.', 'You do not have enough points for this reward.', 'خاڵەکانت بەس نین بۆ ئەم خەڵاتە.')
      : code === 'REWARD_SHOP_HOLDING'
        ? loc('لديك هذا الكوبون ولم تستخدمه بعد — استخدمه أولًا.', 'You already hold this coupon — use it first.', 'ئەم کۆپۆنەت هەیە و هێشتا بەکارت نەهێناوە — سەرەتا بەکاری بهێنە.')
        : code === 'REWARD_SHOP_UNAVAILABLE'
          ? loc('هذه المكافأة غير متاحة الآن.', 'This reward is not available right now.', 'ئەم خەڵاتە ئێستا بەردەست نییە.')
          : loc('تعذّر إتمام الاستبدال.', 'The swap did not go through.', 'گۆڕینەوەکە تەواو نەبوو.');

  const buy = async () => {
    if (!asking) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/rewards/program/shop/${asking.kind}`);
      setDone(loc('أُضيف الكوبون إلى كوبوناتك.', 'The coupon is now in My coupons.', 'کۆپۆنەکە خرایە ناو کۆپۆنەکانت.'));
      setAsking(null);
      await onChanged();
    } catch (err) {
      setError(refusal(err instanceof ApiError ? err.code : undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-8" aria-labelledby="shop">
      <SectionTitle id="shop" icon={<ShoppingBag className="w-5 h-5" />}>
        {loc('استبدل نقاطك', 'Spend your points', 'خاڵەکانت خەرج بکە')}
      </SectionTitle>
      <div className="lv-surface p-4 text-[13px] text-text-secondary leading-relaxed">
        {loc(
          'عند الدفع: فعّل «استخدام النقاط» وكل نقطة تخصم دينارًا واحدًا من قيمة المنتجات.',
          'At checkout: switch on «Use points», and each point takes 1 IQD off the products.',
          'لە کاتی پارەدان: «بەکارهێنانی خاڵ» چالاک بکە، و هەر خاڵێک یەک دینار لە نرخی بەرهەمەکان کەم دەکاتەوە.'
        )}
      </div>
      {done && (
        <div role="status" className="lv-alert lv-alert-success text-[13px] font-medium text-text-primary text-center mt-3">
          {done}
        </div>
      )}
      {hub.shop.length > 0 && (
        <ul className="space-y-3 mt-3">
          {hub.shop.map((item) => (
            <li key={item.kind} className="lv-surface p-4 flex items-center gap-3">
              <div className="size-10 rounded-full bg-gold/10 text-gold flex items-center justify-center shrink-0">
                {item.kind === 'free_shipping' ? <Truck aria-hidden="true" className="w-5 h-5" /> : <Percent aria-hidden="true" className="w-5 h-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-text-primary font-bold text-[14px]">{name(item)}</p>
                <p className="text-text-secondary text-[12px]">
                  {item.kind === 'filament_discount' && hub.program.filament.max_discount_iqd
                    ? loc(`حتى ${money(hub.program.filament.max_discount_iqd)} · صالح ${hub.program.valid_days} أيام`, `Up to ${money(hub.program.filament.max_discount_iqd)} · valid ${hub.program.valid_days} days`, `تا ${money(hub.program.filament.max_discount_iqd)} · ${hub.program.valid_days} ڕۆژ بەکاردێت`)
                    : loc(`صالح ${hub.program.valid_days} أيام`, `Valid ${hub.program.valid_days} days`, `${hub.program.valid_days} ڕۆژ بەکاردێت`)}
                </p>
              </div>
              <button
                type="button"
                disabled={!item.affordable}
                onClick={() => {
                  setDone('');
                  setError('');
                  setAsking(item);
                }}
                className="lv-button lv-button-secondary min-h-10 px-3 text-[13px] shrink-0 tabular-nums disabled:opacity-60"
              >
                {loc(`${formatFigure(item.points, l)} نقطة`, `${formatFigure(item.points, l)} pts`, `${formatFigure(item.points, l)} خاڵ`)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!asking}
        title={asking ? name(asking) : ''}
        consequence={
          asking
            ? loc(
                `ستُخصم ${formatFigure(asking.points, l)} نقطة من رصيدك الآن، ويصلك الكوبون صالحًا ${hub.program.valid_days} أيام لطلب واحد.`,
                `${formatFigure(asking.points, l)} points come off your balance now, and the coupon is yours for ${hub.program.valid_days} days, for one order.`,
                `${formatFigure(asking.points, l)} خاڵ ئێستا لە باڵانسەکەت دەبڕدرێت، و کۆپۆنەکە ${hub.program.valid_days} ڕۆژ بۆ یەک داواکاری هی تۆیە.`
              )
            : ''
        }
        confirmLabel={loc('استبدل', 'Swap', 'بیگۆڕەوە')}
        cancelLabel={loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}
        onConfirm={buy}
        onCancel={() => setAsking(null)}
        busy={busy}
        error={error || undefined}
      />
    </section>
  );
}

// -------------------------------------------------------------- competitions

export function Competitions({ hub, onChanged }: { hub: RewardsHubData | null; onChanged: () => Promise<void> | void }) {
  const { loc } = useLanguage();
  if (!hub) return null;
  return (
    <section className="mb-8" aria-labelledby="competitions">
      <SectionTitle id="competitions" icon={<Trophy className="w-5 h-5" />}>
        {loc('المسابقات', 'Competitions', 'پێشبڕکێکان')}
      </SectionTitle>
      {hub.competitions.length === 0 ? (
        <div className="lv-well rounded-xl p-4 text-center text-text-secondary text-[13px]">
          {loc('لا مسابقات الآن. نعلن كل مسابقة جديدة هنا.', 'No competitions right now. Every new one is announced here.', 'ئێستا هیچ پێشبڕکێیەک نییە. هەر پێشبڕکێیەکی نوێ لێرە ڕادەگەیەنرێت.')}
        </div>
      ) : (
        <ul className="space-y-3">
          {hub.competitions.map((c) => (
            <CompetitionCard key={c.id} c={c} balance={hub.point_balance} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}
