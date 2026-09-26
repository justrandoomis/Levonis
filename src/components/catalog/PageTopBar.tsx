import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * THE DISCOVERY PAGES' TOP BAR (docs/ux/CATALOG_DISCOVERY.md §5–§7).
 *
 * 56 px, translucent over the page (`bg-canvas/88` + blur, so content scrolls
 * under it rather than past a hard edge), sticky at the top of the app's
 * scroll container. The hairline under it appears only once the page has
 * scrolled — at rest there is nothing to separate it from.
 *
 * THE TITLE CAN WAIT FOR THE HERO. A category page shows its name large in
 * the hero; repeating it in the bar at the same time says it twice. The page
 * passes `titleVisible={false}` while its hero is on screen and the title
 * fades in as the hero leaves (a cross-fade; nothing moves under reduced
 * motion). A listing, which has no hero, shows its title from the start.
 *
 * BACK GOES BACK — or home, for a link opened cold (no history entry of this
 * app to return to), so the button is never a dead end.
 */
export default function PageTopBar({
  title,
  subtitle,
  titleVisible = true,
  actions,
  fallback = '/',
}: {
  title: string;
  subtitle?: React.ReactNode;
  titleVisible?: boolean;
  /** The end side: search, share, the compare badge. */
  actions?: React.ReactNode;
  /** Where «back» goes when there is nothing to go back to. */
  fallback?: string;
}) {
  const { dir, loc } = useLanguage();
  const navigate = useNavigate();
  const scrolled = useScrolled();

  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback);
  };

  return (
    <header
      data-page-topbar
      className={`sticky top-0 z-30 h-14 border-b bg-canvas/[0.88] backdrop-blur-xl backdrop-saturate-150 transition-colors ${
        scrolled ? 'border-border-subtle' : 'border-transparent'
      }`}
    >
      <div className="mx-auto flex h-full w-full max-w-[1200px] items-center gap-2 px-4 sm:px-6 lg:px-8">
      <button
        type="button"
        onClick={back}
        aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
        className="lv-hit relative grid size-10 shrink-0 place-items-center rounded-full border border-border-subtle bg-surface text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {dir === 'rtl' ? <ChevronRight aria-hidden="true" className="size-5" /> : <ChevronLeft aria-hidden="true" className="size-5" />}
      </button>
      <div
        className={`min-w-0 flex-1 transition-opacity duration-200 motion-reduce:transition-none ${titleVisible ? 'opacity-100' : 'opacity-0'}`}
        aria-hidden={titleVisible ? undefined : true}
      >
        <p className="truncate text-[16px] font-extrabold leading-[22px] text-text-primary">{title}</p>
        {subtitle ? <p className="truncate text-[11.5px] leading-4 text-text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
    </header>
  );
}

/** A 40 px round control for the bar's end side, with a 44 px target. */
export function TopBarButton({
  label,
  onClick,
  children,
  onPointerDown,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  onPointerDown?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      aria-label={label}
      title={label}
      className="lv-hit relative grid size-10 shrink-0 place-items-center rounded-full border border-border-subtle bg-surface text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {children}
    </button>
  );
}

/** Has the app's scroll container left its top? */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = document.getElementById('main-scroll-container');
    if (!el) return;
    const read = () => setScrolled(el.scrollTop > 4);
    read();
    el.addEventListener('scroll', read, { passive: true });
    return () => el.removeEventListener('scroll', read);
  }, []);
  return scrolled;
}
