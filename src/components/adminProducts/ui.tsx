/**
 * Shared UI primitives for the v2 admin product editor.
 * Arabic-first labels with a small English secondary line, dark admin theme,
 * iPad-friendly touch targets. Money inputs keep the null-vs-zero contract:
 * an EMPTY input is null (inherit), an explicit 0 stays 0.
 */

import React, { useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Trash2, X, AlertTriangle } from 'lucide-react';
import { ApiError, uploadFile } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import type { TransStatus } from './types';

export const ACCENT = '#6B46FF';

export const inputCls =
  'w-full min-h-10 bg-zinc-800/30 border border-zinc-700 rounded-lg px-2.5 py-2 text-[13px] text-white focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-all';

// Admin density: the owner reviewed the 44px scale on an iPad and asked for
// smaller buttons and smaller text across the panel. Inputs keep the 40px
// floor (the §12 suite asserts every input/select >= 40px); buttons drop to
// 36px, which is still a comfortable tap target.
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 min-h-9 bg-[#6B46FF] hover:bg-[#5a3ae0] text-white text-[13px] px-3 py-1.5 rounded-lg font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 min-h-9 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[13px] px-3 py-1.5 rounded-lg font-bold transition-colors border border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed';
export const btnGhostDanger =
  'p-2 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors';

/** Arabic-first field label with a small English secondary. */
export function L({ ar, en, hint }: { ar: string; en: string; hint?: string }) {
  return (
    <div className="mb-1.5">
      <span className="block text-[12px] font-bold text-zinc-300">
        {ar} <span className="text-[10px] font-medium text-zinc-500 mx-1">{en}</span>
      </span>
      {hint && <span className="block text-[10px] text-zinc-500 mt-0.5">{hint}</span>}
    </div>
  );
}

/** Collapsible editor section card (grouped sections, mobile-friendly). */
export function Section({
  ar,
  en,
  badge,
  defaultOpen = false,
  children,
}: {
  ar: string;
  en: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-2xl overflow-hidden mb-3 shadow-lg">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2.5 sm:px-3 py-2 bg-zinc-800/20 border-b border-zinc-800/50 flex items-center justify-between gap-3 text-start min-h-10"
      >
        <span className="font-bold text-white text-[13px] min-w-0">
          {ar} <span className="text-[10px] font-medium text-zinc-500 mx-1">{en}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {badge}
          {open ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
        </span>
      </button>
      {open && <div className="p-3 sm:p-4">{children}</div>}
    </div>
  );
}

/**
 * Nullable IQD integer input. EMPTY = null (placeholder shows the inherit
 * hint), explicit 0 allowed and preserved. Never uses truthiness on value.
 */
export function NullableIqd({
  value,
  onChange,
  placeholder = 'موروث / inherit',
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      disabled={disabled}
      value={value === null || value === undefined ? '' : value}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') { onChange(null); return; }
        const n = Math.floor(Number(raw));
        if (Number.isFinite(n) && n >= 0) onChange(n);
      }}
      className={inputCls + ' disabled:opacity-50'}
      dir="ltr"
    />
  );
}

/** Required IQD integer input (base price): empty is treated as 0 explicitly shown. */
export function RequiredIqd({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        const n = Math.floor(Number(e.target.value));
        onChange(Number.isFinite(n) && n >= 0 ? n : 0);
      }}
      className={inputCls}
      dir="ltr"
    />
  );
}

