/**
 * Shared UI primitives for the v2 admin product editor.
 * Arabic-first labels with a small English secondary line, dark admin theme,
 * iPad-friendly touch targets. Money inputs keep the null-vs-zero contract:
 * an EMPTY input is null (inherit), an explicit 0 stays 0.
 */

import React, { useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Info, Trash2, X, AlertTriangle } from 'lucide-react';
import { failureText, uploadFile } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import type { TransStatus } from './types';

export const ACCENT = '#6B46FF';

// A FIELD IS A WELL (clay, docs/DECISIONS.md row 207): the `lv-input` of the
// app (well, 3:1 field line, the focus ring that keeps the well) at the 40px
// admin floor and 13px text.
const inputSize = 'w-full min-h-10 px-2.5 py-2 text-[13px]';
export const inputCls = `lv-input ${inputSize}`;

// Admin density: the owner reviewed the 44px scale on an iPad and asked for
// smaller buttons and smaller text across the panel. Inputs keep the 40px
// floor (the §12 suite asserts every input/select >= 40px); buttons drop to
// 36px, which is still a comfortable tap target. They are the clay buttons
// of the app (`lv-button`: resting clay, a dent while pressed, the focus
// ring, disabled and busy states) at that admin height; the primary keeps
// the violet admin fill on the rim and base of a primary.
export const btnPrimary =
  'lv-button lv-button-primary min-h-9 gap-1.5 px-3 py-1.5 text-[13px] bg-[#6B46FF] hover:bg-iris-deep text-snow';
export const btnSecondary =
  'lv-button lv-button-secondary min-h-9 gap-1.5 px-3 py-1.5 text-[13px]';
export const btnGhostDanger =
  'p-2 text-text-muted hover:text-danger hover:bg-danger/10 active:bg-[var(--clay-well-bg)] active:shadow-press rounded-md transition-colors';

/** Arabic-first field label with a small English secondary. */
/**
 * ONE FIELD LABEL FOR THE WHOLE ADMIN — and it now speaks the same language as
 * the product form's `Field`, because the owner's rule for these screens is
 * that they follow that form.
 *
 * Two things changed and both were making the panels read as noise:
 *
 *  - it painted `zinc-300`/`zinc-500` literals while everything around it uses
 *    the `.ap` tokens, so labels sat at a slightly different temperature from
 *    the controls they name;
 *  - `hint` is permanent text under every label, and these panels carry
 *    sentences — "عدّاد مستقل تمامًا عن مخزون البيع المباشر…" — that are true,
 *    necessary once, and then read as a wall for ever after. `tip` puts that
 *    explanation behind an info glyph exactly the way the product form does,
 *    and keeps it reachable to a screen reader. `hint` stays for the short
 *    line that genuinely belongs under the control.
 */
export function L({ ar, en, hint, tip }: { ar: string; en: string; hint?: string; tip?: string }) {
  return (
    <div className="mb-1.5">
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-[12px] font-bold text-[var(--ap-text-1)] truncate">
          {ar} <span className="text-[10px] font-medium text-[var(--ap-text-3)] mx-1">{en}</span>
        </span>
        {tip && (
          <span className="group relative shrink-0">
            <Info className="w-3.5 h-3.5 text-[var(--ap-text-3)]" aria-hidden="true" />
            <span className="sr-only">{tip}</span>
            <span
              role="tooltip"
              className="pointer-events-none absolute z-30 start-0 top-5 hidden group-hover:block group-focus-within:block
                         w-56 max-w-[70vw] rounded-[var(--ap-radius-md)] bg-[var(--ap-surface-4)] border border-[var(--ap-border-strong)]
                         p-2 text-[11px] leading-snug text-[var(--ap-text-2)] shadow-[var(--ap-shadow-1)]"
            >
              {tip}
            </span>
          </span>
        )}
      </span>
      {hint && <span className="block text-[10px] text-[var(--ap-text-3)] mt-0.5">{hint}</span>}
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
    // One clay card per section; its header row is flat (a divider, no fill of its own).
    <div className="lv-surface overflow-hidden mb-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`w-full px-2.5 sm:px-3 py-2 flex items-center justify-between gap-3 text-start min-h-10 hover:bg-white/[0.04] transition-colors ${open ? 'border-b border-border-subtle' : ''}`}
      >
        <span className="font-bold text-text-primary text-[13px] min-w-0">
          {ar} <span className="text-[10px] font-medium text-text-muted mx-1">{en}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {badge}
          {open ? <ChevronUp className="w-5 h-5 text-text-muted" /> : <ChevronDown className="w-5 h-5 text-text-muted" />}
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
/**
 * The same control for a SIGNED difference. `NullableIqd` clamps at zero,
 * which is right for a price and wrong for "this order type is 50,000 dearer
 * — or cheaper": an adjustment is the one money field that may be negative,
 * and silently refusing the minus sign would make a discount unenterable.
 */
export function SignedIqd({
  value,
  onChange,
  placeholder = 'بلا فرق / no difference',
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      className={`lv-input ${inputSize} disabled:opacity-50`}
      type="number"
      inputMode="numeric"
      step={1}
      disabled={disabled}
      value={value === null || value === undefined ? '' : value}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '' || raw === '-') { onChange(null); return; }
        const n = Math.trunc(Number(raw));
        if (Number.isFinite(n)) onChange(n);
      }}
      dir="ltr"
    />
  );
}

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
      className={`lv-input ${inputSize} disabled:opacity-50`}
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
      className={`lv-input ${inputSize}`}
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => {
        const n = Math.floor(Number(e.target.value));
        onChange(Number.isFinite(n) && n >= 0 ? n : 0);
      }}
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

