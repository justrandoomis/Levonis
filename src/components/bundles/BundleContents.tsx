import React, { useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { useMoney } from '../../CurrencyContext';

/**
 * ONE MAIN ITEM WITH EXPANDABLE CONTENTS — the disclosure the cart, the
 * checkout review screen and the order page all use
 * (docs/BUNDLES_MYSTERY.md §5.2, §6.3, §13).
 *
 * THREE RULES IT EXISTS TO KEEP, all of them things that go wrong when each
 * screen renders its own version:
 *
 * 1. THE PARTS ARE NEVER TOP-LEVEL LINES. A bundle is one row in the cart, one
 *    row in the quote and one row on the order; its parts unfold underneath.
 *    Four extra rows at 0 IQD would double the item count on the screen and
 *    make the visible line sum disagree with the total being charged.
 *
 * 2. EVERY NUMBER COMES FROM THE SERVER. The per-part figure is that part's
 *    STANDALONE value, labelled as such, and the discount is stated once — on
 *    the bundle. Nothing here adds, divides or rounds: a percentage recomputed
 *    in the browser would disagree with the one the offer page showed.
 *
 * 3. RTL-SAFE AND TRILINGUAL. Every string goes through `loc(ar, en, ckb)`, the
 *    layout is logical-direction (`text-start`, `gap`), and the quantity is
 *    rendered as `×2` beside the name rather than inside a translated sentence.
 */
export interface BundleContentLine {
  key: string;
  name: string;
  name_ar?: string;
  variant?: string;
  qty: number;
  /** The part's standalone value, or null when the payload does not carry it. */
  value_iqd?: number | null;
  optional?: boolean;
  included?: boolean;
}

export default function BundleContents({
  lines,
  componentTotalIqd = null,
  savingPercent = null,
  defaultOpen = false,
  className = '',
}: {
  lines: BundleContentLine[];
  componentTotalIqd?: number | null;
  savingPercent?: number | null;
  defaultOpen?: boolean;
  className?: string;
}) {
  const { money } = useMoney();
  const { loc } = useLanguage();
  const m = useMotion();
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const shown = lines.filter((l) => l.included !== false);
  if (shown.length === 0) return null;

  const count = shown.length;
  return (
    <div className={className} data-bundle-contents={count}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="w-full min-h-[36px] px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-600 flex items-center gap-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
      >
        <span className="min-w-0 flex-1 text-[12px] text-zinc-300">
          {/* The count is rendered HERE, from the list the payload carries —
              never frozen into the immutable snapshot as an English sentence. */}
          {loc(`${count} قطعة داخل الحزمة`, `${count} items in this bundle`, `${count} پارچە لەم پاکێجەدا`)}
        </span>
        {savingPercent !== null && savingPercent > 0 && (
          <span className="shrink-0 text-[11px] text-[#ef233c] tabular-nums">
            {loc(`وفّر ${savingPercent}٪`, `Save ${savingPercent}%`, `${savingPercent}٪ پاشەکەوت`)}
          </span>
        )}
        <ChevronDown
          className={`w-3.5 h-3.5 text-zinc-500 shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {/* THE SAME UNFOLD AS THE WARRANTY DISCLOSURE TWO ROWS BELOW (§13.2).
          `hidden={!open}` made a bundle JUMP open while the extended-warranty
          panel beside it sprang, so the one pattern the contract pins this
          component to was the one it did not follow. The id lives on the
          always-present wrapper so `aria-controls` resolves whether the panel
          is open or not; under reduced motion it cross-fades. */}
      <div id={panelId}>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="panel"
              initial={m.reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={m.reduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
              exit={m.reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={m.spring('quick')}
              className="overflow-hidden"
            >
              <ul className="mt-1.5 rounded-xl border border-zinc-800 bg-black/30 p-2 flex flex-col gap-1.5">
                {shown.map((l) => (
                  <li key={l.key} className="flex items-start justify-between gap-3 text-[12px]">
                    <span className="min-w-0 text-zinc-200">
                      {/* §13.3: product, option and colour names STAY ENGLISH in
                          every language, and every other product name in the app
                          carries `dir="ltr"`. Without it a latin name and its
                          `×2` suffix are bidi-reordered inside the Arabic panel.
                          The `name_ar` branch is gone: it translated exactly the
                          names the contract says are never translated. */}
                      <span dir="ltr" className="block truncate text-start">
                        {l.name}
                        {l.qty > 1 && <span className="text-zinc-400 tabular-nums"> ×{l.qty}</span>}
                      </span>
                      {l.variant && (
                        <span dir="ltr" className="block text-[11px] text-zinc-500 truncate text-start">
                          {l.variant}
                        </span>
                      )}
                    </span>
                    {typeof l.value_iqd === 'number' && l.value_iqd > 0 && (
                      <span className="shrink-0 text-[11.5px] text-zinc-400 tabular-nums">{money(l.value_iqd)}</span>
                    )}
                  </li>
                ))}
                {componentTotalIqd !== null && componentTotalIqd > 0 && (
                  <li className="mt-0.5 pt-1.5 border-t border-zinc-800 flex items-center justify-between gap-3 text-[11.5px] text-zinc-400">
                    <span>{loc('قيمة القطع منفردة', 'Bought separately', 'بەجیا کڕدرا')}</span>
                    <span className="tabular-nums line-through">{money(componentTotalIqd)}</span>
                  </li>
                )}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
