/**
 * «شاهد إعلانًا» — WHAT THE MISSION CARD SAYS (owner, 2026-11-05: «2 times he can
 * see. one per day»; migration 0227; DECISIONS row 300). Pure, and it decides
 * nothing: every figure here is one GET /api/rewards answered.
 */

export interface AdView {
  id: string;
  title: { ar: string; en: string; ckb: string };
  poster_url: string | null;
  width: number;
  height: number;
  views_used: number;
  views_max: number;
  ends_at: string;
}

export interface VideoMissionFacts {
  claimed: boolean;
  available: boolean;
  videoUrl: string | null;
  /** Absent on a server older than 0227's code; null when no ad is on the card. */
  ad?: AdView | null;
  next_at?: string | null;
  done?: boolean;
}

export type AdCard =
  /** The old setting runs the mission (or an older server): the card as it always was. */
  | { kind: 'plain' }
  /** A view can be watched now. */
  | { kind: 'ready'; left: number; until: string }
  /** Today's view is paid; `again` when another remains and the ad still runs tomorrow. */
  | { kind: 'watched'; again: boolean }
  /** Every view this ad gives this customer has been paid. */
  | { kind: 'used_up'; views: number };

export function adCard(video: VideoMissionFacts): AdCard {
  if (!video.ad) return { kind: 'plain' };
  if (video.done) return { kind: 'used_up', views: video.ad.views_max };
  if (video.claimed) return { kind: 'watched', again: !!video.next_at };
  // The owner switched the whole mission off: the disabled card promises no views it will not give.
  if (!video.available) return { kind: 'plain' };
  return { kind: 'ready', left: Math.max(0, video.ad.views_max - video.ad.views_used), until: video.ad.ends_at };
}

/**
 * «أنهيت كل مهام اليوم» IS A CLAIM, AND IT MUST BE TRUE. The ad's card now stays
 * on screen after today's view, so the sentence can no longer be read off «no
 * card left». A view left for tomorrow does not stop today being finished; a
 * used-up ad has nothing more to give, today or tomorrow, so it counts as done
 * although nothing was claimed today. An ad that simply is not running does not
 * count as done: nobody has finished what they were never offered.
 */
export function missionsAllDone(m: { push: { claimed: boolean }; browse: { claimed: boolean }; video: Pick<VideoMissionFacts, 'claimed' | 'done'> }): boolean {
  return m.push.claimed && m.browse.claimed && (m.video.claimed || m.video.done === true);
}

type Loc = (ar: string, en: string, ckb: string) => string;

/** «مشاهدة واحدة», «مشاهدتان», «3 مشاهدات», «11 مشاهدة»: Arabic counts its noun. */
function viewsLeftArabic(n: number): string {
  if (n === 1) return 'مشاهدة واحدة';
  if (n === 2) return 'مشاهدتان';
  const tail = n % 100;
  return tail >= 3 && tail <= 10 ? `${n} مشاهدات` : `${n} مشاهدة`;
}

/** «مرتين», «3 مرات», «11 مرة». */
function timesArabic(n: number): string {
  if (n === 2) return 'مرتين';
  const tail = n % 100;
  return tail >= 3 && tail <= 10 ? `${n} مرات` : `${n} مرة`;
}

/**
 * The card's line. `date` is the reader's own day and month of `until`, written
 * by the shop's date helper, so a Baghdad reader sees the last day the ad runs.
 */
export function adCardLine(card: AdCard, loc: Loc, date: (iso: string) => string): string {
  switch (card.kind) {
    case 'ready': {
      const until = date(card.until);
      return loc(
        `مرة واحدة في اليوم · تبقّت لك ${viewsLeftArabic(card.left)} حتى ${until}`,
        `Once a day · ${card.left} ${card.left === 1 ? 'view' : 'views'} left until ${until}`,
        `ڕۆژانە یەک جار · ${card.left} بینینت ماوە تا ${until}`
      );
    }
    case 'watched':
      return card.again
        ? loc('غدًا تستطيع مشاهدته مرة أخرى', 'You can watch it again tomorrow', 'سبەی دەتوانیت دووبارە بیبینیت')
        : loc('شاهدته اليوم', 'Watched today', 'ئەمڕۆ بینیت');
    case 'used_up':
      if (card.views === 1) return loc('شاهدت هذا الإعلان', "You've watched this ad", 'ئەم ڕیکلامەت بینی');
      if (card.views === 2) return loc('شاهدت هذا الإعلان مرتين', "You've watched this ad twice", 'ئەم ڕیکلامەت دوو جار بینی');
      return loc(`شاهدت هذا الإعلان ${timesArabic(card.views)}`, `You've watched this ad ${card.views} times`, `ئەم ڕیکلامەت ${card.views} جار بینی`);
    case 'plain':
      return '';
  }
}

