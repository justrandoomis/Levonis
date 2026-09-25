/**
 * OVERLAYS — one primitive for every window in the app.
 *
 * WHAT WAS WRONG. Twenty-four files opened an overlay, and almost all of them
 * did it the same way: render `fixed inset-0 bg-black/80 backdrop-blur-sm` when
 * a boolean flips, and unmount it when the boolean flips back. That means the
 * window has no enter animation and — worse — no exit at all: it vanishes. A
 * thing that appears from nowhere and disappears to nowhere gives a person
 * nothing to build a mental model out of, which is the whole point of Apple's
 * spatial-consistency rule: "if something disappears one way, we expect it to
 * emerge from where it came."
 *
 * WHAT THIS DOES INSTEAD.
 *
 *   SYMMETRY. Enter and exit run the same path in reverse. There is exactly one
 *   place that decides the path, so the two can never drift apart.
 *
 *   MATERIALIZE, DON'T FADE. Glass arrives as glass: the blur radius and the
 *   scale animate together, so the surface reads as a real material coming into
 *   place rather than a rectangle whose opacity went up.
 *
 *   ANCHORED ORIGIN. A menu or a popover scales from the control that opened
 *   it, not from its own centre, so the relationship between the button and
 *   what it produced is visible. Pass `anchor` for that.
 *
 *   DIM AND PUSH BACK vs OFFSET WITHOUT A SCRIM. A modal task takes over: it
 *   dims and pushes the page back. A parallel, non-blocking panel must NOT
 *   break the flow, so it gets translucency and an offset and no scrim. That is
 *   the `mode` prop — it is a real behavioural difference, not a style.
 *
 *   INTERRUPTIBLE. Springs, not transitions or keyframes. A window caught
 *   halfway open and dismissed again continues from where it actually is,
 *   because a spring animates from its presentation value by definition.
 *
 *   DRAGGABLE TO DISMISS. A sheet that can only be closed with an X is a
 *   dialog wearing a sheet's clothes. `Sheet` tracks the finger 1:1, resists
 *   progressively when dragged the wrong way (rubber-banding), and on release
 *   decides by PROJECTED momentum rather than by where the finger stopped — a
 *   flick closes it even from near the top, and a slow drag most of the way
 *   down still springs back if it was slowing to a stop.
 *
 *   REDUCED MOTION. Every travel collapses to a short opacity cross-fade. The
 *   window still announces itself; it just does not fly.
 *
 * WHAT A MODAL NOW ALSO OWNS (wave 3 — the merchant workspace needs every one
 * of these on every screen, and a private copy per caller is how the admin
 * product editor ended up with the only correct dialog in the repo):
 *
 *   ONE KEYBOARD OWNER. Open layers register on a stack (`overlayStack.ts`);
 *   Escape goes to the TOP one only, so a confirmation opened over a sheet
 *   backs out one step, not two.
 *
 *   FOCUS STAYS IN, AND COMES BACK. A modal keeps Tab inside itself, and on
 *   close hands focus back to the control that had it (or to `anchor`) — a
 *   keyboard user lands where they were, not at the top of the page.
 *
 *   THE KEYBOARD DOES NOT COVER IT. While the on-screen keyboard shrinks the
 *   visual viewport, the layer is pinned to what is actually visible, so a
 *   sheet's input and its buttons stay on screen.
 *
 *   UNSAVED WORK IS ASKED ABOUT. `dirty` turns Escape, the scrim and a
 *   drag-dismiss into a question («متابعة التحرير» / «تجاهل وإغلاق») instead of
 *   silently throwing typed text away.
 *
 *   CONTENT CAN BE BUILT ONLY WHILE OPEN. `children` may be a function; it is
 *   called only while the window is open. `AdminKyc.tsx` records the
 *   black-screen crash that JSX children caused by being evaluated while the
 *   window was closed and its data was not there.
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, type PanInfo } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import { project, useMotion } from '../../lib/motion';
import { layerAbove, pushLayer, recentlyPressed } from './overlayStack';

/** One documented stacking contract for the app chrome and every floating UI. */
export const UI_LAYERS = Object.freeze({
  header: 100,
  bottomNav: 120,
  popover: 160,
  overlay: 200,
  /** Above every window a caller can open (legacy z values lift to 200–260),
   *  and below AppBusy's blocking layer at overlay + 100. `--z-toast` in CSS. */
  toast: 280,
});

