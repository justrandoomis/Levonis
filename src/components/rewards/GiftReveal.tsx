/**
 * THE ANALYSIS — the full-screen sheet a gift code opens (owner, 2026-11-05;
 * docs/DECISIONS.md row 301): «after he write the code animation appear that show
 * his review like analysis his review for text images video review on story on
 * insta like downloading and analysis animation and then appear how much system
 * give like 5 or 26 so every 20 score the level appear and he can see the gift of
 * level and select then confirm then add to cart as free gift».
 *
 * A LAZY CHUNK of its own (RateScreen's `prefetchable`), with no stylesheet: its
 * layout is the shop's utilities and clay tokens, its motion is data.
 *
 * THE MOTION (./revealScript.ts holds every frame and the clock). No animation
 * library: Web Animations on `transform` and `opacity` only, so the compositor runs
 * them; the one thing written per frame is the big figure's text, from a table made
 * once. Calm clay, no neon, no confetti. About 7 to 9 seconds, skippable with «تخطَّ»
 * at any moment. `prefers-reduced-motion` opens straight on the result, with nothing
 * moving; «شاهد التحليل» then unfolds the same figures still.
 *
 * EVERY FIGURE IS THE SERVER'S (`GiftReveal`). A part is drawn at its real score,
 * a missing video at its real 0. Closed levels' gifts are not on the page because
 * the server never sent them, and the track says at what score each one opens.
 *
 * THE ROAD ON. One gift across the opened levels (`lv-choice`), «تأكيد», the
 * dialog «هديتك النهائية؟», then POST choose, POST redeem and POST
 * /api/cart/gift-items, each one replay-safe on the server, so a failure in the
 * middle is resumed by pressing again. A cart conflict is asked in the words
 * «هداياي» uses. Leaving at any point loses nothing: the gift waits in /gifts and
 * on /rewards/rate at the right step (`stageOf`).
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, FileText, Gift, Images, Instagram, SlidersHorizontal, Star, Video, X, type LucideIcon } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMoney } from '../../CurrencyContext';
import { formatFigure } from '../../lib/localeNumber';
import { usePrefersReducedMotion } from '../../lib/motion';
import { Button, IconButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Overlay } from '../ui/Overlay';
import SafeImage from '../ui/SafeImage';
import { GiftItemSummary, groupByLevel, type GiftView } from '../reviews/gifts/GiftCard';
import { giftLang, giftText, type GiftStringKey } from '../reviews/gifts/giftStrings';
import { SCORE_SCALE } from './copy';
import { SEP } from './model';
import {
  MOTION,
  PART_FILL,
  REVEAL_MS,
  countAt,
  fillMotion,
  fillOf,
  fillTransform,
  initialPick,
  itemOfChoice,
  opensOnAnalysis,
  railFill,
  revealScript,
  sheenMotion,
  signOf,
  stageOf,
  trackCaption,
  type RevealMotion,
  type RevealSign,
  type RevealStep,
  type RevealStepKey,
} from './revealScript';
import type { GiftReveal as RevealData } from './types';
import { useRewardsT } from './useT';

export interface GiftRevealProps {
  data: RevealData;
  /** Play the analysis: a code just written. A returning customer opens on the result. */
  play: boolean;
  onClose: () => void;
  /** The gift moved: the page behind reads the hub again. */
  onChanged: () => void;
}

/** A refusal that means what is on screen is out of date: the next read shows the truth. */
const STALE_CODES: ReadonlySet<string> = new Set(['GIFT_NOT_FOUND', 'GIFT_STATE', 'GIFT_ITEM_UNAVAILABLE', 'GIFT_NOT_AVAILABLE', 'GIFT_NOT_ORDERABLE', 'GIFT_NOT_REDEEMED']);

// ------------------------------------------------------------ the material

