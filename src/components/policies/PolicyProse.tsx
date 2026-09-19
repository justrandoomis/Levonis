/**
 * THE DOCUMENT ITSELF — long legal prose, set to be read and to be quoted.
 *
 * WHAT THE CORPUS ACTUALLY CONTAINS, and therefore what this renders: `## `
 * part headings, `### 4.2 ` articles, `- ` bullets, paragraphs and `**bold**`.
 * Nothing else appears in any of the eighteen documents, so nothing else is
 * parsed. This is deliberately NOT a markdown library: the input is written in
 * this repository by the shop, the output is inserted as React elements and
 * never as HTML, and a parser that accepted images, links and raw HTML would
 * be a larger attack surface and a larger bundle for text that contains none
 * of them.
 *
 * EVERY ARTICLE IS ADDRESSABLE. «انظر المادة ٤٫٢» is worth nothing if the
 * reader cannot send it, so each `###` carries the anchor policyReader derives
 * from its NUMBER — the same anchor in all three languages — and a copy button
 * that puts the absolute URL on the clipboard.
 *
 * THE COPY BUTTON IS NOT A HOVER AFFORDANCE. Tailwind v4 gates `hover:` behind
 * `@media (hover: hover)`, so a control revealed only on hover does not exist
 * on the iPad and the phone the owner actually uses — which is precisely the
 * device they would be holding while showing a clause to a courier. It is
 * always rendered, always 44px, quiet until it is wanted, and it strengthens
 * on hover and focus rather than appearing.
 *
 * TYPOGRAPHY. The measure is capped well below the column width: a line of
 * ninety Arabic characters is where the eye starts losing its place on the
 * return sweep, and this is text somebody reads for ten minutes during an
 * argument. Every font-size here is paired with an explicit line-height —
 * Tailwind's arbitrary `text-[13px]` sets font-size ONLY and leaves leading
 * inherited from the ancestor, which is how a 13px note ends up on 28px
 * leading inside a body that set it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import { useMotion } from '../../lib/motion';
import { parsePolicyLine, policyArticleHref } from '../../lib/policyReader';
import { usePolicyStrings } from './policyStrings';

/**
 * `**bold**` only. Split on the delimiter rather than matching it, so an
 * unbalanced pair in a draft renders as the asterisks that were typed instead
 * of silently swallowing the rest of the document.
 */
function Inline({ text }: { text: string }) {
  const parts = text.split(/\*\*/);
  if (parts.length < 3) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        // Odd indices are the runs BETWEEN a pair of delimiters. A trailing
        // odd run with no closing pair is rendered plain, not bold.
        i % 2 === 1 && i < parts.length - 1 ? <strong key={i} className="font-bold text-text-primary">{part}</strong> : <React.Fragment key={i}>{part}</React.Fragment>
      )}
    </>
  );
}

function CopyArticleLink({ href, label }: { href: string; label: string }) {
  const s = usePolicyStrings();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async () => {
    const absolute = new URL(href, window.location.origin).toString();
    try {
      // `writeText` rejects on an insecure origin and on a browser that has
      // not granted the permission; the fallback is the reader's own address
      // bar, which is why the failure says so instead of failing silently.
      await navigator.clipboard.writeText(absolute);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2400);
  }, [href]);

  return (
    <span className="relative inline-flex shrink-0 print:hidden">
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        data-policy-copy-link
        className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-md)] text-text-muted transition-colors hover:bg-white/5 hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {state === 'copied' ? <Check aria-hidden="true" className="h-4 w-4 text-success" /> : <Link2 aria-hidden="true" className="h-4 w-4" />}
      </button>
      {/* A polite live region rather than a tooltip: the confirmation has to
          reach a screen reader and a reader who tapped with a thumb over the
          icon, and neither of those sees a hover bubble. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'copied' ? s.copied : state === 'failed' ? s.copyFailed : ''}
      </span>
      {state !== 'idle' && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-full z-10 mt-1 whitespace-nowrap rounded-[var(--radius-sm)] border border-border-subtle bg-surface-raised px-2 py-1 text-[11px] leading-[1.5] text-text-secondary end-0"
        >
          {state === 'copied' ? s.copied : s.copyFailed}
        </span>
      )}
    </span>
  );
}

export interface PolicyProseProps {
  body: string;
  policyKey: string;
  version: number | null;
  /** The anchor the reader arrived at, so the article can say "here". */
  activeAnchor: string;
}

