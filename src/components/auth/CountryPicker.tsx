import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { COMMON_ISO, COUNTRIES, countryByIso, countryNames, flagOf, toAsciiDigitsClient } from './PhoneField';

/**
 * CountryPicker — 245 countries, in the shop's own theme, findable by typing.
 *
 * WHAT THIS REPLACED. A native `<select>`. It works, it is accessible, and on
 * a phone it opens the operating system's own list — which is why the owner's
 * screenshot of it looks like a different decade of a different product: grey
 * system chrome in the middle of a black and gold page, 245 rows deep, with no
 * way to type «العراق» or `964` and land on the answer.
 *
 * SO THE ONE THING IT HAD TO GAIN IS SEARCH, and search over three different
 * things people actually know:
 *
 *   * the country's NAME in the language they are reading — «العراق», "Iraq",
 *     `Irak`, and the Latin spelling too, because an Arabic keyboard is not
 *     always what is in front of them;
 *   * the DIAL CODE, with or without the plus — `964`, `+964`, and with
 *     Arabic-Indic digits folded, because ٩٦٤ is what a phone keypad in Iraq
 *     produces;
 *   * the ISO code, `IQ`, which is what a developer or a returning customer
 *     types.
 *
 * WHAT IS NOT GIVEN UP FOR THE THEME. A native select is keyboard-operable and
 * announces itself; a div is neither by default. This is a real combobox: the
 * button carries `aria-expanded` and `aria-haspopup`, the list is a `listbox`
 * of `option`s with `aria-selected`, the input owns the focus while the list is
 * open and drives it through `aria-activedescendant`, and ↑ ↓ Home End Enter
 * Escape all do what they do in the native control. Nothing here is reachable
 * only by pointer.
 *
 * ON A PHONE it is a sheet from the bottom of the screen rather than a popover:
 * a floating list anchored to a control near the top of a tall page ends up
 * under the keyboard, which is exactly where a search field must not be.
 */

export interface CountryPickerProps {
  id: string;
  /** ISO 3166-1 alpha-2, e.g. 'IQ'. */
  value: string;
  onChange: (iso: string) => void;
  lang?: 'ar' | 'en' | 'ckb';
  /** Accessible name for the control. */
  label: string;
  /** Show `+964` beside each country. Off for a plain "where do you live". */
  showDial?: boolean;
  disabled?: boolean;
  /** Renders the closed control as the compact flag+dial chip of a phone
   *  field rather than a full-width field. */
  compact?: boolean;
  error?: boolean;
  placeholder?: string;
  /** Section headings, already translated by the caller. */
  commonLabel?: string;
  allLabel?: string;
  /** Shown when nothing matches what was typed. */
  emptyLabel?: string;
  /**
   * Makes "no country" a real choice, labelled with this string.
   *
   * The sign-up form asks for a country and does not require one, and a picker
   * that cannot express "I would rather not say" turns an optional question
   * into a permanent one: once a person has tapped a row there is no way back
   * to blank. The row is offered FIRST and only when the caller asks for it.
   */
  unsetLabel?: string;
}

interface Entry {
  iso: string;
  dial: string;
  flag: string;
  name: string;
  /** Everything this row can be found by, folded once at build time. */
  haystack: string;
  common: boolean;
}

/**
 * Lowercased, accents removed, Arabic-Indic digits folded to ASCII.
 *
 * `NFD` + stripping combining marks is what makes `Turkiye` find «Türkiye» and
 * `Emirats` find «Émirats» — a person typing on a keyboard that has no ü is
 * not making a spelling mistake.
 */
function fold(s: string): string {
  return toAsciiDigitsClient(String(s ?? ''))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Arabic orthography, the same folding the server's search uses: أ إ آ → ا
    // and ة → ه, so «سوريا» and «سوريه» are one search.
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/ـ/g, '');
}

