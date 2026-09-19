/**
 * THE TABLE OF CONTENTS, built from the document's own headings.
 *
 * A LIBRARY DOCUMENT IS NAVIGATED, NOT SCROLLED. The general terms run to a
 * hundred and sixty headings; a reader looking for the clause about pricing
 * errors should be able to see that such a part exists and jump to it, and a
 * reader who arrived on article 4.2 from somebody else's link should be able
 * to see where in the document they have landed.
 *
 * TWO SHAPES, ONE COMPONENT. The long documents group their articles under
 * numbered parts, the five single-clause documents do not; the outline renders
 * a flat list of articles when there are no parts rather than inventing a
 * heading level to hang them from.
 *
 * ON THE PHONE IT IS A DISCLOSURE, closed by default. A hundred and sixty
 * links above the first sentence is not a table of contents, it is a wall —
 * and `<details>` costs no JavaScript, is keyboard-operable and announces its
 * own state without an aria attribute in sight. On a wide screen it is a rail
 * that stays put while the document scrolls beside it.
 */
import { Link } from 'react-router-dom';
import { ListTree } from 'lucide-react';
import { policyArticleHref, type PolicyHeading } from '../../lib/policyReader';
import { usePolicyStrings } from './policyStrings';

export interface PolicyOutlineProps {
  headings: PolicyHeading[];
  policyKey: string;
  version: number | null;
  activeAnchor: string;
}

function OutlineList({ headings, policyKey, version, activeAnchor }: PolicyOutlineProps) {
  const s = usePolicyStrings();
  const hasParts = headings.some((h) => h.level === 2 && h.number);

  return (
    <ol className="space-y-0.5">
      {headings.map((heading) => {
        // The unnumbered title line of a single-clause document is the
        // document's own name, which the page header already shows.
        if (heading.level === 2 && !heading.number && !hasParts) return null;
        const active = heading.anchor === activeAnchor;
        return (
          <li key={heading.anchor}>
            <Link
              to={policyArticleHref(policyKey, heading.anchor, version)}
              aria-current={active ? 'location' : undefined}
              data-policy-outline={heading.anchor}
              className={`flex min-h-[44px] items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                heading.level === 2
                  ? 'mt-3 text-[13px] font-bold leading-[1.6] text-text-primary'
                  : 'text-[13px] leading-[1.7] text-text-secondary ps-5'
              } ${active ? 'bg-gold/12 text-gold' : 'hover:bg-white/5 hover:text-text-primary'}`}
            >
              {heading.number && (
                <span dir="ltr" className="shrink-0 font-mono text-[11px] leading-[1.5] text-text-muted">{heading.number}</span>
              )}
              <span className="min-w-0 flex-1">{heading.title}</span>
              {active && <span className="sr-only">{s.article}</span>}
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

export default function PolicyOutline(props: PolicyOutlineProps) {
  const s = usePolicyStrings();
  if (props.headings.length < 2) return null;

  return (
    <>
      {/* Phone and tablet: a closed disclosure above the document. */}
      <details className="lv-surface mb-8 p-0 lg:hidden print:hidden" data-policy-outline-disclosure>
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 py-3 text-[14px] font-bold leading-[1.6] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <ListTree aria-hidden="true" className="h-4 w-4 text-gold" />
          {s.contents}
        </summary>
        <nav aria-label={s.contents} className="max-h-[60vh] overflow-y-auto border-t border-border-subtle px-2 py-2 custom-scrollbar">
          <OutlineList {...props} />
        </nav>
      </details>

      {/* Wide screen: a rail that holds its place beside the prose. The offset
          clears the app header, whose height the shell publishes as a token. */}
      <nav
        aria-label={s.contents}
        className="sticky hidden max-h-[calc(100dvh-var(--app-header-height,68px)-3rem)] overflow-y-auto pe-2 lg:block custom-scrollbar print:hidden"
        style={{ top: 'calc(var(--app-header-height, 68px) + 1rem)' }}
      >
        <h2 className="mb-2 flex items-center gap-2 px-2.5 text-[12px] font-bold uppercase leading-[1.6] tracking-wide text-text-muted">
          <ListTree aria-hidden="true" className="h-3.5 w-3.5" />
          {s.contents}
        </h2>
        <OutlineList {...props} />
      </nav>
    </>
  );
}