/** The sheet's own geometry and clay, all of it tokens of the theme. Inline, because the shop's CSS gate has no room for a sheet nobody else uses. */
const LOOK = {
  head: { minHeight: 56, paddingTop: 'max(0.25rem, env(safe-area-inset-top))', paddingBottom: '0.25rem' },
  foot: { paddingTop: '0.75rem', paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' },
  fill: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: 'var(--color-accent)',
    boxShadow: 'inset 0 1px 0 var(--clay-rim), inset 0 -1px 0 var(--clay-base)',
    willChange: 'transform',
  },
  sheen: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineStart: 0,
    width: '40%',
    background: 'linear-gradient(to right, transparent, color-mix(in oklab, var(--color-accent) 55%, white), transparent)',
  },
  scan: {
    position: 'absolute',
    insetInline: 0,
    top: 0,
    height: '70%',
    pointerEvents: 'none',
    willChange: 'transform',
    background:
      'linear-gradient(to bottom, transparent, color-mix(in oklab, var(--color-accent) 16%, transparent) 62%, color-mix(in oklab, var(--color-accent) 30%, transparent) 64%, transparent 66%)',
  },
  dot: { display: 'inline-block', width: 6, height: 6, borderRadius: 999, backgroundColor: 'var(--color-accent)' },
  score: { display: 'inline-block', fontSize: 'clamp(64px, 19vw, 84px)', fontWeight: 900, lineHeight: 1, letterSpacing: '-0.02em', willChange: 'transform' },
  scoreSmall: { fontSize: 52, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.02em' },
  rail: { position: 'absolute', top: 15, insetInline: '10%', height: 6, borderRadius: 999, overflow: 'hidden' },
  disc: {
    display: 'grid',
    placeItems: 'center',
    width: 36,
    height: 36,
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
  },
  discClosed: { color: 'var(--color-text-muted)', backgroundColor: 'var(--clay-well-bg)', boxShadow: 'var(--clay-well)' },
  discLit: { color: 'var(--color-accent-contrast)', backgroundColor: 'var(--color-accent)', boxShadow: 'var(--clay-1)' },
  caption: { fontSize: 11, lineHeight: '14px', textWrap: 'balance' },
  /** While the levels light: room for two lines, so a caption going from two lines to one never moves the track. */
  captionHeld: { fontSize: 11, lineHeight: '14px', textWrap: 'balance', minHeight: 28 },
  panel: { borderRadius: 0 },
} as const satisfies Record<string, React.CSSProperties>;

/** The panel's corners: a full-screen sheet has none. */
const PANEL_MOTION = { style: LOOK.panel };

/** Plays one move on an element when `run` turns true, and takes it back when the element goes. */
function useMove<T extends Element>(run: boolean, motion: RevealMotion) {
  const ref = useRef<T | null>(null);
  const spec = JSON.stringify(motion);
  useEffect(() => {
    const el = ref.current;
    if (!run || !el || typeof el.animate !== 'function') return;
    const m = JSON.parse(spec) as RevealMotion;
    const move = el.animate(m.frames, { ...m.options, iterations: m.loop ? Infinity : 1 });
    return () => move.cancel();
  }, [run, spec]);
  return ref;
}

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={`w-3.5 h-3.5 ${n <= value ? 'text-accent fill-current' : 'text-text-muted'}`} />
      ))}
    </span>
  );
}

/** A sunk bar and the block that slides in to fill it. `still`: at rest, with no move. */
function Bar({ fill, run, still, sign, duration, delay, sheen }: { fill: number; run: boolean; still?: boolean; sign: RevealSign; duration: number; delay: number; sheen?: boolean }) {
  const ref = useMove<HTMLSpanElement>(run && !still, fillMotion(0, fill, sign, duration, delay));
  const band = useMove<HTMLSpanElement>(!!sheen && !still, sheenMotion(sign));
  return (
    <span className="lv-well relative block h-2 overflow-hidden rounded-full">
      <span ref={ref} style={{ ...LOOK.fill, transform: fillTransform(run ? fill : 0, sign) }}>
        {sheen && <span ref={band} style={{ ...LOOK.sheen, transform: `translateX(${-100 * sign}%)` }} />}
      </span>
    </span>
  );
}

// ------------------------------------------------------------ one part's line

interface PartLine {
  key: RevealStepKey;
  Icon: LucideIcon;
  text: string;
  score: number;
  max: number;
}

/** The rows of the analysis, from the server's figures. */
function usePartLines(data: RevealData): PartLine[] {
  const { t, count, lang } = useRewardsT();
  const b = data.breakdown;
  return useMemo(() => {
    const figure = (n: number) => formatFigure(n, lang);
    const lines: PartLine[] = [
      {
        key: 'text',
        Icon: FileText,
        text: t('reveal.text', { chars: count('chars', b.text.chars), words: count('words', b.text.words) }),
        score: b.text.score,
        max: b.text.max,
      },
      { key: 'images', Icon: Images, text: t('reveal.images', { images: count('images', b.images.count) }), score: b.images.score, max: b.images.max },
      { key: 'video', Icon: Video, text: t(b.video.present ? 'reveal.video.yes' : 'reveal.video.no'), score: b.video.score, max: b.video.max },
      { key: 'story', Icon: Instagram, text: t(b.story.present ? 'reveal.story.yes' : 'reveal.story.no'), score: b.story.score, max: b.story.max },
      { key: 'stars', Icon: Star, text: t('reveal.stars', { stars: figure(b.stars.stars) }), score: b.stars.score, max: b.stars.max },
    ];
    return lines;
  }, [b, t, count, lang]);
}

