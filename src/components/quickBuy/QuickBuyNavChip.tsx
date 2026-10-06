/**
 * «⚡ mm:ss» ON THE ACCOUNT TAB while a Quick Buy session is collecting
 * (docs/GIFTS_QUICK_BUY.md §3.5).
 *
 * A LAZY CHUNK, mounted by the bottom navigation inside the account icon for a
 * signed-in account. The navigation is in every visitor's first paint, and the
 * entry plus the store pages sit at their byte budget
 * (tests/bundleBudget.test.ts, 233 KB): the chip, its clock and the session
 * store arrive after the first paint, at the cost of one `React.lazy` line in
 * the navigation.
 *
 * It also carries the navigation's share of the store's refresh duty
 * (src/lib/quickBuyStore.ts `useQuickBuySync`): read the session when it
 * mounts — a sign-in, a return from the product page — and again whenever the
 * tab comes back.
 *
 * THE TIME IS IN THE TAB'S NAME. The pill is decorative (the badge's own
 * styling, in the accent); a screen reader hears «الحساب — الشراء السريع:
 * الوقت المتبقي 28:42» from the link's `aria-label`. That label is the
 * navigation's own prop, and the navigation does not import this chunk's
 * words, so the chip writes the time into it and puts the plain name back
 * when the session ends or it unmounts. React leaves the attribute alone while
 * the prop is unchanged; when the prop does change (a language switch), this
 * chip re-renders in the same commit and writes it again.
 */
import React, { useLayoutEffect, useRef } from 'react';
import { Zap } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import {
  formatQuickBuyClock,
  quickBuyRemainingMs,
  useQuickBuyNow,
  useQuickBuySnapshot,
  useQuickBuySync,
} from '../../lib/quickBuyStore';
import { quickBuyNavLabel } from './navStrings';

export default function QuickBuyNavChip() {
  const { user } = useAuth();
  const { lang } = useLanguage();
  const owner = user?.id ?? null;
  useQuickBuySync(owner);
  const snap = useQuickBuySnapshot(owner);
  const open = snap.session?.state === 'open';
  const now = useQuickBuyNow(open);
  const left = open ? quickBuyRemainingMs(snap, now) : null;
  const clock = left !== null && left > 0 ? formatQuickBuyClock(left) : null;
  const label = clock ? quickBuyNavLabel(lang, clock) : null;
  const anchor = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const link = anchor.current?.closest('a');
    if (!link || !label) return;
    // The tab's own name is its visible label — the link's last child.
    const name = link.lastElementChild?.textContent?.trim() || link.getAttribute('aria-label') || '';
    link.setAttribute('aria-label', `${name} — ${label}`);
    return () => {
      link.setAttribute('aria-label', name);
    };
  }, [label]);

  return (
    <>
      <span ref={anchor} hidden />
      {clock ? (
        // The badge's own pill, in the accent, centred ON the icon's top edge:
        // a five-character chip is wider than the icon, and hung off one side
        // like the count badge it would cover the cart's icon beside it.
        // Centred, it stays inside its own tab in every language.
        <span
          aria-hidden="true"
          data-nav-badge="quick-buy"
          className="absolute inline-flex items-center gap-0.5 h-[16px] px-1 rounded-full bg-gold text-accent-contrast text-[10px] font-black leading-[16px] tabular-nums whitespace-nowrap shadow-1"
          style={{ top: -12, left: '50%', transform: 'translateX(-50%)' }}
        >
          <Zap className="w-2.5 h-2.5 fill-current" strokeWidth={2.4} />
          {clock}
        </span>
      ) : null}
    </>
  );
}
