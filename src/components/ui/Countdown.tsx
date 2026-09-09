import React, { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { daysLeftLabel } from '../orders/format';

/**
 * THE OFFER CLOCK (docs/BUNDLES_MYSTERY.md §13.2).
 *
 * Decoration only. The API still refuses an expired offer to the millisecond
 * and still locks one that has not opened — this never gates anything, it only
 * says how long is left.
 *
 * FOUR DECISIONS, EACH OF THEM A BUG IF IT GOES THE OTHER WAY.
 *
 * 1. ONE TICKER FOR A WHOLE GRID, never one `setInterval` per card. Twenty
 *    cards with their own timers is twenty wake-ups a second on a phone, and
 *    on mobile Safari that is a visible battery and scroll cost. A single
 *    module-level 1 Hz tick is published to every mounted clock, and it stops
 *    entirely when the last one unmounts.
 *
 * 2. AT ZERO IT ASKS THE SERVER, ONCE. Without that, an `upcoming` offer keeps
 *    showing its lock past its own start time and an ending one counts into
 *    negative numbers — the single most visible moment of a limited offer,
 *    spent showing something false. The anonymous listing is cached for 60 s
 *    (§14), so the state can legitimately be a minute stale at exactly that
 *    boundary, and this revalidate is what closes it. `onZero` fires once per
 *    target, never in a loop.
 *
 * 3. UNDER REDUCED MOTION THE DIGITS KEEP UPDATING. `prefers-reduced-motion`
 *    governs animation, not live data: freezing the clock would show those
 *    users a stale time presented as current. Only the transition is dropped,
 *    and `m.spring()` already collapses to a cross-fade on its own.
 *
 * 4. THE DIGITS ARE WRAPPED IN `<bdi dir="ltr">`. An `HH:MM:SS` string inside
 *    an Arabic or Sorani paragraph is bidi-reordered around its colons and
 *    comes out backwards; the codebase already puts `dir="ltr"` on every
 *    product name for the same reason.
 */

type Tick = (now: number) => void;

const subscribers = new Set<Tick>();
let timer: ReturnType<typeof setInterval> | null = null;

/** The shared 1 Hz heartbeat. Started by the first clock on the page, stopped
 *  by the last — no page without a countdown ever pays for one. */
function subscribe(fn: Tick): () => void {
  subscribers.add(fn);
  if (timer === null) {
    timer = setInterval(() => {
      const now = Date.now();
      for (const s of subscribers) s(now);
    }, 1000);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const STRINGS = {
  ar: { opens: 'يبدأ خلال', ends: 'ينتهي خلال', gone: '—' },
  en: { opens: 'Opens in', ends: 'Ends in', gone: '—' },
  ckb: { opens: 'دەست پێدەکات لە', ends: 'کۆتایی دێت لە', gone: '—' },
} as const;

/** Two digits, always — `9:5:3` reads as three separate numbers. */
const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

/**
 * The CLOCK ONLY — `HH:MM:SS`, latin digits, safe inside a `<bdi dir="ltr">`.
 *
 * The day part used to be glued on as `3d`, so an Arabic viewer read
 * «يبدأ خلال 3d 01:01:01» and a Sorani viewer «دەست پێدەکات لە 3d 01:01:01» —
 * a latin unit suffix inside a right-to-left sentence, with the only localised
 * day count living in the `sr-only` span, i.e. the one audience that got it was
 * a screen reader. `daysLeftLabel` renders the days beside this, in the
 * viewer's own language and with its own plural rules.
 */
export function remainingLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export default function Countdown({
  /** An ABSOLUTE server ISO timestamp. A duration computed in the browser
   *  would drift with the device clock and with the time the response spent in
   *  a cache; an instant does not. */
  target,
  kind,
  onZero,
  className = '',
}: {
  target: string | null | undefined;
  kind: 'opens' | 'ends';
  /** Fired ONCE when this target passes, so the page can revalidate. */
  onZero?: () => void;
  className?: string;
}) {
  const { lang } = useLanguage();
  const at = target ? Date.parse(target) : NaN;
  const [now, setNow] = useState(() => Date.now());
  const firedFor = useRef<number | null>(null);

  useEffect(() => subscribe(setNow), []);

  useEffect(() => {
    if (!Number.isFinite(at)) return;
    if (now < at) return;
    if (firedFor.current === at) return;
    firedFor.current = at;
    onZero?.();
  }, [now, at, onZero]);

  if (!Number.isFinite(at)) return null;
  const left = at - now;
  const s = STRINGS[lang];

  // Past zero: an em dash, never a negative clock. The revalidate above is
  // what replaces this with the server's new state.
  if (left <= 0) {
    return (
      <span className={`text-[11px] text-zinc-500 tabular-nums ${className}`}>
        {s[kind]} <bdi dir="ltr">{s.gone}</bdi>
      </span>
    );
  }

  const days = Math.floor(left / 86_400_000);
  return (
    <span className={`text-[11px] text-zinc-400 tabular-nums ${className}`}>
      {s[kind]}{' '}
      {/* The DAY count in the viewer's own language and plural form, beside the
          isolated latin clock — never `3d` glued to the front of it. */}
      {days > 0 && <span className="font-bold text-zinc-200">{daysLeftLabel(days, lang)} </span>}
      <bdi dir="ltr" className="font-bold text-zinc-200">
        {remainingLabel(left)}
      </bdi>
      {/* The coarse text needs no tick at all, and is what a screen reader
          hears instead of a number that changes every second. */}
      <span className="sr-only"> {daysLeftLabel(days, lang)}</span>
    </span>
  );
}
