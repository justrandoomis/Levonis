/**
 * A copy control small enough to sit beside an order id on a card.
 *
 * Same honesty rule as the admin's CopyField: no tick for a copy that did not
 * happen. When the clipboard is refused (insecure origin, locked-down
 * webview), the button says so for a moment instead of pretending.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

export default function InlineCopy({ value, label, className = '' }: { value: string; label: string; className?: string }) {
  const { loc } = useLanguage();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(
    async (e: React.MouseEvent) => {
      // Cards may sit inside a link; copying must never navigate.
      e.preventDefault();
      e.stopPropagation();
      if (timer.current) clearTimeout(timer.current);
      try {
        if (!navigator.clipboard) throw new Error('no clipboard');
        await navigator.clipboard.writeText(value);
        setState('copied');
      } catch {
        setState('failed');
      }
      timer.current = setTimeout(() => setState('idle'), 2000);
    },
    [value]
  );

  const copied = loc('تم النسخ', 'Copied', 'لەبەرگیرا');
  const failed = loc('تعذّر النسخ', 'Copy blocked', 'لەبەرگرتنەوە نەکرا');

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <button
        type="button"
        onClick={copy}
        aria-label={`${loc('نسخ', 'Copy', 'لەبەرگرتنەوە')} — ${label}`}
        data-copy-inline={label}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
          state === 'copied' ? 'text-emerald-400' : state === 'failed' ? 'text-amber-400' : 'text-zinc-500 hover:text-white hover:bg-zinc-800'
        }`}
      >
        {state === 'copied' ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
      </button>
      <span role="status" aria-live="polite" className={`text-[10.5px] ${state === 'idle' ? 'sr-only' : state === 'copied' ? 'text-emerald-400' : 'text-amber-400'}`}>
        {state === 'copied' ? copied : state === 'failed' ? failed : ''}
      </span>
    </span>
  );
}
