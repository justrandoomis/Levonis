import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CameraOff, Flashlight, FlashlightOff, ImagePlus, RotateCcw, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import Spinner from '../ui/Spinner';
import { classifyLabel, type DecodedCode, type LabelRead } from '../../../packages/catalog/src/deviceSerials';
import { CodeWindow, DecodeEngine, guideCrop, type EngineKind } from './decodeEngine';
import { scanFeedback, type ScanFeedback } from './feedback';
import { SCANNER_STRINGS } from './strings';

/**
 * THE ONE CAMERA SCANNER — for the customer adding a printer on /warranty and
 * for the admin filling the serial inventory from box labels.
 *
 * LAZY: import it with `React.lazy(() => import('…/scanner/BarcodeScanner'))`.
 * Nothing here, nor the reader library behind it, reaches a page until a
 * scanner is opened (tests/bundleBudget.test.ts).
 *
 * TWO MODES.
 *  - `single`: stops at the first USEFUL read — a device serial or a warranty
 *    receipt. A box SN alone is taken only after a pause (the server can map
 *    it to its serial); an EAN alone is never taken, and the frame says why.
 *  - `continuous`: one call per LABEL, then keeps going. The same serial held
 *    in view does not fire twice; `onRead` answers with how it went
 *    (added / duplicate / invalid) and the frame flashes, beeps and buzzes
 *    accordingly.
 *
 * THE CAMERA IS NEVER LEFT ON. The stream stops on close, on unmount, on the
 * first read in single mode, and whenever the page is hidden
 * (visibilitychange) — it restarts when the page is shown again. A camera
 * light that stays on after the window has gone is the one thing this
 * component must never do.
 *
 * Rear camera (`facingMode: environment`), torch when the track offers one,
 * tap-to-focus where the browser exposes focus control (and a hint where it
 * does not), a guide frame the decoder is limited to, a photo fallback and a
 * typed fallback. The preview area is a dark subtree in both themes: a
 * camera picture is not a surface that follows the theme.
 */

export interface ScanRead extends LabelRead {
  /** Every code that made up this read, as decoded. */
  raw: DecodedCode[];
}

export interface BarcodeScannerProps {
  mode: 'single' | 'continuous';
  /** Single: called once. Continuous: per label; return how it went to drive the feedback. */
  onRead: (read: ScanRead) => ScanFeedback | void;
  onClose: () => void;
  title?: string;
  titleId?: string;
  /** What the frame should hold: a whole box label, or one barcode. */
  frame?: 'label' | 'strip';
  /** Also read QR codes (warranty receipts). */
  qr?: boolean;
  /** The typed fallback. Omit to hide it. */
  onManual?: (text: string) => void;
  /** Rendered under the controls — the admin's list of scanned rows. */
  children?: React.ReactNode;
}

type CameraState = 'starting' | 'slow' | 'on' | 'paused' | 'denied' | 'unavailable' | 'insecure' | 'failed' | 'stopped';
type PhotoState = 'idle' | 'decoding' | 'nothing';
type Hint = 'aimAtSn' | 'boxOnly' | null;

/** The camera-only capabilities TypeScript's DOM types do not list yet. */
type CameraCaps = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[]; pointsOfInterest?: unknown };
type TorchTrack = MediaStreamTrack;

const CORNERS = [
  'top-0 start-0 border-t-[3px] border-s-[3px] rounded-ss-xl',
  'top-0 end-0 border-t-[3px] border-e-[3px] rounded-se-xl',
  'bottom-0 start-0 border-b-[3px] border-s-[3px] rounded-es-xl',
  'bottom-0 end-0 border-b-[3px] border-e-[3px] rounded-ee-xl',
];

/** Box SN alone is accepted in single mode after this long without a product SN. */
const BOX_ONLY_AFTER_MS = 3000;
/** Continuous, library engine: wait this long after the SN for the EAN/box of the same label. */
const COMPANION_WAIT_MS = 900;
/** Continuous: the same SN must be out of view this long before it can fire again. */
const SAME_SN_QUIET_MS = 2500;

