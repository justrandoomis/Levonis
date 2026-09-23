/**
 * THE BLOCKING BUSY LAYER — one primitive, mounted once, for the whole app.
 *
 * WHAT IT IS FOR. «لا توجد شاشة تحميل مركزية في أي مكان تمنع الضغط المزدوج أو
 * الإرهاق». A disabled button stops a second tap on ITSELF. It does not stop
 * the bottom navigation, the header, a link in the page behind it, or a finger
 * that lands two pixels outside it. While an order is on its way to the server
 * the application is genuinely unavailable, and this is the only thing in the
 * codebase that says so with its whole surface.
 *
 * WHAT IT IS NOT, and the distinction matters three ways:
 *
 *   IT IS NOT A DIALOG. `role="status"`, not `role="dialog"`; no `aria-modal`,
 *   no initial focus, no focus trap. Focus stays exactly where the customer
 *   left it — usually on the Place-order button, whose own `aria-busy` is
 *   already saying the right thing to a screen reader. Moving focus here would
 *   throw it away and then have to guess where to put it back.
 *
 *   IT IS NOT `Overlay`. That primitive's scrim is a real `<button>`, because
 *   a window you can tap outside of must be leavable by keyboard too. A wait
 *   is not leavable — there is nothing to dismiss — so a tab stop in front of
 *   a page that is only temporarily unavailable would be a control that
 *   promises something it cannot do.
 *
 *   IT IS NOT THE MASCOT'S VEIL. `.lv-app-intro` is `pointer-events: none` by
 *   design: it hides the page during boot and deliberately blocks nothing.
 *   Swallowing input is the entire point of this layer, and it sits above
 *   `UI_LAYERS.overlay` so it also covers an open sheet, the header and the
 *   bottom navigation.
 *
 * THE TWO CLOCKS.
 *
 *   THE DELAY. Nothing is drawn for the first `BUSY_DELAY_MS`, the same
 *   threshold `beginRequestFeedback` uses before it puts a loading face on the
 *   character and the same as `Spinner`'s default. A 90ms re-quote must not
 *   flash a takeover; a takeover that flashes is worse than no takeover, both
 *   because it reads as a glitch and because it teaches people to distrust it.
 *
 *   THE CEILING. `BUSY_CEILING_MS` and then this layer lets go, whatever the
 *   store still says. A request that never settles is not a reason to own
 *   somebody's phone, and a hold that leaked is not a reason to make the
 *   application permanently unusable. Escape does the same thing immediately.
 *   Both are escape hatches, not the mechanism: the button underneath stays
 *   disabled, and the idempotency key the checkout minted still stands between
 *   a determined second tap and a second order.
 *
 * LANGUAGE. Every sentence here is copied verbatim from a place a human
 * already wrote it — the Place-order button, the delivery row, the inline
 * spinner. Nothing on this screen is generated, in any of the three languages.
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { UI_LAYERS, acquireModalLock } from './Overlay';
import Spinner from './Spinner';
import { useBusySnapshot, type BusyReason } from '../../lib/busy';
import { DEFAULT_TIMEOUT_MS } from '../../lib/api';

/** Long enough that a fast response never flashes, short enough that a slow
 *  one is covered before a second tap can land. */
export const BUSY_DELAY_MS = 140;

/**
 * After this, the layer lets go no matter what the store says.
 *
 * IT MUST OUTLAST THE REQUEST IT IS COVERING, and for five seconds it did
 * not. The ceiling was a flat 15,000 while `DEFAULT_TIMEOUT_MS` is 20,000 and
 * Checkout does not override it (src/pages/Checkout.tsx), so on a slow mobile
 * connection the overlay released at t=15s with `POST /api/orders` still in
 * flight until t=20s: the bottom navigation, the header and the back gesture
 * all came back, the customer could navigate away, Checkout would unmount,
 * the order would commit on the server and `setPlacedOrder` would never run
 * — no order number, no confirmation, and a customer primed to order again.
 * That five-second hole is the exact scenario the layer was built for.
 *
 * So it is DERIVED, not copied: the ceiling is the API deadline plus one
 * margin, and tuning either end keeps the ordering that makes this correct.
 * The margin covers the browser's own teardown of an aborted fetch and the
 * store's release afterwards; it is not a guess at network time.
 */
export const BUSY_CEILING_MARGIN_MS = 5000;
export const BUSY_CEILING_MS = DEFAULT_TIMEOUT_MS + BUSY_CEILING_MARGIN_MS;

