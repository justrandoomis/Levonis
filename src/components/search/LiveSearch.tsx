import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, PackageSearch, RotateCcw, Search, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, type ApiProduct, type ProductsListResponse } from '../../lib/api';
import { productPrimaryImage } from '../../lib/productImage';
import { CROSS_FADE, useMotion } from '../../lib/motion';
import SafeImage from '../ui/SafeImage';
import { Skeleton } from '../ui/Skeleton';
import CardPrice from '../CardPrice';
import { acceptOnChange, acceptOnKey, ghostFor, ghostLayers, liveQuery, stepActive, textDirection } from './ghost';

/**
 * THE SEARCH FIELD THAT ANSWERS WHILE YOU TYPE.
 *
 * «يجب أن تكون هناك على الأقل نتائج تظهر من شريط البحث بشكل سلس … أما المنتجات
 * المقترحة عند الكتابة فإن شريط البحث يتوسع للأسفل يكون بشكل متوسع حاويا
 * بالمنتج». The header search was a bare `<input>` that did nothing until
 * Enter, and then threw the shopper onto a results page with no field on it.
 * This is the field, the panel that grows down out of it with the products it
 * found, and the grey word inside it (./ghost.ts) — one component, so the
 * header on Home and the bar on the results page are the same control.
 *
 * WHAT IT ASKS. The same `GET /api/products?search=` the results page reads,
 * six rows, so a row here and a card there can never disagree about a price
 * (the listing prices through the one path every shelf uses). 200 ms after the
 * last keystroke, one request in flight — the previous one is aborted, and a
 * late answer to an older query is dropped by id rather than painted over a
 * newer one. `mascot: 'silent'`: typing is not work the character should act
 * out on every keystroke.
 *
 * WHAT IT SHOWS WHILE IT WAITS. The last answer stays on screen, dimmed, until
 * the new one lands — a panel that blanks to a skeleton on every letter reads
 * as flicker. Skeleton rows only when there is nothing to show yet; a quiet
 * row with a retry when the request failed; «لا توجد نتائج» only for an answer
 * that really was empty.
 *
 * THE PANEL IS THE FIELD'S, NOT THE PAGE'S. It hangs from the field's own box
 * (no portal, no scrim): it is a list of choices belonging to what is being
 * typed, not a task that takes the page over — docs/MOTION.md §3's anchored
 * case. It grows DOWNWARD from the field's edge with the house spring, and its
 * height follows the rows as they change; under reduced motion it cross-fades
 * and sizes instantly. Tap outside, Escape, a route change or a choice closes
 * it.
 *
 * A COMBOBOX, SAID OUT LOUD. `role="combobox"` on the input with the listbox
 * it controls, `aria-activedescendant` for the row ↑/↓ highlight, and
 * `aria-autocomplete="both"` because it both lists and completes inline. The
 * rows are links (`role="option"` is allowed on `a[href]`), so a long-press or
 * a middle-click still opens a product the way every other card does.
 */

/** Long enough that a word typed at speed is one request, short enough that the panel feels attached. */
const DEBOUNCE_MS = 200;
/** Rows in the panel. The full list is one tap away in the footer. */
const ROWS = 6;
/** The server refuses a longer `search` (worker/routes/products.ts). */
export const SEARCH_MAX_LENGTH = 100;

type LiveResponse = ProductsListResponse & { suggestion?: string | null };
interface Answer {
  products: ApiProduct[];
  suggestion: string | null;
}

/**
 * The last answers this tab received, so backspacing through a word repaints
 * at once. It only decides what is on screen WHILE the fresh request runs —
 * the request always goes out, because a price can change and a signed-in
 * viewer's tier changes what the rows cost.
 */
const recent = new Map<string, Answer>();
const RECENT_MAX = 40;
function remember(query: string, answer: Answer) {
  recent.delete(query);
  recent.set(query, answer);
  if (recent.size > RECENT_MAX) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
}

/** Where a result opens — the same rule as the results grid. A composition row is bought at /bundles. */
export const productHref = (p: ApiProduct): string =>
  p.product_slug ? `/bundles/${p.product_slug}` : `/product/${p.slug || p.id}`;

export interface LiveSearchProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter with no row highlighted, and the footer: the full results page for this text. */
  onSubmit: (query: string) => void;
  /** A row was chosen; the caller may clear itself before the product opens. */
  onPick?: () => void;
  /** 50px field, or the 44px one the scrolled header and the results bar use. */
  size?: 'regular' | 'compact';
  /** The Home header's glass field, or the results page's pill. */
  tone?: 'header' | 'bar';
  /** Reopen the panel when the field is focused with text already in it. */
  openOnFocus?: boolean;
  className?: string;
}