/**
 * Old callers passed local z-values such as 50/60. Those values made sense
 * inside their page but sat below the global bottom navigation. Preserve their
 * relative ordering while lifting every real overlay above app chrome.
 */
export function overlayLayer(z: number): number {
  return z < UI_LAYERS.overlay ? UI_LAYERS.overlay + Math.max(0, z) : z;
}

/**
 * Every sentence here already existed, written by hand in all three languages,
 * in the admin product editor's dialog (`adminProducts/ui.tsx`, MODAL_STRINGS)
 * — copied verbatim. No Sorani was written for this file.
 */
const STRINGS = {
  ar: {
    close: 'إغلاق',
    unsavedTitle: 'لديك تغييرات غير محفوظة',
    unsavedBody: 'إغلاق النافذة الآن يفقد ما كتبته أو لصقته. هل تريد المتابعة؟',
    discard: 'تجاهل وإغلاق',
    keep: 'متابعة التحرير',
  },
  en: {
    close: 'Close',
    unsavedTitle: 'Unsaved changes',
    unsavedBody: 'Closing now discards what you typed or pasted. Continue?',
    discard: 'Discard & close',
    keep: 'Keep editing',
  },
  ckb: {
    close: 'داخستن',
    unsavedTitle: 'گۆڕانکاری پاشەکەوتنەکراو',
    unsavedBody: 'داخستن ئێستا ئەوەی نووسیوتە دەفەوتێنێت. بەردەوام بم؟',
    discard: 'پشتگوێخستن و داخستن',
    keep: 'بەردەوامبوون لە دەستکاری',
  },
} as const;

let modalLockCount = 0;
let modalLockState:
  | {
      bodyOverflow: string;
      main: HTMLElement | null;
      mainOverflow: string;
      owners: Array<[HTMLElement, string]>;
      alreadyMarked: boolean;
    }
  | undefined;

/** The app scrolls in #main-scroll-container, not body. Lock both, once, and
 * keep the lock alive when one modal opens over another.
 *
 * EXPORTED because the blocking busy layer (`src/components/ui/AppBusy.tsx`)
 * is a second thing that takes the screen, and it must share THIS counter
 * rather than keep its own. Two independent locks would each restore the
 * overflow they captured: a busy overlay released while a sheet is still open
 * would hand the page back its scroll with the sheet still sitting on it, and
 * would clear `html[data-overlay-open]` — the flag `src/index.css` uses to
 * move the bottom navigation and the character out of a modal's way. One
 * counter, one restore, whoever is last out.
 *
 * A shell whose scroller is NOT #main-scroll-container (the merchant
 * workspace, a store's own subdomain) marks it `data-scroll-owner`, and it is
 * locked and restored exactly the same way. Unmarked, nothing changes. */