/** ar / en / ckb text inputs for one logical field. */
export function TriText({
  ar, en, ckb,
  onAr, onEn, onCkb,
  textarea = false,
  labelAr, labelEn,
  chips,
}: {
  ar: string; en: string; ckb: string;
  onAr: (v: string) => void; onEn: (v: string) => void; onCkb: (v: string) => void;
  textarea?: boolean;
  labelAr: string; labelEn: string;
  chips?: { en?: ReactNode; ckb?: ReactNode };
}) {
  const C = textarea ? 'textarea' : 'input';
  const cls = inputCls + (textarea ? ' h-28' : '');
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <div>
        <L ar={`${labelAr} (عربي — المصدر)`} en={`${labelEn} (Arabic source)`} />
        <C value={ar} dir="rtl" onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onAr(e.target.value)} className={cls} />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <L ar={`${labelAr} (إنجليزي)`} en={`${labelEn} (English)`} />
          {chips?.en}
        </div>
        <C value={en} dir="ltr" onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onEn(e.target.value)} className={cls} />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <L ar={`${labelAr} (کوردی سۆرانی)`} en={`${labelEn} (Kurdish ckb)`} />
          {chips?.ckb}
        </div>
        <C value={ckb} dir="rtl" onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onCkb(e.target.value)} className={cls} />
      </div>
    </div>
  );
}

const TRANS_STATUS_STYLE: Record<TransStatus, string> = {
  approved: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  imported: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  stale: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  missing: 'bg-zinc-700/30 text-zinc-500 border-zinc-600/40',
};
const TRANS_STATUS_AR: Record<TransStatus, string> = {
  approved: 'معتمدة',
  imported: 'مستوردة',
  stale: 'قديمة',
  missing: 'مفقودة',
};

/** Translation status chip (from translation_meta). */
export function TransChip({ status }: { status: TransStatus }) {
  return (
    <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded border ${TRANS_STATUS_STYLE[status]}`}>
      {TRANS_STATUS_AR[status]} · {status}
    </span>
  );
}

/** Product status chip (list + editor). */
export function StatusChip({ status }: { status: string }) {
  const map: Record<string, { ar: string; cls: string }> = {
    active: { ar: 'نشط', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    hidden: { ar: 'مخفي', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
    draft: { ar: 'مسودة', cls: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40' },
  };
  const m = map[status] ?? map.draft;
  return (
    <span className={`inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${m.cls}`}>
      {m.ar} · {status}
    </span>
  );
}

/** Up / down / delete controls for repeatable rows (44px touch targets). */
export function RowControls({
  onUp, onDown, onRemove, upDisabled, downDisabled,
}: {
  onUp: () => void; onDown: () => void; onRemove: () => void;
  upDisabled: boolean; downDisabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button type="button" disabled={upDisabled} onClick={onUp}
        className="p-2.5 text-zinc-400 hover:text-white disabled:opacity-30 hover:bg-zinc-800 rounded-lg transition-colors" title="Move up / تحريك لأعلى">
        <ChevronUp className="w-5 h-5" />
      </button>
      <button type="button" disabled={downDisabled} onClick={onDown}
        className="p-2.5 text-zinc-400 hover:text-white disabled:opacity-30 hover:bg-zinc-800 rounded-lg transition-colors" title="Move down / تحريك لأسفل">
        <ChevronDown className="w-5 h-5" />
      </button>
      <button type="button" onClick={onRemove} className={btnGhostDanger} title="Remove / حذف">
        <Trash2 className="w-5 h-5" />
      </button>
    </div>
  );
}

/** Active/inactive toggle pill. */
export function ActiveToggle({ value, onChange, arOn = 'مفعّل', arOff = 'معطّل' }: {
  value: boolean; onChange: (v: boolean) => void; arOn?: string; arOff?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
        value
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
          : 'bg-zinc-800 text-zinc-500 border-zinc-700'
      }`}
    >
      {value ? `${arOn} · on` : `${arOff} · off`}
    </button>
  );
}

// ---------------------------------------------------------------- modal

/**
 * Open-dialog stack. Dialogs nest (the import dialog hosts the template
 * preview dialog), and both would otherwise answer the same Escape keypress
 * — closing the parent too. Only the TOP dialog reacts to Escape and traps
 * Tab; the ones underneath stay inert until they are on top again.
 */
const modalStack: symbol[] = [];

const FOCUSABLE =
  'a[href],area[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),' +
  'button:not([disabled]),iframe,object,embed,[tabindex]:not([tabindex="-1"]),[contenteditable]';

