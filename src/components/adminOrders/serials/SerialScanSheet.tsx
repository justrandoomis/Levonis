/**
 * THE CAMERA SHEET of «Scan Serial» (brief §2, §3, §22; spec §5.2).
 *
 * A bottom sheet over the order window — never a page of its own — around the
 * ONE camera scanner (src/components/scanner/BarcodeScanner, lazy): a guide
 * frame, the torch where the camera has one, tap-to-focus, a photo fallback
 * and a typed field. Detection is automatic, so there is no capture button.
 *
 * ONE READ, THEN QUIET. Single mode stops the camera on the first useful read
 * (and waits a moment for the same label's EAN and BOX SN), so a label held in
 * view is never linked twice. The read goes to the server, and the SERVER's
 * verdict is what sounds and buzzes (`deferFeedback`): the success chime and a
 * light tap for a link that was made, the error tone for a serial that is on
 * another order. A success closes the sheet after a beat; a refusal stays, in
 * the reader's language, with «امسح مجددًا» and — for the owner, where the
 * refusal has one — the exception with its mandatory reason.
 *
 * A Bluetooth reader on a tablet types into the scanner's own field: «استخدم
 * قارئًا أو لوحة مفاتيح» puts the cursor there, and the keystrokes are read the
 * same way the slot's field reads them (wedge.ts — burst, physical keys).
 */