export function acquireModalLock(): () => void {
  if (modalLockCount === 0) {
    const main = document.getElementById('main-scroll-container');
    const owners = Array.from(document.querySelectorAll<HTMLElement>('[data-scroll-owner]'))
      .filter((el) => el !== main)
      .map((el): [HTMLElement, string] => [el, el.style.overflow]);
    modalLockState = {
      bodyOverflow: document.body.style.overflow,
      main,
      mainOverflow: main?.style.overflow ?? '',
      owners,
      alreadyMarked: document.documentElement.dataset.overlayOpen === 'true',
    };
    document.body.style.overflow = 'hidden';
    if (main) main.style.overflow = 'hidden';
    for (const [el] of owners) el.style.overflow = 'hidden';
    document.documentElement.dataset.overlayOpen = 'true';
  }
  modalLockCount += 1;

  return () => {
    modalLockCount = Math.max(0, modalLockCount - 1);
    if (modalLockCount !== 0 || !modalLockState) return;
    document.body.style.overflow = modalLockState.bodyOverflow;
    if (modalLockState.main) modalLockState.main.style.overflow = modalLockState.mainOverflow;
    for (const [el, overflow] of modalLockState.owners) el.style.overflow = overflow;
    if (!modalLockState.alreadyMarked) delete document.documentElement.dataset.overlayOpen;
    modalLockState = undefined;
  };
}

// ------------------------------------------------------------------ scrim

/**
 * The dimming layer. It is a button, not a div with an onClick: a person using
 * a keyboard or a screen reader has to be able to leave the same way everyone
 * else can, and "tap outside to close" is invisible to both otherwise. It is
 * named for what it does — «إغلاق» in the reader's own language — not after
 * the window it closes.
 */
function Scrim({ onClose, label, visible }: { onClose?: () => void; label: string; visible: boolean }) {
  const m = useMotion();
  return (
    <motion.button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onClick={onClose}
      data-overlay-scrim
      className="no-press lv-scrim absolute inset-0 backdrop-blur-[3px] cursor-default"
      initial={{ opacity: 0 }}
      animate={{ opacity: visible ? 1 : 0 }}
      exit={{ opacity: 0 }}
      transition={m.spring('quick')}
    />
  );
}

/**
 * THE QUESTION A DIRTY WINDOW ASKS instead of closing. Inline, at the foot of
 * the window, never a second window over the first: a nested dialog would
 * need its own trap and its own Escape, and would hide the work it is asking
 * about. Focus moves to «keep editing» — the answer that loses nothing.
 */
