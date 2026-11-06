/**
 * «كوبوناتك» — THE COUPON LANDS ON THE PRODUCT (owner, 2026-11-05: «from user side
 * with apply on cart product»; docs/DECISIONS.md row 298).
 *
 * `useCartCoupons` is the cart's quiet read of GET /api/cart/reward-coupons, and
 * `CartCoupons` its card: what each coupon takes off the ticked lines, one press to
 * apply them, one to take them off. `CheckoutCouponsRow` is the same offer as one
 * quiet line at the checkout. Every figure is the server's; the page adds up only
 * which of the server's lines are ticked.
 *
 * WHAT «APPLIED» MEANS. The checkout still takes one code, and that code opens the
 * customer's whole pool. So the coupons are applied when the remembered code is one
 * of the read's codes, or the code check says it opens the pool (a code that ended
 * last week still opens this week's). A customer who pressed «استخدمه الآن» in the
 * rewards area arrives with them applied. A code of theirs that opens nothing now is
 * forgotten silently, so the checkout never refuses it to their face; the press is
 * remembered on this page, so ticking the filament back brings it back. Nothing is
 * ever spent without a press, and the checkout quote stays the authority.
 *
 * A TYPED PROMO CODE stays one per order and never opens the pool: it shows on the
 * lines from the code check's own figures, the card says so, and «طبّق كوبوناتي»
 * replaces it. A code the box refuses while the coupons are applied takes nothing away:
 * only an accepted code replaces them, and the refusal stays on screen.
 *
 * WHAT A COUPON SAVES IS NOT ALWAYS WHAT IT TAKES: a member's free delivery is tested on
 * the goods after the coupons, so the server says what the pool brings back of the fee
 * (`fee_back_iqd`) and what the customer saves in the end (`net_iqd`), and a pool that
 * saves nothing is not offered. At the checkout the row asks the quote itself.
 *
 * A CUSTOMER WITH NO COUPON SEES NOTHING NEW AND COSTS ONE READ: an empty answer ends
 * the reads for this page, and the card is not drawn.
 *
 * This file rides in the cart's own chunk, which every visitor prefetches: it reads
 * nothing from the rewards area's copy.ts or model.ts, and its words are the table
 * below (tests/cartCouponsUi.test.ts holds the three languages).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Percent, Ticket, Truck } from 'lucide-react';
import { useMoney } from '../../CurrencyContext';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, isAborted } from '../../lib/api';
import { formatFigure, formatPercent } from '../../lib/localeNumber';
import { readStoredPromo, storePromo, type CouponCheckResult } from '../PromoCodeField';
import { Button } from '../ui/Button';

// ------------------------------------------------------------ the server's answer

export type CartCouponState = 'applies' | 'waiting' | 'min_not_met' | 'no_fee' | 'no_piece' | 'on_offer' | 'no_gain' | 'no_target';

export interface CartCouponTargets {
  products: Array<{ id: string; slug: string }>;
  products_total: number;
  section: { path: string } | null;
}

export interface CartCoupon {
  id: string;
  code: string;
  kind: 'free_shipping' | 'filament_discount';
  percent: number;
  amount_iqd: number | null;
  min_total_iqd: number;
  max_discount_iqd: number | null;
  max_quantity: number | null;
  expires_at: string;
  take_iqd: number;
  lines: Array<{ line_id: string; amount_iqd: number }>;
  state: CartCouponState;
  short_of_iqd: number;
  targets?: CartCouponTargets | null;
}

export interface CartCouponPreview {
  code: string;
  count: number;
  merchandise_iqd: number;
  delivery_iqd: number;
  total_iqd: number;
  /** What the coupons bring back of the delivery fee. An older server sends none. */
  fee_back_iqd?: number;
  /** What the customer saves in the end. An older server sends none: `total_iqd`. */
  net_iqd?: number;
  lines: Array<{ line_id: string; amount_iqd: number }>;
  goods_after_discount_iqd: number;
  blocked_min_total_iqd: number | null;
  short_of_iqd: number;
  delivery_waiting: boolean;
}