/**
 * Live geometry of the VISUAL viewport.
 *
 * `visualViewport` is what shrinks and shifts when the iPad/iPhone software
 * keyboard opens — `100dvh` does neither. Pinning the overlay to
 * `{ top: offsetTop, height }` instead of `inset-0` is what keeps the
 * preview/confirm footer on screen while a field is focused, and what stops
 * the dialog from sliding under the keyboard (mandate §6.2). Falls back to
 * the layout viewport where `visualViewport` is unavailable.
 */
function useVisualViewport(): { height: number; offsetTop: number } {
  const read = () => {
    if (typeof window === 'undefined') return { height: 800, offsetTop: 0 };
    const vv = window.visualViewport;
    return vv ? { height: vv.height, offsetTop: vv.offsetTop } : { height: window.innerHeight, offsetTop: 0 };
  };
  const [box, setBox] = useState(read);
  useEffect(() => {
    const onChange = () => setBox(read());
    const vv = window.visualViewport;
    vv?.addEventListener('resize', onChange);
    vv?.addEventListener('scroll', onChange);
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    onChange();
    return () => {
      vv?.removeEventListener('resize', onChange);
      vv?.removeEventListener('scroll', onChange);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
    };
  }, []);
  return box;
}

const MODAL_STRINGS = {
  ar: {
    close: 'إغلاق',
    dialog: 'نافذة',
    unsavedTitle: 'لديك تغييرات غير محفوظة',
    unsavedBody: 'إغلاق النافذة الآن يفقد ما كتبته أو لصقته. هل تريد المتابعة؟',
    discard: 'تجاهل وإغلاق',
    keep: 'متابعة التحرير',
  },
  en: {
    close: 'Close',
    dialog: 'Dialog',
    unsavedTitle: 'Unsaved changes',
    unsavedBody: 'Closing now discards what you typed or pasted. Continue?',
    discard: 'Discard & close',
    keep: 'Keep editing',
  },
  ckb: {
    close: 'داخستن',
    dialog: 'پەنجەرە',
    unsavedTitle: 'گۆڕانکاری پاشەکەوتنەکراو',
    unsavedBody: 'داخستن ئێستا ئەوەی نووسیوتە دەفەوتێنێت. بەردەوام بم؟',
    discard: 'پشتگوێخستن و داخستن',
    keep: 'بەردەوامبوون لە دەستکاری',
  },
} as const;

/**
 * Admin dialog shell (mandate §6.2).
 *
 * ROOT CAUSE this fixes: the dashboard used to render dialogs inside its
 * scrolling content column, which carries `position:relative; z-index:0`.
 * A z-index other than `auto` opens a STACKING CONTEXT, so a `fixed z-50`
 * child was painted *inside* that context and therefore under the sidebar
 * (z-20) and the topbar (z-10). Bumping z-index in the dialog could never
 * fix that. The dialog is now rendered through a portal into `document.body`,
 * outside every clipping/transform/stacking ancestor, and DashboardLayout no
 * longer opens a stacking context around page content.
 *
 * Also: focus is trapped and returned to the opener, Escape closes, the panel
 * height is bound to the VISUAL viewport (keyboard-aware), the body scroll is
 * locked, the footer is sticky and safe-area padded, and `dirty` turns a
 * backdrop click / Escape into an explicit discard confirmation instead of
 * silently throwing template text away.
 */
