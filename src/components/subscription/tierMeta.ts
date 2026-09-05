/**
 * ONE table for how a membership tier is named and coloured.
 *
 * The card face, the ambient glow, the tier selector, every chip, the
 * confirmation window, the ledger, the Header pill and the Profile badge all
 * read this — so PRIME can never fall back to PLUS wording or PLUS colours
 * again (it used to be labelled "PLUS" in the toast, the ledger, the pending
 * banner and the profile, and drawn in the free grey on the card).
 *
 * Colours are the site's established palette: the LEVONIS green the Header
 * already uses for PLUS (#59A846 — the `olive` token itself is a very dark
 * surface colour and is invisible as text on black), the gold token for
 * PRIME, and the PRO red (#B03142 / #e06070).
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
    text: 'text-[#7FCB5A]',
    chip: 'bg-[#59A846]/15 text-[#7FCB5A] border-[#59A846]/40',
    indicator: 'bg-[#59A846]/20 border-[#59A846]/50',
    ring: 'border-[#59A846]/80',
    glow: 'bg-[#59A846]/10',
    cardFace: 'bg-gradient-to-br from-[#59A846]/25 via-black/85 to-black/95',
    dot: 'bg-[#59A846] text-[#59A846]',
    check: 'text-[#59A846]',
    heading: 'text-[#7FCB5A]',
    panelBorder: 'border-[#59A846]/20',
  },
  prime: {
    id: 'prime',
    label: 'PRIME',
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
    text: 'text-[#e06070]',
    chip: 'bg-[#B03142]/20 text-[#e06070] border-[#B03142]/40',
    indicator: 'bg-[#B03142]/25 border-[#B03142]/60',
    ring: 'border-[#B03142]/90',
    glow: 'bg-[#B03142]/15',
    cardFace: 'bg-gradient-to-br from-[#B03142]/40 via-black/85 to-black/95',
    dot: 'bg-[#B03142] text-[#B03142]',
    check: 'text-[#e06070]',
    heading: 'text-[#e06070]',
    panelBorder: 'border-[#B03142]/25',
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

/** PLUS / PRIME / PRO — never "PLUS" for a PRIME member. */
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
  prepaid_pending_launch: { ar: 'محجوزة حتى الإطلاق', en: 'Reserved until launch', ckb: 'پارێزراوە تا دەستپێک' },
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
