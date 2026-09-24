/**
 * TOASTS — «تم الحفظ», «تعذّر الحفظ», «حُذف المنتج · تراجع».
 *
 * The only toast in the app was the PWA's UpdateReadyToast, positioned by the
 * customer shell's `--nav-stack`; the merchant tabs reported a save with
 * `alert()`, or with nothing. This is the shared one.
 *
 * HOW TO USE. Mount `<Toaster />` ONCE in a shell (it holds the live regions,
 * which must exist before the first message for a screen reader to hear it);
 * then anywhere, in any lazy chunk:
 *
 *   const toast = useToast();
 *   toast.success(loc('تم الحفظ', 'Saved', 'پاشەکەوت کرا'));
 *   toast.error(message, { action: { label: retryLabel, onClick: retry } });
 *   toast.success(deletedLabel, { action: { label: undoLabel, onClick: undo } });
 *
 * WHAT IT GUARANTEES.
 *
 *   HEARD, NOT JUST SEEN. Every message is also written into a persistent live
 *   region — polite for success and info, assertive (`role="alert"`) for an
 *   error — so it is announced without stealing focus.
 *
 *   NEVER COLOUR ALONE. Each tone has its own icon AND its words; the tint is
 *   the third cue, not the only one.
 *
 *   TIME TO READ, AND TIME TO UNDO. Success and info leave after 4s, errors
 *   after 8s, anything with an action after at least 6s. Pointing at the
 *   stack, or moving focus into it, pauses every timer (WCAG 2.2.1), and so
 *   does a hidden tab — a message is not spent while nobody can see it.
 *
 *   STACKED ABOVE THE SHELL'S BOTTOM BAR. It sits over
 *   `--shell-bottom-inset` plus the safe area, never under a phone tab bar or
 *   the home indicator; at most three show at once and the rest wait their
 *   turn rather than being dropped. It paints at `UI_LAYERS.toast`, above any
 *   open window, so a toast raised from inside a sheet is not hidden by it.
 *
 *   ONE OPERATION, ONE TOAST. Passing the same `id` replaces the toast
 *   instead of stacking a second «جارٍ الحفظ…» on the first.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { UI_LAYERS } from './Overlay';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  description?: string;
  /** One verb: «تراجع», «إعادة المحاولة», «عرض». Pressing it also dismisses the toast. */
  action?: ToastAction;
  /** Milliseconds on screen; `Infinity` keeps it until dismissed. */
  duration?: number;
  /** Replace the toast with this id instead of adding one. */
  id?: string;
}

export interface ToastRecord {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  duration: number;
}

const VISIBLE = 3;
const DEFAULT_MS: Record<ToastTone, number> = { success: 4000, info: 4000, error: 8000 };
const ACTION_MIN_MS = 6000;

