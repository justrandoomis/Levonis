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

// ---------------------------------------------------------------- Phase 5c
// THE STATUS STRIP of /requests/:id (src/pages/community/Request.tsx): the
// six stations a request passes, and where a state sits on them. A state
// that is not on the line (draft, cancelled, expired, disputed) answers -1
// and the page says it in a sentence instead.
export const REQUEST_STEPS = ['published', 'offers', 'chosen', 'in_progress', 'delivered', 'completed'] as const;
export type RequestStep = (typeof REQUEST_STEPS)[number];

export function requestStepIndex(state: string): number {
  switch (state) {
    case 'open':
    case 'receiving_offers':
      return 1;
    case 'offer_selected':
    case 'awarded':
      return 2;
    case 'in_progress':
      return 3;
    case 'delivered':
      return 4;
    case 'completed':
      return 5;
    default:
      return -1;
  }
}

/**
 * The state chip's tone (StatusChip: theme tokens, one word + one dot + one
 * flat tint) — on the request page and, since the clay sweep, on the board's
 * own chip too. REQUEST_STATE_TONE's legacy classes stay exported for the
 * every-state check in tests/communityP1.test.ts; no screen draws them now.
 */
export function requestStateTone(state: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (state) {
    case 'open':
    case 'receiving_offers':
      return 'success';
    case 'offer_selected':
    case 'awarded':
    case 'in_progress':
    case 'delivered':
      return 'info';
    case 'completed':
      return 'success';
    case 'disputed':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** The request takes offers (and comments): the board's own two states. */
export function requestTakesOffers(state: string): boolean {
  return state === 'open' || state === 'receiving_offers';
}

/** Where a request lives: its own route (src/pages/community/Request.tsx). */
export const requestPath = (id: string) => `/requests/${encodeURIComponent(id)}`;

/**
 * THE OLD ADDRESS, REDIRECTED (src/pages/Requests.tsx): `/requests?request=<id>&cost=1`
 * with `#discussion` becomes `/requests/<id>?cost=1#discussion` — the id is
 * the path; every other parameter and the hash ride along.
 */
export function requestRedirect(id: string, params: URLSearchParams, hash = ''): string {
  const rest = new URLSearchParams(params);
  rest.delete('request');
  const qs = rest.toString();
  return `${requestPath(id)}${qs ? `?${qs}` : ''}${hash && hash !== '#' ? hash : ''}`;
}

/**
 * THE REQUEST PAGE'S SECTIONS, in the owner's order (docs/COMMUNITY_ECOSYSTEM.md
 * §9.5 «Client») — the landmarks src/pages/community/Request.tsx draws as
 * `data-request-section`; `compare` is the offers' own table (OfferCompare).
 */
export const REQUEST_SECTIONS = [
  'header',
  'status',
  'files',
  'details',
  'discussion',
  'offers',
  'compare',
  'chat',
  'accepted',
  'timeline',
  'escrow',
  'delivery',
  'review',
] as const;

/** The newest moment of an order's timeline — what the page's «آخر تحديث» line says. */
export function latestEvent<E extends { at: string }>(t: { timeline: E[] } | null | undefined): E | null {
  if (!t?.timeline?.length) return null;
  return t.timeline.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a));
}
