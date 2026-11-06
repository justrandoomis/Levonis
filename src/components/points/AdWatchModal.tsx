/**
 * THE AD WINDOW OF «شاهد إعلانًا» (owner's ad: 1080×1920, 47.5 s; migration 0227;
 * DECISIONS row 300).
 *
 * It fits a phone: the video keeps its own shape and is never taller than the
 * screen leaves room for, so the claim is always on screen below it. It plays
 * inline, with sound, and goes muted only when the browser refuses sound (with
 * the toggle right there to turn it on). The line under it is the video's real
 * playback. The poster stands in while it loads, a failed video says so and can
 * be tried again, and no state here can leave a spinner turning for ever.
 *
 * IT DECIDES NOTHING. The claim is offered when the video has ended AND the
 * server's own countdown is over, as ever, and the server re-checks its own
 * `started_at` regardless. Leaving and coming back keeps that clock (the server
 * keeps the first start of the day), and the player returns to where it was.
 *
 * A FILM ONCE FINISHED STAYS FINISHED FOR ITS TICKET: leaving at the claim, or
 * losing the claim's request on mobile data, does not cost the customer the film
 * again (`FilmNote`, ./adMission.ts). Coming back it is not played or even loaded,
 * and the claim is offered at once. A new day's ticket starts over.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Check, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Overlay } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { filmAt, filmEnded, parseFilmNote, recallFilm, stageAfterPause, type AdView, type FilmNote, type FilmStage } from './adMission';

/**
 * The height the frame may take: of what the phone really shows (`dvh`) where the
 * browser knows it. Decided here, not by two long utility classes, because the
 * shop's stylesheets sit at their budget (tests/bundleBudget.test.ts).
 */
const FRAME_HEIGHT = typeof CSS !== 'undefined' && CSS.supports?.('height', '1dvh') ? '62dvh' : '62vh';

/** A video that has not got going in this long is not going to: it says so. */
const STUCK_AFTER_MS = 20_000;

/**
 * Where today's film was left, for the life of the page: closing the window is
 * not starting over. Its END is also kept in the tab's storage, because a phone
 * may discard a tab left at the claim, and that must not cost the film again.
 */
let filmNote: FilmNote | null = null;
const FILM_NOTE_KEY = 'levo_ad_film';

function readFilmNote(): FilmNote | null {
  if (filmNote) return filmNote;
  try {
    filmNote = parseFilmNote(sessionStorage.getItem(FILM_NOTE_KEY));
  } catch {
    // Storage refused (a private window): the page's own memory still holds.
  }
  return filmNote;
}

function keepFilmEnd(note: FilmNote | null): void {
  filmNote = note;
  try {
    sessionStorage.setItem(FILM_NOTE_KEY, JSON.stringify(note));
  } catch {
    // As above.
  }
}

interface AdWatchModalProps {
  open: boolean;
  onClose: () => void;
  anchor?: RefObject<HTMLElement | null>;
  videoUrl: string | null;
  /** The server's ad; null when the old setting supplies the video. */
  ad: AdView | null;
  /** Which ticket the server opened this on: what a film's end is remembered against. */
  ticket: string | null;
  /** Why the last claim did not go through, when the window stays open for another press. */
  note?: string;
  /** The server's seconds still to run, counted down by the page. */
  secondsLeft: number;
  points: number;
  claiming: boolean;
  onClaim: () => void;
}

export default function AdWatchModal({ open, onClose, anchor, videoUrl, ad, ticket, note, secondsLeft, points, claiming, onClaim }: AdWatchModalProps) {
  const { loc, lang } = useLanguage();
  const title = ad ? ad.title[lang === 'en' || lang === 'ckb' ? lang : 'ar'] || ad.title.ar : '';
  return (
    <Overlay
      open={open && !!videoUrl}
      onClose={onClose}
      labelledBy="rewards-video-title"
      anchor={anchor}
      placement="center"
      z={50}
      dismissOnScrim={false}
      testId="rewards-video"
      panelClassName="w-full max-w-md"
    >
      {() => (
        <div className="p-4 flex flex-col items-stretch gap-3">
          <h3 id="rewards-video-title" className="text-text-primary font-bold text-[16px] text-center leading-snug">
            {title || loc('شاهد الإعلان لتربح النقاط', 'Watch the ad to earn', 'ڕیکلامەکە ببینە بۆ بردنەوەی خاڵ')}
          </h3>
          {videoUrl && <AdPlayer videoUrl={videoUrl} ad={ad} ticket={ticket} note={note} secondsLeft={secondsLeft} points={points} claiming={claiming} onClaim={onClaim} onClose={onClose} />}
        </div>
      )}
    </Overlay>
  );
}