// ------------------------------------------------------------ the film's place

/**
 * WHERE THE FILM OF TODAY'S TICKET WAS LEFT. Without this, a claim lost on mobile
 * data, or a customer who left at the claim, watched the whole film again: 47
 * seconds and its data, though the server's ticket had long been ripe.
 *
 * It is kept against the TICKET, the instant `/video/start` answers: the same on
 * every press of one day, new on the next. So a new day's ticket forgets it and is
 * watched again. It only decides what the window offers: the claim's answer is the
 * server's, from its own `started_at`, whatever this says.
 */
export interface FilmNote {
  url: string;
  ticket: string;
  at: number;
  ended: boolean;
}

/** What the note says of this film under this ticket: nothing, if it was another's. */
export function recallFilm(note: FilmNote | null, url: string, ticket: string | null): { at: number; ended: boolean } {
  return note && ticket !== null && note.url === url && note.ticket === ticket ? { at: note.at, ended: note.ended } : { at: 0, ended: false };
}

/**
 * The film is at `time`. Time 0 changes nothing: reloading the element fires this
 * at 0 before it has been sought back, and that restarted a retried film from 0:00.
 */
export function filmAt(note: FilmNote | null, url: string, ticket: string | null, time: number): FilmNote | null {
  if (ticket === null || !(time > 0)) return note;
  return { url, ticket, at: time, ended: recallFilm(note, url, ticket).ended };
}

/** The film reached its end under this ticket. */
export function filmEnded(note: FilmNote | null, url: string, ticket: string | null): FilmNote | null {
  return ticket === null ? note : { url, ticket, at: recallFilm(note, url, ticket).at, ended: true };
}

/** A note read back from the tab's storage, which anything may have written to. */
export function parseFilmNote(raw: string | null): FilmNote | null {
  if (!raw) return null;
  try {
    const n = JSON.parse(raw) as Partial<FilmNote> | null;
    return n && typeof n.url === 'string' && typeof n.ticket === 'string' && typeof n.at === 'number' && typeof n.ended === 'boolean'
      ? { url: n.url, ticket: n.ticket, at: n.at, ended: n.ended }
      : null;
  } catch {
    return null;
  }
}

/** What the window is showing over the film. */
export type FilmStage = 'loading' | 'playing' | 'blocked' | 'failed';

/**
 * The film paused. Something outside stopped it (a call, headphones, the lock
 * screen), so the play button is the way on, not a countdown over a frozen frame.
 * A film at its end fires this too, and is simply finished; a failure stays one.
 */
export function stageAfterPause(stage: FilmStage, atEnd: boolean): FilmStage {
  return atEnd || stage === 'failed' ? stage : 'blocked';
}

// ------------------------------------------------------------ a claim that failed

/**
 * WHAT A FAILED CLAIM LEAVES ON THE SCREEN.
 *
 *   keep     the film and the claim stay. The server said its time is not over, or
 *            gave no answer at all (no connection, its own trouble, too many
 *            requests): nothing is lost, so the customer presses again.
 *   new_day  the ticket was yesterday's: the film crossed midnight.
 *   close    the server answered and there is nothing more to wait for, including
 *            the two 503s that are answers: the mission or the ad has gone.
 */
export type ClaimFailure = 'keep' | 'new_day' | 'close';

export function adClaimFailure(error: unknown): ClaimFailure {
  const e = (error ?? {}) as { status?: unknown; code?: unknown };
  if (e.code === 'TOO_SOON') return 'keep';
  if (e.code === 'NO_TICKET') return 'new_day';
  if (e.code === 'TASK_DISABLED' || e.code === 'NO_VIDEO') return 'close';
  const status = typeof e.status === 'number' ? e.status : 0;
  return status === 0 || status === 429 || status >= 500 ? 'keep' : 'close';
}

/**
 * «شغّل الإعلان أولًا» is the wrong thing to tell someone who just watched it. The
 * window can only be open on a ticket the server issued, so NO_TICKET here means
 * that ticket's day has ended.
 */
export function adNewDayText(loc: Loc): string {
  return loc(
    'بدأ يوم جديد قبل أن تطلب نقاطك، فلم يُحتسب شيء. يمكنك مشاهدة الإعلان من جديد.',
    'A new day started before you claimed, so nothing was counted. You can watch the ad again.',
    'ڕۆژێکی نوێ دەستی پێکرد پێش ئەوەی خاڵەکانت داوا بکەیت، بۆیە هیچ نەژمێردرا. دەتوانیت دووبارە ڕیکلامەکە ببینیت.'
  );
}
