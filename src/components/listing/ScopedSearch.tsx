import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * «ابحث في طابعات FDM» (§7 item 3): a search that stays INSIDE this section.
 * The grid below is the answer — it narrows as you type (400 ms after the
 * last key, or at once on Enter), so there is no second list of suggestions
 * competing with it. The text lives in the URL (`q`) like every other part of
 * the listing's state, and a clear button empties it.
 */
export default function ScopedSearch({ value, placeholder, onChange }: { value: string; placeholder: string; onChange: (q: string) => void }) {
  const { loc } = useLanguage();
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const schedule = (next: string) => {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next.trim()), 400);
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        onChange(text.trim());
        (document.activeElement as HTMLElement | null)?.blur();
      }}
      className="flex h-11 items-center gap-2 rounded-xl border border-border-subtle bg-surface px-3 focus-within:border-text-muted focus-within:ring-2 focus-within:ring-focus lg:h-12"
    >
      <Search aria-hidden="true" className="size-[18px] shrink-0 text-text-muted" />
      <input
        type="search"
        enterKeyHint="search"
        value={text}
        onChange={(e) => schedule(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={100}
        className="-my-px h-11 min-w-0 flex-1 bg-transparent lg:h-12 text-[14px] text-text-primary outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {text ? (
        <button
          type="button"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            setText('');
            onChange('');
          }}
          // OWNER: Sorani to be written by hand.
          aria-label={loc('مسح البحث', 'Clear search')}
          className="lv-hit relative -me-1 grid size-7 shrink-0 place-items-center rounded-full bg-surface-selected text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </form>
  );
}