export default function BarcodeScanner({
  mode,
  onRead,
  onClose,
  title,
  titleId: titleIdProp,
  frame = mode === 'continuous' ? 'label' : 'strip',
  qr = false,
  onManual,
  children,
}: BarcodeScannerProps) {
  const { lang } = useLanguage();
  const s = SCANNER_STRINGS[lang] ?? SCANNER_STRINGS.ar;
  const m = useMotion();
  const autoId = useId();
  const titleId = titleIdProp ?? `scanner-title-${autoId}`;
  const photoId = `scanner-photo-${autoId}`;
  const manualId = `scanner-manual-${autoId}`;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const guideRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<DecodeEngine | null>(null);
  const windowRef = useRef(new CodeWindow());
  const rafRef = useRef(0);
  const lastTickRef = useRef(0);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const aliveRef = useRef(true);
  const snFirstSeenRef = useRef(new Map<string, number>());
  const snQuietRef = useRef(new Map<string, number>());
  const boxSinceRef = useRef<number | null>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;

  const [camera, setCamera] = useState<CameraState>('starting');
  const [photo, setPhoto] = useState<PhotoState>('idle');
  const [engine, setEngine] = useState<EngineKind | null>(null);
  const [hint, setHint] = useState<Hint>(null);
  const [flash, setFlash] = useState<ScanFeedback | null>(null);
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  const [focusAt, setFocusAt] = useState<{ x: number; y: number; key: number } | null>(null);
  const [manual, setManual] = useState('');

  const stopStream = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const showFlash = useCallback((kind: ScanFeedback) => {
    setFlash(kind);
    window.setTimeout(() => setFlash((f) => (f === kind ? null : f)), 700);
  }, []);

  /** Single mode: hand over one read and switch everything off. */
  const finish = useCallback(
    (read: ScanRead) => {
      if (doneRef.current) return;
      doneRef.current = true;
      stopStream();
      setCamera('stopped');
      scanFeedback('captured');
      onReadRef.current(read);
    },
    [stopStream]
  );

  /** What a tick's worth of codes means, in each mode. */
  const consider = useCallback(
    (codes: DecodedCode[], fromPhoto = false) => {
      const now = performance.now();
      const win = windowRef.current;
      win.add(codes, now);
      const raw = win.recent(now);
      const read = classifyLabel(raw);
      if (mode === 'single') {
        if (read.receipt || read.productSn) return finish({ ...read, raw });
        if (read.boxSn) {
          boxSinceRef.current ??= now;
          if (fromPhoto || now - boxSinceRef.current >= BOX_ONLY_AFTER_MS) return finish({ ...read, raw });
          setHint('boxOnly');
          return;
        }
        if (read.ean) setHint('aimAtSn');
        return;
      }
      // continuous
      const sn = read.productSn;
      if (!sn) {
        if (read.ean || read.boxSn) setHint('aimAtSn');
        return;
      }
      setHint(null);
      const quiet = snQuietRef.current.get(sn);
      if (quiet !== undefined && now - quiet < SAME_SN_QUIET_MS) {
        // Still the label just handled: keep it quiet while it stays in view.
        snQuietRef.current.set(sn, now);
        return;
      }
      const first = snFirstSeenRef.current.get(sn) ?? now;
      snFirstSeenRef.current.set(sn, first);
      const waitForCompanions = !fromPhoto && engineRef.current?.kind === 'library' && !(read.ean && read.boxSn);
      if (waitForCompanions && now - first < COMPANION_WAIT_MS) return;
      const outcome: ScanFeedback = onReadRef.current({ ...read, raw }) || 'added';
      snQuietRef.current.set(sn, now);
      snFirstSeenRef.current.delete(sn);
      win.clear();
      scanFeedback(outcome);
      showFlash(outcome);
    },
    [finish, mode, showFlash]
  );

  const loop = useCallback(() => {
    rafRef.current = requestAnimationFrame(async (t) => {
      if (doneRef.current || !streamRef.current) return;
      if (t - lastTickRef.current >= 110 && !busyRef.current) {
        lastTickRef.current = t;
        const v = videoRef.current;
        const g = guideRef.current;
        const eng = engineRef.current;
        if (v && g && eng && v.readyState >= 2 && v.videoWidth > 0) {
          busyRef.current = true;
          try {
            const crop = guideCrop(v, g);
            if (crop) consider(await eng.decode(v, crop));
          } catch {
            /* one bad frame; keep scanning */
          } finally {
            busyRef.current = false;
          }
        }
      }
      if (!doneRef.current && streamRef.current) loop();
    });
  }, [consider]);

  const start = useCallback(async () => {
    if (doneRef.current || !aliveRef.current) return;
    if (typeof window !== 'undefined' && window.isSecureContext === false) return setCamera('insecure');
    if (!navigator.mediaDevices?.getUserMedia) return setCamera('unavailable');
    setCamera((c) => (c === 'paused' ? 'starting' : c));
    // A camera the person already refused would only re-prompt nothing:
    // say so at once instead of waiting on a promise that rejects later.
    try {
      const perm = await navigator.permissions?.query({ name: 'camera' as PermissionName });
      if (perm?.state === 'denied') return setCamera('denied');
    } catch {
      /* Safari and Firefox may not know the 'camera' permission name */
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (!aliveRef.current || doneRef.current || document.visibilityState === 'hidden') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0] as TorchTrack | undefined;
      const caps = track?.getCapabilities?.() as CameraCaps | undefined;
      setTorch({ supported: !!caps?.torch, on: false });
      if (caps?.focusMode?.includes('continuous')) {
        track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined);
      }
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      try {
        await v.play();
      } catch {
        /* autoplay policies: the frame still updates once metadata loads */
      }
      if (!engineRef.current) {
        const eng = new DecodeEngine({ qr });
        setEngine(await eng.init());
        engineRef.current = eng;
      }
      if (!aliveRef.current || doneRef.current) return;
      setCamera('on');
      loop();
    } catch (err) {
      if (!aliveRef.current) return;
      const name = (err as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') setCamera('denied');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') setCamera('unavailable');
      else setCamera('failed');
    }
  }, [loop, qr]);

  useEffect(() => {
    // Reset on every (re)mount: StrictMode runs mount → cleanup → mount.
    aliveRef.current = true;
    doneRef.current = false;
    const slowTimer = window.setTimeout(() => {
      if (aliveRef.current) setCamera((c) => (c === 'starting' ? 'slow' : c));
    }, 12000);
    void start();
    const onVisibility = () => {
      if (doneRef.current) return;
      if (document.visibilityState === 'hidden') {
        stopStream();
        setCamera((c) => (c === 'on' || c === 'starting' || c === 'slow' ? 'paused' : c));
      } else if (!streamRef.current) {
        void start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      aliveRef.current = false;
      window.clearTimeout(slowTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      stopStream();
    };
  }, [start, stopStream]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch({ supported: true, on: next });
    } catch {
      setTorch({ supported: false, on: false });
    }
  };

  /** Tap-to-focus where the track allows a point of interest; the ring is shown either way. */
  const onViewportPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const key = Date.now();
    setFocusAt({ x, y, key });
    window.setTimeout(() => setFocusAt((f) => (f?.key === key ? null : f)), 900);
    const track = streamRef.current?.getVideoTracks()[0] as TorchTrack | undefined;
    const caps = track?.getCapabilities?.() as CameraCaps | undefined;
    if (track && caps && 'pointsOfInterest' in caps) {
      const modes = caps.focusMode ?? [];
      const once = modes.includes('single-shot') ? 'single-shot' : modes.includes('continuous') ? 'continuous' : undefined;
      track
        .applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }], ...(once ? { focusMode: once } : {}) } as unknown as MediaTrackConstraintSet] })
        .catch(() => undefined);
    }
  };

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || doneRef.current) return;
    setPhoto('decoding');
    busyRef.current = true;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(file);
      const eng = engineRef.current ?? new DecodeEngine({ qr });
      if (!engineRef.current) {
        setEngine(await eng.init());
        engineRef.current = eng;
      }
      const codes = await eng.decode(bitmap, { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height }, true);
      const read = classifyLabel(codes);
      if (read.productSn || read.receipt || read.boxSn) {
        setPhoto('idle');
        consider(codes, true);
      } else setPhoto('nothing');
    } catch {
      setPhoto('nothing');
    } finally {
      bitmap?.close();
      busyRef.current = false;
    }
  };

  const retry = () => {
    stopStream();
    setCamera('starting');
    void start();
  };

  const cameraOff = camera === 'denied' || camera === 'unavailable' || camera === 'insecure' || camera === 'failed' || camera === 'paused';
  const live = camera === 'on';
  const status =
    photo === 'decoding'
      ? s.decoding
      : photo === 'nothing'
        ? s.nothing
        : camera === 'starting'
          ? s.starting
          : camera === 'slow'
            ? s.slow
            : camera === 'denied'
              ? s.denied
              : camera === 'unavailable'
                ? s.unavailable
                : camera === 'insecure'
                  ? s.insecure
                  : camera === 'failed'
                    ? s.failed
                    : camera === 'paused'
                      ? s.paused
                      : camera === 'stopped'
                        ? s.captured
                        : hint === 'aimAtSn'
                          ? s.aimAtSn
                          : hint === 'boxOnly'
                            ? s.boxOnly
                            : frame === 'label'
                              ? s.lookingLabel
                              : s.looking;

  const frameTone =
    flash === 'added' || flash === 'captured'
      ? 'border-success'
      : flash === 'duplicate'
        ? 'border-warning'
        : flash === 'invalid'
          ? 'border-danger'
          : 'border-gold';

  return (
    <div className="flex flex-col min-h-0" data-scanner-mode={mode} data-scanner-engine={engine ?? ''} data-scanner-camera={camera}>
      <div className="flex items-center justify-between gap-3 ps-4 pe-2 pt-3 pb-2">
        <h2 id={titleId} className="text-white font-bold text-base truncate">
          {title ?? s.title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={s.close}
          className="inline-flex items-center justify-center w-11 h-11 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <X aria-hidden="true" className="w-5 h-5" />
        </button>
      </div>

      {/* The camera picture: a dark subtree in both themes. */}
      <div
        data-theme="dark"
        className="relative w-full aspect-[3/4] sm:aspect-[4/3] max-h-[58vh] bg-charcoal overflow-hidden select-none touch-manipulation"
        onPointerDown={live ? onViewportPointer : undefined}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          aria-hidden="true"
          className={`absolute inset-0 w-full h-full object-cover ${cameraOff ? 'invisible' : ''}`}
        />
        {cameraOff && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400">
              <CameraOff aria-hidden="true" className="w-6 h-6" />
            </span>
            <p className="text-zinc-200 text-sm leading-relaxed max-w-[34ch]">{status}</p>
            {camera === 'denied' && <p className="text-zinc-400 text-[12px] leading-relaxed max-w-[36ch]">{s.deniedHelp}</p>}
            {(camera === 'denied' || camera === 'failed') && (
              <button
                type="button"
                onClick={retry}
                className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-100 text-[13px] font-bold hover:bg-zinc-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                <RotateCcw aria-hidden="true" className="w-4 h-4" />
                {s.retry}
              </button>
            )}
          </div>
        )}
        {(camera === 'starting' || camera === 'slow') && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner size="md" delayMs={0} decorative />
          </div>
        )}
        {!cameraOff && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden="true">
            <div
              ref={guideRef}
              data-scanner-guide
              className={`relative w-[86%] ${frame === 'label' ? 'aspect-[3/2]' : 'aspect-[3/1]'} max-h-[78%] rounded-xl shadow-[0_0_0_200vmax_rgb(0_0_0_/_0.42)] transition-colors duration-200`}
            >
              {CORNERS.map((c) => (
                <span
                  key={c}
                  className={`absolute w-7 h-7 ${frameTone} ${c} transition-colors duration-200 ${live && !flash && !m.reduced ? 'animate-pulse' : ''}`}
                />
              ))}
              {flash && <span className={`absolute inset-0 rounded-xl border-2 ${frameTone}`} />}
            </div>
          </div>
        )}
        {focusAt && live && (
          // Pointer coordinates are physical, so this one ring is placed with
          // `left`, not a logical inset: it goes where the finger went.
          <span
            key={focusAt.key}
            aria-hidden="true"
            className={`absolute w-16 h-16 rounded-full border-2 border-gold pointer-events-none -translate-x-1/2 -translate-y-1/2 ${m.reduced ? '' : 'animate-ping'}`}
            style={{ left: `${focusAt.x * 100}%`, top: `${focusAt.y * 100}%` }}
          />
        )}
        {torch.supported && live && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleTorch}
            aria-pressed={torch.on}
            aria-label={torch.on ? s.torchOff : s.torchOn}
            className="absolute top-3 end-3 inline-flex items-center justify-center w-11 h-11 rounded-full bg-onyx/60 text-snow backdrop-blur-sm hover:bg-onyx/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold aria-pressed:bg-gold aria-pressed:text-accent-contrast"
          >
            {torch.on ? <FlashlightOff aria-hidden="true" className="w-5 h-5" /> : <Flashlight aria-hidden="true" className="w-5 h-5" />}
          </button>
        )}
        {live && (
          <p className="absolute bottom-3 inset-x-3 mx-auto w-fit max-w-[calc(100%-1.5rem)] rounded-full bg-onyx/65 px-3 py-1.5 text-center text-[12px] leading-snug text-snow backdrop-blur-sm pointer-events-none">
            {status}
          </p>
        )}
      </div>

      <div className="px-4 py-3 space-y-3">
        <p role="status" aria-live="polite" className={live ? 'sr-only' : 'text-[13px] text-zinc-300 min-h-[1.25rem]'}>
          {status}
        </p>
        {live && <p className="text-[11.5px] text-zinc-500 leading-relaxed">{s.tapToFocus}</p>}
        <div className="flex items-stretch gap-2 flex-wrap">
          <label
            htmlFor={photoId}
            className={`inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl border border-zinc-700/70 bg-zinc-800/70 hover:bg-zinc-800 text-zinc-100 text-[13px] font-bold cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-gold ${
              photo === 'decoding' ? 'opacity-60 pointer-events-none' : ''
            }`}
          >
            <ImagePlus aria-hidden="true" className="w-4 h-4" />
            {s.choosePhoto}
            <input id={photoId} type="file" accept="image/*" className="sr-only" disabled={photo === 'decoding'} onChange={onPickPhoto} />
          </label>
          {onManual && (
            <form
              className="flex flex-1 min-w-[15rem] gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = manual.trim();
                if (!v) return;
                setManual('');
                onManual(v);
              }}
            >
              <label htmlFor={manualId} className="sr-only">
                {s.manualLabel}
              </label>
              <input
                id={manualId}
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder={s.manualLabel}
                aria-describedby={`${manualId}-hint`}
                maxLength={120}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                dir="ltr"
                className="flex-1 min-w-0 min-h-[44px] rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 font-mono text-sm text-white placeholder:text-zinc-500 placeholder:font-sans outline-none focus:border-gold/50 focus-visible:ring-2 focus-visible:ring-gold"
              />
              <span id={`${manualId}-hint`} className="sr-only">
                {s.manualPlaceholder}
              </span>
              <button
                type="submit"
                disabled={!manual.trim()}
                className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl bg-gold text-accent-contrast text-[13px] font-bold hover:brightness-110 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                {s.manualSubmit}
              </button>
            </form>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