let toasts: ToastRecord[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function show(tone: ToastTone, title: string, options: ToastOptions = {}): string {
  const id = options.id ?? `t${++seq}`;
  const base = options.duration ?? DEFAULT_MS[tone];
  const record: ToastRecord = {
    id,
    tone,
    title,
    description: options.description,
    action: options.action,
    duration: options.action ? Math.max(base, ACTION_MIN_MS) : base,
  };
  const at = toasts.findIndex((t) => t.id === id);
  toasts = at >= 0 ? toasts.map((t, i) => (i === at ? record : t)) : [...toasts, record];
  emit();
  return id;
}

function dismiss(id?: string): void {
  toasts = id === undefined ? [] : toasts.filter((t) => t.id !== id);
  emit();
}

/** The toast API. Stable: safe in dependency arrays and outside components. */
export const toast = Object.freeze({
  show,
  success: (title: string, options?: ToastOptions) => show('success', title, options),
  error: (title: string, options?: ToastOptions) => show('error', title, options),
  info: (title: string, options?: ToastOptions) => show('info', title, options),
  dismiss,
});

export function useToast(): typeof toast {
  return toast;
}

/** The queue as it stands, oldest first (the Toaster shows the first three). */
export function toastQueue(): readonly ToastRecord[] {
  return toasts;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const snapshot = () => toasts;

const TONE_ICON: Record<ToastTone, React.ReactNode> = {
  success: <CheckCircle2 aria-hidden="true" className="h-[18px] w-[18px] text-success" />,
  error: <AlertCircle aria-hidden="true" className="h-[18px] w-[18px] text-danger" />,
  info: <Info aria-hidden="true" className="h-[18px] w-[18px] text-info" />,
};

function ToastItem({ record, paused, closeLabel }: { record: ToastRecord; paused: boolean; closeLabel: string }) {
  const m = useMotion();
  const remaining = useRef(record.duration);
  const startedAt = useRef(0);

  // A replaced toast (same id, new text) gets its full time again.
  useEffect(() => {
    remaining.current = record.duration;
  }, [record]);

  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => dismiss(record.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [paused, record]);

  return (
    <motion.div
      layout={!m.reduced}
      initial={{ opacity: 0, y: m.travel(16), scale: m.reduced ? 1 : 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: m.travel(8), scale: m.reduced ? 1 : 0.98 }}
      transition={m.spring('ui')}
      data-toast={record.tone}
      // One cue for the tone — its icon, beside its words. A coloured edge as
      // well was a second cue, and on a 20px corner it curved into a crescent.
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-border-subtle bg-surface-raised py-2 ps-3 pe-1 shadow-3"
    >
      <span className="mt-3 shrink-0">{TONE_ICON[record.tone]}</span>
      <div className="min-w-0 flex-1 py-2">
        <p className="text-sm font-semibold leading-snug text-text-primary">{record.title}</p>
        {record.description && <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">{record.description}</p>}
      </div>
      {record.action && (
        <button
          type="button"
          onClick={() => {
            record.action?.onClick();
            dismiss(record.id);
          }}
          className="lv-button lv-button-ghost lv-button-sm shrink-0 text-accent"
        >
          {record.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismiss(record.id)}
        aria-label={closeLabel}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </motion.div>
  );
}

/** What the live regions say: the newest message of each urgency. */
function useAnnouncements(list: ToastRecord[]): { polite: string; assertive: string } {
  const [said, setSaid] = useState({ polite: '', assertive: '' });
  const seen = useRef(new Set<string>());
  const flip = useRef(false);
  useEffect(() => {
    for (const t of list) {
      const key = `${t.id}|${t.title}|${t.description ?? ''}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      // A zero-width mark alternates so an identical second message is still
      // a CHANGE the reader announces.
      flip.current = !flip.current;
      const text = `${t.title}${t.description ? `. ${t.description}` : ''}${flip.current ? '\u200B' : ''}`;
      setSaid((prev) => (t.tone === 'error' ? { ...prev, assertive: text } : { ...prev, polite: text }));
    }
  }, [list]);
  return said;
}

/** Mount once per shell. Renders nothing visible until there is something to say. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { loc } = useLanguage();
  const [hovered, setHovered] = useState(false);
  const [focusedIn, setFocusedIn] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const said = useAnnouncements(list);

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  if (typeof document === 'undefined') return null;
  const visible = list.slice(0, VISIBLE);
  const paused = hovered || focusedIn || hidden;
  const closeLabel = loc('إغلاق', 'Dismiss', 'داخستن');

  return createPortal(
    <>
      <section
        aria-label={loc('الإشعارات', 'Notifications', 'ئاگادارکردنەوەکان')}
        data-toaster
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocusedIn(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedIn(false);
        }}
        className="pointer-events-none fixed inset-x-0 flex flex-col items-center gap-2 px-4 sm:items-end"
        style={{
          zIndex: UI_LAYERS.toast,
          insetBlockEnd: 'calc(var(--shell-bottom-inset, 0px) + max(0.75rem, env(safe-area-inset-bottom)))',
        }}
      >
        <AnimatePresence initial={false}>
          {visible.map((t) => (
            <ToastItem key={t.id} record={t} paused={paused} closeLabel={closeLabel} />
          ))}
        </AnimatePresence>
      </section>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {said.polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {said.assertive}
      </div>
    </>,
    document.body
  );
}
