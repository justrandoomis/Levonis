/**
 * THE COMPOSER'S DOCK — «شارك مشروعًا» as a pill that sits above the bottom
 * bar while the feed is on screen. It is the LAST child of the feed section
 * and `position: sticky` to the block end: sticky-bottom inside its section
 * shows it exactly while the section crosses the viewport and nowhere else,
 * with no scroll listener. The offsets are inline (Toast's pattern) because
 * the stylesheet budget (tests/bundleBudget.test.ts) had no room for a rule —
 * there is NO `.lv-community-dock` rule in src/index.css, and the element
 * carries no such class, so nobody looks for one; `data-community-dock` is
 * its hook. An open overlay hides it as it hides the bottom nav — by reading
 * the same `data-overlay-open` flag on <html> (src/components/ui/Overlay.tsx)
 * rather than by a selector, for the same reason.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useHubStrings } from '../hub/strings';

export default function ComposerDock({ to, state }: { to: string; state?: unknown }) {
  const s = useHubStrings();
  const hidden = useOverlayOpen();
  return (
    <div
      className={`pointer-events-none sticky mt-4 flex justify-center transition-opacity ${hidden ? 'opacity-0' : ''}`}
      style={{ insetBlockEnd: 'calc(max(var(--shell-bottom-inset, 0px), var(--nav-stack)) + 0.5rem)', zIndex: 'calc(var(--z-bottom-nav) - 10)' }}
      data-community-dock
    >
      <Link
        to={to}
        state={state}
        tabIndex={hidden ? -1 : undefined}
        aria-hidden={hidden || undefined}
        className={`press-scale material material-thick inline-flex ${hidden ? 'pointer-events-none' : 'pointer-events-auto'} min-h-11 items-center gap-2 rounded-full px-5 text-[13px] font-bold text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        <Plus aria-hidden="true" className="h-4 w-4 text-sage" />
        {s.shareProject}
      </Link>
    </div>
  );
}

/** True while a sheet or dialog owns the screen (`html[data-overlay-open='true']`). */
function useOverlayOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setOpen(el.getAttribute('data-overlay-open') === 'true');
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ['data-overlay-open'] });
    return () => mo.disconnect();
  }, []);
  return open;
}
