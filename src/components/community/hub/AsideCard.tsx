/**
 * A CARD OF THE DESKTOP ASIDE (community UI plan C1 D3 (e), (f); IMG_8462):
 * a head (the gold glyph and the title), its rows on the card separated by
 * hairlines, and an optional footer link («استعرض الطلبات ‹»). The head has no
 * link of its own: the reference names the same list twice (the head «الكل»
 * and the footer), and one door is enough.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { OnwardChevron } from '../kit/buttons';

export default function AsideCard({
  id,
  title,
  icon,
  footer,
  children,
  ...rest
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  footer?: { to: string; label: string };
  children: React.ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <section aria-labelledby={id} className="cm-card rounded-xl shadow-sm" {...rest}>
      <div className="flex items-center gap-2 px-5 pb-2 pt-4">
        <span aria-hidden="true" className="shrink-0 text-gold">
          {icon}
        </span>
        <h2 id={id} className="min-w-0 text-xl font-bold text-text-primary">
          {title}
        </h2>
      </div>
      {children}
      {footer && (
        <Link
          to={footer.to}
          className="mx-3 mb-2 flex min-h-11 items-center gap-2 rounded-md px-2 text-[15px] font-semibold text-text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {footer.label}
          <OnwardChevron className="h-4 w-4" />
        </Link>
      )}
    </section>
  );
}
