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
 *    (added / exists / duplicate / invalid) and the frame flashes, sounds and
 *    buzzes accordingly. The answer may be a PROMISE — the admin's camera
 *    registers each label on the server and the sound must be the server's
 *    verdict, never a guess made before it («مسجلة مسبقًا» is only known
 *    there). The scanner keeps reading other labels while one is in flight.
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
  /**
   * Single: called once. Continuous: per label; return how it went to drive
   * the feedback — at once, or as a promise of it.
   */
  onRead: (read: ScanRead) => ScanFeedback | void | Promise<ScanFeedback | void>;
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
  /**
   * Rendered directly under the camera picture, before the fallbacks — the
   * verdict on the last label, where the eyes already are.
   */
  verdict?: React.ReactNode;
  /**
   * Embedded in a window that has its own title and close button (the admin's
   * scan sheet): no header row, and a shorter picture so the verdict and the
   * session list stay in view on a phone.
   */
  embedded?: boolean;
  /**
   * Single mode: do NOT play the «captured» chime on the read. The caller
   * sounds the SERVER's verdict instead (the order screen's serial scan: a
   * success chime for a link that was made, the error tone for a serial that
   * belongs to another order) — a cheerful sound before a refusal teaches the
   * wrong thing (serial spec §5.2, Audit B §8).
   */
  deferFeedback?: boolean;
  /**
   * Single mode: once the product SN is read, keep looking a moment longer
   * for the same label's EAN and BOX SN, so the server can check the product
   * and refuse a box read as a device (critique-2 L2). Never longer than
   * COMPANION_WAIT_MS; a photo is read whole and never waits.
   */
  waitForCompanions?: boolean;
  /** The typed fallback's input, for a caller that focuses it (a Bluetooth reader on a tablet). */
  manualInputRef?: React.Ref<HTMLInputElement>;
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
  verdict,
  embedded = false,
  deferFeedback = false,
  waitForCompanions = false,
  manualInputRef,
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
  /** Continuous reads still waiting for their answer. */
  const [inFlight, setInFlight] = useState(0);
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
    // A refusal stays on the frame a little longer: it is the one the eyes must catch.
    const hold = kind === 'exists' || kind === 'duplicate' ? 1200 : 700;
    window.setTimeout(() => setFlash((f) => (f === kind ? null : f)), hold);
  }, []);

  /** Single mode: hand over one read and switch everything off. */
  const finish = useCallback(
    (read: ScanRead) => {
      if (doneRef.current) return;
      doneRef.current = true;
      stopStream();
      setCamera('stopped');
      if (!deferFeedback) scanFeedback('captured');
      onReadRef.current(read);
    },
    [stopStream, deferFeedback]
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
        if (read.receipt) return finish({ ...read, raw });
        if (read.productSn) {
          if (waitForCompanions && !fromPhoto && !(read.ean && read.boxSn)) {
            const first = snFirstSeenRef.current.get(read.productSn) ?? now;
            snFirstSeenRef.current.set(read.productSn, first);
            if (now - first < COMPANION_WAIT_MS) return;
          }
          return finish({ ...read, raw });
        }
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
      const waitHere = !fromPhoto && engineRef.current?.kind === 'library' && !(read.ean && read.boxSn);
      if (waitHere && now - first < COMPANION_WAIT_MS) return;
      const answer = onReadRef.current({ ...read, raw });
      snQuietRef.current.set(sn, now);
      snFirstSeenRef.current.delete(sn);
      win.clear();
      // Sound, buzz and flash on the frame the verdict lands — together.
      const deliver = (outcome: ScanFeedback | void) => {
        if (!aliveRef.current) return;
        scanFeedback(outcome || 'added');
        showFlash(outcome || 'added');
      };
      if (answer && typeof (answer as Promise<unknown>).then === 'function') {
        setInFlight((n) => n + 1);
        (answer as Promise<ScanFeedback | void>)
          .then(deliver, () => deliver('invalid'))
          .finally(() => {
            if (aliveRef.current) setInFlight((n) => Math.max(0, n - 1));
          });
      } else {
        deliver(answer as ScanFeedback | void);
      }
    },
    [finish, mode, showFlash, waitForCompanions]
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
                        : inFlight > 0
                          ? s.registering
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
        : flash === 'invalid' || flash === 'exists'
          ? 'border-danger'
          : 'border-gold';

  return (
    <div className="flex flex-col min-h-0" data-scanner-mode={mode} data-scanner-engine={engine ?? ''} data-scanner-camera={camera}>
      {embedded ? (
        // The window around it carries the visible title and its own close.
        <h2 id={titleId} className="sr-only">
          {title ?? s.title}
        </h2>
      ) : (
        <div className="flex items-center justify-between gap-3 ps-4 pe-2 pt-3 pb-2">
          <h2 id={titleId} className="text-text-primary font-bold text-base truncate">
            {title ?? s.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={s.close}
            className="lv-button lv-button-ghost w-11 px-0 rounded-full hover:bg-white/[0.06] hover:text-text-primary"
          >
            <X aria-hidden="true" className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* The camera picture: a dark subtree in both themes. */}
      <div
        data-theme="dark"
        className={`relative w-full bg-charcoal overflow-hidden select-none touch-manipulation ${
          embedded ? 'aspect-[4/3] max-h-[46vh] rounded-2xl' : 'aspect-[3/4] sm:aspect-[4/3] max-h-[58vh]'
        }`}
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
            <span className="w-12 h-12 rounded-full bg-surface border border-border-subtle flex items-center justify-center text-text-secondary">
              <CameraOff aria-hidden="true" className="w-6 h-6" />
            </span>
            <p className="text-text-primary text-sm leading-relaxed max-w-[34ch]">{status}</p>
            {camera === 'denied' && <p className="text-text-secondary text-[12px] leading-relaxed max-w-[36ch]">{s.deniedHelp}</p>}
            {(camera === 'denied' || camera === 'failed') && (
              <button
                type="button"
                onClick={retry}
                className="lv-button lv-button-secondary"
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
            className="absolute top-3 end-3 inline-flex items-center justify-center w-11 h-11 rounded-full bg-onyx/70 text-snow hover:bg-onyx/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold aria-pressed:bg-gold aria-pressed:text-accent-contrast"
          >
            {torch.on ? <FlashlightOff aria-hidden="true" className="w-5 h-5" /> : <Flashlight aria-hidden="true" className="w-5 h-5" />}
          </button>
        )}
        {live && (
          <p className="absolute bottom-3 inset-x-3 mx-auto w-fit max-w-[calc(100%-1.5rem)] rounded-full bg-onyx/75 px-3 py-1.5 text-center text-[12px] leading-snug text-snow pointer-events-none">
            {status}
          </p>
        )}
      </div>

      {verdict}
      <div className={embedded ? 'py-3 space-y-3' : 'px-4 py-3 space-y-3'}>
        <p role="status" aria-live="polite" className={live ? 'sr-only' : 'text-[13px] text-text-secondary min-h-[1.25rem]'}>
          {status}
        </p>
        {live && <p className="text-[11.5px] text-text-muted leading-relaxed">{s.tapToFocus}</p>}
        <div className="flex items-stretch gap-2 flex-wrap">
          <label
            htmlFor={photoId}
            className={`lv-button lv-button-secondary cursor-pointer focus-within:ring-2 focus-within:ring-focus ${
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
                className="lv-input flex-1 min-w-0 font-mono text-sm placeholder:font-sans"
                ref={manualInputRef}
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
              />
              <span id={`${manualId}-hint`} className="sr-only">
                {s.manualPlaceholder}
              </span>
              <button
                type="submit"
                disabled={!manual.trim()}
                className="lv-button lv-button-primary"
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