export interface CartRewardCoupons {
  installed: boolean;
  server_time: string;
  coupons: CartCoupon[];
  preview: CartCouponPreview | null;
}

// ------------------------------------------------------------ the words

type Row3 = readonly [ar: string, en: string, ckb: string];

export const CART_COUPON_WORDS = {
  title: ['كوبوناتك', 'Your coupons', 'کۆپۆنەکانت'],
  apply: ['طبّق كوبوناتي', 'Apply my coupons', 'کۆپۆنەکانم جێبەجێ بکە'],
  applySave: ['طبّق كوبوناتي · وفّر {money}', 'Apply my coupons · save {money}', 'کۆپۆنەکانم جێبەجێ بکە · {money} پاشەکەوت'],
  applied: ['مطبّق', 'Applied', 'جێبەجێ کراوە'],
  remove: ['إزالة', 'Remove', 'لابردن'],
  delivery: ['كوبون التوصيل', 'Delivery coupon', 'کۆپۆنی گەیاندن'],
  filament: ['خصم {percent} على الفلامنت', '{percent} off filament', '{percent} داشکاندن لەسەر فیلامێنت'],
  on: ['على {name}', 'on {name}', 'لەسەر {name}'],
  addFor: ['أضف {money} ليعمل كوبون التوصيل', 'Add {money} for the delivery coupon to work', '{money} زیاد بکە بۆ ئەوەی کۆپۆنی گەیاندن کار بکات'],
  noFilament: ['ليس في سلتك فلامنت يشمله', 'No filament in your cart that it covers', 'لە سەبەتەکەتدا هیچ فیلامێنتێک نییە کە بیگرێتەوە'],
  onOffer: ['لا يعمل على قطعة عليها عرض', 'Does not work on a piece with an offer', 'لەسەر پارچەیەک کە ئۆفەری لەسەرە کار ناکات'],
  noGain: ['يعيد أجرة التوصيل فلا يوفّر هنا، ويبقى لطلبك القادم', 'It would bring the delivery fee back and save nothing here, so it stays for your next order', 'کرێی گەیاندن دەگەڕێنێتەوە و لێرە هیچ پاشەکەوت ناکات، بۆیە بۆ داواکاری داهاتووت دەمێنێتەوە'],
  feeBack: ['تعود أجرة التوصيل ({money}) لأن طلبك ينزل عن حد التوصيل المجاني', 'The delivery fee ({money}) comes back: your order drops under the free-delivery line', 'کرێی گەیاندن ({money}) دەگەڕێتەوە چونکە داواکارییەکەت لە سنووری گەیاندنی بەخۆڕایی کەمتر دەبێت'],
  seeFilament: ['تصفّح الفلامنت', 'Browse filament', 'فیلامێنتەکان ببینە'],
  nextOrder: ['يبقى لطلبك القادم', 'Stays for your next order', 'بۆ داواکاری داهاتووت دەمێنێتەوە'],
  waiting: ['يُخصم من التوصيل عند الدفع', 'Comes off the delivery at checkout', 'لە کاتی پارەدان لە کرێی گەیاندن کەم دەکرێتەوە'],
  finalAtCheckout: ['يُحسب نهائيًا عند الدفع', 'Final at checkout', 'لە کاتی پارەدان بە تەواوی دیاری دەکرێت'],
  promoInForce: [
    'كود الخصم {code} مطبّق، والكوبونات لا تجتمع معه.',
    'The promo code {code} is in force, and coupons do not join it.',
    'کۆدی داشکاندنی {code} جێبەجێ کراوە و کۆپۆنەکان لەگەڵیدا کۆنابنەوە.',
  ],
  promoLess: [
    'كوبوناتك توفّر أكثر من هذا الكود، وتحلّ محله إن طبّقتها.',
    'Your coupons save more than this code, and replace it if you apply them.',
    'کۆپۆنەکانت لەم کۆدە زیاتر پاشەکەوت دەکەن، و ئەگەر جێبەجێیان بکەیت جێگەی دەگرنەوە.',
  ],
  lineChip: ['كوبون', 'Coupon', 'کۆپۆن'],
  lineChipPromo: ['كود الخصم', 'Promo code', 'کۆدی داشکاندن'],
  summaryGoods: ['كوبونات المكافأة', 'Reward coupons', 'کۆپۆنەکانی خەڵات'],
  summaryPromo: ['كود الخصم', 'Promo code', 'کۆدی داشکاندن'],
  summaryDelivery: ['كوبون التوصيل', 'Delivery coupon', 'کۆپۆنی گەیاندن'],
  checkoutApply: ['طبّق', 'Apply', 'جێبەجێ بکە'],
  checkoutOne: ['لديك كوبون — وفّر {money}', 'You have 1 coupon — save {money}', 'کۆپۆنێکت هەیە — {money} پاشەکەوت بکە'],
  checkoutTwo: ['لديك كوبونان — وفّر {money}', 'You have 2 coupons — save {money}', 'دوو کۆپۆنت هەیە — {money} پاشەکەوت بکە'],
  checkoutFew: ['لديك {n} كوبونات — وفّر {money}', 'You have {n} coupons — save {money}', '{n} کۆپۆنت هەیە — {money} پاشەکەوت بکە'],
  checkoutMany: ['لديك {n} كوبونًا — وفّر {money}', 'You have {n} coupons — save {money}', '{n} کۆپۆنت هەیە — {money} پاشەکەوت بکە'],
} as const satisfies Record<string, Row3>;

