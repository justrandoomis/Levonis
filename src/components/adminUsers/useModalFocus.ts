/**
 * THE HALF OF A DIALOG THAT `Overlay` DELIBERATELY DOES NOT DO.
 *
 * src/components/ui/Overlay.tsx says so in its own header: "It is not a focus
 * manager. Escape-to-close and initial focus are here because every caller
 * needs them; a full focus trap belongs to the callers that actually need one,
 * and pretending otherwise would hide the ones that do."
 *
 * The member detail is one that needs one, for a reason specific to THIS
 * screen: it opens out of a row in a table of a hundred users. Without a trap,
 * Tab walks straight out of the window and into the ninety-nine rows behind it
 * — a keyboard user ends up editing a member they cannot see, in a window they
 * believe they are still inside. And without a restore, closing the window
 * drops focus onto `<body>`, so the next Tab starts again from the top of the
 * page and the row they were working on is gone. Both are the keyboard
 * equivalent of the complaint that produced this modal in the first place:
 * «وليس أن يظهر في نهاية الصفحة» — do not throw me somewhere I have to go
 * looking for my place again.
 *
 * WHAT IT DOES NOT DO. It does not close on Escape and it does not lock the
 * page behind: `Overlay` already owns both, and a second implementation of
 * either would fight it. In particular the body lock is REFERENCE COUNTED in
 * Overlay (`acquireModalLock`) so that a dialog opened over another dialog does
 * not release the page early — a naive `document.body.style.overflow` here
 * would break exactly that.
 */

import { useCallback, useEffect, useRef } from 'react';

/**
 * Everything that can take focus. `[tabindex]:not([tabindex="-1"])` is the
 * deliberate shape: the Overlay panel itself carries `tabIndex={-1}` so it can
 * receive INITIAL focus, and it must not then become a stop in the cycle —
 * otherwise Tab lands on an unlabelled box between the last control and the
 * first, and a screen reader announces nothing.
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalFocus {
  /** Hand this to `Overlay`'s `panelMotion.ref` so the trap knows its box. */
  setPanel: (el: HTMLElement | null) => void;
}

/**
 * @param open   whether the window is up. The trap arms and disarms with it.
 * @param opener the control the window was opened from. Focus returns here on
 *               close — pass the same ref used as Overlay's `anchor`, so the
 *               window visually collapses into, and the caret returns to, the
 *               one element.
 */
export function useModalFocus(open: boolean, opener: React.RefObject<HTMLElement | null>): ModalFocus {
  const panelRef = useRef<HTMLElement | null>(null);
  const setPanel = useCallback((el: HTMLElement | null) => {
    panelRef.current = el;
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      // `offsetParent === null` is how a hidden control is recognised without a
      // layout read per element: a collapsed section's buttons are in the DOM
      // and must not be Tab stops. The active element is kept regardless,
      // because `position: fixed` also reports a null offsetParent and the
      // control the person is standing on is by definition reachable.
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // The panel counts as "before the first item" so the very first Shift+Tab
      // after opening wraps to the end instead of escaping to the page.
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    // CAPTURE PHASE, so the trap sees Tab before any control inside the window
    // can consume it — a `<select>` that stops propagation would otherwise
    // punch a hole straight through the trap.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Captured on the way IN. By the time this cleanup runs the table may have
    // re-rendered after a save, so the element is checked against the live
    // document before it is focused — a detached node swallows the focus call
    // and leaves the caret on <body>, which is the bug this exists to avoid.
    const returnTo = opener.current;
    return () => {
      if (returnTo && typeof returnTo.focus === 'function' && document.contains(returnTo)) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, [open, opener]);

  return { setPanel };
}