const PART_ICON = 'size-8 shrink-0 rounded-full lv-well grid place-items-center text-text-secondary';
const PART_LINE = 'min-w-0 min-h-5 text-[13px] font-semibold leading-5 text-text-primary';
const PART_FIGURE = 'shrink-0 text-[12.5px] font-bold tabular-nums text-text-secondary';

/**
 * One part: its line, its real figure, and a bar that fills to it. Until its step it
 * waits dimly, its line unwritten and its bar empty, so the page never jumps and the
 * customer sees what is about to be read. `still`: the same figures with no move.
 */
function PartRow({ line, shown, active, still }: { line: PartLine; shown: boolean; active?: boolean; still?: boolean }) {
  const { lang, dir } = useRewardsT();
  const row = useMove<HTMLLIElement>(shown && !still, MOTION.rise);
  const figure = useMove<HTMLElement>(shown && !still, MOTION.fade);
  return (
    <li ref={row} className="flex min-h-11 items-center gap-2.5" style={{ opacity: shown ? 1 : 0.32 }} data-shown={shown || undefined} data-part={line.key}>
      <span className={PART_ICON} aria-hidden="true">
        <line.Icon className="w-4 h-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className={PART_LINE}>{shown ? line.text : ''}</span>
          <bdi ref={figure} dir="ltr" className={PART_FIGURE}>
            {shown ? `${formatFigure(line.score, lang)}/${formatFigure(line.max, lang)}` : ''}
          </bdi>
        </div>
        <div className="mt-1">
          <Bar fill={fillOf(line.score, line.max)} run={shown} still={still} sign={signOf(dir)} duration={PART_FILL.duration} delay={PART_FILL.delay} sheen={active} />
        </div>
      </div>
    </li>
  );
}

/** The gap between the parts and the final score, on a line of its own. Never spread over the parts. */
function AdjustRow({ value, shown, still }: { value: number; shown: boolean; still?: boolean }) {
  const { t, lang } = useRewardsT();
  const row = useMove<HTMLLIElement>(shown && !still, MOTION.rise);
  return (
    <li ref={row} className="flex min-h-11 items-center gap-2.5" style={{ opacity: shown ? 1 : 0 }} data-shown={shown || undefined} data-part="adjust">
      <span className={PART_ICON} aria-hidden="true">
        <SlidersHorizontal className="w-4 h-4" />
      </span>
      <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
        <span className={PART_LINE}>{t('reveal.adjust')}</span>
        <bdi dir="ltr" className={PART_FIGURE}>
          {formatFigure(value, lang, 0, true)}
        </bdi>
      </div>
    </li>
  );
}

// ------------------------------------------------------------ the big figure

/**
 * Counts to the real score. The figures are made once and only the text node
 * changes on each frame, on a layer of its own (`LOOK.score`), so nothing else on
 * the page lays out or paints again.
 */
function CountUp({ to, run, durationMs }: { to: number; run: boolean; durationMs: number }) {
  const { lang } = useRewardsT();
  const ref = useRef<HTMLSpanElement | null>(null);
  const figures = useMemo(() => Array.from({ length: to + 1 }, (_, i) => formatFigure(i, lang)), [to, lang]);
  useEffect(() => {
    if (!run) return;
    let frame = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const n = countAt(to, now - started, durationMs);
      if (ref.current) ref.current.textContent = figures[n] ?? String(n);
      if (n < to) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run, to, durationMs, figures]);
  return (
    <span ref={ref} className="tabular-nums text-text-primary" style={LOOK.score} aria-hidden="true">
      {figures[0]}
    </span>
  );
}

// ---------------------------------------------------------------- the track

/** One of the five steps: raised clay in the accent once it is on, sunk with its threshold while it is closed. */
function TrackStep({ step, on, settled }: { step: RevealData['track'][number]; on: boolean; settled?: boolean }) {
  const { t, lang } = useRewardsT();
  const disc = useMove<HTMLSpanElement>(on && !settled, MOTION.settle);
  const caption = trackCaption(step, on);
  return (
    <li className="relative flex min-w-0 flex-col items-center gap-1.5 text-center" data-lit={on || undefined} data-level={step.level}>
      <span ref={disc} style={{ ...LOOK.disc, ...(on ? LOOK.discLit : LOOK.discClosed) }} aria-hidden="true">
        {formatFigure(step.level, lang)}
      </span>
      <span className={on ? 'font-semibold text-text-secondary' : 'text-text-muted'} style={settled ? LOOK.caption : LOOK.captionHeld}>
        {t(caption.key, { n: formatFigure(caption.n, lang) })}
      </span>
    </li>
  );
}

