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

import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, type PanInfo } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import { project, useMotion } from '../../lib/motion';

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
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
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
          style={{ zIndex: z }}
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
            className={`relative min-w-0 ${solid ? 'shadow-2xl' : 'material material-thick border border-white/10'} ${
              placement === 'bottom' ? 'rounded-t-3xl sm:rounded-3xl' : 'rounded-3xl'
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
      panelClassName={panelClassName}
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
 * It stays in the caller's DOM (no portal) so it inherits the trigger's
 * stacking and RTL context — a menu is part of its control, not a separate
 * window.
 */
export function Anchored({
  open,
  onClose,
  anchor,
  children,
  label,
  className = '',
  align = 'end',
  z = 50,
  testId,
}: AnchoredProps) {
  const m = useMotion();
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t)) return;
      if (document.getElementById(id)?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onClose, anchor, id]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          id={id}
          role="menu"
          aria-label={label}
          data-anchored={testId ?? true}
          initial={{ opacity: 0, scale: m.reduced ? 1 : 0.92, y: m.travel(-6) }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: m.reduced ? 1 : 0.92, y: m.travel(-6) }}
          transition={m.spring('quick')}
          // The origin is the top edge on the side the trigger sits on, stated
          // logically so it mirrors with the writing direction instead of
          // needing a second rule for Arabic.
          className={`material material-thin absolute top-full mt-1.5 origin-top border border-white/10 rounded-2xl shadow-xl ${
            align === 'end' ? 'end-0 [transform-origin:100%_0%] rtl:[transform-origin:0%_0%]' : 'start-0 [transform-origin:0%_0%] rtl:[transform-origin:100%_0%]'
          } ${className}`}
          style={{ zIndex: z }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