export type CartCouponWord = keyof typeof CART_COUPON_WORDS;
const SLOT = { ar: 0, en: 1, ckb: 2 } as const;

/** One word in the reader's language, its `{name}` marks filled. */
export function cartCouponText(key: CartCouponWord, lang: 'ar' | 'en' | 'ckb', vars: Record<string, string | number> = {}): string {
  const raw: string = CART_COUPON_WORDS[key][SLOT[lang] ?? 0];
  return raw.replace(/\{(\w+)\}/g, (mark, name: string) => (name in vars ? String(vars[name]) : mark));
}

function useWords() {
  const { lang } = useLanguage();
  return useCallback((key: CartCouponWord, vars?: Record<string, string | number>) => cartCouponText(key, lang, vars), [lang]);
}

/** The saving as the summary and the rows write it: a real minus, on the side the reader starts from. */
export const minus = (shown: string) => `−${shown}`;

// ------------------------------------------------------------ what the page shows

/**
 * Identical coupons are one row («×2»). The server's order inside a state (soonest to
 * end first); the states in the order a customer needs them.
 */
export interface CartCouponRow {
  key: string;
  kind: CartCoupon['kind'];
  state: CartCouponState;
  count: number;
  percent: number;
  take_iqd: number;
  line_ids: string[];
  min_total_iqd: number;
  short_of_iqd: number;
  targets: CartCouponTargets | null;
}

const STATE_ORDER: readonly CartCouponState[] = ['applies', 'waiting', 'min_not_met', 'no_piece', 'no_fee', 'no_gain', 'on_offer', 'no_target'];

export function cartCouponRows(coupons: readonly CartCoupon[]): CartCouponRow[] {
  const rows = new Map<string, CartCouponRow>();
  for (const c of coupons) {
    const lineIds = c.lines.map((l) => l.line_id);
    const key = [c.kind, c.state, c.percent, c.amount_iqd ?? '', c.take_iqd, lineIds.join(','), c.min_total_iqd, c.short_of_iqd].join('|');
    const row = rows.get(key);
    if (row) {
      row.count += 1;
      row.take_iqd += c.take_iqd;
    } else {
      rows.set(key, {
        key,
        kind: c.kind,
        state: c.state,
        count: 1,
        percent: c.percent,
        take_iqd: c.take_iqd,
        line_ids: lineIds,
        min_total_iqd: c.min_total_iqd,
        short_of_iqd: c.short_of_iqd,
        targets: c.targets ?? null,
      });
    }
  }
  return STATE_ORDER.flatMap((state) => [...rows.values()].filter((r) => r.state === state));
}