/**
 * Five steps on a rail. `lit` counts how many have come on so far; the rail's fill
 * moves on to each as it lights. `settled`: already there, with no move.
 */
function LevelTrack({ data, lit, settled }: { data: RevealData; lit: number; settled?: boolean }) {
  const { dir } = useRewardsT();
  const sign = signOf(dir);
  const fill = railFill(lit);
  const ref = useRef<HTMLSpanElement | null>(null);
  const was = useRef(fill);
  useEffect(() => {
    const el = ref.current;
    const from = was.current;
    was.current = fill;
    if (settled || from === fill || !el || typeof el.animate !== 'function') return;
    const m = fillMotion(from, fill, sign, 260);
    el.animate(m.frames, m.options);
  }, [fill, settled, sign]);
  return (
    <ol className="relative m-0 grid grid-cols-5 gap-1 p-0 list-none" data-reveal-track>
      <li className="lv-well" style={LOOK.rail} aria-hidden="true">
        <span ref={ref} style={{ ...LOOK.fill, transform: fillTransform(fill, sign) }} />
      </li>
      {data.track.map((step, i) => (
        <TrackStep key={step.level} step={step} on={step.opened && i < lit} settled={settled} />
      ))}
    </ol>
  );
}

// ------------------------------------------------------------ the analysis