export default function CountryPicker({
  id,
  value,
  onChange,
  lang = 'ar',
  label,
  showDial = true,
  disabled,
  compact,
  error,
  placeholder,
  commonLabel,
  allLabel,
  emptyLabel,
  unsetLabel,
}: CountryPickerProps) {
  const listId = `${useId()}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // `countryByIso` falls back to Iraq for anything it does not know, which is
  // the right answer for a dial code and the wrong one here: an unset country
  // must read as unset, not as a country the person never chose.
  const unset = !/^[A-Za-z]{2}$/.test(String(value ?? '')) || !COUNTRIES.some((c) => c.iso === String(value).toUpperCase());
  const selected = countryByIso(value);

  /**
   * Built once per language, not per keystroke. Intl.DisplayNames is a real
   * cost across 245 entries and it is the same answer every time.
   *
   * The ENGLISH name goes into the haystack as well as the localized one, so
   * somebody reading the Arabic page can still type "Germany" — which is what
   * happens when the keyboard in their hand is Latin.
   */
  const entries = useMemo<Entry[]>(() => {
    const localized = countryNames(lang);
    const english = countryNames('en');
    const commonSet = new Set(COMMON_ISO);
    const rows = COUNTRIES.map((c) => {
      const name = localized(c.iso);
      return {
        iso: c.iso,
        dial: c.dial,
        flag: c.flag || flagOf(c.iso),
        name,
        haystack: fold(`${name} ${english(c.iso)} ${c.iso} ${c.dial} +${c.dial}`),
        common: commonSet.has(c.iso),
      };
    });
    // The markets this shop serves first, then everything else alphabetically
    // in the reader's own language — the same recipe /welcome uses.
    const common = COMMON_ISO.map((iso) => rows.find((r) => r.iso === iso)).filter(Boolean) as Entry[];
    const rest = rows.filter((r) => !commonSet.has(r.iso)).sort((a, b) => a.name.localeCompare(b.name, lang));
    return [...common, ...rest];
  }, [lang]);

  const results = useMemo(() => {
    const q = fold(query).trim();
    if (!q) return entries;
    // Every word must appear somewhere in the row, in any order: "iraq 964"
    // and "964 iraq" are the same question.
    const words = q.split(/\s+/).filter(Boolean);
    return entries.filter((e) => words.every((w) => e.haystack.includes(w)));
  }, [entries, query]);

  /** Where the "all countries" heading goes, when there is no search. */
  const firstRestIndex = useMemo(() => results.findIndex((e) => !e.common), [results]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const choose = useCallback(
    (iso: string) => {
      onChange(iso);
      close();
      // Focus returns to the control that opened the list, which is what a
      // native select does and what a keyboard user is expecting.
      rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    },
    [close, onChange]
  );

  // Opening moves focus into the search field; the list starts on whatever is
  // currently selected rather than at the top, so ↓ from a closed control
  // behaves like the native one.
  useEffect(() => {
    if (!open) return;
    const at = unset ? -1 : results.findIndex((e) => e.iso === selected.iso);
    setActive(at >= 0 ? at : 0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // `results` deliberately absent: this runs on OPEN, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A search narrows the list under the cursor, so the cursor goes back to the
  // top — otherwise Enter picks a row that scrolled out of the result set.
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);

  // Keep the active row in view, including when it moved because of a search.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLLIElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open, results]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + results.length) % results.length);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : Math.max(0, results.length - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[active];
      if (hit) choose(hit.iso);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div className="lv-cpick" ref={rootRef}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`lv-cpick__button${compact ? ' is-compact' : ''}${error ? ' is-error' : ''}${open ? ' is-open' : ''}`}
      >
        {!unset && (
          <span className="lv-cpick__flag" aria-hidden>
            {selected.flag || flagOf(selected.iso)}
          </span>
        )}
        {compact ? (
          <span className="lv-cpick__dial lv-mono">+{selected.dial}</span>
        ) : (
          <span className={`lv-cpick__name${unset ? ' is-unset' : ''}`}>
            {unset ? unsetLabel ?? '' : countryNames(lang)(selected.iso)}
          </span>
        )}
        {!compact && showDial && !unset && <span className="lv-cpick__dial lv-mono">+{selected.dial}</span>}
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden className="lv-cpick__caret">
          <path d="M5.3 7.7a1 1 0 0 1 1.4 0L10 11l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z" />
        </svg>
      </button>

      {open && (
        <>
          {/* The scrim belongs to the sheet layout on a phone; on a desktop it
              is invisible and only catches the click that closes the popover. */}
          <div className="lv-cpick__scrim" aria-hidden onClick={close} />
          <div className={`lv-cpick__panel${compact ? ' is-compact' : ''}`} role="presentation">
            <div className="lv-cpick__search">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <circle cx="9" cy="9" r="6" />
                <path d="m14 14 4 4" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={results[active] ? optionId(active) : undefined}
                aria-label={label}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={placeholder ?? ''}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="lv-cpick__input"
              />
            </div>
            <ul id={listId} role="listbox" ref={listRef} className="lv-cpick__list" aria-label={label}>
              {results.length === 0 && <li className="lv-cpick__empty">{emptyLabel ?? '—'}</li>}
              {/* "Would rather not say", first and only when offered. It is
                  not in `results`, so it is never a search hit and never the
                  row Enter lands on by accident. */}
              {unsetLabel && !query && (
                <li
                  role="option"
                  aria-selected={unset}
                  className={`lv-cpick__opt${unset ? ' is-selected' : ''}`}
                  onPointerDown={(ev) => {
                    ev.preventDefault();
                    choose('');
                  }}
                >
                  <span className="lv-cpick__optname is-unset">{unsetLabel}</span>
                </li>
              )}
              {results.map((e, i) => (
                <React.Fragment key={e.iso}>
                  {/* Headings only when the list is whole; once somebody has
                      typed, "frequently used" is not a useful way to read the
                      four rows that matched. */}
                  {!query && i === 0 && commonLabel && (
                    <li className="lv-cpick__head" role="presentation">
                      {commonLabel}
                    </li>
                  )}
                  {!query && i === firstRestIndex && firstRestIndex > 0 && allLabel && (
                    <li className="lv-cpick__head" role="presentation">
                      {allLabel}
                    </li>
                  )}
                  <li
                    id={optionId(i)}
                    role="option"
                    aria-selected={e.iso === selected.iso}
                    data-active={i === active}
                    className={`lv-cpick__opt${i === active ? ' is-active' : ''}${e.iso === selected.iso ? ' is-selected' : ''}`}
                    // `pointerdown` rather than `click`: the scrim's own
                    // pointerdown closes the panel, and a click that lands
                    // after the panel is gone is a click on nothing.
                    onPointerDown={(ev) => {
                      ev.preventDefault();
                      choose(e.iso);
                    }}
                    onPointerEnter={() => setActive(i)}
                  >
                    <span className="lv-cpick__flag" aria-hidden>
                      {e.flag}
                    </span>
                    <span className="lv-cpick__optname">{e.name}</span>
                    {showDial && <span className="lv-cpick__dial lv-mono">+{e.dial}</span>}
                  </li>
                </React.Fragment>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