/** Where «تصفّح الفلامنت» leads: its one product, its section, or the coupon on «كوبوناتي», which lists the rest. */
export function couponTargetLink(targets: CartCouponTargets | null): string | null {
  if (!targets) return null;
  const only = targets.products?.[0];
  if (targets.products_total === 1 && only?.slug) return `/product/${encodeURIComponent(only.slug)}`;
  if (targets.products_total > 1) return '/rewards/coupons';
  return targets.section?.path ?? null;
}

// ------------------------------------------------------------ the read

/** Long enough for three quick taps to be one read. */
export const CART_COUPONS_DEBOUNCE_MS = 300;

export const cartCouponsPath = (itemIds: readonly string[], deliveryIqd: number | null, feeIsFinal = false, pointsIqd = 0) => {
  const q = new URLSearchParams({ item_ids: itemIds.join(',') });
  if (deliveryIqd !== null) q.set('delivery_iqd', String(deliveryIqd));
  // A quote's fee has every waiver in it: the server must not test the membership on it again.
  if (feeIsFinal) q.set('delivery_final', '1');
  if (pointsIqd > 0) q.set('points_iqd', String(pointsIqd));
  return `/api/cart/reward-coupons?${q.toString()}`;
};

/** What the customer saves in the end: what the pool takes, less the delivery fee it brings back. */
export const previewSaving = (preview: Pick<CartCouponPreview, 'total_iqd' | 'net_iqd'>): number => preview.net_iqd ?? preview.total_iqd;

/**
 * The code check's bucket is 30 presses in five minutes, and it guards against guessing codes,
 * so a typed code's silent re-check shares it. Running out is not an answer about the code: the
 * last accepted figures stay on the page rather than leaving it without a word, and the next
 * change asks again.
 */
export const isRateLimited = (e: unknown): boolean => e instanceof ApiError && e.status === 429;

export type CartCouponMode = 'none' | 'pool' | 'promo';

export interface CartCouponsInput {
  /** The cart has answered, with lines of the shop's own: nothing is asked before that, or for a guest. */
  enabled: boolean;
  /** The ticked lines. None ticked: nothing to ask. */
  itemIds: readonly string[];
  /** Changes with every quantity and every answer of the server about a line. */
  signature: string;
  /** The delivery estimate the page shows; null when it has none (the fee is pending). */
  deliveryIqd: number | null;
  /** The points the customer has switched on: a free-delivery line can be tested after them. */
  pointsIqd?: number;
}

export interface CartCouponsState {
  /** The read's answer; null before it, after a failure, and for a customer with no coupon. */
  read: CartRewardCoupons | null;
  mode: CartCouponMode;
  /** A typed code in force. */
  promo: CouponCheckResult | null;
  /** What lands on each line while something is applied. */
  lineAmounts: ReadonlyMap<string, number>;
  /** The part that comes off the delivery while something is applied. */
  deliveryOff: number;
  /** What the applied coupons bring back of the delivery fee: it is no saving. */
  feeBack: number;
  /** A typed code the box should show, ready to apply. Never a reward code. */
  boxCode: string;
  /** Changes when the page, not the box, clears the box. */
  boxKey: string;
  apply: () => void;
  remove: () => void;
  /** The box's answer: an accepted code with its check, or '' when it was removed or refused. */
  onBox: (code: string, result?: CouponCheckResult) => void;
  /** The customer asked for the coupons: only an accepted code replaces them, and a refused one takes nothing away. */
  holdsPool: boolean;
}

