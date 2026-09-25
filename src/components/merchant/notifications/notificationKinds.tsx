/**
 * What each merchant notification kind LOOKS like — an icon and a word — and
 * the coarse «منذ ٥ دقائق» time. Presentation only; the kinds, their copy and
 * their links are the server's (worker/lib/merchantNotify.ts).
 */
import {
  AlertTriangle, Banknote, Bell, CircleCheck, MessageCircle, PackageMinus, Printer, RefreshCw,
  ShieldAlert, ShoppingBag, Star, Store, Tag, Wallet, XCircle, type LucideIcon,
} from 'lucide-react';

export type Loc = (ar: string, en: string, ckb?: string) => string;

/**
 * The server isolates ids, codes and figures in Arabic copy with FSI…PDI
 * (worker/lib/merchantNotify.ts). Each isolated run is drawn as one
 * unbreakable LTR island, so «ORD-7F3A21» never wraps at its hyphen.
 */
export function IsolatedText({ text }: { text: string }) {
  const parts = text.split(/\u2068([^\u2069]*)\u2069/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <bdi key={i} dir="ltr" className="whitespace-nowrap">
            {part}
          </bdi>
        ) : (
          part
        )
      )}
    </>
  );
}

const ICONS: Record<string, LucideIcon> = {
  new_order: ShoppingBag,
  order_needs_action: AlertTriangle,
  new_message: MessageCircle,
  matching_request: Printer,
  print_request_match: Printer,
  offer_accepted: CircleCheck,
  offer_stale: RefreshCw,
  offer_rejected: XCircle,
  low_stock: PackageMinus,
  new_review: Star,
  dispute_opened: ShieldAlert,
  payout_available: Wallet,
  payout_paid: Banknote,
  coupon_ending: Tag,
  store_status_changed: Store,
};

/** The kind is an open set, so this always answers. */
export function kindIcon(kind: string): LucideIcon {
  return ICONS[kind] ?? Bell;
}

/** Kinds that ask the merchant to act, drawn in the warning tone. */
export const ATTENTION_KINDS = new Set(['order_needs_action', 'dispute_opened', 'store_status_changed', 'low_stock']);

function arCount(n: number, one: string, two: string, few: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  const digits = n.toLocaleString('ar');
  return n <= 10 ? `${digits} ${few}` : `${digits} ${one}`;
}

/** «منذ ٥ دقائق» / «5m ago» — coarse on purpose. */
export function relTime(iso: string, loc: Loc, now = Date.now()): string {
  const min = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min) || min < 1) return loc('الآن', 'now', 'ئێستا');
  if (min < 60) return loc(`منذ ${arCount(min, 'دقيقة', 'دقيقتين', 'دقائق')}`, `${min}m ago`);
  const h = Math.floor(min / 60);
  if (h < 24) return loc(`منذ ${arCount(h, 'ساعة', 'ساعتين', 'ساعات')}`, `${h}h ago`);
  const d = Math.floor(h / 24);
  if (d < 30) return loc(`منذ ${arCount(d, 'يوم', 'يومين', 'أيام')}`, `${d}d ago`);
  const mo = Math.floor(d / 30);
  return loc(`منذ ${arCount(mo, 'شهر', 'شهرين', 'أشهر')}`, `${mo}mo ago`);
  // OWNER: Sorani to be written by hand (the relative times fall back to Arabic).
}

/** Today / yesterday / earlier, in the viewer's own calendar. */
export function dayBucket(iso: string, now = new Date()): 'today' | 'yesterday' | 'earlier' {
  const d = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= start) return 'today';
  if (d.getTime() >= start - 86_400_000) return 'yesterday';
  return 'earlier';
}
