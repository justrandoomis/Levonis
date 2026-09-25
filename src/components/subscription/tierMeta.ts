/**
 * ONE table for how a membership tier is named and coloured.
 *
 * The card face, the ambient glow, the tier selector, every chip, the
 * confirmation window, the ledger, the Header pill and the Profile badge all
 * read this — so PREMIUM can never fall back to PLUS wording or colours
 * again (it used to be labelled "PLUS" in the toast, the ledger, the pending
 * banner and the profile, and drawn in the free grey on the card).
 *
 * Colours are the site's established palette: the LEVONIS green the Header
 * already uses for PLUS (#59A846 — the `olive` token itself is a very dark
 * surface colour and is invisible as text on black), the gold token for
 * PREMIUM, and the PRO red (#B03142 / #e06070).
 */
import { Crown, Sparkles, Zap, type LucideIcon } from 'lucide-react';

export type PaidTier = 'plus' | 'prime' | 'pro';
export type AnyTier = PaidTier | 'free';

/** Precedence, lowest first — mirrors worker/lib/pricing.ts TIER_RANK. */
export const TIER_ORDER: Record<AnyTier, number> = { free: 0, plus: 1, prime: 2, pro: 3 };

export interface TierMeta {
  id: PaidTier;
  /** The customer-facing name. Latin in every language, by design. */
  label: string;
  Icon: LucideIcon;
  /** The accent, for inline shadows and SVG. */
  hex: string;
  /** A deeper shade of the accent, for the dark stop of a gradient. */
  accentDeep: string;
  /** A lighter shade of the accent, for the bright stop of a gradient. */
  accentLight: string;
  /** Accent text on the dark ground. */
  text: string;
  /** A soft chip: background, text and border. */
  chip: string;
  /** The moving indicator of the tier selector. */
  indicator: string;
  /** The ring around the selected duration card. */
  ring: string;
  /** The ambient page glow. */
  glow: string;
  /** The membership card face. */
  cardFace: string;
  /** The small status dot on the card. */
  dot: string;
  /** Check marks in the benefit lists. */
  check: string;
  /** Section heading colour for the benefit card. */
  heading: string;
  /** Border tint for the benefit card. */
  panelBorder: string;
}

export const TIER_META: Record<PaidTier, TierMeta> = {
  plus: {
    id: 'plus',
    label: 'PLUS',
    Icon: Zap,
    hex: '#59A846',
    accentDeep: 'var(--color-olive-light)',
    accentLight: '#a3e635',
    text: 'text-sprout',
    chip: 'bg-leaf/15 text-sprout border-leaf/40',
    indicator: 'bg-leaf/20 border-leaf/50',
    ring: 'border-leaf/80',
    glow: 'bg-leaf/10',
    cardFace: 'bg-gradient-to-br from-leaf/25 via-black/85 to-black/95',
    dot: 'bg-[#59A846] text-leaf',
    check: 'text-leaf',
    heading: 'text-sprout',
    panelBorder: 'border-leaf/20',
  },
  prime: {
    id: 'prime',
    label: 'PREMIUM',
    Icon: Crown,
    hex: '#BAA369',
    accentDeep: '#7A6836',
    accentLight: '#E6D8AE',
    text: 'text-gold',
    chip: 'bg-gold/15 text-gold border-gold/40',
    indicator: 'bg-gold/20 border-gold/50',
    ring: 'border-gold/80',
    glow: 'bg-gold/10',
    cardFace: 'bg-gradient-to-br from-gold/30 via-black/85 to-black/95',
    dot: 'bg-gold text-gold',
    check: 'text-gold',
    heading: 'text-gold',
    panelBorder: 'border-gold/25',
  },
  pro: {
    id: 'pro',
    label: 'PRO',
    Icon: Sparkles,
    hex: '#B03142',
    accentDeep: '#7f1d1d',
    accentLight: '#ff4d4d',
    text: 'text-coral',
    chip: 'bg-crimson/20 text-coral border-crimson/40',
    indicator: 'bg-crimson/25 border-crimson/60',
    ring: 'border-crimson/90',
    glow: 'bg-crimson/15',
    cardFace: 'bg-gradient-to-br from-crimson/40 via-black/85 to-black/95',
    dot: 'bg-[#B03142] text-crimson',
    check: 'text-coral',
    heading: 'text-coral',
    panelBorder: 'border-crimson/25',
  },
};