export function useCartCoupons({ enabled, itemIds, signature, deliveryIqd, pointsIqd = 0 }: CartCouponsInput): CartCouponsState {
  const [read, setRead] = useState<CartRewardCoupons | null>(null);
  // Mirrors the box's sessionStorage, which is what the checkout reads.
  const [code, setCode] = useState<string>(() => readStoredPromo());
  // The customer asked for the pool: on this page, or by arriving with one of its codes.
  const [poolAsked, setPoolAsked] = useState(false);
  const [promo, setPromo] = useState<CouponCheckResult | null>(null);
  const [boxTurn, setBoxTurn] = useState(0);

  const ids = itemIds.join(',');
  const readKey = `${ids}~${signature}~${deliveryIqd ?? ''}~${pointsIqd}`;
  // A code the pool does not answer for still needs the check: a typed code, or one that ended.
  const checkCode = poolAsked ? '' : code;

  const holdsNone = useRef(false);
  const lastRead = useRef<CartRewardCoupons | null>(null);
  const readFor = useRef('');
  const checkedFor = useRef('');

  useEffect(() => {
    if (!enabled || !ids) return;
    const needRead = !holdsNone.current && readFor.current !== readKey;
    const checkKey = `${checkCode}~${readKey}`;
    const known = lastRead.current?.coupons.some((c) => c.code === checkCode) ?? false;
    if (!needRead) {
      if (!checkCode) {
        setPromo(null);
        return;
      }
      if (known) {
        setPromo(null);
        setPoolAsked(true);
        return;
      }
      if (checkedFor.current === checkKey) return;
    }
    const ac = new AbortController();
    const run = async () => {
      let answer = lastRead.current;
      if (needRead) {
        try {
          answer = await api.get<CartRewardCoupons>(cartCouponsPath(itemIds, deliveryIqd, false, pointsIqd), { signal: ac.signal, mascot: 'silent' });
          if (ac.signal.aborted) return;
          holdsNone.current = answer.coupons.length === 0;
        } catch (e) {
          if (ac.signal.aborted || isAborted(e)) return;
          // A failed read shows nothing and never blocks the cart.
          answer = null;
        }
        readFor.current = readKey;
        lastRead.current = answer;
        setRead(answer);
      }
      if (!checkCode) {
        setPromo(null);
        return;
      }
      if (answer?.coupons.some((c) => c.code === checkCode)) {
        setPromo(null);
        setPoolAsked(true);
        return;
      }
      if (checkedFor.current === checkKey) return;
      try {
        const res = await api.post<CouponCheckResult>(
          '/api/cart/coupon-check',
          { code: checkCode, item_ids: itemIds, ...(deliveryIqd !== null ? { delivery_iqd: deliveryIqd } : {}) },
          { signal: ac.signal, mascot: 'silent' }
        );
        if (ac.signal.aborted) return;
        checkedFor.current = checkKey;
        if (res.valid && res.pool) {
          setPromo(null);
          setPoolAsked(true);
        } else if (res.valid) {
          setPromo(res);
        } else {
          setPromo(null);
          // Their own reward code that opens nothing now: forgotten without a word. A
          // typed code stays in the box as it always did, and the checkout says why.
          if (res.reward_code) {
            storePromo('');
            setCode('');
          }
        }
      } catch (e) {
        if (ac.signal.aborted || isAborted(e) || isRateLimited(e)) return;
        setPromo(null);
      }
    };
    const timer = setTimeout(() => void run(), CART_COUPONS_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
    // `itemIds`, `deliveryIqd` and `pointsIqd` are inside `readKey`, by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, readKey, checkCode]);

  // WHAT THE CHECKOUT WILL READ follows the pool: a code that opens nothing is not
  // stored, and when the pool opens again (a line ticked back) a live code is.
  useEffect(() => {
    if (!poolAsked || !read) return;
    const live = read.coupons.some((c) => c.code === code);
    const next = read.preview ? (live ? code : read.preview.code) : '';
    if (next !== code) {
      storePromo(next);
      setCode(next);
    }
  }, [poolAsked, read, code]);

  const apply = useCallback(() => {
    const opener = lastRead.current?.preview?.code;
    if (!opener) return;
    storePromo(opener);
    setCode(opener);
    setPromo(null);
    setPoolAsked(true);
    setBoxTurn((n) => n + 1);
  }, []);

  const remove = useCallback(() => {
    storePromo('');
    setCode('');
    setPoolAsked(false);
    setBoxTurn((n) => n + 1);
  }, []);

  const onBox = useCallback(
    (typed: string, result?: CouponCheckResult) => {
      setCode(typed);
      if (!typed) {
        setPromo(null);
        setPoolAsked(false);
        return;
      }
      if (result?.pool) {
        // A reward code typed by hand is the same press as «طبّق كوبوناتي».
        setPromo(null);
        setPoolAsked(true);
        setBoxTurn((n) => n + 1);
        return;
      }
      // The box asked about these very lines: there is nothing to ask again.
      checkedFor.current = `${typed}~${readKey}`;
      setPromo(result ?? null);
      setPoolAsked(false);
    },
    [readKey]
  );

  const pool = poolAsked && read?.preview ? read.preview : null;
  const shown = pool ?? (promo && !poolAsked ? promo : null);
  const lineAmounts = new Map((shown?.lines ?? []).map((l) => [l.line_id, l.amount_iqd]));

  return {
    read: read && read.coupons.length > 0 ? read : null,
    mode: pool ? 'pool' : promo && !poolAsked ? 'promo' : 'none',
    promo: poolAsked ? null : promo,
    lineAmounts,
    deliveryOff: shown?.delivery_iqd ?? 0,
    feeBack: pool?.fee_back_iqd ?? 0,
    boxCode: poolAsked || promo ? '' : code,
    boxKey: poolAsked ? 'pool' : `box-${boxTurn}`,
    apply,
    remove,
    onBox,
    holdsPool: poolAsked,
  };
}

// ------------------------------------------------------------ the card

const DISC = 'size-9 shrink-0 rounded-full lv-well grid place-items-center text-text-secondary';
/** The list joiner in each language. Joiners are code, not copy. */
const SEP = { ar: '، ', en: ', ', ckb: '، ' } as const;

export interface CartCouponsProps {
  read: CartRewardCoupons;
  mode: CartCouponMode;
  /** The typed code in force, in `promo` mode. */
  promoCode: string;
  /** What the typed code takes off this cart: the page offers only the better of the two (row 223 #5). */
  promoSaving?: number;
  /** A ticked line's name, by its id. */
  lineName: (lineId: string) => string;
  /** A ticked line whose price moves when it is paid on delivery: what a coupon takes of it moves too. */
  repricesAtCheckout?: boolean;
  onApply: () => void;
  onRemove: () => void;
}

export function CartCoupons({ read, mode, promoCode, promoSaving = 0, lineName, repricesAtCheckout = false, onApply, onRemove }: CartCouponsProps) {
  const t = useWords();
  const { money } = useMoney();
  const rows = cartCouponRows(read.coupons);
  const preview = read.preview;
  const applied = mode === 'pool';
  // A typed code that saves as much or more stands alone: pressing would cost the customer money.
  const promoWins = mode === 'promo' && !!preview && promoSaving >= previewSaving(preview);
  const offersApply = !applied && !!preview && !promoWins;
  const feeBack = preview?.fee_back_iqd ?? 0;
  // The note qualifies a figure: a waiting coupon has none, and its own row says when it comes off.
  const estimated = !!preview && (preview.delivery_iqd > 0 || feeBack > 0 || (repricesAtCheckout && preview.total_iqd > 0));

  return (
    <section data-cart-coupons={mode} aria-labelledby="cart-coupons-title" className="lv-surface mx-4 mt-3 p-4 space-y-2">
      <h2 id="cart-coupons-title" className="flex items-center gap-2 text-[15px] font-bold text-text-primary">
        <Ticket className="w-5 h-5 text-text-secondary" aria-hidden="true" />
        {t('title')}
      </h2>

      {mode === 'promo' && (
        <p data-cart-coupons-promo className="text-[12.5px] leading-5 text-text-secondary">
          {t('promoInForce', { code: promoCode })}
          {offersApply && ` ${t('promoLess')}`}
        </p>
      )}

      <ul className="divide-y divide-border-subtle">
        {rows.map((row) => (
          <CouponRow key={row.key} row={row} applied={applied} lineName={lineName} />
        ))}
      </ul>

      {feeBack > 0 && (
        <p data-cart-coupons-fee-back className="text-[12px] leading-5 text-text-secondary">
          {t('feeBack', { money: money(feeBack) })}
        </p>
      )}

      {estimated && (
        <p data-cart-coupons-estimate className="text-[12px] leading-5 text-text-muted">
          {t('finalAtCheckout')}
        </p>
      )}

      {offersApply && (
        <Button variant="primary" block className="py-2" onClick={onApply} data-cart-coupons-apply>
          {preview.total_iqd > 0 && mode !== 'promo' ? t('applySave', { money: money(previewSaving(preview)) }) : t('apply')}
        </Button>
      )}
      {applied && (
        <Button variant="secondary" block onClick={onRemove} data-cart-coupons-remove>
          {t('remove')}
        </Button>
      )}
    </section>
  );
}

function CouponRow({ row, applied, lineName }: { row: CartCouponRow; applied: boolean; lineName: (lineId: string) => string }) {
  const t = useWords();
  const { lang } = useLanguage();
  const { money } = useMoney();
  const ship = row.kind === 'free_shipping';
  const title = ship ? t('delivery') : t('filament', { percent: formatPercent(row.percent, lang, 0) });
  const active = row.state === 'applies' || row.state === 'waiting';
  const link = row.state === 'no_target' ? couponTargetLink(row.targets) : null;
  const names = row.line_ids.map(lineName).filter(Boolean);

  let detail: string | null = null;
  if (row.state === 'applies' && names.length > 0) detail = t('on', { name: names.join(SEP[lang]) });
  else if (row.state === 'waiting') detail = t('waiting');
  else if (row.state === 'min_not_met') detail = t('addFor', { money: money(row.short_of_iqd) });
  else if (row.state === 'no_fee' || row.state === 'no_piece') detail = t('nextOrder');
  else if (row.state === 'on_offer') detail = t('onOffer');
  else if (row.state === 'no_gain') detail = t('noGain');
  // A delivery coupon has no line only on an order with nothing paid: it simply stays.
  else if (row.state === 'no_target') detail = ship ? t('nextOrder') : t('noFilament');

  const progress = row.state === 'min_not_met' && row.min_total_iqd > 0 ? Math.max(0, Math.min(100, ((row.min_total_iqd - row.short_of_iqd) / row.min_total_iqd) * 100)) : null;

  return (
    <li data-cart-coupon-row={row.state} className={`flex items-start gap-3 py-2.5 ${active ? '' : 'text-text-muted'}`}>
      <span aria-hidden="true" className={`${DISC} ${active ? '' : 'opacity-60'}`}>
        {ship ? <Truck className="w-4 h-4" /> : <Percent className="w-4 h-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-[14px] font-semibold leading-5 ${active ? 'text-text-primary' : 'text-text-secondary'}`}>
          {title}
          {row.count > 1 && (
            <>
              {' '}
              <bdi dir="ltr" className="tabular-nums text-text-muted">
                ×{formatFigure(row.count, lang)}
              </bdi>
            </>
          )}
        </p>
        {detail && <p className="mt-0.5 text-[12px] leading-5 text-text-muted">{detail}</p>}
        {progress !== null && (
          <div aria-hidden="true" className="mt-1.5 h-1 overflow-hidden rounded-full lv-well">
            <div className="h-full rounded-full bg-text-muted" style={{ width: `${progress}%` }} />
          </div>
        )}
        {link && (
          <Link to={link} className="mt-0.5 inline-block rounded text-[12px] font-semibold leading-5 text-text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {t('seeFilament')}
          </Link>
        )}
      </div>
      {row.take_iqd > 0 && (
        <div className="shrink-0 text-end">
          <p className="text-[14px] font-bold leading-5 tabular-nums text-text-primary">{minus(money(row.take_iqd))}</p>
          {applied && (
            <p data-cart-coupon-applied className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-semibold leading-5 text-success">
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              {t('applied')}
            </p>
          )}
        </div>
      )}
      {row.take_iqd === 0 && row.state === 'waiting' && applied && (
        <p data-cart-coupon-applied className="shrink-0 inline-flex items-center gap-1 text-[12px] font-semibold leading-5 text-success">
          <Check className="w-3.5 h-3.5" aria-hidden="true" />
          {t('applied')}
        </p>
      )}
    </li>
  );
}

// ------------------------------------------------------------ the checkout's quiet row

/** «لديك 3 كوبونات — وفّر 9,500 د.ع»: the Arabic count takes its dual and its plurals. */
export function checkoutCouponsText(preview: Pick<CartCouponPreview, 'count' | 'total_iqd'>, lang: 'ar' | 'en' | 'ckb', money: (iqd: number) => string): string {
  const n = Math.max(1, Math.trunc(preview.count));
  const vars = { n: formatFigure(n, lang), money: money(preview.total_iqd) };
  if (n === 1) return cartCouponText('checkoutOne', lang, vars);
  if (n === 2) return cartCouponText('checkoutTwo', lang, vars);
  const r = n % 100;
  return cartCouponText(r >= 3 && r <= 10 ? 'checkoutFew' : 'checkoutMany', lang, vars);
}

/** What the quote says with a code on the order: what the customer would pay, and how many coupons it spends. */
export interface CheckoutCouponQuote {
  total_iqd: number;
  count: number;
}

export interface CheckoutCouponsRowProps {
  /** No code on the order, and a settled quote this can be read against. */
  enabled: boolean;
  itemIds: readonly string[];
  /** Changes with everything that prices the order: the lines, the address, the method, the payment. */
  signature: string;
  /** The quote's fee. The quote stays the authority on everything. */
  deliveryIqd: number;
  /** What the order comes to now, with no code on it. */
  plainTotalIqd: number;
  /** The same quote with this code on it. It places nothing and changes nothing on the page. */
  quoteWith: (code: string, signal: AbortSignal) => Promise<CheckoutCouponQuote>;
  onApply: (code: string) => void;
}

/**
 * The offer as one line beside «استخدام كود خاص», only with a coupon that saves
 * something. One read per change of the order, and none at all once the customer is
 * known to hold no coupon. WHAT IT PROMISES IS THE QUOTE'S OWN DIFFERENCE: only the quote
 * knows the address, the payment, the points and every waiver, and a coupon can bring a
 * waived fee back, so the row asks it, and says nothing if the order would not come out
 * cheaper. A customer holding no coupon costs no second request.
 */
export function CheckoutCouponsRow({ enabled, itemIds, signature, deliveryIqd, plainTotalIqd, quoteWith, onApply }: CheckoutCouponsRowProps) {
  const t = useWords();
  const { lang } = useLanguage();
  const { money } = useMoney();
  const [offer, setOffer] = useState<{ asked: string; code: string; count: number; total_iqd: number } | null>(null);
  const holdsNone = useRef(false);
  const ids = itemIds.join(',');
  const asked = `${ids}~${signature}~${deliveryIqd}~${plainTotalIqd}`;

  useEffect(() => {
    if (!enabled || !ids || holdsNone.current) return;
    const ac = new AbortController();
    const run = async () => {
      const res = await api.get<CartRewardCoupons>(cartCouponsPath(itemIds, deliveryIqd, true), { signal: ac.signal, mascot: 'silent' });
      if (ac.signal.aborted) return;
      holdsNone.current = res.coupons.length === 0;
      if (!res.preview || res.preview.total_iqd <= 0) {
        setOffer(null);
        return;
      }
      const code = res.preview.code;
      const quoted = await quoteWith(code, ac.signal);
      if (ac.signal.aborted) return;
      const saved = plainTotalIqd - quoted.total_iqd;
      setOffer(saved > 0 ? { asked, code, count: quoted.count, total_iqd: saved } : null);
    };
    run().catch(() => {
      // A refused or failed question is no offer, and never blocks the checkout.
      if (!ac.signal.aborted) setOffer(null);
    });
    return () => ac.abort();
    // `itemIds` is inside `ids`, by value, and `quoteWith` is the page's for the same `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, asked]);

  // An answer about another order is no answer: it stops showing the moment the order changes.
  if (!enabled || !offer || offer.asked !== asked) return null;
  return (
    <div data-checkout-coupons className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
      <p className="inline-flex min-w-0 items-center gap-2 text-[13px] leading-5 text-text-secondary">
        <Ticket className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        <span className="min-w-0">{checkoutCouponsText(offer, lang, money)}</span>
      </p>
      <Button variant="secondary" size="sm" className="ms-auto" onClick={() => onApply(offer.code)} data-checkout-coupons-apply>
        {t('checkoutApply')}
      </Button>
    </div>
  );
}