import React, { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Check, Keyboard, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { ApiError } from '../../../lib/api';
import { refusalText } from '../../../lib/refusalStrings';
import { useLanguage } from '../../../LanguageContext';
import { useMotion } from '../../../lib/motion';
import { Sheet } from '../../ui/Sheet';
import Spinner from '../../ui/Spinner';
import { IconButton } from '../../ui/Button';
import { scanFeedback } from '../../scanner/feedback';
import type { ScanRead } from '../../scanner/BarcodeScanner';
import { serialStrings } from './strings';
import { newOpId, overrideFor, serialRefusal, serialsApi, shortDate, type ReadPayload } from './serialsApi';
import { formatNoteTexts, hasFormatNotes } from './formatNotes';
import { WedgeTracker, isTerminator } from './wedge';
import type { LinkResult, OverrideKind, ScanTarget } from './types';

const BarcodeScanner = React.lazy(() => import('../../scanner/BarcodeScanner'));

/**
 * How long the success state stays on screen before the sheet slides away —
 * unless the link carries a warning (a device cancelled after it left, stock
 * not taken again): that stays until «تم», since a sentence that vanishes in
 * 0.65 s was never read (UX review #7).
 */
const CLOSE_AFTER_SUCCESS_MS = 650;

type Phase = 'scan' | 'checking' | 'done' | 'refused';

export interface SerialScanSheetProps {
  orderId: string;
  target: ScanTarget | null;
  viewerOwner: boolean;
  /** Open straight on a refusal the slot's own field received (the owner finishes the exception here). */
  initialRefusal?: { read: ReadPayload; error: unknown } | null;
  onClose: () => void;
  onExited?: () => void;
  onLinked: (res: LinkResult, read: ReadPayload) => void;
}

/** After the commit that mounts the element a focus call needs. */
function afterFrame(fn: () => void) {
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(() => fn());
  else globalThis.setTimeout(fn, 0);
}

export default function SerialScanSheet({ orderId, target, viewerOwner, initialRefusal, onClose, onExited, onLinked }: SerialScanSheetProps) {
  const { lang, dir } = useLanguage();
  const s = serialStrings(lang);
  const m = useMotion();
  const titleId = useId();
  const reasonId = useId();

  const [phase, setPhase] = useState<Phase>('scan');
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<ReadPayload | null>(null);
  const [result, setResult] = useState<LinkResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const manualRef = useRef<HTMLInputElement | null>(null);
  // Where the keyboard goes when a control it was on disappears (UX review
  // #3): a Bluetooth reader on a tablet must never type into <body>.
  const scanAgainRef = useRef<HTMLButtonElement | null>(null);
  const overrideBtnRef = useRef<HTMLButtonElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const useReaderRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  /** After «امسح مجددًا»: back into the typed field when the last read was typed. */
  const refocusTyped = useRef(false);
  /** After «امسح مجددًا» on a camera read: «استخدم قارئًا» holds the focus while the camera starts. */
  const rescanCamera = useRef(false);
  const lang3 = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  const tracker = useRef(new WedgeTracker());
  const inFlight = useRef(false);

  // Every opening starts clean (or on the refusal the slot handed over).
  const openKey = target ? `${target.order_item_id}:${target.unit_index}:${target.replaceAssignmentId ?? ''}` : '';
  useEffect(() => {
    if (!openKey) return;
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    tracker.current.reset();
    setResult(null);
    // Opened from the slot's «استثناء المالك»: the exception form is what was
    // asked for — one tap, not two (UX review #8).
    setOverrideOpen(!!initialRefusal);
    setReason('');
    refocusTyped.current = false;
    rescanCamera.current = false;
    if (initialRefusal) {
      setRead(initialRefusal.read);
      setError(initialRefusal.error);
      setPhase('refused');
    } else {
      setRead(null);
      setError(null);
      setPhase('scan');
    }
    setAttempt((a) => a + 1);
    // `initialRefusal` is read once per opening on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    []
  );

  const succeed = useCallback(
    (res: LinkResult, payload: ReadPayload) => {
      setResult(res);
      setPhase('done');
      // The light tap and the chime ride the server's answer, never the read.
      scanFeedback('added');
      onLinked(res, payload);
      // A format note (owner decision 2: the brand's rule accepted it with a
      // warning) is a warning too, and stays until «تم».
      if (res.warnings.length === 0 && !hasFormatNotes(res)) closeTimer.current = window.setTimeout(onClose, CLOSE_AFTER_SUCCESS_MS);
    },
    [onClose, onLinked]
  );

  const submit = useCallback(
    async (payload: ReadPayload) => {
      if (!target || inFlight.current) return;
      inFlight.current = true;
      setRead(payload);
      setError(null);
      setOverrideOpen(false);
      setPhase('checking');
      const opId = newOpId();
      try {
        const res = target.replaceAssignmentId
          ? await serialsApi.change(orderId, target.replaceAssignmentId, payload, opId)
          : await serialsApi.scan(orderId, target, payload, opId);
        succeed(res, payload);
      } catch (e) {
        setError(e);
        setPhase('refused');
        scanFeedback(e instanceof ApiError && e.code === 'SERIAL_INVALID' ? 'invalid' : 'exists');
      } finally {
        inFlight.current = false;
      }
    },
    [orderId, succeed, target]
  );

  const onRead = useCallback(
    (r: ScanRead) => {
      // A lone box-shaped read goes as the code: the SERVER reads it by the
      // line's rule (owner decision 2) — under Bambu Lab's it is a box number
      // (its known device, else BOX_ONLY); under any other brand's it is the
      // serial itself, linked with a warning.
      const code = r.productSn ?? r.boxSn ?? r.receipt ?? '';
      if (!code) return;
      void submit({ code, ean: r.ean, box_sn: r.productSn ? r.boxSn : null, source: 'camera' });
    },
    [submit]
  );

  const onManual = useCallback(
    (value: string) => {
      const { text, source } = tracker.current.finish(value);
      if (text) void submit({ code: text, source });
    },
    [submit]
  );

  // The scanner's typed field, read like the slot's: burst + physical keys,
  // and a Tab from a reader that ends with Tab submits instead of moving on.
  // A CALLBACK REF, because the scanner is lazy: the field mounts after this
  // sheet's first render, and an effect keyed on the phase would miss it.
  const keyHandler = useRef<((e: KeyboardEvent) => void) | null>(null);
  const setManualField = useCallback((el: HTMLInputElement | null) => {
    if (manualRef.current && keyHandler.current) manualRef.current.removeEventListener('keydown', keyHandler.current);
    manualRef.current = el;
    keyHandler.current = null;
    if (!el) return;
    if (refocusTyped.current) {
      refocusTyped.current = false;
      el.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (isTerminator(e.key, tracker.current.inBurst)) {
        if (e.key === 'Tab') {
          e.preventDefault();
          el.form?.requestSubmit();
        }
        return;
      }
      tracker.current.push(e);
    };
    keyHandler.current = onKey;
    el.addEventListener('keydown', onKey);
  }, []);

  const scanAgain = () => {
    tracker.current.reset();
    setError(null);
    setOverrideOpen(false);
    // The button itself unmounts: a typed read goes back to the typed field
    // (once the lazy scanner mounts it), a camera read to «استخدم قارئًا».
    refocusTyped.current = !!read && read.source !== 'camera';
    rescanCamera.current = !refocusTyped.current;
    setPhase('scan');
    setAttempt((a) => a + 1);
  };

  // A refusal unmounts the scanner (and its focused field): «امسح مجددًا» takes
  // the focus, so Enter / Space re-arms and a screen reader lands on the verdict.
  useEffect(() => {
    if (phase === 'refused' && !overrideOpen) afterFrame(() => scanAgainRef.current?.focus({ preventScroll: true }));
    if (phase === 'done' && result && (result.warnings.length > 0 || hasFormatNotes(result))) afterFrame(() => doneRef.current?.focus({ preventScroll: true }));
    if (phase === 'scan' && rescanCamera.current) {
      rescanCamera.current = false;
      afterFrame(() => useReaderRef.current?.focus({ preventScroll: true }));
    }
  }, [phase, attempt, overrideOpen, result]);
  // The exception form opens on its reason; closing it returns to its button.
  const overrideWasOpen = useRef(false);
  useEffect(() => {
    if (overrideOpen) afterFrame(() => reasonRef.current?.focus({ preventScroll: true }));
    else if (overrideWasOpen.current && phase === 'refused') afterFrame(() => overrideBtnRef.current?.focus({ preventScroll: true }));
    overrideWasOpen.current = overrideOpen;
  }, [overrideOpen, phase]);

  const kind: OverrideKind | null = viewerOwner ? overrideFor(error) : null;
  const details = (error instanceof ApiError ? error.details : null) as Record<string, unknown> | null;

  const submitOverride = async () => {
    if (!target || !read || !kind || overrideBusy) return;
    if (reason.trim().length < 5) return;
    setOverrideBusy(true);
    try {
      const res = await serialsApi.override(
        orderId,
        { order_item_id: target.order_item_id, unit_index: target.unit_index, part: target.part, assignment_id: target.replaceAssignmentId },
        read,
        // A resold device always carries its original warranty (owner decision 3): no mode to choose.
        { kind, reason: reason.trim() },
        newOpId()
      );
      succeed(res, read);
    } catch (e) {
      setError(e);
      scanFeedback('exists');
    } finally {
      setOverrideBusy(false);
    }
  };

  const refusal = phase === 'refused' ? serialRefusal(error, lang) : null;
  const title = target
    ? target.replaceAssignmentId
      ? s.sheetChangeTitle(target.product_name, target.unit_index)
      : s.sheetTitle(target.product_name, target.unit_index)
    : '';

  const verdict = (
    <div className="pt-3" aria-live="assertive" data-serial-verdict={phase}>
      <AnimatePresence mode="popLayout" initial={false}>
        {phase === 'checking' && (
          <motion.div
            key="checking"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={m.spring('quick')}
            role="status"
            className="flex items-center gap-3 rounded-2xl border border-border-subtle bg-surface-raised p-3"
          >
            <Spinner size="sm" delayMs={0} decorative />
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-text-primary">{s.checking}</p>
              {read && (
                <p className="font-mono text-[13px] text-text-secondary break-all">
                  <span dir="ltr">{read.code}</span>
                </p>
              )}
            </div>
          </motion.div>
        )}
        {phase === 'done' && result && (
          <motion.div
            key="done"
            initial={{ opacity: 0, y: m.travel(6) }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={m.spring('quick')}
            role="status"
            className="lv-alert lv-alert-success flex items-start gap-3"
          >
            <motion.span
              initial={{ scale: m.reduced ? 1 : 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={m.spring('quick')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success text-surface"
            >
              <Check className="h-5 w-5" strokeWidth={3} aria-hidden />
            </motion.span>
            <div className="min-w-0 flex-1">
              {/* The circle beside is the ✓ of «✓ تم ربط الرقم التسلسلي»; an
                  existing device is two facts, so two ticked lines (§13). */}
              {result.outcome === 'existing' ? (
                <>
                  {/* §31's one sentence (critique-1 #32), then §13's two facts, quieter. */}
                  <p className="text-[14px] font-bold text-text-primary" data-serial-existing-sentence>
                    {refusalText('SERIAL_EXISTING_LINKED', lang3, s.existingLine1)}
                  </p>
                  <ul className="mt-0.5 space-y-0.5">
                    {[s.existingLine1, s.existingLine2].map((line) => (
                      <li key={line} className="flex items-center gap-1.5 text-[12.5px] text-text-secondary" data-serial-existing-line>
                        <Check className="h-3 w-3 shrink-0 text-success" strokeWidth={3} aria-hidden />
                        {line}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-[14px] font-bold text-text-primary">{result.outcome === 'already' ? s.already : s.linkedLine}</p>
              )}
              {result.slot.assignment && (
                <p className="mt-0.5 font-mono text-[13px] text-text-primary break-all">
                  <span dir="ltr">{result.slot.assignment.serial_display}</span>
                </p>
              )}
              {result.warnings.map((w) => (
                <p key={w} className="mt-1 text-[12px] text-warning">
                  {s.warnings[w] ?? w}
                </p>
              ))}
              {formatNoteTexts(result.format?.warnings, lang).map((line) => (
                <p key={line} className="mt-1 text-[12px] text-warning" data-serial-format-note>
                  {line}
                </p>
              ))}
              {(result.warnings.length > 0 || hasFormatNotes(result)) && (
                <button
                  ref={doneRef}
                  type="button"
                  onClick={onClose}
                  className="mt-2.5 inline-flex items-center min-h-[44px] px-5 rounded-full bg-text-primary text-surface text-[13.5px] font-bold transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                  data-serial-done
                >
                  {s.done}
                </button>
              )}
            </div>
          </motion.div>
        )}
        {phase === 'refused' && refusal && (
          <motion.div
            key={`refused-${attempt}`}
            initial={{ opacity: 0, y: m.travel(6) }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={m.spring('quick')}
            role="alert"
            className="lv-alert lv-alert-danger"
            data-serial-refusal={error instanceof ApiError ? error.code ?? '' : ''}
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger text-surface">
                {error instanceof ApiError && error.code === 'SERIAL_INVALID' ? (
                  <X className="h-5 w-5" strokeWidth={3} aria-hidden />
                ) : (
                  <AlertTriangle className="h-5 w-5" aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-bold text-text-primary">{refusal.text}</p>
                {refusal.detail && <p className="mt-0.5 text-[12.5px] text-text-secondary">{refusal.detail}</p>}
                {read && (
                  <p className="mt-0.5 font-mono text-[13px] text-text-secondary break-all">
                    <span dir="ltr">{read.code}</span>
                  </p>
                )}
                {/* §10: the other order is named to the owner only — the server sends it to nobody else. */}
                {typeof details?.order_id === 'string' && details.order_id && (
                  <p className="mt-1 text-[12.5px] text-text-secondary" data-serial-other-order>
                    {s.otherOrder(details.order_id)}
                  </p>
                )}
                {Array.isArray(details?.expected_lots) && (details.expected_lots as unknown[]).length > 0 && (
                  <div className="mt-1.5 text-[12.5px] text-text-secondary">
                    <p>{s.expectedLots}</p>
                    <ul className="mt-0.5 space-y-0.5">
                      {(details.expected_lots as Array<{ id: string; received_at: string | null; location: string | null }>).map((l) => (
                        <li key={l.id}>• {s.lotLine(shortDate(l.received_at, lang), l.location ?? '')}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                ref={scanAgainRef}
                type="button"
                onClick={scanAgain}
                className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-full bg-text-primary text-surface text-[13.5px] font-bold transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                data-serial-scan-again
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                {s.scanAgain}
              </button>
              {kind && !overrideOpen && (
                <button
                  ref={overrideBtnRef}
                  type="button"
                  onClick={() => setOverrideOpen(true)}
                  className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-full border border-border-subtle bg-surface text-text-primary text-[13.5px] font-semibold transition-colors hover:bg-surface-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                  data-serial-owner-override={kind}
                >
                  <ShieldAlert className="h-4 w-4" aria-hidden />
                  {s.ownerOverride}
                </button>
              )}
            </div>
            {kind && overrideOpen && (
              <form
                className="mt-3 space-y-2.5 border-t border-border-subtle pt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitOverride();
                }}
                data-serial-override-form={kind}
              >
                <p className="text-[13.5px] font-bold text-text-primary">{s.overrideTitle[kind]}</p>
                <div>
                  <label htmlFor={reasonId} className="block text-[12.5px] font-semibold text-text-secondary mb-1">
                    {s.reasonLabel}
                  </label>
                  <textarea
                    className="lv-input resize-none py-2 text-[14px] leading-relaxed"
                    ref={reasonRef}
                    id={reasonId}
                    rows={2}
                    minLength={5}
                    maxLength={500}
                    required
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    aria-describedby={`${reasonId}-hint`}
                  />
                  <p id={`${reasonId}-hint`} className="mt-0.5 text-[11.5px] text-text-secondary">
                    {s.reasonHint}
                  </p>
                </div>
                {(kind === 'delivered_device' || kind === 'unavailable') && (
                  <p className="text-[12px] leading-relaxed text-text-secondary" data-serial-override-carry>
                    <span className="font-semibold text-text-primary">{s.warrantyMode}: </span>
                    {s.carryOnly}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    disabled={reason.trim().length < 5 || overrideBusy}
                    className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-full bg-gold text-accent-contrast text-[13.5px] font-bold transition-opacity disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                    data-serial-override-submit
                  >
                    {overrideBusy ? <Spinner size="sm" delayMs={0} decorative /> : <ShieldAlert className="h-4 w-4" aria-hidden />}
                    {s.confirmOverride}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOverrideOpen(false)}
                    className="min-h-[44px] px-4 rounded-full text-text-secondary text-[13.5px] font-semibold hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
                  >
                    {s.cancel}
                  </button>
                </div>
              </form>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  // The header is the sheet's drag handle (v2 Sheet): pulled down, the sheet
  // goes; the camera and the typed field below scroll and tap as usual.
  const header = (
    <div className="border-b border-border-subtle" dir={dir}>
      <div className="flex items-center justify-between gap-3 ps-4 pe-2 py-2">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[16px] font-bold text-text-primary truncate">
            {title}
          </h2>
          {target?.variant_label && (
            <p className="text-[12px] text-text-secondary truncate">
              <bdi>{target.variant_label}</bdi>
            </p>
          )}
        </div>
        <IconButton onClick={() => onClose()} label={s.close} icon={<X className="h-5 w-5" aria-hidden />} data-serial-sheet-close />
      </div>
    </div>
  );

  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      onExited={onExited}
      detents={['large']}
      header={header}
      labelledBy={titleId}
      z={220}
      restoreFocus={false}
      testId="serial-prep-scan"
      panelClassName="sm:max-w-xl sm:h-[min(85dvh,44rem)]"
    >
      <div className="px-4 pt-3 pb-4" dir={dir} data-serial-scan-sheet>
        {phase === 'scan' || phase === 'checking' ? (
          <Suspense fallback={<div className="py-16 text-center text-[13px] text-text-secondary">{s.loading}</div>}>
            <BarcodeScanner
              key={attempt}
              mode="single"
              frame="label"
              qr
              embedded
              deferFeedback
              waitForCompanions
              title={title}
              onRead={onRead}
              onManual={onManual}
              onClose={onClose}
              manualInputRef={setManualField}
              verdict={verdict}
            >
              {phase === 'scan' && (
                <button
                  ref={useReaderRef}
                  type="button"
                  onClick={() => manualRef.current?.focus()}
                  className="inline-flex items-center gap-1.5 min-h-[44px] text-[13px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold rounded-lg"
                  data-serial-use-reader
                >
                  <Keyboard className="h-4 w-4" aria-hidden />
                  {s.useScanner}
                </button>
              )}
            </BarcodeScanner>
          </Suspense>
        ) : (
          verdict
        )}
      </div>
    </Sheet>
  );
}
