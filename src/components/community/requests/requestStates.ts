/**
 * A PRINT REQUEST'S STATE, IN WORDS AND A TONE — one table for every screen
 * that shows one: the board's chip (src/pages/Requests.tsx) and the
 * customer's «طلباتي» (src/components/print/MyRequestsList.tsx). «طلباتي» had
 * a shorter table of its own and printed the raw machine word for the three it
 * lacked — `offer_selected`, `delivered`, `disputed` (review of Levo
 * Community, 2026-09-28).
 *
 * The Sorani is the hand-written one AdminMystery.tsx already carries.
 */
type Loc = (ar: string, en: string, ckb?: string) => string;

export const REQUEST_STATE_TONE: Record<string, string> = {
  draft: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/20',
  open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  receiving_offers: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  offer_selected: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  awarded: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  in_progress: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  delivered: 'bg-purple-500/10 text-purple-300 border-purple-500/20',
  completed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  disputed: 'bg-red-500/10 text-red-300 border-red-500/20',
  cancelled: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  expired: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
};

export function requestStateLabel(state: string, loc: Loc): string {
  switch (state) {
    case 'draft':
      return loc('مسودة', 'Draft', 'ڕەشنووس');
    case 'open':
      return loc('مفتوح', 'Open', 'کراوە');
    case 'receiving_offers':
      return loc('يستقبل عروضًا', 'Receiving offers', 'ئۆفەر وەردەگرێت');
    case 'offer_selected':
    case 'awarded':
      return loc('تم اختيار عرض', 'Offer selected', 'ئۆفەر هەڵبژێردرا');
    case 'in_progress':
      return loc('قيد التنفيذ', 'In progress', 'لە جێبەجێکردندا');
    case 'delivered':
      return loc('تم التسليم', 'Delivered', 'گەیشت');
    case 'completed':
      return loc('مكتمل', 'Completed', 'تەواو');
    case 'disputed':
      return loc('نزاع', 'Disputed', 'ناکۆکی');
    case 'cancelled':
      return loc('ملغي', 'Cancelled', 'هەڵوەشێنراوە');
    case 'expired':
      return loc('منتهٍ', 'Expired', 'بەسەرچوو');
    default:
      // A state added on the server later still reads as words, not a code.
      // OWNER: Sorani to be written by hand.
      return loc('قيد المتابعة', 'In progress');
  }
}
