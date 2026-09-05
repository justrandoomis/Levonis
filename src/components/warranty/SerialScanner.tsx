import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CameraOff, ImagePlus, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import Spinner from '../ui/Spinner';
import { WARRANTY_STRINGS } from './strings';

/**
 * Camera scanner for a serial barcode or a warranty-receipt QR code.
 *
 * Decoding runs at ~10 fps off a requestAnimationFrame loop: the native
 * BarcodeDetector when the browser has one (Chrome/Android, recent Safari),
 * otherwise jsQR on a downscaled grayscale frame, loaded lazily so the page
 * never pays for it unless someone opens the scanner. The stream is stopped
 * on the first hit, on close and on unmount — a camera light that stays on
 * after the window has gone is the one thing this component must never do.
 *
 * The decoded text is handed over UNCHANGED. It may be a serial, a receipt
 * number, or the receipt's own QR link; the server accepts all three and
 * the caller must not try to be clever about which one it got.
 */

interface DetectedBarcodeLike {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcodeLike[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

const FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'data_matrix'];

function createDetector(): BarcodeDetectorLike | null {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
  try {
    return new Ctor({ formats: FORMATS });
  } catch {
    return null;
  }
}

type JsQR = typeof import('jsqr').default;
let jsqrPromise: Promise<JsQR> | null = null;
function loadJsQR(): Promise<JsQR> {
  if (!jsqrPromise) jsqrPromise = import('jsqr').then((m) => m.default);
  return jsqrPromise;
}

/** Draw a frame downscaled and grayscale, then let jsQR look for a QR code. */
function decodeWithJsQR(jsQR: JsQR, source: CanvasImageSource, w: number, h: number, canvas: HTMLCanvasElement): string | null {
  if (w <= 0 || h <= 0) return null;
  const scale = Math.min(1, 800 / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  const text = hit?.data?.trim();
  return text ? text : null;
}

async function decodePhoto(file: File): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = null;
  }
  const detector = createDetector();
  if (detector && bitmap) {
    try {
      const codes = await detector.detect(bitmap);
      const hit = codes.find((c) => c.rawValue && c.rawValue.trim());
      if (hit) {
        bitmap.close();
        return hit.rawValue.trim();
      }
    } catch {
      /* fall through to jsQR */
    }
  }
  const jsQR = await loadJsQR();
  const canvas = document.createElement('canvas');
  if (bitmap) {
    try {
      return decodeWithJsQR(jsQR, bitmap, bitmap.width, bitmap.height, canvas);
    } finally {
      bitmap.close();
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return decodeWithJsQR(jsQR, img, img.naturalWidth, img.naturalHeight, canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type CameraState = 'starting' | 'slow' | 'on' | 'denied' | 'unavailable' | 'failed' | 'stopped';
type PhotoState = 'idle' | 'decoding' | 'nothing';

const CORNERS = [
  'top-0 start-0 border-t-2 border-s-2 rounded-ss-lg',
  'top-0 end-0 border-t-2 border-e-2 rounded-se-lg',
  'bottom-0 start-0 border-b-2 border-s-2 rounded-es-lg',
  'bottom-0 end-0 border-b-2 border-e-2 rounded-ee-lg',
];

export default function SerialScanner({
  onDetected,
  onClose,
  titleId = 'warranty-scanner-title',
}: {
  onDetected: (text: string) => void;
  onClose: () => void;
  titleId?: string;
}) {
  const { lang } = useLanguage();
  const s = WARRANTY_STRINGS[lang];
  const m = useMotion();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null | undefined>(undefined);
  const rafRef = useRef(0);
  const lastTickRef = useRef(0);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  const [camera, setCamera] = useState<CameraState>('starting');
  const [photo, setPhoto] = useState<PhotoState>('idle');

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const finish = useCallback(
    (text: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      cancelAnimationFrame(rafRef.current);
      stopStream();
      setCamera('stopped');
      try {
        navigator.vibrate?.(40);
      } catch {
        /* not every browser vibrates */
      }
      onDetectedRef.current(text);
    },
    [stopStream]
  );

  const decodeFrame = useCallback(async (): Promise<string | null> => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || v.videoWidth === 0) return null;
    if (detectorRef.current === undefined) detectorRef.current = createDetector();
    if (detectorRef.current) {
      try {
        const codes = await detectorRef.current.detect(v);
        const hit = codes.find((c) => c.rawValue && c.rawValue.trim());
        return hit ? hit.rawValue.trim() : null;
      } catch {
        // The native detector exists but refuses this source: fall back for good.
        detectorRef.current = null;
      }
    }
    const jsQR = await loadJsQR();
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
    return decodeWithJsQR(jsQR, v, v.videoWidth, v.videoHeight, canvasRef.current);
  }, []);

  // ~10 fps: decoding every frame would only heat the phone.
  const loop = useCallback(() => {
    rafRef.current = requestAnimationFrame(async (t) => {
      if (doneRef.current) return;
      if (t - lastTickRef.current >= 100 && !busyRef.current) {
        lastTickRef.current = t;
        busyRef.current = true;
        try {
          const text = await decodeFrame();
          if (text) {
            finish(text);
            return;
          }
        } catch {
          /* keep scanning */
        } finally {
          busyRef.current = false;
        }
      }
      if (!doneRef.current) loop();
    });
  }, [decodeFrame, finish]);

  useEffect(() => {
    let cancelled = false;
    // Reset on every (re)mount: StrictMode runs mount → cleanup → mount, and
    // the cleanup below marks the loop done.
    doneRef.current = false;
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) setCamera((c) => (c === 'starting' ? 'slow' : c));
    }, 12000);

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera('unavailable');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        try {
          await v.play();
        } catch {
          /* autoplay policies: the frame still updates once metadata loads */
        }
        if (cancelled) return;
        setCamera('on');
        loop();
      } catch (err) {
        if (cancelled) return;
        const name = (err as { name?: string } | null)?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') setCamera('denied');
        else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') setCamera('unavailable');
        else setCamera('failed');
      }
    })();

    return () => {
      cancelled = true;
      doneRef.current = true;
      window.clearTimeout(slowTimer);
      cancelAnimationFrame(rafRef.current);
      stopStream();
    };
  }, [loop, stopStream]);

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || doneRef.current) return;
    setPhoto('decoding');
    busyRef.current = true;
    try {
      const text = await decodePhoto(file);
      if (text) {
        setPhoto('idle');
        finish(text);
        return;
      }
      setPhoto('nothing');
    } catch {
      setPhoto('nothing');
    } finally {
      busyRef.current = false;
    }
  };

  const cameraOff = camera === 'denied' || camera === 'unavailable' || camera === 'failed';
  const scanning = camera === 'on' && photo !== 'decoding';

  const status =
    photo === 'decoding'
      ? s.scanDecoding
      : photo === 'nothing'
        ? s.scanNothing
        : camera === 'starting'
          ? s.scanStarting
          : camera === 'slow'
            ? s.scanSlow
            : camera === 'denied'
              ? s.scanDenied
              : camera === 'unavailable'
                ? s.scanUnavailable
                : camera === 'failed'
                  ? s.scanFailed
                  : camera === 'stopped'
                    ? s.scanCaptured
                    : s.scanLooking;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
        <h2 id={titleId} className="text-white font-bold text-base">
          {s.scanTitle}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={s.close}
          className="p-2 -me-2 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
        >
          <X aria-hidden="true" className="w-5 h-5" />
        </button>
      </div>

      <div className="relative bg-black aspect-[4/3] overflow-hidden">
        {/* The camera preview is purely visual; the status line below narrates it. */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          aria-hidden="true"
          className={`absolute inset-0 w-full h-full object-cover ${cameraOff ? 'hidden' : ''}`}
        />
        {cameraOff && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="w-12 h-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500">
              <CameraOff aria-hidden="true" className="w-6 h-6" />
            </span>
            <p className="text-zinc-300 text-sm leading-relaxed">{status}</p>
          </div>
        )}
        {(camera === 'starting' || camera === 'slow') && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner size="md" delayMs={0} decorative />
          </div>
        )}
        {!cameraOff && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden="true">
            <div className={`relative w-[64%] max-w-[260px] aspect-square ${scanning && !m.reduced ? 'animate-pulse' : ''}`}>
              {CORNERS.map((c) => (
                <span key={c} className={`absolute w-6 h-6 border-[#BAA369] ${c}`} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-4 space-y-3">
        {!cameraOff && (
          <p role="status" aria-live="polite" className="text-[13px] text-zinc-300 min-h-[1.25rem]">
            {status}
          </p>
        )}
        {cameraOff && (
          <p role="status" aria-live="polite" className="sr-only">
            {status}
          </p>
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <label
            htmlFor="warranty-scanner-photo"
            className={`inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl border border-zinc-700/70 bg-zinc-800/70 hover:bg-zinc-800 text-zinc-100 text-[13px] font-bold cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-[#BAA369] ${
              photo === 'decoding' ? 'opacity-60 pointer-events-none' : ''
            }`}
          >
            <ImagePlus aria-hidden="true" className="w-4 h-4" />
            {s.choosePhoto}
            <input
              id="warranty-scanner-photo"
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              disabled={photo === 'decoding'}
              onChange={onPickPhoto}
            />
          </label>
          <p className="text-[11px] text-zinc-500 flex-1 min-w-[12rem] leading-relaxed">{s.scanHint}</p>
        </div>
      </div>
    </div>
  );
}