export default function LiveSearch({
  value,
  onChange,
  onSubmit,
  onPick,
  size = 'regular',
  tone = 'header',
  openOnFocus = true,
  className = '',
}: LiveSearchProps) {
  const { t, loc, dir: pageDir } = useLanguage();
  const m = useMotion();
  const location = useLocation();
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const caretToEndRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const [overflowing, setOverflowing] = useState(false);
  const [active, setActive] = useState(-1);
  const [answer, setAnswer] = useState<{ query: string; data: Answer } | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);
  const [panelHeight, setPanelHeight] = useState<number | 'auto'>('auto');
  const [inputFontSize, setInputFontSize] = useState<string | undefined>(undefined);

  const query = liveQuery(value);
  const hasQuery = query.trim() !== '';
  const panelShown = open && hasQuery;

  // ------------------------------------------------------------ the request
  useEffect(() => {
    if (!panelShown) return;
    const cached = recent.get(query);
    if (cached) setAnswer({ query, data: cached });
    setStatus('loading');
    const id = ++requestRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.get<LiveResponse>(
          `/api/products?search=${encodeURIComponent(query)}&limit=${ROWS}`,
          { signal: controller.signal, mascot: 'silent' }
        );
        if (requestRef.current !== id) return;
        const data: Answer = { products: res.products ?? [], suggestion: res.suggestion ?? null };
        remember(query, data);
        setAnswer({ query, data });
        setStatus('ok');
      } catch (err) {
        if (controller.signal.aborted || requestRef.current !== id) return;
        if (err instanceof ApiError && err.code === 'ABORTED') return;
        setStatus('error');
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, panelShown, attempt]);

  // ------------------------------------------------------ closing the panel
  // A route change is a choice made (a row, the footer, the back button).
  useEffect(() => {
    setOpen(false);
    setActive(-1);
  }, [location.key]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!formRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // ---------------------------------------------------------- the grey word
  const textDir = textDirection(value, pageDir);
  const ghost = ghostFor(value, answer?.data.suggestion, textDir);
  const ghostVisible = focused && caretAtEnd && !overflowing && ghost !== '';
  const visibleGhost = ghostVisible ? ghost : '';
  const layers = ghostLayers(value, visibleGhost);

  const readCaret = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    setCaretAtEnd(el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length);
  }, []);

  // After a completion is taken the caret belongs at the end of the new text,
  // and the grey word is only honest when the typed text fits the field.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (caretToEndRef.current) {
      caretToEndRef.current = false;
      el.setSelectionRange(el.value.length, el.value.length);
      setCaretAtEnd(true);
    }
    setOverflowing(el.scrollWidth > el.clientWidth + 1);
    // The size the input ACTUALLY renders at. On a touch screen src/index.css
    // raises every text field to 16px so iOS does not zoom on focus, whatever
    // the class says — and a grey line drawn at the class's 15px would start
    // in the wrong place and drift further with every letter.
    const fontSize = getComputedStyle(el).fontSize;
    setInputFontSize((have) => (have === fontSize ? have : fontSize));
  }, [value, size]);

  // The panel's height follows its rows, so a new answer grows or shrinks it
  // instead of snapping.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!panelShown || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setPanelHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [panelShown]);

  const commit = (next: string, caretToEnd = false) => {
    caretToEndRef.current = caretToEnd;
    onChange(next.slice(0, SEARCH_MAX_LENGTH));
    setOpen(true);
    setActive(-1);
  };

  // ------------------------------------------------------------- the rows
  const data = answer?.data;
  const fresh = answer?.query === query;
  const rows = (data?.products ?? []).slice(0, ROWS);
  const view: 'skeleton' | 'error' | 'empty' | 'rows' =
    status === 'error' && !fresh
      ? 'error'
      : !data || (!fresh && rows.length === 0)
        ? 'skeleton'
        : rows.length === 0
          ? 'empty'
          : 'rows';
  const activeRow = view === 'rows' && active >= 0 && active < rows.length ? active : -1;

  const pick = () => {
    onPick?.();
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const atEnd = el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length;
    const accepted = acceptOnKey(e.key, value, visibleGhost, textDir, atEnd, answer?.data.suggestion);
    if (accepted !== null) {
      e.preventDefault();
      commit(accepted, true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hasQuery) return;
      e.preventDefault();
      if (!panelShown) {
        setOpen(true);
        return;
      }
      setActive((a) => stepActive(a, e.key === 'ArrowDown' ? 1 : -1, view === 'rows' ? rows.length : 0));
      return;
    }
    if (e.key === 'Enter' && panelShown && activeRow >= 0) {
      e.preventDefault();
      document.getElementById(optionId(activeRow))?.click();
      return;
    }
    if (e.key === 'Escape' && panelShown) {
      // Also stops a search input's native "Escape clears the text".
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  // Keep the highlighted row in view when ↑/↓ walks past the panel's edge.
  useEffect(() => {
    if (activeRow < 0) return;
    document.getElementById(optionId(activeRow))?.scrollIntoView({ block: 'nearest' });
    // optionId is derived from a stable useId value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRow]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text) return;
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
    onSubmit(text.slice(0, SEARCH_MAX_LENGTH));
  };

  // ------------------------------------------------------------- geometry
  // The icon sits at the PAGE's start and the clear button at its end, but the
  // input's own direction follows what is typed. Logical padding would resolve
  // against the input's direction and slide the text under the icon the moment
  // a Latin name is typed on an Arabic page, so the padding is physical.
  const compact = size === 'compact';
  const iconPad = compact ? 44 : 48;
  const endPad = value ? 44 : 16;
  // ONE LINE BOX FOR BOTH, the full height inside the 1px border. Centring the
  // grey line with flexbox and letting the input centre its own text put the
  // two baselines a pixel or two apart; with the same line-height on the same
  // font they are the same line.
  const lineHeight = `${(compact ? 44 : 50) - 2}px`;
  const padding: React.CSSProperties =
    pageDir === 'rtl'
      ? { paddingRight: iconPad, paddingLeft: endPad, lineHeight }
      : { paddingLeft: iconPad, paddingRight: endPad, lineHeight };
  const mirrorStyle: React.CSSProperties = inputFontSize ? { ...padding, fontSize: inputFontSize } : padding;
  const heightClass = compact ? 'h-11' : 'h-[50px]';
  const textClass = compact ? 'text-[14px]' : 'text-[15px]';
  const fieldSkin =
    tone === 'bar'
      ? 'rounded-full border border-zinc-800/70 bg-zinc-900 focus-within:border-focus'
      : `rounded-xl border border-border-subtle shadow-sm focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20 focus-within:bg-surface-raised ${
          compact ? 'bg-surface/95' : 'bg-surface/86'
        }`;

  const announcement = !panelShown
    ? ''
    : view === 'rows' && fresh
      ? `${rows.length} ${loc('نتيجة', 'results', 'ئەنجام')}`
      : view === 'empty'
        ? loc('لا توجد نتائج', 'No results', 'هیچ ئەنجامێک نییە')
        : '';

  const Forward = pageDir === 'rtl' ? ArrowLeft : ArrowRight;

  return (
    <form ref={formRef} role="search" onSubmit={submit} className={`relative ${className}`}>
      <div className={`relative ${heightClass} transition-[height,background-color,border-color] duration-300 ${fieldSkin}`}>
        {/* THE GREY WORD. A second line of text drawn exactly under the
            input's own — same font, size, padding and direction — whose typed
            part is invisible and whose tail is grey. The input above it has a
            transparent background, so the tail shows through right after the
            caret. aria-hidden: the combobox announces completions itself. */}
        <div
          aria-hidden="true"
          dir={textDir}
          style={mirrorStyle}
          className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre font-medium ${textClass}`}
        >
          <span className="invisible">{layers.typed}</span>
          <span className="text-text-muted" data-testid="search-ghost">
            {layers.tail}
          </span>
        </div>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          dir={textDir}
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={SEARCH_MAX_LENGTH}
          placeholder={t('search')}
          aria-label={t('search')}
          aria-autocomplete="both"
          aria-expanded={panelShown}
          aria-controls={listId}
          aria-activedescendant={activeRow >= 0 ? optionId(activeRow) : undefined}
          value={value}
          style={padding}
          onChange={(e) => {
            const next = e.target.value;
            const accepted = acceptOnChange(value, next, visibleGhost, answer?.data.suggestion);
            commit(accepted ?? next, accepted !== null);
          }}
          onKeyDown={onKeyDown}
          onSelect={readCaret}
          onKeyUp={readCaret}
          onClick={readCaret}
          onFocus={() => {
            setFocused(true);
            readCaret();
            if (openOnFocus && value.trim()) setOpen(true);
          }}
          onBlur={(e) => {
            setFocused(false);
            if (!formRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
          className={`relative h-full w-full appearance-none bg-transparent font-medium text-text-primary placeholder-text-muted focus:outline-none ${textClass} [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none`}
        />
        <button
          type="submit"
          aria-label={t('search')}
          className={`absolute inset-y-0 start-0 flex items-center justify-center rounded-lg text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
            compact ? 'w-11' : 'w-12'
          }`}
        >
          <Search className={compact ? 'h-4 w-4' : 'h-5 w-5'} strokeWidth={2.5} aria-hidden="true" />
        </button>
        {value && (
          <button
            type="button"
            aria-label={loc('مسح البحث', 'Clear search', 'سڕینەوەی گەڕان')}
            onClick={() => {
              commit('');
              setOpen(false);
              inputRef.current?.focus();
            }}
            className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      <AnimatePresence>
        {panelShown && (
          <motion.div
            key="panel"
            data-testid="search-panel"
            // Grows DOWN out of the field's edge and goes back the way it came.
            initial={m.reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: panelHeight }}
            exit={m.reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={m.reduced ? { ...CROSS_FADE, height: { duration: 0 } } : m.spring('ui')}
            // Keeps the caret in the field while a row is tapped.
            onMouseDown={(e) => e.preventDefault()}
            className="material material-thick pointer-events-auto absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border border-border-subtle shadow-2xl shadow-black/50"
          >
            <div ref={contentRef}>
              <div className="max-h-[min(55dvh,26rem)] overflow-y-auto overscroll-contain p-1.5">
                <div
                  role="listbox"
                  id={listId}
                  aria-label={t('search')}
                  aria-busy={status === 'loading'}
                  className={`transition-opacity duration-150 ${view === 'rows' && !fresh ? 'opacity-60' : ''}`}
                >
                  {view === 'rows' &&
                    rows.map((p, i) => (
                      <Link
                        key={p.id}
                        id={optionId(i)}
                        role="option"
                        aria-selected={i === activeRow}
                        tabIndex={-1}
                        to={productHref(p)}
                        onClick={pick}
                        onPointerEnter={() => setActive(i)}
                        className={`flex min-h-[60px] items-center gap-3 rounded-xl px-2 py-1.5 transition-colors ${
                          i === activeRow ? 'bg-white/[0.10]' : 'hover:bg-white/[0.05]'
                        }`}
                      >
                        <SafeImage
                          src={productPrimaryImage(p)}
                          alt=""
                          aspect="auto"
                          className="h-12 w-12 shrink-0 overflow-hidden rounded-lg"
                          fallbackIconClassName="h-4 w-4"
                        />
                        <div className="min-w-0 flex-1">
                          {/* §3/§12: the product name is English in every language. */}
                          <p className="line-clamp-2 text-[14px] font-medium leading-snug text-text-primary">{p.name}</p>
                          <div className="mt-0.5">
                            <CardPrice p={p} compact />
                          </div>
                        </div>
                      </Link>
                    ))}
                </div>
                {view === 'skeleton' && (
                  <div aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex min-h-[60px] items-center gap-3 px-2 py-1.5">
                        <Skeleton className="h-12 w-12 shrink-0 rounded-lg" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-3.5 w-3/5" />
                          <Skeleton className="h-3 w-1/4" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {view === 'empty' && (
                  <div className="flex min-h-[60px] items-center gap-3 px-3 text-text-secondary">
                    <PackageSearch className="h-5 w-5 shrink-0 text-text-muted" aria-hidden="true" />
                    <span className="text-[14px]">{loc('لا توجد نتائج', 'No results', 'هیچ ئەنجامێک نییە')}</span>
                  </div>
                )}
                {view === 'error' && (
                  <div className="flex min-h-[60px] items-center justify-between gap-3 px-3">
                    <span className="text-[14px] text-text-secondary">
                      {loc('تعذر التحميل', 'Failed to load', 'بارکردن سەرکەوتوو نەبوو')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAttempt((n) => n + 1)}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold text-text-primary hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      {t('retry')}
                    </button>
                  </div>
                )}
              </div>
              {view === 'rows' && (
                <button
                  type="submit"
                  className="flex min-h-11 w-full items-center justify-between gap-3 border-t border-border-subtle/80 px-4 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-white/[0.04] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                >
                  <span className="truncate">{loc('عرض كل النتائج', 'See all results', 'هەمووی ببینە')}</span>
                  <Forward className="h-4 w-4 shrink-0" aria-hidden="true" />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}