/** What a free account's card looks like — no tier, no accent. */
export const FREE_FACE = {
  cardFace: 'bg-gradient-to-br from-zinc-800/80 to-zinc-900/90',
  dot: 'bg-zinc-400 text-zinc-400',
  glow: 'bg-zinc-500/10',
} as const;

export function isPaidTier(t: unknown): t is PaidTier {
  return t === 'plus' || t === 'prime' || t === 'pro';
}

/** PLUS / PREMIUM / PRO. (`prime` remains the compatibility API id.) */
export function tierLabel(tier: string | null | undefined): string {
  if (isPaidTier(tier)) return TIER_META[tier].label;
  return tier ? String(tier).toUpperCase() : '';
}

export function tierMetaFor(tier: unknown): TierMeta | null {
  return isPaidTier(tier) ? TIER_META[tier] : null;
}

/**
 * The ledger states in the viewer's words — one table for the ledger, the
 * confirmation window and anything else that must name a state, so a machine
 * value like `pending_payment` never reaches a customer's screen.
 */
export const MEMBERSHIP_STATE_LABELS: Record<string, { ar: string; en: string; ckb: string }> = {
  active: { ar: 'فعالة', en: 'Active', ckb: 'چالاکە' },
  // The site is live: a reservation left from before it is converted on its
  // account's next read, so the ledger can only meet one for a moment — or one
  // an admin still has to resolve. Neither is "until the launch".
  prepaid_pending_launch: { ar: 'قيد التفعيل', en: 'Being activated', ckb: 'لە چالاککردندایە' },
  pending_payment: { ar: 'بانتظار الدفع', en: 'Pending payment', ckb: 'چاوەڕێی پارەدان' },
  expired: { ar: 'منتهية', en: 'Expired', ckb: 'بەسەرچووە' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled', ckb: 'هەڵوەشێنراوەتەوە' },
};

/** A state's label in `lang` (ar/en/ckb); an unknown state falls back to itself. */
export function membershipStateLabel(state: string, lang: string): string {
  const l = MEMBERSHIP_STATE_LABELS[state];
  if (!l) return state;
  return lang === 'en' ? l.en : lang === 'ckb' ? l.ckb : l.ar;
}

/**
 * The member-facing names of the entitlements (ENTITLEMENT_MINIMUM_TIER in
 * worker/lib/entitlements.ts), shared by the paused-benefits list and the
 * plan comparison so one benefit is never called two things. Short labels;
 * the Sorani ones are the store's existing words.
 */
export const ENTITLEMENT_LABELS: Record<string, { ar: string; en: string; ckb: string }> = {
  proPricing: { ar: 'أسعار PRO', en: 'PRO prices', ckb: 'نرخەکانی PRO' },
  freeDelivery: { ar: 'التوصيل المجاني', en: 'Free delivery', ckb: 'گەیاندنی بێبەرامبەر' },
  noPreorderCommission: { ar: 'إعفاء رسوم الشحن', en: 'Shipping surcharge waiver', ckb: 'لێبوردنی زیادکراوی گەیاندن' },
  priorityService: { ar: 'أولوية الخدمة والدعم', en: 'Priority service and support', ckb: 'پێشینەی خزمەتگوزاری و پشتیوانی' },
  proExclusive: { ar: 'عروض PRO', en: 'PRO offers', ckb: 'ئۆفەرەکانی PRO' },
  merchantProfile: { ar: 'ملف التاجر', en: 'Merchant profile', ckb: 'پرۆفایلی بازرگان' },
  merchantStore: { ar: 'المتجر', en: 'Storefront', ckb: 'فرۆشگا' },
  merchantProducts: { ar: 'نشر المنتجات', en: 'Publishing products', ckb: 'بڵاوکردنەوەی بەرهەم' },
  merchantOrders: { ar: 'طلبات المتجر', en: 'Store orders', ckb: 'داواکارییەکانی فرۆشگا' },
  communityOffers: { ar: 'عروض المجتمع', en: 'Community offers', ckb: 'ئۆفەرەکانی کۆمەڵگە' },
  merchantAnalytics: { ar: 'تحليلات المتجر', en: 'Store analytics', ckb: 'شیکاری فرۆشگا' },
  merchantSubdomain: { ar: 'رابط المتجر الفرعي', en: 'Store subdomain', ckb: 'ژێردۆمەینی فرۆشگا' },
  exclusiveCoupons: { ar: 'كوبونات الأعضاء', en: 'Member coupons', ckb: 'کۆپۆنی ئەندامان' },
  exclusiveSections: { ar: 'الأقسام الحصرية', en: 'Exclusive sections', ckb: 'بەشە تایبەتەکان' },
  memberOffers: { ar: 'عروض الأعضاء', en: 'Member offers', ckb: 'ئۆفەری ئەندامان' },
  verifiedMerchant: { ar: 'شارة التاجر PRO', en: 'PRO merchant badge', ckb: 'نیشانەی بازرگانی PRO' },
  proMerchantBadge: { ar: 'شارة التاجر PRO', en: 'PRO merchant badge', ckb: 'نیشانەی بازرگانی PRO' },
  primeDeliveryEligible: { ar: 'توصيل PREMIUM المجاني', en: 'PREMIUM free delivery', ckb: 'گەیاندنی بێبەرامبەری PREMIUM' },
  premiumDelivery: { ar: 'توصيل PREMIUM المجاني', en: 'PREMIUM free delivery', ckb: 'گەیاندنی بێبەرامبەری PREMIUM' },
  bnpl: { ar: 'اشترِ الآن وادفع لاحقًا', en: 'Buy now, pay later', ckb: 'ئێستا بکڕە و دواتر بدە' },
  priorityDelivery12h: { ar: 'تجهيز وتوصيل خلال 12 ساعة', en: '12-hour preparation and delivery', ckb: 'خزمەتی ١٢ کاتژمێر' },
};

/**
 * What stands between a figure and its duration. A middle dot beside
 * Arabic-Indic digits reads as a zero — «PLUS · ١٢ شهرًا» looks like «١٢٠» —
 * so Arabic and Sorani take the Arabic comma, which no digit resembles.
 */
export function durationSep(lang: string): string {
  return lang === 'en' ? ' · ' : '، ';
}

/** Arabic counts its months: شهر واحد، شهران، 3–10 أشهر، 11+ شهرًا. */
export function durationLabel(months: number, lang: string): string {
  // The same digits the prices beside it use (`formatIqd` formats with the
  // device's locale), so «١٢ شهرًا» never sits next to «٢٩٬٠٠٠ د.ع» as «12».
  const n = months.toLocaleString();
  if (lang === 'en') return `${n} ${months === 1 ? 'month' : 'months'}`;
  if (lang === 'ckb') return `${n} مانگ`;
  if (months === 1) return 'شهر واحد';
  if (months === 2) return 'شهران';
  if (months >= 3 && months <= 10) return `${n} أشهر`;
  return `${n} شهرًا`;
}

/**
 * THE CARD THE PAGE OPENS ON — not always PRO.
 *
 * A member lands on the tier above theirs, because an upgrade is what this
 * page can still sell them; a guest or a free account on the lowest tier that
 * is actually on sale; a member of the top tier (or of a tier with nothing on
 * sale above it) on their own card. `tiers` is the catalogue's order.
 */
export function pickDefaultTier(tiers: PaidTier[], current: AnyTier, onSale: (tier: PaidTier) => boolean): PaidTier | null {
  if (tiers.length === 0) return null;
  const byRank = [...tiers].sort((a, b) => TIER_ORDER[a] - TIER_ORDER[b]);
  if (isPaidTier(current)) {
    return (
      byRank.find((x) => TIER_ORDER[x] > TIER_ORDER[current] && onSale(x)) ??
      (tiers.includes(current) ? current : byRank[byRank.length - 1])
    );
  }
  return byRank.find(onSale) ?? byRank[0];
}
