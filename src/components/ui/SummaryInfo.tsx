import React, { useId, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * A MONEY ROW THAT CAN ANSWER A QUESTION ABOUT ITSELF — the «علامة تعجب» the
 * owner asked for beside the two figures the customer did not choose.
 *
 * «ثم علامة تعجب أمام كلمة تكلفة التوصيل إلى البيت حيث عند الضغط عليها يوضح
 *  أن توصيل حسب المنتج وعدد القطع ويوضح تكاليف التوصيل.»
 *
 * WHY THIS IS A WHOLE ROW AND NOT JUST A BUTTON. The answer has to open
 * UNDER the row, and a bare button dropped into the label of a
 * `justify-between` flex would open it INSIDE that flex — the explanation
 * would land in the middle of the line, between the label and the figure, and
 * squeeze the price. Owning the row is what lets the button sit in the label
 * and the panel sit beneath it, which is the only arrangement that reads.
 *
 * A DISCLOSURE, NOT A TOOLTIP, and that is deliberate. A tooltip is a hover,
 * and the device this shop is run from has no hover — on an iPad it either
 * never opens or opens on a tap and then cannot be dismissed. This is a button
 * that toggles a panel: it works with a finger, with a mouse and with a
 * keyboard, it announces its state, and it closes the way it opened.
 *
 * THE EXPLANATION SITS UNDER THE ROW rather than floating over it. A checkout
 * summary is a column of numbers that must add up, and a layer drawn on top of
 * the next figure hides the very thing the customer is checking. Pushing the
 * rows down is honest: it says "this is part of that line".
 *
 * Closed, it costs one 14px glyph at the end of the label and nothing else —
 * the row reads exactly as it did. That restraint is the point: the money is
 * the content, and the affordance to ask about it must not compete with it.
 */
export default function SummaryInfo({
  label,
  value,
  question,
  note,
  children,
  testId,
  tone = 'default',
}: {
  /** The name of the figure, as the customer reads it. */
  label: React.ReactNode;
  /** The figure itself, already formatted. */
  value: React.ReactNode;
  /** What the «!» asks, for a screen reader: "why does delivery cost this?". */
  question: string;
  /** A sentence that is always visible under the row (a membership note). */
  note?: React.ReactNode;
  /** The answer. Rendered only while the panel is open. */
  children: React.ReactNode;
  testId: string;
  /** `quiet` is for a figure that is NOT summed into the total below. */
  tone?: 'default' | 'quiet';
}) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div data-summary-row={testId}>
      <div
        className={`flex justify-between items-center gap-3 ${
          tone === 'quiet' ? 'text-zinc-500 text-[13px]' : 'text-zinc-400'
        }`}
      >
        <span className="font-light inline-flex items-center min-w-0">
          <span className="truncate">{label}</span>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={question}
            onClick={() => setOpen((v) => !v)}
            data-summary-info={testId}
            // A 24px target inside a 13px row. The height comes back out as
            // negative margin so asking the question never makes the row
            // taller than the rows around it.
            className={`-my-1 ms-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full align-middle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] ${
              open ? 'text-[#BAA369]' : 'text-zinc-600 hover:text-zinc-300'
            }`}
          >
            {/*
              «علامة تعجب» — the owner's own word, twice, so it is an
              exclamation and not the circled «i» a designer would reach for.
              It is drawn in zinc at 14px and carries no tint: everything else
              in this column that uses this glyph (the advance warning, the
              refused quote) is amber or red WITH a sentence beside it, so a
              neutral mark alone at the end of a label cannot be read as an
              alarm about the price it sits next to.
            */}
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </span>
        <span className="shrink-0">{value}</span>
      </div>
      {note}
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={question}
          data-summary-info-panel={testId}
          className="mt-2 rounded-lg border border-white/5 bg-white/[0.025] px-3 py-2.5 text-xs font-light leading-relaxed text-zinc-400 space-y-2"
        >
          {children}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="block pt-0.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
          >
            {loc('إخفاء', 'Hide', 'شاردنەوە')}
          </button>
        </div>
      )}
    </div>
  );
}
