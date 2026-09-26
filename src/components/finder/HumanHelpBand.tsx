import React from 'react';
import { Link } from 'react-router-dom';
import { Headphones } from 'lucide-react';

/**
 * «هل تريد مساعدة بشرية؟» — a feature band (`data-feature`, src/index.css
 * FEATURE SURFACES: charcoal on the dark theme, a cream card on the light one)
 * with the one gold call to action. It opens the support intake carrying the
 * answers.
 */
export default function HumanHelpBand({ title, body, cta, to }: { title: string; body: string; cta: string; to: string }) {
  return (
    <section data-feature="" className="flex flex-wrap items-center gap-4 rounded-[22px] border border-border-subtle bg-charcoal px-5 py-5">
      <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-2xl bg-surface-raised text-gold">
        <Headphones className="size-5" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1 basis-[180px]">
        <h2 className="text-[16px] font-extrabold leading-[22px] text-text-primary">{title}</h2>
        <p className="mt-1 text-[13px] leading-[20px] text-text-secondary">{body}</p>
      </div>
      <Link
        to={to}
        className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-2xl bg-gold-fill px-6 text-[15px] font-extrabold text-ink transition-[filter,transform] duration-150 hover:brightness-105 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-charcoal motion-reduce:transition-none"
      >
        {cta}
      </Link>
    </section>
  );
}