export function Modal({
  titleAr, titleEn, onClose, children, wide, footer, dirty = false, onEscape,
}: {
  titleAr: string;
  titleEn: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Sticky action bar; stays visible while the body scrolls. */
  footer?: ReactNode;
  /** Unsaved work — dismissing asks before discarding. */
  dirty?: boolean;
  /**
   * FIRST REFUSAL ON ESCAPE, for content that has its own meaning for the key.
   *
   * The dialog listens in the CAPTURE phase on `document` and stops the event
   * there, so nothing inside can hear Escape on its own — that is deliberate,
   * because it is what stops a nested dialog from closing two at once. But an
   * editor inside a dialog can have a smaller thing to cancel than the dialog
   * itself: Quick Edit throws away the cells the admin typed and stays open.
   *
   * Return true to say "I handled it"; the dialog then leaves itself open.
   * Return false (or omit the prop) and Escape closes as it always has.
   */
  onEscape?: () => boolean;
}) {
  const { lang, dir } = useLanguage();
  const t = MODAL_STRINGS[lang] ?? MODAL_STRINGS.ar;
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const viewport = useVisualViewport();
  const titleId = useRef(`dlg-${Math.random().toString(36).slice(2, 9)}`).current;
  const stackId = useRef(Symbol('modal')).current;
  const isTop = useCallback(() => modalStack[modalStack.length - 1] === stackId, [stackId]);

  useEffect(() => {
    modalStack.push(stackId);
    return () => {
      const i = modalStack.indexOf(stackId);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [stackId]);

  const requestClose = useCallback(() => {
    if (dirty) { setConfirmingClose(true); return; }
    onClose();
  }, [dirty, onClose]);

  // Remember the opener and restore focus to it on unmount (§6.2).
  useEffect(() => {
    openerRef.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current as HTMLElement | null;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  // Body scroll lock: the page behind must not scroll under the dialog.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Escape + Tab trap.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return; // a dialog opened on top of this one owns the key
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (onEscape?.()) return;
        requestClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === firstEl || active === panel)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [requestClose, isTop, onEscape]);

  const body = (
    <div
      dir={dir}
      // z-[1000] is meaningful here ONLY because the portal target is
      // document.body — no ancestor stacking context can trap it.
      // Bound to the VISUAL viewport, not inset-0, so the on-screen keyboard
      // shrinks the dialog instead of hiding its footer.
      className="fixed inset-x-0 z-[1000] flex items-end sm:items-center justify-center bg-black/80 p-0 sm:p-4"
      style={{ top: viewport.offsetTop, height: viewport.height }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // Height follows the VISUAL viewport so the sticky footer survives the
        // on-screen keyboard; min-w-0 keeps wide tables from pushing the panel.
        style={{ maxHeight: Math.max(240, viewport.height - 24) }}
        className={`bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full min-w-0 ${
          wide ? 'sm:max-w-5xl' : 'sm:max-w-2xl'
        } overflow-hidden flex flex-col shadow-2xl outline-none`}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between gap-3 shrink-0 bg-zinc-900">
          <h3 id={titleId} className="text-white font-bold text-sm sm:text-base min-w-0 truncate">
            {titleAr} <span className="text-xs font-medium text-zinc-500 mx-1">{titleEn}</span>
          </h3>
          <button
            type="button"
            onClick={requestClose}
            aria-label={t.close}
            className="p-2 min-h-11 min-w-11 flex items-center justify-center text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 sm:p-4">{children}</div>

        {confirmingClose && (
          <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <div className="flex items-start gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200 min-w-0">
                <span className="font-bold block">{t.unsavedTitle}</span>
                {t.unsavedBody}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnSecondary} onClick={() => setConfirmingClose(false)}>
                {t.keep}
              </button>
              <button type="button" className={btnPrimary} onClick={onClose}>
                {t.discard}
              </button>
            </div>
          </div>
        )}

        {footer && (
          <div
            className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 backdrop-blur px-3 sm:px-4 py-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}

/** Inline error banner. */
export function ErrorBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-2xl p-4 mb-4 text-sm font-medium">
      {text}
    </div>
  );
}

/** Upload one product image; resolves to its delivery URL + key. */
export async function uploadProductImage(file: File): Promise<{ key: string; url: string }> {
  try {
    return await uploadFile(file, 'product');
  } catch (err) {
    throw new Error(err instanceof ApiError ? err.message : 'فشل الرفع / upload failed');
  }
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}