function DiscardGuard({
  strings,
  onKeep,
  onDiscard,
}: {
  strings: (typeof STRINGS)['ar' | 'en' | 'ckb'];
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const id = useId();
  const keepRef = useRef<HTMLButtonElement | null>(null);
  // Scrolled to, not just focused: in a window whose whole panel scrolls, the
  // question is at the foot of the content and must be seen to be answered.
  useEffect(() => {
    keepRef.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-d`}
      data-overlay-guard
      className="lv-alert lv-alert-warning m-3 shrink-0"
    >
      <p id={`${id}-t`} className="text-sm font-bold text-text-primary">
        {strings.unsavedTitle}
      </p>
      <p id={`${id}-d`} className="mt-1 text-[13px] leading-relaxed text-text-secondary">
        {strings.unsavedBody}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button ref={keepRef} type="button" onClick={onKeep} className="lv-button lv-button-secondary lv-button-sm">
          {strings.keep}
        </button>
        <button type="button" onClick={onDiscard} className="lv-button lv-button-danger lv-button-sm">
          {strings.discard}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Overlay

export type OverlayMode =
  /** A task that takes over: dim the page, push it back. */
  | 'modal'
  /** A parallel panel: translucent and offset, no scrim, flow unbroken. */
  | 'parallel';

/** What a function child receives. */
export interface OverlayApi {
  /** Close the way Escape and the scrim do — through the unsaved-work question when `dirty`. */
  close: () => void;
}

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  /**
   * The window's content. A FUNCTION is called only while the window is open,
   * so content that reads data which exists only while open cannot crash the
   * page by being built while it is closed (the AdminKyc incident).
   */
  children: React.ReactNode | ((api: OverlayApi) => React.ReactNode);
  /** Accessible name for the window itself. */
  label?: string;
  /** id of the element naming it, when the title is already on screen. */
  labelledBy?: string;
  /** id of the element explaining it — a confirmation's consequence. */
  describedBy?: string;
  /** A question that must be answered (`role="alertdialog"`), e.g. a confirmation. */
  alert?: boolean;
  mode?: OverlayMode;
  /**
   * The element the window came from. When given, the window scales FROM it,
   * so the spatial link between the control and its result is visible. Pass the
   * trigger's ref.
   */
  anchor?: React.RefObject<HTMLElement | null>;
  /** Extra classes for the panel. Geometry only — the material is provided. */
  panelClassName?: string;
  /** Where the panel sits in the viewport. */
  placement?: 'center' | 'bottom' | 'top';
  /** Escape closes by default; pass false for a window that must be answered. */
  dismissOnEscape?: boolean;
  /** Tapping the scrim closes by default; same exception. */
  dismissOnScrim?: boolean;
  /** Unsaved work inside: Escape, the scrim and a drag-dismiss ask before discarding it. */
  dirty?: boolean;
  /** What takes focus on opening. Default: the panel, so the whole window is announced. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** Keep Tab inside the window. Default: true for a modal, false for a parallel panel. */
  trapFocus?: boolean;
  /** On close, give focus back to the control that had it on opening (else `anchor`). Default true. */
  restoreFocus?: boolean;
  className?: string;
  /** Stacking. Defaults high enough to sit over the app chrome. */
  z?: number;
  /** For probes and for the caller's own tests. */
  testId?: string;
  /**
   * Motion props merged onto the PANEL. `Sheet` uses this to make the panel
   * itself draggable — the drag has to move the window, not its contents, so
   * it cannot live on an inner wrapper. A `ref` in here is MERGED with the
   * panel's own ref (which takes initial focus), never substituted for it, and
   * a `style` in here is merged with the panel's own.
   */
  panelMotion?: Record<string, unknown> & { ref?: (el: HTMLDivElement | null) => void };
  /**
   * Opt OUT of the glass material, for a surface whose content needs its own
   * ground: a QR code has to stay dark-on-light to scan at all, and a photo
   * viewer wants nothing tinted behind it. The window still arrives and leaves
   * the same way every other window does; it is just not translucent. The
   * caller supplies the background in `panelClassName`.
   */
  solid?: boolean;
}

const PLACEMENT: Record<NonNullable<OverlayProps['placement']>, string> = {
  center: 'items-center justify-center p-4',
  bottom: 'items-end justify-center p-0 sm:items-center sm:p-4',
  top: 'items-start justify-center p-4',
};

/** transform-origin that points at the trigger, in the panel's own box. */
function originFrom(anchor: React.RefObject<HTMLElement | null> | undefined): string | undefined {
  const el = anchor?.current;
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  const x = Math.round(((r.left + r.width / 2) / Math.max(1, window.innerWidth)) * 100);
  const y = Math.round(((r.top + r.height / 2) / Math.max(1, window.innerHeight)) * 100);
  return `${x}% ${y}%`;
}

export function Overlay({
  open,
  onClose,
  children,
  label,
  labelledBy,
  describedBy,
  alert = false,
  mode = 'modal',
  anchor,
  panelClassName = '',
  placement = 'center',
  dismissOnEscape = true,
  dismissOnScrim = true,
  dirty = false,
  initialFocus,
  trapFocus,
  restoreFocus = true,
  className = '',
  z = 200,
  testId,
  panelMotion,
  solid = false,
}: OverlayProps) {
  const m = useMotion();
  const { dir, lang } = useLanguage();
  const strings = STRINGS[lang] ?? STRINGS.ar;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const originRef = useRef<string | undefined>(undefined);
  const zRef = useRef<number | undefined>(undefined);
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const askedFrom = useRef<HTMLElement | null>(null);
  // The caller's motion props may carry their own ref (Sheet measures the
  // panel through one). Spreading it after `ref=` would REPLACE the panel ref
  // and initial focus would silently never happen on phones, so the two are
  // merged into one callback and the spread carries everything but `ref`.
  const { ref: callerRef, ...panelMotionRest } = panelMotion ?? {};
  const setPanel = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      callerRef?.(el);
    },
    [callerRef]
  );

  // The origin is read ONCE, when the window opens: the trigger may scroll or
  // unmount while the window is up, and re-reading it then would make the exit
  // fly to somewhere the button no longer is.
  if (open && originRef.current === undefined) originRef.current = originFrom(anchor);
  if (!open) originRef.current = undefined;
  // THE LAYER IS CHOSEN ONCE TOO: above every layer already open, so a window
  // opened from inside a sheet at z=220 is never painted under that sheet.
  if (open && zRef.current === undefined) zRef.current = layerAbove(overlayLayer(z));
  if (!open) zRef.current = undefined;
  // WHO HAD FOCUS is read here, in render, for the same reason: by the time
  // any effect runs, a child's `autoFocus` has already moved focus INTO the
  // panel, and "the opener" would be a field of the window itself.
  // A TAP does not focus the button it lands on (iOS Safari), so when nothing
  // is focused the control that was just pressed is the opener.
  if (open && openerRef.current === undefined) {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : recentlyPressed();
  }
  if (!open) openerRef.current = undefined;
  // A question left open when the caller closed the window must not greet the
  // next opening.
  if (!open && asking) setAsking(false);

  const requestClose = useCallback(() => {
    if (dirty) {
      const active = document.activeElement;
      askedFrom.current = active instanceof HTMLElement ? active : null;
      setAsking(true);
    } else {
      onClose();
    }
  }, [dirty, onClose]);

  const keepEditing = useCallback(() => {
    setAsking(false);
    const back = askedFrom.current;
    askedFrom.current = null;
    (back && back.isConnected ? back : panelRef.current)?.focus({ preventScroll: true });
  }, []);

  // Escape is decided at key time from the LATEST props, so the stack entry
  // is not torn down and re-made every time a parent re-renders.
  const escapeRef = useRef<() => void>(() => {});
  const restoreRef = useRef(restoreFocus);
  // The trigger as it is at CLOSE time: a list that re-rendered while the
  // window was up may have replaced the element the window opened from.
  const anchorNow = useRef<() => HTMLElement | null>(() => null);
  useLayoutEffect(() => {
    escapeRef.current = () => {
      if (asking) keepEditing();
      else if (dismissOnEscape) requestClose();
    };
    restoreRef.current = restoreFocus;
    anchorNow.current = () => anchor?.current ?? null;
  });

  const traps = trapFocus ?? mode === 'modal';
  useLayoutEffect(() => {
    if (!open) return;
    return pushLayer({
      z: zRef.current ?? overlayLayer(z),
      trap: traps ? () => panelRef.current : null,
      onEscape: () => escapeRef.current(),
    });
    // The layer's z is fixed at opening (zRef), so `z` changing later is ignored on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, traps]);

  // The page behind a MODAL must not scroll under it; a parallel panel leaves
  // the flow alone, which is the whole reason it is a different mode.
  useEffect(() => {
    if (!open || mode !== 'modal') return;
    return acquireModalLock();
  }, [open, mode]);

  // WHO HAD FOCUS, captured before the panel takes it; given back on close —
  // but only if focus is still ours to give (inside this window, or nowhere).
  // Somebody who already moved into the window that replaced this one keeps
  // their place.
  //
  // AFTER THE COMMIT, not during it: React re-focuses whatever was focused
  // before a commit if it is still in the document — and the closing panel
  // still is, while it animates out — so a focus() made inside the commit
  // is silently undone (measured: focus went to the opener, then straight
  // back to the dialog's Cancel button, then to <body> when the panel left).
  useLayoutEffect(() => {
    if (!open) return;
    const opener = openerRef.current ?? null;
    return () => {
      if (!restoreRef.current) return;
      const panel = panelRef.current;
      queueMicrotask(() => {
        const now = document.activeElement;
        if (now && now !== document.body && !(panel && panel.contains(now))) return;
        const target = opener && opener.isConnected ? opener : anchorNow.current();
        if (target && target.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
    if (open && initialFocus?.current) initialFocus.current.focus({ preventScroll: true });
  }, [open, initialFocus]);

  // THE ON-SCREEN KEYBOARD. `inset-0` is the LAYOUT viewport, which the iOS
  // and Android keyboards do not shrink — a bottom sheet's field and buttons
  // end up underneath it. While the visual viewport is shorter than the layout
  // one (and the page is not pinch-zoomed), the layer is pinned to what is
  // visible and the panel may not be taller than that. Written to the DOM
  // directly, per frame, instead of through state: a keyboard animating in
  // fires dozens of resize events and none of them should re-render the window.
  useEffect(() => {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
    if (!open || !vv) return;
    let frame = 0;
    let savedMax: string | null = null;
    const apply = () => {
      frame = 0;
      const layer = layerRef.current;
      if (!layer) return;
      // 60px: a keyboard is hundreds of pixels; a sub-pixel rounding or the
      // browser chrome settling is not one.
      const keyboard = Math.abs(vv.scale - 1) < 0.01 && window.innerHeight - vv.height > 60;
      layer.style.top = keyboard ? `${vv.offsetTop}px` : '';
      layer.style.height = keyboard ? `${vv.height}px` : '';
      layer.style.bottom = keyboard ? 'auto' : '';
      const panel = panelRef.current;
      if (!panel) return;
      if (keyboard && savedMax === null) {
        savedMax = panel.style.maxHeight;
        panel.style.maxHeight = '100%';
      } else if (!keyboard && savedMax !== null) {
        panel.style.maxHeight = savedMax;
        savedMax = null;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
    };
  }, [open]);

  const travel = placement === 'bottom' ? m.travel(28) : m.travel(14);
  const scaleFrom = m.reduced ? 1 : anchor ? 0.9 : 0.96;
  const blurFrom = m.reduced ? 0 : 8;
  const callerStyle = panelMotionRest.style as React.CSSProperties | undefined;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          ref={layerRef}
          className={`fixed inset-0 flex ${PLACEMENT[placement]} ${className}`}
          style={{ zIndex: zRef.current ?? overlayLayer(z) }}
          data-overlay={testId ?? true}
          data-overlay-mode={mode}
        >
          {mode === 'modal' && (
            <Scrim visible={open} label={strings.close} onClose={dismissOnScrim ? requestClose : undefined} />
          )}
          <motion.div
            ref={setPanel}
            dir={dir}
            role="dialog"
            {...(alert ? { role: 'alertdialog' } : null)}
            aria-modal={mode === 'modal'}
            aria-label={labelledBy ? undefined : label}
            aria-labelledby={labelledBy}
            aria-describedby={describedBy}
            tabIndex={-1}
            data-overlay-panel
            // ENTER AND EXIT ARE THE SAME OBJECT, so they cannot disagree. The
            // blur travels with the scale: the surface materializes.
            initial={{ opacity: 0, scale: scaleFrom, y: travel, filter: `blur(${blurFrom}px)` }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: scaleFrom, y: travel, filter: `blur(${blurFrom}px)` }}
            transition={m.spring(placement === 'bottom' ? 'sheet' : 'ui')}
            {...panelMotionRest}
            style={{ transformOrigin: originRef.current, outline: 'none', ...callerStyle }}
            className={`relative min-w-0 ${solid ? 'shadow-2xl' : 'bg-surface-raised border border-border-subtle shadow-2xl'} ${
              placement === 'bottom' ? 'rounded-t-xl sm:rounded-xl' : 'rounded-xl'
            } ${panelClassName}`}
          >
            {typeof children === 'function' ? children({ close: requestClose }) : children}
            {asking && (
              <DiscardGuard
                strings={strings}
                onKeep={keepEditing}
                onDiscard={() => {
                  setAsking(false);
                  onClose();
                }}
              />
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}

// ------------------------------------------------------------------ Sheet

export interface SheetProps extends Omit<OverlayProps, 'placement' | 'anchor'> {
  /** Rough panel height in px, used for the rubber-band scale and the
   *  dismissal threshold. Measured when omitted. */
  height?: number;
}

/**
 * A bottom sheet that can be thrown away.
 *
 * The release decision uses PROJECTED momentum, not the release position: a
 * fast flick from near the top closes, and a slow drag that has almost reached
 * the bottom but is decelerating springs back. Deciding on position alone is
 * what makes a sheet feel like it is arguing with you.
 *
 * The WHOLE PANEL is the drag surface here, which is right for a short sheet
 * and wrong for one whose body scrolls. `src/components/ui/Sheet.tsx` is the
 * v2 sheet — drag from the handle only, detents, header/footer — and it is a
 * separate module on purpose: this file is in every visitor's first load
 * (the header's menus use `Anchored`), and the v2 gesture code is not.
 */
export function Sheet({ open, onClose, children, height, panelClassName = '', ...rest }: SheetProps) {
  const m = useMotion();
  const measured = useRef(0);
  // Stable, so the merged panel ref in Overlay is not re-attached every render.
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) measured.current = el.offsetHeight;
  }, []);

  const onDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      const h = height || measured.current || 320;
      // WHERE IT IS GOING, not where the finger stopped. A fast flick from
      // near the top closes; a slow drag that has almost reached the bottom
      // but is decelerating springs back. Deciding on position alone is what
      // makes a sheet feel like it is arguing with you.
      const projected = info.offset.y + project(info.velocity.y);
      if (projected > h * 0.35 || info.velocity.y > 900) onClose();
    },
    [height, onClose]
  );

  const panelMotion = m.reduced
    ? undefined
    : {
        // 1:1 downward (elastic 1 = the constraint stops resisting entirely);
        // upward it barely moves, which is Apple's progressive resistance
        // rather than a hard stop the user reads as a freeze.
        drag: 'y' as const,
        dragDirectionLock: true,
        dragConstraints: { top: 0, bottom: 0 },
        dragElastic: { top: 0.04, bottom: 1 },
        dragMomentum: false,
        dragPropagation: false,
        dragSnapToOrigin: true,
        onDragEnd,
        ref: measure,
      };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      placement="bottom"
      panelClassName={`pb-[env(safe-area-inset-bottom)] sm:pb-0 ${panelClassName}`}
      panelMotion={panelMotion}
      {...rest}
    >
      {(api) => (
        <>
          {/* The grabber. Its job is to say "this can be pulled" before anyone has
              tried — an affordance has to precede its gesture. */}
          {!m.reduced && (
            <div className="flex justify-center pt-2.5 pb-1" aria-hidden data-sheet-grabber>
              <span className="h-1 w-9 rounded-full bg-white/25" />
            </div>
          )}
          {typeof children === 'function' ? children(api) : children}
        </>
      )}
    </Overlay>
  );
}

// --------------------------------------------------------------- Anchored

export interface AnchoredProps {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  label?: string;
  className?: string;
  /** Which corner of the trigger it grows from, in logical (RTL-safe) terms. */
  align?: 'start' | 'end';
  z?: number;
  testId?: string;
  /** The panel's role: `menu` (every caller so far), or e.g. `presentation`
   *  when the content carries its own role (`Menu` puts `role="menu"` on its list). */
  role?: React.AriaRole;
  /** The panel's id, so a trigger can point at it (`aria-controls`). */
  id?: string;
}

/**
 * A menu or popover that grows OUT OF its trigger.
 *
 * The difference from a modal is not decoration: a dropdown that scales from
 * its own centre looks like it arrived from nowhere and happens to be near the
 * button. Scaling from the trigger's edge is what makes it read as the button's
 * own content unfolding.
 *
 * It is positioned from the trigger but portalled to body. That is the only
 * reliable way to escape header transforms, search stacking contexts and
 * overflow clipping. Direction is copied explicitly, so portal placement does
 * not trade away RTL correctness.
 *
 * It sits on the overlay stack: Escape closes it (and only it, when it was
 * opened inside a dialog) and hands focus back to the trigger, and it paints
 * above whatever layer it was opened from.
 */
export function Anchored({
  open,
  onClose,
  anchor,
  children,
  label,
  className = '',
  align = 'end',
  z = UI_LAYERS.popover,
  testId,
  role = 'menu',
  id: idProp,
}: AnchoredProps) {
  const m = useMotion();
  const autoId = useId();
  const id = idProp ?? autoId;
  const { dir } = useLanguage();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const zRef = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    origin: string;
  } | null>(null);

  if (open && zRef.current === undefined) zRef.current = layerAbove(Math.max(z, UI_LAYERS.popover));
  if (!open) zRef.current = undefined;

  const updatePosition = useCallback(() => {
    const trigger = anchor.current;
    if (!trigger) return;
    const a = trigger.getBoundingClientRect();
    const panel = panelRef.current;
    const width = panel?.offsetWidth || 160;
    const height = panel?.offsetHeight || 160;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const gap = 8;
    const edge = 8;

    // Logical alignment, expressed in physical viewport coordinates only at
    // this final boundary.
    const rawLeft =
      align === 'end'
        ? dir === 'rtl'
          ? a.left
          : a.right - width
        : dir === 'rtl'
          ? a.right - width
          : a.left;
    const left = Math.min(Math.max(edge, rawLeft), Math.max(edge, viewportWidth - width - edge));

    const roomBelow = viewportHeight - a.bottom;
    const opensAbove = roomBelow < height + gap + edge && a.top > roomBelow;
    const rawTop = opensAbove ? a.top - height - gap : a.bottom + gap;
    const top = Math.min(Math.max(edge, rawTop), Math.max(edge, viewportHeight - height - edge));
    const anchorX = Math.min(Math.max(a.left + a.width / 2 - left, 12), Math.max(12, width - 12));

    setPosition({ top, left, origin: `${Math.round(anchorX)}px ${opensAbove ? '100%' : '0%'}` });
  }, [align, anchor, dir]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    const viewport = window.visualViewport;
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    viewport?.addEventListener('resize', updatePosition);
    viewport?.addEventListener('scroll', updatePosition);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      viewport?.removeEventListener('resize', updatePosition);
      viewport?.removeEventListener('scroll', updatePosition);
    };
  }, [open, updatePosition]);

  // Escape through the stack: only when this is the top layer, and focus goes
  // back to the trigger if it was inside the panel.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useLayoutEffect(() => {
    if (!open) return;
    return pushLayer({
      z: zRef.current ?? UI_LAYERS.popover,
      trap: null,
      onEscape: () => {
        const panel = panelRef.current;
        const hadFocus = !!panel && panel.contains(document.activeElement);
        closeRef.current();
        if (hadFocus) anchor.current?.focus({ preventScroll: true });
      },
    });
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t)) return;
      if (document.getElementById(id)?.contains(t)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, onClose, anchor, id]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panelRef}
          id={id}
          dir={dir}
          role={role}
          aria-label={label}
          data-anchored={testId ?? true}
          initial={{ opacity: 0, scale: m.reduced ? 1 : 0.92, y: m.travel(-6) }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: m.reduced ? 1 : 0.92, y: m.travel(-6) }}
          transition={m.spring('quick')}
          className={`fixed overflow-hidden rounded-md border border-border-subtle bg-surface-raised shadow-2xl ${className}`}
          style={{
            zIndex: zRef.current ?? Math.max(z, UI_LAYERS.popover),
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position ? 'visible' : 'hidden',
            transformOrigin: position?.origin,
          }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