// Status is information: a flat, opaque chip (`lv-chip`, AA on any ground) — the StatusChip tones.
const TRANS_STATUS_STYLE: Record<TransStatus, string> = {
  approved: 'lv-chip [--chip:var(--color-success)]',
  imported: 'lv-chip [--chip:var(--color-info)]',
  stale: 'lv-chip [--chip:var(--color-warning)]',
  missing: 'bg-white/[0.06] text-text-secondary',
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
    <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${TRANS_STATUS_STYLE[status]}`}>
      {TRANS_STATUS_AR[status]} · {status}
    </span>
  );
}

/** Product status chip (list + editor). */
export function StatusChip({ status }: { status: string }) {
  const map: Record<string, { ar: string; cls: string }> = {
    active: { ar: 'نشط', cls: 'lv-chip [--chip:var(--color-success)]' },
    hidden: { ar: 'مخفي', cls: 'lv-chip [--chip:var(--color-warning)]' },
    draft: { ar: 'مسودة', cls: 'bg-white/[0.06] text-text-secondary' },
  };
  const m = map[status] ?? map.draft;
  return (
    <span className={`inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${m.cls}`}>
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
        className="p-2.5 text-text-secondary hover:text-text-primary disabled:opacity-30 hover:bg-white/[0.06] active:bg-[var(--clay-well-bg)] active:shadow-press rounded-md transition-colors" title="Move up / تحريك لأعلى">
        <ChevronUp className="w-5 h-5" />
      </button>
      <button type="button" disabled={downDisabled} onClick={onDown}
        className="p-2.5 text-text-secondary hover:text-text-primary disabled:opacity-30 hover:bg-white/[0.06] active:bg-[var(--clay-well-bg)] active:shadow-press rounded-md transition-colors" title="Move down / تحريك لأسفل">
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
          ? 'lv-chip [--chip:var(--color-success)] border-transparent'
          : 'bg-surface-raised text-text-muted border-border-subtle'
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
  titleAr, titleEn, onClose, children, wide, footer, dirty = false, onEscape, workspace = false,
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
  /** A larger, calmer editor surface for dense tools such as Quick Price. */
  workspace?: boolean;
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
      className="ap fixed inset-x-0 z-[1000] flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4"
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
        className={`${workspace ? 'ap-quick-workspace sm:max-w-[1180px]' : wide ? 'sm:max-w-5xl' : 'sm:max-w-2xl'}
          bg-[var(--ap-surface-1)] border border-[var(--ap-border-strong)] rounded-t-3xl sm:rounded-2xl
          w-full min-w-0 overflow-hidden flex flex-col shadow-2xl outline-none`}
      >
        <div className="px-4 sm:px-5 py-3.5 border-b border-[var(--ap-hairline)] flex items-center justify-between gap-3 shrink-0 bg-[var(--ap-surface-1)]">
          <h3 id={titleId} className="min-w-0">
            <span className="block text-[15px] sm:text-[17px] leading-tight font-semibold tracking-[-0.01em] text-[var(--ap-text-1)] truncate">{titleAr}</span>
            <span className="block mt-1 text-[11px] sm:text-[12px] leading-tight font-medium text-[var(--ap-text-3)] truncate" dir="ltr">{titleEn}</span>
          </h3>
          <button
            type="button"
            onClick={requestClose}
            aria-label={t.close}
            className="min-h-11 min-w-11 grid place-items-center text-[var(--ap-text-2)] hover:text-[var(--ap-text-1)] rounded-full hover:bg-[var(--ap-surface-3)] active:bg-[var(--ap-surface-4)] shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ap-ring)]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className={`ap-quick-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain ${workspace ? 'p-3 sm:p-5' : 'p-3 sm:p-4'}`}>{children}</div>

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
            // Flat, on the material of the dialog: a slab carries one shadow, so its footer is a divider.
            className="shrink-0 border-t border-[var(--ap-hairline)] bg-[var(--ap-surface-1)] px-3 sm:px-4 py-3"
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
    <div className="lv-alert lv-alert-danger text-danger mb-4 text-sm font-medium">
      {text}
    </div>
  );
}

/** Upload one product image; resolves to its delivery URL + key. */
export async function uploadProductImage(file: File): Promise<{ key: string; url: string }> {
  try {
    return await uploadFile(file, 'product');
  } catch (err) {
    // Decode/encode/size failures are plain Errors and carry the only wording
    // that tells the admin what to change — see `failureText`.
    throw new Error(failureText(err, 'فشل الرفع / upload failed'));
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