function Analysis({ data, script, onDone, onSkip }: { data: RevealData; script: readonly RevealStep[]; onDone: () => void; onSkip: () => void }) {
  const { t, tri, dir, lang } = useRewardsT();
  const parts = usePartLines(data);
  const [step, setStep] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);

  // One timer at a time, so a skip or a close leaves nothing running.
  useEffect(() => {
    if (step >= script.length) {
      onDone();
      return;
    }
    const id = setTimeout(() => setStep((s) => s + 1), script[step].ms);
    return () => clearTimeout(id);
  }, [step, script, onDone]);

  const indexOf = useCallback((key: RevealStepKey) => script.findIndex((s) => s.key === key), [script]);
  const reached = (key: RevealStepKey) => step >= indexOf(key) && indexOf(key) >= 0;
  const lit = script.slice(0, step + 1).filter((s) => s.key === 'level').length;
  const atTotal = reached('total');
  const reading = !atTotal;

  // A small phone: the total sits below the fold until now.
  useEffect(() => {
    const el = scroller.current;
    if (atTotal && el) el.scrollTo({ top: el.scrollHeight });
  }, [atTotal]);

  const scan = useMove<HTMLSpanElement>(reading, MOTION.scan);
  const dot = useMove<HTMLSpanElement>(reading, MOTION.breathe);
  const total = useMove<HTMLDivElement>(atTotal, MOTION.rise);

  const name = tri(data.review.name);
  const status = t(step === 0 ? 'reveal.download' : atTotal ? 'reveal.total' : 'reveal.analysing');
  const current = script[step]?.key;
  return (
    <div className="flex h-full min-h-0 flex-col" data-reveal-view="analysis" data-reveal-step={current ?? 'end'}>
      <header className="mx-auto flex w-full max-w-lg shrink-0 items-center gap-3 px-4" style={LOOK.head}>
        <h2 className="min-w-0 flex-1 text-[15px] font-bold leading-6 text-text-primary">{t('reveal.title')}</h2>
        <button type="button" onClick={onSkip} className="lv-button lv-button-ghost lv-button-sm" data-reveal-skip>
          {t('reveal.skip')}
        </button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col gap-4 px-4 pb-6">
          <section className="lv-surface relative overflow-hidden p-3" aria-label={name}>
            {reading && <span ref={scan} style={LOOK.scan} aria-hidden="true" />}
            <div className="flex items-center gap-3">
              {/* `reveal="none"`: the photo's blur-in animates `filter`, and this sheet moves nothing but transform and opacity. */}
              <SafeImage src={data.review.image || null} alt="" aspect="square" sizes="64px" reveal="none" className="size-16 shrink-0 rounded-lg" bgClassName="bg-surface-raised" />
              <div className="min-w-0 flex-1 space-y-1">
                <p dir="auto" className="line-clamp-2 text-[14px] font-bold leading-5 text-text-primary">
                  {name}
                </p>
                <Stars value={data.review.stars} />
              </div>
            </div>
            <p className="mt-3 flex items-center gap-2 text-[12px] font-semibold text-text-secondary" aria-hidden="true">
              <span ref={dot} style={LOOK.dot} />
              {status}
            </p>
            <div className="mt-1.5">
              <Bar fill={1} run sign={signOf(dir)} duration={REVEAL_MS.download} delay={0} />
            </div>
          </section>

          <ul className="space-y-2.5" aria-hidden="true">
            {parts.map((line) => (
              <PartRow key={line.key} line={line} shown={reached(line.key)} active={current === line.key} />
            ))}
            {data.breakdown.adjustment !== 0 && <AdjustRow value={data.breakdown.adjustment} shown={reached('adjust')} />}
          </ul>

          <div ref={total} className="mt-auto py-1 text-center" style={{ opacity: atTotal ? 1 : 0 }} data-shown={atTotal || undefined} aria-hidden="true">
            <p className="text-[12px] font-semibold text-text-secondary">{t('reveal.total')}</p>
            <div className="flex items-baseline justify-center gap-2">
              <CountUp to={data.score} run={atTotal} durationMs={REVEAL_MS.total - 150} />
              <span className="text-[13px] font-semibold text-text-muted">{t('reveal.of100', { max: formatFigure(SCORE_SCALE.to, lang) })}</span>
            </div>
            <div className="mt-3">
              <LevelTrack data={data} lit={lit} />
            </div>
          </div>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {current && current !== 'level' && current !== 'settle' ? (parts.find((p) => p.key === current)?.text ?? status) : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- the result

/** «فتحت المستويات 1، 2» from the server's list, in the reader's digits and joiner. */
function useOpenedLine(levels: readonly number[]): string {
  const { t, lang } = useRewardsT();
  const list = levels.map((n) => formatFigure(n, lang)).join(SEP[lang]);
  return t(levels.length === 1 ? 'reveal.opened.one' : 'reveal.opened.many', { list });
}

/** One gift of an opened level, as a radio. */
function ChoiceRow({ item, picked, onPick, disabled }: { item: NonNullable<GiftView['choices']>[number]; picked: boolean; onPick: () => void; disabled: boolean }) {
  const { lang } = useRewardsT();
  const { money } = useMoney();
  const id = item.item_id ?? item.product_id;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={picked}
      disabled={disabled}
      onClick={onPick}
      data-reveal-choice={id}
      className="lv-choice w-full p-3 text-start [touch-action:manipulation]"
    >
      <GiftItemSummary
        lang={giftLang(lang)}
        item={item}
        money={money}
        size="sm"
        trailing={
          <span className="lv-choice-mark mt-0.5" aria-hidden="true">
            <Check className="w-3.5 h-3.5" strokeWidth={3} />
          </span>
        }
      />
    </button>
  );
}

function Result({
  data,
  gift,
  onGift,
  onWatch,
  watching,
  onClose,
  headingRef,
  picked,
  setPicked,
}: {
  data: RevealData;
  gift: GiftView;
  onGift: (gift: GiftView) => void;
  onWatch: () => void;
  /** Reduced motion: the analysis unfolded, still. */
  watching: boolean;
  onClose: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  /** The pick outlives a replay of the analysis. */
  picked: string;
  setPicked: React.Dispatch<React.SetStateAction<string>>;
}) {
  const { t, tri, lang } = useRewardsT();
  const reduced = usePrefersReducedMotion();
  const root = useMove<HTMLDivElement>(!reduced, MOTION.rise);
  const { money } = useMoney();
  const gl = giftLang(lang);
  const parts = usePartLines(data);
  const opened = useOpenedLine(data.levels);
  const stage = stageOf(gift);
  const groupId = useId();
  const choices = useMemo(() => gift.choices ?? [], [gift.choices]);
  const groups = useMemo(() => groupByLevel(choices), [choices]);
  // A pick the offer no longer holds is no pick: nothing is selected, and the confirm stays shut until they choose again.
  const pickedItem = picked ? itemOfChoice(gift, picked) : null;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<'shipping' | 'seller' | null>(null);

  /** The level by the owner's name for it, with its number when that name does not already say «المستوى». */
  const levelName = (n: number | null) => {
    const step = data.track.find((s) => s.level === n);
    const plain = t('rate.level', { n: formatFigure(n ?? 0, lang) });
    const name = tri(step?.name);
    if (!name || name === plain) return plain;
    return name.startsWith(plain.split(' ')[0]) ? name : `${plain} · ${name}`;
  };

  /** A refusal in the customer's words: network and rate first, then the code's own sentence. */
  const sentence = async (err: unknown): Promise<string> => {
    if (err instanceof ApiError && err.status === 0) return giftText(gl, 'networkError');
    if (err instanceof ApiError && err.status === 429) return giftText(gl, 'tooManyTries');
    try {
      const table = await import('../../lib/refusalStrings');
      return table.apiRefusal(err, gl, t('reveal.err.generic')) || t('reveal.err.generic');
    } catch {
      return t('reveal.err.generic');
    }
  };

  /** Read the gift again after a refusal that says the screen is behind: a sold-out choice leaves the list. */
  const refresh = async (err: unknown) => {
    if (!(err instanceof ApiError) || !STALE_CODES.has(err.code ?? '')) return;
    try {
      const fresh = await api.get<RevealData>(`/api/rewards/program/gift-reveal/${encodeURIComponent(gift.id)}`);
      onGift(fresh.gift);
      setPicked((id) => ((fresh.gift.choices ?? []).some((c) => (c.item_id ?? c.product_id) === id) ? id : ''));
    } catch {
      /* the refusal already said what happened; the list stays as it was */
    }
  };

  /** The answer of each door is the gift as it now stands. The cart's answer is the cart, so the badge moves by itself. */
  const addToCart = async (current: GiftView, replaceCart = false) => {
    try {
      await api.post('/api/cart/gift-items', replaceCart ? { giftId: current.id, replaceCart: true } : { giftId: current.id });
      setConflict(null);
      onGift({ ...current, status: 'ADDED_TO_ORDER' });
    } catch (err) {
      const code = err instanceof ApiError ? err.code ?? '' : '';
      if (!replaceCart && code === 'CART_SHIPPING_CONFLICT') {
        onGift(current);
        setConflict('shipping');
        return;
      }
      if (!replaceCart && code === 'CART_SELLER_CONFLICT') {
        onGift(current);
        setConflict('seller');
        return;
      }
      setConflict(null);
      onGift(current);
      setError(await sentence(err));
      await refresh(err);
    }
  };

  /** «تأكيد الهدية»: choose, redeem, cart. Every door is replay-safe, so pressing again resumes where it stopped. */
  const confirmGift = async () => {
    if (busy || !pickedItem) return;
    setBusy(true);
    setError('');
    try {
      const chosen = await api.post<{ gift: GiftView }>(`/api/gifts/${encodeURIComponent(gift.id)}/choose`, { itemId: picked });
      onGift(chosen.gift);
      const redeemed = await api.post<{ gift: GiftView }>(`/api/gifts/${encodeURIComponent(gift.id)}/redeem`, {});
      onGift(redeemed.gift);
      setConfirming(false);
      await addToCart(redeemed.gift);
    } catch (err) {
      setConfirming(false);
      setError(await sentence(err));
      await refresh(err);
    } finally {
      setBusy(false);
    }
  };

  const addOnly = async (replaceCart = false) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await addToCart(gift, replaceCart);
    } finally {
      setBusy(false);
    }
  };

  const pickedName = pickedItem ? [pickedItem.name.en || pickedItem.name.ar || pickedItem.name.ckb, tri(pickedItem.color)].filter(Boolean).join(' · ') : '';
  const conflictKeys: [GiftStringKey, GiftStringKey] = conflict === 'seller' ? ['sellerConflictTitle', 'sellerConflictBody'] : ['shippingConflictTitle', 'shippingConflictBody'];

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col" data-reveal-view="result" data-reveal-stage={stage}>
      <header className="mx-auto flex w-full max-w-lg shrink-0 items-center gap-3 px-4" style={LOOK.head}>
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 text-[15px] font-bold leading-6 text-text-primary outline-none">
          {t('reveal.title')}
        </h2>
        <IconButton variant="ghost" label={t('close')} icon={<X className="w-5 h-5" aria-hidden="true" />} onClick={onClose} data-reveal-close />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-lg space-y-4 px-4 pb-4">
          <section className="lv-surface space-y-3 p-4" data-reveal-score={data.score}>
            <div className="flex items-center gap-4">
              <div className="shrink-0 text-center">
                <span className="block tabular-nums text-text-primary" style={LOOK.scoreSmall}>
                  {formatFigure(data.score, lang)}
                </span>
                <span className="text-[12px] font-semibold text-text-muted">{t('reveal.of100', { max: formatFigure(SCORE_SCALE.to, lang) })}</span>
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-[13px] font-bold leading-5 text-text-primary">{opened}</p>
                <p dir="auto" className="line-clamp-1 text-[12px] leading-5 text-text-secondary">
                  {tri(data.review.name)}
                </p>
                <Stars value={data.review.stars} />
              </div>
            </div>
            <LevelTrack data={data} lit={data.levels.length} settled />
            <Button variant="ghost" size="sm" onClick={onWatch} aria-expanded={watching} data-reveal-watch className="w-full">
              {t('rate.watch')}
            </Button>
            {watching && (
              <ul className="space-y-2.5 border-t border-border-subtle pt-3" data-reveal-still>
                {parts.map((line) => (
                  <PartRow key={line.key} line={line} shown still />
                ))}
                {data.breakdown.adjustment !== 0 && <AdjustRow value={data.breakdown.adjustment} shown still />}
              </ul>
            )}
          </section>

          {stage === 'choose' &&
            (choices.length === 0 ? (
              <p className="lv-well rounded-lg px-3 py-3 text-[13px] leading-6 text-text-secondary" data-reveal-empty>
                {t('reveal.noGifts')}
              </p>
            ) : (
              <section aria-labelledby={`${groupId}-pick`} className="space-y-2">
                <h3 id={`${groupId}-pick`} className="px-1 text-[15px] font-bold leading-6 text-text-primary">
                  {t('reveal.pick')}
                </h3>
                <div role="radiogroup" aria-labelledby={`${groupId}-pick`} className="space-y-2">
                  {groups.map((group) => (
                    <div key={group.level ?? 'all'} className="space-y-2" data-reveal-level={group.level ?? undefined}>
                      <p className="px-1 text-[12.5px] font-semibold text-text-secondary">{levelName(group.level)}</p>
                      {group.items.map((item) => {
                        const id = item.item_id ?? item.product_id;
                        return <ChoiceRow key={id} item={item} picked={picked === id} onPick={() => setPicked(id)} disabled={busy} />;
                      })}
                    </div>
                  ))}
                </div>
              </section>
            ))}

          {stage !== 'choose' && gift.chosen && (
            <section className="lv-surface space-y-3 p-4" data-reveal-chosen>
              <h3 className="flex items-center gap-2 text-[15px] font-bold leading-6 text-text-primary">
                {stage === 'done' ? <Check className="w-5 h-5 text-success" aria-hidden="true" /> : <Gift className="w-5 h-5 text-text-secondary" aria-hidden="true" />}
                {t(stage === 'done' ? 'rate.inCart' : 'reveal.chosen')}
              </h3>
              <GiftItemSummary lang={gl} item={gift.chosen} money={money} />
              {stage === 'done' && <p className="text-[13px] leading-6 text-text-secondary">{t('reveal.done.body', { zero: formatFigure(0, lang) })}</p>}
              {stage === 'ordered' && <p className="text-[13px] leading-6 text-text-secondary">{t('reveal.ordered')}</p>}
              {stage === 'fulfilled' && <p className="text-[13px] leading-6 text-text-secondary">{t('reveal.fulfilled')}</p>}
            </section>
          )}
          {stage === 'cancelled' && <p className="lv-well rounded-lg px-3 py-3 text-[13px] leading-6 text-text-secondary">{t('reveal.cancelled')}</p>}

          {error && (
            <p role="alert" className="lv-alert lv-alert-danger text-[13px] leading-6 text-text-primary" data-reveal-error>
              {error}
            </p>
          )}
        </div>
      </div>

      <footer className="shrink-0 bg-surface shadow-dock" style={LOOK.foot} hidden={stage === 'ordered' && !gift.order}>
        <div className="mx-auto w-full max-w-lg space-y-2 px-4">
          {(stage === 'choose' || stage === 'add') && (
            <p className="text-center text-[12.5px] font-semibold text-text-secondary" data-reveal-delivery-only>
              {t('reveal.deliveryOnly')}
            </p>
          )}
          {stage === 'choose' && choices.length > 0 && (
            <Button variant="primary" block disabled={!pickedItem || busy} onClick={() => setConfirming(true)} data-reveal-confirm>
              {t('code.confirm')}
            </Button>
          )}
          {stage === 'add' && (
            <Button variant="primary" block loading={busy} onClick={() => void addOnly()} data-reveal-add>
              {t('reveal.addToCart')}
            </Button>
          )}
          {stage === 'done' && (
            <>
              <Link to="/cart" className="lv-button lv-button-primary w-full" data-reveal-checkout>
                {t('reveal.checkout')}
              </Link>
              <Link to="/gifts" className="lv-button lv-button-secondary w-full">
                {t('rate.gifts')}
              </Link>
            </>
          )}
          {stage === 'ordered' && gift.order && (
            <Link to={`/orders/${encodeURIComponent(gift.order.id)}`} className="lv-button lv-button-secondary w-full">
              {t('past.viewOrder')}
            </Link>
          )}
          {(stage === 'fulfilled' || stage === 'cancelled' || (stage === 'choose' && choices.length === 0)) && (
            <Link to="/gifts" className="lv-button lv-button-secondary w-full">
              {t('rate.gifts')}
            </Link>
          )}
        </div>
      </footer>

      <ConfirmDialog
        open={confirming}
        title={t('reveal.confirm.title')}
        consequence={t('reveal.confirm.body', { item: pickedName })}
        confirmLabel={t('reveal.confirm.go')}
        cancelLabel={t('cancel')}
        busy={busy}
        onConfirm={confirmGift}
        onCancel={() => setConfirming(false)}
        testId="gift-reveal-confirm"
      />
      <ConfirmDialog
        open={conflict !== null}
        title={giftText(gl, conflictKeys[0])}
        consequence={giftText(gl, conflictKeys[1])}
        confirmLabel={giftText(gl, 'replaceCart')}
        cancelLabel={t('cancel')}
        destructive
        busy={busy}
        onConfirm={() => addOnly(true)}
        onCancel={() => setConflict(null)}
        testId="gift-reveal-conflict"
      />
    </div>
  );
}

