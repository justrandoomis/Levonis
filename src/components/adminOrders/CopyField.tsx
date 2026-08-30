import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * A value the admin has to retype somewhere else — into a courier's form,
 * onto a receipt, into a phone dialler — with a button that copies exactly
 * that value and nothing around it.
 *
 * WHY EACH FIELD COPIES ALONE. The point of this screen is that the admin
 * copies the customer's NAME into one box and the PHONE into another. A
 * single "copy the address" button that yields "Ali Hassan · 0770… · Baghdad"
 * means editing the paste every time, which is exactly the manual step this
 * is meant to remove.
 *
 * The clipboard write can fail — an insecure origin, a browser that refuses
 * without a user gesture, a locked-down webview. When it does, the field
 * SELECTS its own text so the admin can copy it by hand, and says so. It never
 * shows a success tick for a copy that did not happen.
 */
export default function CopyField({
  label,
  value,
  mono,
  emphasis,
  multiline,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** The one value on the screen that gets written on the receipt. */
  emphasis?: boolean;
  multiline?: boolean;
}) {
  const { loc } = useLanguage();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const valueRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Select the text so the admin can still take it manually.
      const el = valueRef.current;
      if (el && window.getSelection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), 2200);
  }, [value]);

  const empty = !value.trim();

  return (
    <div
      className={`rounded-xl border px-3 py-2.5 min-w-0 ${
        emphasis ? 'border-olive/50 bg-olive/10' : 'border-zinc-800 bg-zinc-900/50'
      }`}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold text-zinc-500 mb-0.5">{label}</span>
          {empty ? (
            // Never an empty box the admin has to interpret: say it is not set.
            <span className="text-[13px] text-zinc-600 italic">
              {loc('غير محدّد', 'not set', 'دیارینەکراو')}
            </span>
          ) : (
            <span
              ref={valueRef}
              // A phone number or a total inside an RTL paragraph renders its
              // leading '+' on the wrong end — "+964-770…" reads back as
              // "964-770…+". The stored value is right and the copy is right;
              // only the display was wrong, so numeric fields are forced LTR.
              dir={mono ? 'ltr' : undefined}
              data-copy-value
              className={`block text-white select-all ${
                emphasis ? 'text-lg font-black' : 'text-[14px] font-medium'
              } ${mono ? 'font-mono text-start' : ''} ${multiline ? 'whitespace-pre-wrap break-words' : 'truncate'}`}
              title={value}
            >
              {value}
            </span>
          )}
        </div>
        {!empty && (
          <button
            type="button"
            onClick={copy}
            data-copy-button={label}
            aria-label={`${loc('نسخ', 'Copy', 'لەبەرگرتنەوە')} — ${label}`}
            className={`shrink-0 w-11 h-11 -me-1 rounded-lg flex items-center justify-center transition-colors ${
              state === 'copied'
                ? 'text-emerald-400'
                : state === 'failed'
                  ? 'text-amber-400'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
            }`}
          >
            {state === 'copied' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </button>
        )}
      </div>
      {state === 'failed' && (
        <p className="text-[11px] text-amber-400 mt-1">
          {loc(
            'المتصفح منع النسخ — النص محدَّد، انسخه يدويًا',
            'The browser blocked the copy — the text is selected, copy it manually',
            'وێبگەڕەکە ڕێگری لە لەبەرگرتنەوە کرد — دەقەکە دیاریکراوە، بە دەست لەبەری بگرەوە'
          )}
        </p>
      )}
    </div>
  );
}