export function AdPlayer({
  videoUrl,
  ad,
  ticket,
  note,
  secondsLeft,
  points,
  claiming,
  onClaim,
  onClose,
}: Pick<AdWatchModalProps, 'ad' | 'ticket' | 'note' | 'secondsLeft' | 'points' | 'claiming' | 'onClaim' | 'onClose'> & { videoUrl: string }) {
  const { loc } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  // This ticket's film was already finished: nothing to play, the claim is what is left.
  const [cameBack] = useState(() => recallFilm(readFilmNote(), videoUrl, ticket).ended);
  const [stage, setStage] = useState<FilmStage>(cameBack ? 'playing' : 'loading');
  const [ended, setEnded] = useState(cameBack);
  const [muted, setMuted] = useState(false);
  // Their choice: a retry or a carry-on does not turn the sound back on over it.
  const chosenMute = useRef(false);
  const [fraction, setFraction] = useState(cameBack ? 1 : 0);
  const [shape, setShape] = useState(() => (ad && ad.width > 0 && ad.height > 0 ? { w: ad.width, h: ad.height } : { w: 9, h: 16 }));
  // A retry reloads the element; this is what makes it load again.
  const [attempt, setAttempt] = useState(0);

  /**
   * WITH SOUND IF THE BROWSER ALLOWS, MUTED IF IT DOES NOT, AND A BUTTON IF IT
   * REFUSES EVEN THAT (a data-saver mode, some in-app browsers). The window opens
   * after the server's answer, so a phone may no longer count this as the tap.
   */
  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = chosenMute.current;
    setMuted(chosenMute.current);
    try {
      await video.play();
    } catch (error) {
      if ((error as { name?: string })?.name !== 'NotAllowedError') return; // onError says what went wrong
      video.muted = true;
      setMuted(true);
      try {
        await video.play();
      } catch {
        setStage((s) => (s === 'failed' ? s : 'blocked'));
      }
    }
  }, []);

  useEffect(() => {
    if (!cameBack) void start();
  }, [cameBack, start, attempt]);

  // NEVER A SPINNER FOR EVER: a video stuck on loading, for whatever reason, says so.
  useEffect(() => {
    if (stage !== 'loading') return;
    const id = setTimeout(() => setStage('failed'), STUCK_AFTER_MS);
    return () => clearTimeout(id);
  }, [stage, attempt]);

  // A phone pauses the video behind the lock screen; coming back carries on.
  useEffect(() => {
    if (ended) return;
    const resume = () => {
      const video = videoRef.current;
      if (!document.hidden && video && video.paused && !video.ended && (stage === 'playing' || stage === 'blocked')) void video.play().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [stage, ended]);

  const retry = () => {
    setStage('loading');
    videoRef.current?.load();
    setAttempt((n) => n + 1);
  };

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    chosenMute.current = video.muted;
    setMuted(video.muted);
    // A tap is the permission a refused start was waiting for.
    if (video.paused && !video.ended) void video.play().catch(() => undefined);
  };

  const ready = ended && secondsLeft <= 0;
  const ratio = shape.w / shape.h;
  const percent = Math.round(fraction * 100);

  return (
    <>
      {/* The width follows from the height it may take, so the frame IS the video's
          shape on any phone: never letterboxed, never taller than the screen. */}
      <div
        className={`relative mx-auto max-w-full overflow-hidden rounded-xl ${stage === 'failed' ? 'bg-surface-raised' : 'bg-charcoal'}`}
        style={{ width: `min(100%, calc(${FRAME_HEIGHT} * ${ratio}))`, aspectRatio: `${shape.w} / ${shape.h}` }}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          poster={ad?.poster_url ?? undefined}
          playsInline
          preload={cameBack ? 'none' : 'auto'}
          controls={false}
          disablePictureInPicture
          data-ad-video
          className={`absolute inset-0 w-full h-full object-contain ${stage === 'failed' ? 'invisible' : ''}`}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth > 0 && v.videoHeight > 0) setShape({ w: v.videoWidth, h: v.videoHeight });
            const back = recallFilm(filmNote, videoUrl, ticket).at;
            if (back > 1 && Number.isFinite(v.duration) && back < v.duration - 1) v.currentTime = back;
          }}
          onWaiting={() => setStage((s) => (s === 'failed' ? s : 'loading'))}
          onPlaying={() => setStage('playing')}
          onCanPlay={(e) => {
            // Ready and not asked to wait: nothing to show a spinner over.
            if (!e.currentTarget.paused) setStage('playing');
          }}
          onError={() => setStage('failed')}
          onPause={(e) => {
            const atEnd = e.currentTarget.ended;
            setStage((s) => stageAfterPause(s, atEnd));
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            // Reloading the element fires this at 0, before it is sought back to its place.
            if (v.currentTime > 0 && Number.isFinite(v.duration) && v.duration > 0) setFraction(Math.min(1, v.currentTime / v.duration));
            filmNote = filmAt(filmNote, videoUrl, ticket, v.currentTime);
          }}
          onEnded={() => {
            setEnded(true);
            setFraction(1);
            setStage('playing');
            keepFilmEnd(filmEnded(filmNote, videoUrl, ticket));
          }}
        />

        {cameBack && (
          <div className="absolute inset-0 grid place-items-center p-5 pointer-events-none">
            <span className="lv-surface-raised rounded-full px-4 py-2 flex items-center gap-2 text-text-primary text-sm font-bold">
              <Check aria-hidden="true" className="w-4 h-4 text-gold" strokeWidth={3} />
              {loc('انتهى الإعلان', 'The ad has finished', 'ڕیکلامەکە تەواو بوو')}
            </span>
          </div>
        )}

        {/* On the film, which is over by now: it moves nothing, and covers no button on any phone. */}
        {note && (
          <p role="alert" className="absolute inset-x-0 bottom-0 m-2 lv-surface-raised rounded-xl px-3 py-2 text-text-primary text-xs font-medium text-center">
            {note}
          </p>
        )}

        {stage === 'loading' && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="size-12 rounded-full bg-surface-raised grid place-items-center">
              <Spinner size="md" delayMs={0} decorative />
            </span>
          </div>
        )}

        {stage === 'blocked' && (
          <button
            type="button"
            onClick={() => void start()}
            aria-label={loc('تشغيل الإعلان', 'Play the ad', 'ڕیکلامەکە لێبدە')}
            className="absolute inset-0 grid place-items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span className="size-16 rounded-full bg-gold-fill text-onyx shadow-2 grid place-items-center">
              <Play aria-hidden="true" className="w-7 h-7" fill="currentColor" />
            </span>
          </button>
        )}

        {stage === 'failed' && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-5 text-center">
            <p className="text-text-primary text-sm font-medium">
              {loc('تعذّر تشغيل الإعلان. تحقّق من اتصالك ثم أعد المحاولة.', "The ad couldn't play. Check your connection and try again.", 'ڕیکلامەکە لێنەدرا. پەیوەندییەکەت بپشکنە و دووبارە هەوڵ بدەرەوە.')}
            </p>
            <button type="button" onClick={retry} className="lv-button lv-button-secondary">
              <RotateCcw aria-hidden="true" className="w-4 h-4" />
              {loc('إعادة المحاولة', 'Try again', 'دووبارە هەوڵ بدەرەوە')}
            </button>
          </div>
        )}

        {stage !== 'failed' && !cameBack && (
          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={!muted}
            aria-label={muted ? loc('تشغيل الصوت', 'Turn the sound on', 'دەنگ چالاک بکە') : loc('كتم الصوت', 'Mute', 'بێدەنگ بکە')}
            className="lv-button lv-button-secondary absolute top-2 end-2 min-h-11 min-w-11 px-3 rounded-full gap-1.5"
          >
            {muted ? <VolumeX aria-hidden="true" className="w-5 h-5" /> : <Volume2 aria-hidden="true" className="w-5 h-5" />}
            {muted && <span className="text-[12px] font-bold">{loc('شغّل الصوت', 'Sound on', 'دەنگ')}</span>}
          </button>
        )}
      </div>

      {/* Real playback, not a timer: it stops when the video stops. In a block's
          inline flow, so it fills from the reader's own side. */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={loc('تقدّم الإعلان', 'Ad progress', 'پێشکەوتنی ڕیکلام')}
        className="h-1.5 rounded-full lv-well overflow-hidden"
      >
        <div className="h-full rounded-full bg-gold transition-[width] duration-300 ease-linear" style={{ width: `${percent}%` }} />
      </div>

      {ready ? (
        // The way out stays beside it: a claim that found no connection stays on the screen.
        <div className="w-full flex items-center gap-2">
          <button type="button" className="lv-button lv-button-primary flex-1 min-h-12" onClick={onClaim} disabled={claiming}>
            {claiming
              ? loc('جارٍ المطالبة…', 'Claiming...', 'وەرگرتن…')
              : loc(`احصل على ${points} نقطة`, `Claim ${points} pts`, `${points} خاڵ وەربگرە`)}
          </button>
          <button type="button" className="lv-button lv-button-ghost shrink-0" onClick={onClose}>
            {loc('إغلاق', 'Close', 'داخستن')}
          </button>
        </div>
      ) : (
        <div className="w-full flex items-center justify-between gap-3">
          <span className="text-gold font-bold text-sm tabular-nums">
            {secondsLeft > 0
              ? loc(`متبقٍ ${secondsLeft} ثانية`, `${secondsLeft}s remaining`, `${secondsLeft} چرکە ماوە`)
              : stage === 'playing' && loc('الإعلان قيد التشغيل…', 'Video is playing...', 'ڕیکلامەکە پەخش دەکرێت…')}
          </span>
          <button type="button" className="lv-button lv-button-ghost" onClick={onClose}>
            {loc('إغلاق', 'Close', 'داخستن')}
          </button>
        </div>
      )}
    </>
  );
}
