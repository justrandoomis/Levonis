import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * A BACK BUTTON THAT WORKS WHEN THERE IS NOWHERE TO GO BACK TO.
 *
 * `navigate(-1)` is the obvious implementation and it is wrong for the way
 * this shop is actually opened. A customer reaches a product page from
 * WhatsApp, from a QR code on a printed label, from a supporter's `?ref=`
 * link, from a search result, or by refreshing. In every one of those the tab
 * has NO earlier entry belonging to this app: `navigate(-1)` either does
 * nothing at all — the button appears dead, which is what the owner reported —
 * or, worse, walks the customer out of the shop entirely, back to the
 * conversation they came from, losing their cart and their place.
 *
 * HOW WE KNOW WHETHER WE PUSHED. React Router stamps every entry it creates
 * with an incrementing `idx` on `window.history.state`. On the first entry of
 * a tab that index is 0, and `> 0` is the only reliable signal that a step
 * back lands somewhere we put there. `useNavigationType()` cannot answer this:
 * it reports POP for a fresh load and for a real back alike.
 *
 * It is read DEFENSIVELY. A browser that has not run the router's own
 * navigation yet, a restored session, an embedded webview with a rewritten
 * history — any of these can leave the state null or the shape unfamiliar, and
 * a back button must never be the thing that throws.
 *
 * `fallback` is the page ABOVE this one, not the home page by reflex: from a
 * product the honest parent is the catalogue it was found in, and a screen
 * that names its own parent gives a first-time visitor a way INTO the shop
 * rather than a way out of it.
 */
export function useGoBack(fallback: string) {
  const navigate = useNavigate();
  return useCallback(() => {
    let pushed = false;
    try {
      const idx = (window.history.state as { idx?: unknown } | null)?.idx;
      pushed = typeof idx === 'number' && idx > 0;
    } catch {
      pushed = false;
    }
    if (pushed) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
