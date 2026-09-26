import React, { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import type { JumpChip } from '../../lib/catalog/categoryPageModel';

/**
 * THE SHELF INDEX (docs/ux/CATALOG_DISCOVERY.md §6 item 3).
 *
 * Sticky under the top bar: one chip per shelf that follows, with its count.
 * The chip of the shelf being read is the selected one — a scroll-spy on one
 * IntersectionObserver, reading the band just under the sticky bars — and the
 * row keeps that chip in view as the page moves. A tap scrolls to the shelf
 * (smoothly, or at once under reduced motion) and moves focus to its heading,
 * so a keyboard or screen-reader user lands where a finger would.
 *
 * Links, not tabs: every chip is an in-page anchor (`#shelf-…`), so it also
 * works with no script and opens in place from a copied link.
 */
export default function ShelfJumpChips({ chips, label }: { chips: JumpChip[]; label: string }) {
  const { loc } = useLanguage();
  // OWNER: Sorani to be written by hand (the count's spoken prefix).
  const m = useMotion();
  const [active, setActive] = useState(chips[0]?.target ?? '');
  const rowRef = useRef<HTMLUListElement>(null);
  const lock = useRef(0);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || chips.length === 0) return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        // A tap's own smooth scroll passes other shelves; do not flicker through them.
        if (Date.now() < lock.current) return;
        const first = chips.find((c) => visible.has(c.target));
        if (first) setActive(first.target);
      },
      // The band under the sticky bar and the chips (≈ 112 px), down to 40% of the screen.
      { rootMargin: '-112px 0px -60% 0px', threshold: 0 }
    );
    for (const c of chips) {
      const el = document.getElementById(c.target);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [chips]);

  // Keep the selected chip visible inside the row.
  useEffect(() => {
    const row = rowRef.current;
    const el = row?.querySelector<HTMLElement>(`[data-jump="${active}"]`);
    if (!row || !el) return;
    const r = el.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    // The row alone scrolls — `scrollIntoView` would also move every scrollable ancestor.
    if (r.left < box.left || r.right > box.right) {
      row.scrollTo({ left: row.scrollLeft + (r.left + r.width / 2) - (box.left + box.width / 2), behavior: m.reduced ? 'auto' : 'smooth' });
    }
  }, [active, m.reduced]);

  if (chips.length === 0) return null;

  const go = (e: React.MouseEvent<HTMLAnchorElement>, target: string) => {
    const el = document.getElementById(target);
    if (!el) return;
    e.preventDefault();
    lock.current = Date.now() + 700;
    setActive(target);
    // Scroll the app's own container vertically only (the shelf's `scroll-margin-top` clears the sticky bars).
    const scroller = document.getElementById('main-scroll-container');
    if (scroller) {
      const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 112;
      scroller.scrollTo({ top, behavior: m.reduced ? 'auto' : 'smooth' });
    } else {
      el.scrollIntoView({ block: 'start', behavior: m.reduced ? 'auto' : 'smooth' });
    }
    const heading = el.querySelector<HTMLElement>('h2');
    heading?.focus({ preventScroll: true });
  };

  return (
    <nav
      aria-label={label}
      data-jump-chips
      className="sticky top-14 z-20 -mx-4 bg-canvas/[0.92] py-1 backdrop-blur-lg sm:-mx-6 lg:-mx-8"
    >
      <ul ref={rowRef} className="relative flex gap-1.5 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:px-6 lg:px-8">
        {chips.map((c) => {
          const on = c.target === active;
          return (
            <li key={c.id} className="shrink-0">
              <a
                href={`#${c.target}`}
                data-jump={c.target}
                aria-current={on ? 'location' : undefined}
                onClick={(e) => go(e, c.target)}
                className="group inline-flex min-h-11 items-center focus-visible:outline-none"
              >
                <span
                  className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[12.5px] font-bold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-focus ${
                    on
                      ? 'bg-text-primary text-canvas'
                      : 'border border-border-subtle bg-surface text-text-secondary group-hover:text-text-primary'
                  }`}
                >
                  {c.label}
                  {c.count !== null ? (
                    <span className={`font-semibold tabular-nums ${on ? 'text-canvas/70' : 'text-text-muted'}`}>
                      <span className="sr-only">{loc('، العدد', ', count')} </span>
                      {c.count}
                    </span>
                  ) : null}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
