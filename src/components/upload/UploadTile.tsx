/**
 * ONE FILE ON ITS WAY UP — the shared tile every large-file picker draws
 * (docs/COMMUNITY_ECOSYSTEM.md §9.4: the request wizard, the project
 * composer, the offer composer, the chat attachment picker, the product-files
 * editor). It owns the upload's lifecycle for one file:
 *
 *   a progress ring (inline SVG, `currentColor`, no CSS of its own), the
 *   bytes so far over the total, the CHECKSUM STEP NAMED — a phone reading a
 *   300 MB model for a few seconds must not look stuck — «إلغاء» while it
 *   runs, «إعادة المحاولة» when it fails, and a warning with the size when
 *   the phone is on mobile data and the file is above 25 MB.
 *
 * Unmounting mid-upload keeps the session for a resume (UPLOAD_KEEP_SESSION);
 * only «إلغاء» deletes it. One selection cue, 1px border, compact controls.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
// `m` + <MotionFeatures>, never the `motion` proxy: this tile is imported by
// the chat and the request wizard, and the proxy would put the animation
// features chunk (16 KB gzip) into both pages' closures for one ring.
import * as Motion from 'motion/react-m';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { MotionFeatures } from '../../lib/motionFeatures';
import { isAborted } from '../../lib/api';
import {
  UPLOAD_KEEP_SESSION,
  uploadLarge,
  type SessionPurpose,
  type UploadLargeResult,
  type UploadProgress,
} from '../../lib/uploadSession';
import { Button } from '../ui/Button';
import { CELLULAR_WARN_BYTES, UPLOAD_STRINGS, formatBytes, onCellular } from './strings';

export interface UploadTileProps {
  file: File;
  purpose: SessionPurpose;
  entityId?: string;
  onDone: (result: UploadLargeResult) => void;
  onCancel: () => void;
}

type TileState =
  | { status: 'working'; progress: UploadProgress }
  | { status: 'done'; result: UploadLargeResult }
  | { status: 'failed'; error: unknown }
  | { status: 'cancelled' };

const RING_RADIUS = 18;
const RING_STROKE = 3;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The hash is a tenth of the ring; the transfer is the rest; finishing fills it. */
function ringFraction(p: UploadProgress): number {
  const share = p.total > 0 ? Math.min(1, p.loaded / p.total) : 0;
  if (p.phase === 'hashing') return share * 0.1;
  if (p.phase === 'creating') return 0.1;
  if (p.phase === 'uploading') return 0.1 + 0.9 * share;
  return 1;
}

export function UploadTile({ file, purpose, entityId, onDone, onCancel }: UploadTileProps) {
  const { lang } = useLanguage();
  const t = UPLOAD_STRINGS[lang];
  const m = useMotion();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TileState>({ status: 'working', progress: { phase: 'hashing', loaded: 0, total: file.size } });
  const controllerRef = useRef<AbortController | null>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const cellular = useMemo(
    () => file.size > CELLULAR_WARN_BYTES && onCellular(typeof navigator !== 'undefined' ? navigator : undefined),
    [file]
  );

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    let active = true;
    setState({ status: 'working', progress: { phase: 'hashing', loaded: 0, total: file.size } });
    uploadLarge(file, purpose, {
      entityId,
      signal: controller.signal,
      onProgress: (progress) => {
        // A late report from a lane that finished after another lane's refusal
        // never turns a failed tile back into a working one.
        if (active) setState((prev) => (prev.status === 'working' ? { status: 'working', progress } : prev));
      },
    })
      .then((result) => {
        if (!active) return;
        setState({ status: 'done', result });
        onDoneRef.current(result);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(isAborted(error) ? { status: 'cancelled' } : { status: 'failed', error });
      });
    return () => {
      active = false;
      // Leaving the page is not cancelling: the session stays for a resume.
      if (!controller.signal.aborted) controller.abort(UPLOAD_KEEP_SESSION);
    };
  }, [file, purpose, entityId, attempt]);

  // The refusal sentences (src/lib/refusalStrings.ts, ~20 KB gzip) are loaded
  // on the first failure, not with the tile: most uploads never see one.
  const [failedText, setFailedText] = useState<string | null>(null);
  const failedError = state.status === 'failed' ? state.error : null;
  useEffect(() => {
    if (failedError === null) {
      setFailedText(null);
      return;
    }
    let live = true;
    import('../../lib/refusalStrings')
      .then(({ apiRefusal }) => live && setFailedText(apiRefusal(failedError, lang, t.failed)))
      .catch(() => live && setFailedText(t.failed));
    return () => {
      live = false;
    };
  }, [failedError, lang, t.failed]);

  const cancel = () => {
    controllerRef.current?.abort();
    setState({ status: 'cancelled' });
    onCancel();
  };
  const retry = () => setAttempt((n) => n + 1);

  const fraction = state.status === 'working' ? ringFraction(state.progress) : state.status === 'done' ? 1 : 0;
  const percent = Math.round(fraction * 100);
  const tone = state.status === 'failed' ? 'text-danger' : state.status === 'done' ? 'text-success' : 'text-gold';

  let status: string;
  if (state.status === 'working') {
    const p = state.progress;
    if (p.phase === 'hashing') status = `${t.hashing} ${p.total > 0 ? Math.round((p.loaded / p.total) * 100) : 0}%`;
    else if (p.phase === 'creating') status = `${t.uploading}…`;
    else if (p.phase === 'uploading') {
      status = `${formatBytes(p.loaded)} ${t.of} ${formatBytes(p.total)}`;
      if (p.part && p.parts && p.parts > 1) status += ` · ${t.part(p.part, p.parts)}`;
    } else status = t.finishing;
  } else if (state.status === 'done') status = `${t.done} · ${formatBytes(file.size)}`;
  else if (state.status === 'cancelled') status = t.cancelled;
  else status = failedText ?? t.failed;

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface p-3" role="group" aria-label={file.name}>
      <div
        className={`relative h-11 w-11 shrink-0 ${tone}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={status}
      >
        <svg viewBox="0 0 44 44" width="44" height="44" className="-rotate-90" aria-hidden="true">
          <circle cx="22" cy="22" r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={RING_STROKE} />
          <MotionFeatures>
            <Motion.circle
              cx="22"
              cy="22"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              initial={false}
              animate={{ strokeDashoffset: CIRCUMFERENCE * (1 - fraction) }}
              transition={m.spring('ui')}
            />
          </MotionFeatures>
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-xs tabular-nums text-text-primary" dir="ltr">
          {state.status === 'done' ? '✓' : state.status === 'failed' ? '!' : `${percent}`}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-primary" dir="auto" title={file.name}>
          {file.name}
        </div>
        <div className={`mt-1 text-xs tabular-nums ${state.status === 'failed' ? 'text-danger' : 'text-text-muted'}`} aria-live="polite">
          {status}
        </div>
        {cellular && state.status === 'working' && (
          <div className="mt-1 text-xs text-warning">{t.cellular(formatBytes(file.size))}</div>
        )}
      </div>

      {state.status === 'working' && (
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>
          {t.cancel}
        </Button>
      )}
      {state.status === 'failed' && (
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="secondary" size="sm" onClick={retry}>
            {t.retry}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={cancel}>
            {t.cancel}
          </Button>
        </div>
      )}
    </div>
  );
}

export default UploadTile;