export default function PolicyProse({ body, policyKey, version, activeAnchor }: PolicyProseProps) {
  const s = usePolicyStrings();
  const m = useMotion();
  const lines = body.split('\n');
  const out: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = (atLine: number) => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    out.push(
      <ul key={`ul-${atLine}`} className="my-4 space-y-2.5 ps-1">
        {items.map((item, i) => (
          <li key={i} className="flex gap-3 text-[15px] leading-[1.95] text-text-secondary">
            <span aria-hidden="true" className="mt-[0.7em] h-[5px] w-[5px] shrink-0 rounded-full bg-gold/70" />
            <span className="min-w-0"><Inline text={item} /></span>
          </li>
        ))}
      </ul>
    );
  };

  for (let line = 0; line < lines.length; line++) {
    // The SAME parse the table of contents is built from, so an outline entry
    // can never point at an anchor this loop did not render.
    const parsed = parsePolicyLine(lines[line], line);

    if (parsed.kind === 'blank') {
      flushBullets(line);
      continue;
    }

    if (parsed.kind === 'heading') {
      flushBullets(line);
      const { level, number, title, anchor } = parsed;
      const isActive = anchor === activeAnchor;

      if (level === 2) {
        // A part opens a new region of the document. The rule above it does
        // the separating, so the heading itself does not have to shout.
        out.push(
          <h2
            key={line}
            id={anchor}
            data-policy-heading={anchor}
            className="scroll-mt-28 border-t border-border-subtle pt-9 mt-12 first:mt-0 first:border-t-0 first:pt-0 text-[20px] font-bold leading-[1.55] text-text-primary"
          >
            {number && <span className="me-2 text-gold">{number}.</span>}
            {title}
          </h2>
        );
        continue;
      }

      out.push(
        <h3
          key={line}
          id={anchor}
          data-policy-heading={anchor}
          data-policy-active={isActive || undefined}
          className={`scroll-mt-28 mt-9 flex items-start gap-2 rounded-[var(--radius-md)] text-[16px] font-bold leading-[1.6] text-text-primary transition-colors ${
            isActive ? 'bg-gold/10 px-3 -mx-3 py-1' : ''
          }`}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-2.5">
            {number && (
              <span dir="ltr" className="font-mono text-[12px] font-bold leading-[1.4] tracking-wide text-gold text-start">
                {s.article} {number}
              </span>
            )}
            <span>{title}</span>
          </span>
          <CopyArticleLink href={policyArticleHref(policyKey, anchor, version)} label={`${s.copyLink} — ${s.article} ${number ?? title}`} />
        </h3>
      );
      continue;
    }

    if (parsed.kind === 'bullet') {
      bullets.push(parsed.text);
      continue;
    }

    flushBullets(line);
    out.push(
      <p key={line} className="my-4 text-[15px] leading-[2] text-text-secondary">
        <Inline text={parsed.text} />
      </p>
    );
  }
  flushBullets(lines.length);

  return (
    <div
      data-policy-prose
      // The measure, not the container, is what makes long prose readable: the
      // column stays comfortably short on a wide screen instead of running the
      // full width. `max-w-none` on the small screen keeps the phone at the
      // page gutter and nothing narrower.
      className={`max-w-none lg:max-w-[68ch] ${m.reduced ? '' : 'scroll-smooth'}`}
    >
      {out}
    </div>
  );
}