// ---------------------------------------------------------------- the sheet

export default function GiftReveal({ data, play, onClose, onChanged }: GiftRevealProps) {
  const { t, lang } = useRewardsT();
  const reduced = usePrefersReducedMotion();
  const [gift, setGift] = useState<GiftView>(data.gift);
  const [view, setView] = useState<'analysis' | 'result'>(opensOnAnalysis(play, reduced) ? 'analysis' : 'result');
  const [run, setRun] = useState(0);
  const [still, setStill] = useState(false);
  const [announced, setAnnounced] = useState('');
  // A lone gift is already the choice; a gift chosen earlier comes back chosen, while it is still offered.
  const [picked, setPicked] = useState<string>(() => initialPick(data.gift));
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const script = useMemo(() => revealScript(data), [data]);
  const opened = useOpenedLine(data.levels);
  const resultLine = t('reveal.sr.result', { score: formatFigure(data.score, lang), max: formatFigure(SCORE_SCALE.to, lang), opened });
  const finish = useCallback(() => setView('result'), []);
  // A code just written: the page behind hears of it only here, with the sheet long
  // over it, so nothing says the score before the analysis has.
  const pageTold = useRef(!play);
  useEffect(() => {
    if (view !== 'result' || pageTold.current) return;
    pageTold.current = true;
    onChanged();
  }, [view, onChanged]);

  // Reduced motion arriving late (the query answers after the first paint, or the
  // setting changes while the analysis runs): straight to the result.
  useEffect(() => {
    if (reduced && view === 'analysis') finish();
  }, [reduced, view, finish]);

  // Arriving at the result, by the clock, by «تخطَّ» or straight away: it is said, and focus lands on it.
  useEffect(() => {
    if (view !== 'result') return;
    setAnnounced(resultLine);
    headingRef.current?.focus({ preventScroll: true });
  }, [view, resultLine]);

  const watch = useCallback(() => {
    if (reduced) {
      setStill((s) => !s);
      return;
    }
    setRun((r) => r + 1);
    setView('analysis');
  }, [reduced]);

  const updateGift = useCallback(
    (next: GiftView) => {
      setGift(next);
      onChanged();
    },
    [onChanged]
  );

  return (
    <Overlay
      open
      onClose={onClose}
      placement="dock"
      label={t('reveal.title')}
      solid
      dismissOnScrim={false}
      initialFocus={view === 'result' ? headingRef : undefined}
      testId="gift-reveal"
      panelClassName="h-dvh w-full bg-canvas text-text-primary"
      panelMotion={PANEL_MOTION}
    >
      {view === 'analysis' ? (
        <Analysis key={run} data={data} script={script} onDone={finish} onSkip={finish} />
      ) : (
        <Result data={data} gift={gift} onGift={updateGift} onWatch={watch} watching={still} onClose={onClose} headingRef={headingRef} picked={picked} setPicked={setPicked} />
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announced}
      </p>
    </Overlay>
  );
}