/**
 * One hand-written sentence per reason, per language. `order` is the
 * Place-order button's own busy label (src/pages/Checkout.tsx), `quote` is
 * `S.quoteLoading` — the sentence the delivery row already shows — and
 * `route` is the inline spinner's generic trio. No Sorani was written for
 * this file; all of it already existed.
 */
const LABELS: Record<BusyReason, Record<'ar' | 'en' | 'ckb', string>> = {
  order: { ar: 'جارٍ تأكيد الطلب…', en: 'Placing order…', ckb: 'داواکاری دەنێردرێت…' },
  quote: { ar: 'جارٍ حساب التوصيل...', en: 'Calculating delivery...', ckb: 'حسابکردنی گەیاندن...' },
  route: { ar: 'جارٍ التحميل…', en: 'Loading…', ckb: 'باردەکرێت…' },
};

/** Every pointer event that reaches this layer stops here. That is the fix. */
function swallow(event: React.SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

export default function AppBusy() {
  const { reason, session } = useBusySnapshot();
  const { lang, dir } = useLanguage();
  const m = useMotion();
  const [shown, setShown] = useState(false);
  const [released, setReleased] = useState(false);

  /**
   * Both clocks run from the SESSION, not from the reason. A re-quote that is
   * still in flight when the order starts is one continuous wait from the
   * customer's side, and restarting the ceiling on every internal change of
   * mind is how a ceiling stops being one.
   */
  const idle = reason === null;
  useEffect(() => {
    if (idle) {
      setShown(false);
      setReleased(false);
      return;
    }
    const show = window.setTimeout(() => setShown(true), BUSY_DELAY_MS);
    const ceiling = window.setTimeout(() => setReleased(true), BUSY_CEILING_MS);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(ceiling);
    };
  }, [idle, session]);

  const visible = !idle && shown && !released;

  /**
   * ESCAPE LETS GO. Not because dismissing a wait makes sense, but because a
   * person who is stuck must always have one key that works. It hides the
   * layer for the rest of this session only; the next wait gets a fresh one.
   */
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReleased(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  /** The app scrolls in #main-scroll-container. Share the one counter. */
  useEffect(() => {
    if (visible) return acquireModalLock();
  }, [visible]);

  /**
   * ONLY THE ORDER, AND FROM THE FIRST MILLISECOND.
   *
   * A reload during `POST /api/orders` is the one wait where leaving costs the
   * customer something they cannot see — the request is already with the
   * server. It is deliberately NOT gated on `visible`: the risk exists before
   * the delay has elapsed, and a page that is about to unload is not going to
   * wait 140ms to object. Equally deliberately, it is not armed for a quote:
   * an app that argues with people who are simply leaving a price calculation
   * has taught them to ignore it by the time it matters.
   */
  useEffect(() => {
    if (reason !== 'order') return;
    /**
     * AND IT LETS GO WHEN THE LAYER DOES. `released` is in the dependency
     * list — not `visible`, which is also false during the first 140ms while
     * the risk is at its highest — because the ceiling and the Escape key
     * both mean the same thing: this layer has stopped claiming the page.
     * Without it, a customer who hit Escape, or who waited past the ceiling,
     * saw the screen visibly free itself and then got the browser's leave
     * prompt anyway on a page that had stopped looking busy. An argument on
     * behalf of a wait nobody can see is how people learn to dismiss the
     * prompt that matters.
     */
    if (released) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [reason, released]);

  if (typeof document === 'undefined') return null;

  const label = LABELS[reason ?? 'route'][lang as 'ar' | 'en' | 'ckb'] ?? LABELS[reason ?? 'route'].ar;

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          dir={dir}
          data-app-busy={reason}
          role="status"
          aria-live="polite"
          aria-busy="true"
          onPointerDown={swallow}
          onPointerUp={swallow}
          onClick={swallow}
          onContextMenu={swallow}
          onTouchStart={swallow}
          className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-[3px] cursor-progress"
          // Above `UI_LAYERS.overlay`, so an open sheet is covered too, and
          // above `.lv-app-intro` (z-index 121) so the character cannot be
          // tapped into a journey while the page is unavailable.
          style={{ zIndex: UI_LAYERS.overlay + 100, touchAction: 'none' }}
          // OPACITY ONLY. No scale and no travel, in either preference: this
          // layer appears because something is slow, and a surface that
          // performs an entrance while the app is stalled is the interface
          // talking about itself.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={m.spring('quick')}
        >
          {/* `decorative`, because the sentence below is the status text and
              two live regions announcing the same wait is one too many. */}
          <Spinner size="md" delayMs={0} decorative />
          <span className="text-[13px] font-light text-zinc-300">{label}</span>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
