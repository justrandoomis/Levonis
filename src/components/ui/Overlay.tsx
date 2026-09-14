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
 * WHAT IT DELIBERATELY DOES NOT DO. It is not a focus manager. Escape-to-close
 * and initial focus are here because every caller needs them; a full focus trap
 * belongs to the callers that actually need one, and pretending otherwise would
 * hide the ones that do.
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, type PanInfo } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import { project, useMotion } from '../../lib/motion';

/** One documented stacking contract for the app chrome and every floating UI. */
export const UI_LAYERS = Object.freeze({
  header: 100,
  bottomNav: 120,
  popover: 160,
  overlay: 200,
});

/**
 * Old callers passed local z-values such as 50/60. Those values made sense
 * inside their page but sat below the global bottom navigation. Preserve their
 * relative ordering while lifting every real overlay above app chrome.
 */
export function overlayLayer(z: number): number {
  return z < UI_LAYERS.overlay ? UI_LAYERS.overlay + Math.max(0, z) : z;
}

let modalLockCount = 0;
let modalLockState:
  | {
      bodyOverflow: string;
      main: HTMLElement | null;
      mainOverflow: string;
      alreadyMarked: boolean;
    }
  | undefined;

/** The app scrolls in #main-scroll-container, not body. Lock both, once, and
 * keep the lock alive when one modal opens over another. */
function acquireModalLock(): () => void {
  if (modalLockCount === 0) {
    const main = document.getElementById('main-scroll-container');
    modalLockState = {
      bodyOverflow: document.body.style.overflow,
      main,
      mainOverflow: main?.style.overflow ?? '',
      alreadyMarked: document.documentElement.dataset.overlayOpen === 'true',
    };
    document.body.style.overflow = 'hidden';
    if (main) main.style.overflow = 'hidden';
    document.documentElement.dataset.overlayOpen = 'true';
  }
  modalLockCount += 1;

  return () => {
    modalLockCount = Math.max(0, modalLockCount - 1);
    if (modalLockCount !== 0 || !modalLockState) return;
    document.body.style.overflow = modalLockState.bodyOverflow;
    if (modalLockState.main) modalLockState.main.style.overflow = modalLockState.mainOverflow;
    if (!modalLockState.alreadyMarked) delete document.documentElement.dataset.overlayOpen;
    modalLockState = undefined;
  };
}

// ------------------------------------------------------------------ scrim

/**
 * The dimming layer. It is a button, not a div with an onClick: a person using
 * a keyboard or a screen reader has to be able to leave the same way everyone
 * else can, and "tap outside to close" is invisible to both otherwise.
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
      className="no-press absolute inset-0 bg-black/70 backdrop-blur-[3px] cursor-default"
      initial={{ opacity: 0 }}
      animate={{ opacity: visible ? 1 : 0 }}
      exit={{ opacity: 0 }}
      transition={m.spring('quick')}
    />
  );
}

// ---------------------------------------------------------------- Overlay

export type OverlayMode =
  /** A task that takes over: dim the page, push it back. */
  | 'modal'
  /** A parallel panel: translucent and offset, no scrim, flow unbroken. */
  | 'parallel';

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Accessible name for the window itself. */
  label?: string;
  /** id of the element naming it, when the title is already on screen. */
  labelledBy?: string;
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
  className?: string;
  /** Stacking. Defaults high enough to sit over the app chrome. */
  z?: number;
  /** For probes and for the caller's own tests. */
  testId?: string;
  /**
   * Motion props merged onto the PANEL. `Sheet` uses this to make the panel
   * itself draggable — the drag has to move the window, not its contents, so
   * it cannot live on an inner wrapper. A `ref` in here is MERGED with the
   * panel's own ref (which takes initial focus), never substituted for it.
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
  mode = 'modal',
  anchor,
  panelClassName = '',
  placement = 'center',
  dismissOnEscape = true,
  dismissOnScrim = true,
  className = '',
  z = 200,
  testId,
  panelMotion,
  solid = false,
}: OverlayProps) {
  const m = useMotion();
  const { dir } = useLanguage();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const originRef = useRef<string | undefined>(undefined);
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

  useEffect(() => {
    if (!open || !dismissOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dismissOnEscape, onClose]);

  // The page behind a MODAL must not scroll under it; a parallel panel leaves
  // the flow alone, which is the whole reason it is a different mode.
  useEffect(() => {
    if (!open || mode !== 'modal') return;
    return acquireModalLock();
  }, [open, mode]);

  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  const travel = placement === 'bottom' ? m.travel(28) : m.travel(14);
  const scaleFrom = m.reduced ? 1 : anchor ? 0.9 : 0.96;
  const blurFrom = m.reduced ? 0 : 8;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          className={`fixed inset-0 flex ${PLACEMENT[placement]} ${className}`}
          style={{ zIndex: overlayLayer(z) }}
          data-overlay={testId ?? true}
          data-overlay-mode={mode}
        >
          {mode === 'modal' && (
            <Scrim visible={open} label={label ?? 'إغلاق'} onClose={dismissOnScrim ? onClose : undefined} />
          )}
          <motion.div
            ref={setPanel}
            dir={dir}
            role="dialog"
            aria-modal={mode === 'modal'}
            aria-label={labelledBy ? undefined : label}
            aria-labelledby={labelledBy}
            tabIndex={-1}
            data-overlay-panel
            // ENTER AND EXIT ARE THE SAME OBJECT, so they cannot disagree. The
            // blur travels with the scale: the surface materializes.
            initial={{ opacity: 0, scale: scaleFrom, y: travel, filter: `blur(${blurFrom}px)` }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: scaleFrom, y: travel, filter: `blur(${blurFrom}px)` }}
            transition={m.spring(placement === 'bottom' ? 'sheet' : 'ui')}
            style={{ transformOrigin: originRef.current, outline: 'none' }}
            {...panelMotionRest}
            className={`relative min-w-0 ${solid ? 'shadow-2xl' : 'bg-surface-raised border border-border-subtle shadow-2xl'} ${
              placement === 'bottom' ? 'rounded-t-xl sm:rounded-xl' : 'rounded-xl'
            } ${panelClassName}`}
          >
            {children}
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
      {/* The grabber. Its job is to say "this can be pulled" before anyone has
          tried — an affordance has to precede its gesture. */}
      {!m.reduced && (
        <div className="flex justify-center pt-2.5 pb-1" aria-hidden data-sheet-grabber>
          <span className="h-1 w-9 rounded-full bg-white/25" />
        </div>
      )}
      {children}
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
}: AnchoredProps) {
  const m = useMotion();
  const id = useId();
  const { dir } = useLanguage();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    origin: string;
  } | null>(null);

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t)) return;
      if (document.getElementById(id)?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
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
          role="menu"
          aria-label={label}
          data-anchored={testId ?? true}
          initial={{ opacity: 0, scale: m.reduced ? 1 : 0.92, y: m.travel(-6) }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: m.reduced ? 1 : 0.92, y: m.travel(-6) }}
          transition={m.spring('quick')}
          className={`fixed overflow-hidden rounded-md border border-border-subtle bg-surface-raised shadow-2xl ${className}`}
          style={{
            zIndex: Math.max(z, UI_LAYERS.popover),
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
