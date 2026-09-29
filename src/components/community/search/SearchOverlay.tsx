/**
 * ONE SEARCH FOR THE WHOLE COMMUNITY — the panel under the search bar
 * (docs/COMMUNITY_ECOSYSTEM.md §9.3). The bar and its input belong to the
 * page (src/pages/Community.tsx, src/pages/community/Projects.tsx); this
 * chunk is lazy and hangs from them: it listens to the input, draws the grey
 * completion inside the bar, and draws the answer beneath it.
 *
 * THE OVERLAY IS THE CROSS-ENTITY VIEW; THE TAB IS THE DEEP LIST. Typing shows
 * a few of everything — projects, stores, makers, products, requests,
 * materials, brands, in the owner's order — each with «الكل» to the tab or
 * page that lists the rest with `?q=`. While the panel is open the page
 * behind it holds still (it writes `?q=` only once the panel steps aside, or
 * at once on Enter), so a keystroke costs the two reads of this panel and
 * not a third for a list nobody can see.
 *
 * A COMBOBOX, SAID OUT LOUD. The page's input is `role="combobox"` and names
 * ONE listbox that owns nothing but options and groups: the «ابحث في…» chip
 * and the suggestions in one group, each section a group named by its plain
 * heading text with «الكل» as its last option, the recent terms (each term,
 * its «×», and «مسح السجل») and the trending tags as groups of the empty
 * state. The skeleton, an error, the «no results» copy and the live
 * announcements sit OUTSIDE the listbox. ↑/↓ walk every option in order
 * through `aria-activedescendant` (ids are positional or server ids, never a
 * typed term); Enter opens the row; Delete on a lit recent term forgets it;
 * Escape closes and gives focus back to the input. A card inside an option
 * is the row's one link — no follow pill lives in the panel (the card's page
 * has it), so the option's name is the card's text and nothing else.
 *
 * A PARALLEL WINDOW, NOT A MODAL. The Overlay primitive in `parallel` mode:
 * no scrim, no focus trap — the input outside the panel keeps the caret. A
 * phone gets a docked, full-height panel under the bar on the `sheet` spring
 * (and the page behind it is locked, which also tucks the bottom nav away);
 * from `sm` a centred panel on the `ui` spring. The results block is ONE
 * stable node: a new answer reconciles its rows by id and only its opacity
 * moves (CROSS_FADE) while a fresher answer is on its way — rows never
 * remount or re-animate on a keystroke. Reduced motion: fades.
 *
 * NOTHING IS TRACKED. Recent terms are this browser's (recent.ts) — the term
 * that was searched, or the suggestion that was chosen, never a fragment;
 * trending is one five-minute read shared with the home (api.ts).
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { Clock, Hash, PackageSearch, Search, X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { isAborted } from '../../../lib/api';
import { CROSS_FADE } from '../../../lib/motion';
import { useIsPhone } from '../../../lib/useMediaQuery';
import { productName } from '../../../lib/productText';
import { Overlay, acquireModalLock } from '../../ui/Overlay';
import { ErrorState } from '../../ui/AsyncStates';
import { acceptOnChange, acceptOnKey, ghostFor, ghostLayers, textDirection } from '../../search/ghost';
import ProjectCard from '../projects/ProjectCard';
import CreatorCard from '../hub/CreatorCard';
import StoreCard from '../hub/StoreCard';
import ProductTile from '../hub/ProductTile';
import RequestCard from '../hub/RequestCard';
import { ProjectRailSkeleton, Rail, StoreListSkeleton } from '../hub/parts';
import { hubLang } from '../hub/strings';
import { useStoreFollow } from '../hub/useStoreFollow';
import { useSocial } from '../social/SocialContext';
import { SEARCH_TYPES, cleanTerm, hasAnyRow, searchApi, useTrending, type CatalogueRow, type SearchAnswer, type SearchType, type Suggestion } from './api';
import { clearRecent, forgetRecent, readRecent, rememberRecent, type RecentTerm } from './recent';
import { SEARCH_LIST_ID } from './useSearchBox';
import { boundedCount, fillIn, useSearchStrings } from './strings';

export interface SearchOverlayProps {
  open: boolean;
  /** What is in the box right now. */
  value: string;
  /** The box's own setter — a completion accepted here lands in the box. */
  onChange: (next: string) => void;
  /** Enter with nothing highlighted: the page writes `?q=` on its tab and closes. */
  onSubmit: (term: string) => void;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** The search bar's form: the grey completion is drawn inside it. */
  barRef: React.RefObject<HTMLFormElement | null>;
  /** The list Enter searches — «المشاريع», «المتاجر»… */
  scopeLabel: string;
}

const SUGGEST_DEBOUNCE_MS = 200;
const SEARCH_DEBOUNCE_MS = 300;
const PER_SECTION = 6;

const CHIP = 'lv-choice inline-flex shrink-0 items-center gap-1.5 px-3 text-[12.5px]';
const OPTION_RING = 'ring-2 ring-focus';
/** A text link or button that is an option row: a 44 px target that keeps the line's rhythm. */
const TEXT_ROW = '-my-1 inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 font-semibold focus-visible:outline-none';
/** The heading of a group: plain text, never a heading element (a listbox owns options and groups only). */
const GROUP_HEAD = 'flex items-center gap-1.5 text-[12.5px] font-semibold text-text-muted';
const RECENT_PREFIX = `${SEARCH_LIST_ID}-recent-`;
const RECENT_HINT_ID = `${SEARCH_LIST_ID}-recent-hint`;

export default function SearchOverlay({ open, value, onChange, onSubmit, onClose, inputRef, barRef, scopeLabel }: SearchOverlayProps) {
  const { lang, dir } = useLanguage();
  const s = useSearchStrings();
  const phone = useIsPhone();
  const social = useSocial();
  const follow = useStoreFollow();
  const term = cleanTerm(value);
  const asking = term.length >= 2;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** What the screen reader hears next: the results' counts, the grey word, a forgotten term. */
  const [announcement, setAnnouncement] = useState('');

  // ------------------------------------------------------------ the reads

  const [sugg, setSugg] = useState<{ q: string; rows: Suggestion[] }>({ q: '', rows: [] });
  useEffect(() => {
    if (!open || !asking) return;
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      searchApi
        .suggest(term, { signal: ac.signal })
        .then((rows) => setSugg({ q: term, rows }))
        .catch(() => {
          /* a suggestion that did not arrive is nothing to say */
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [open, asking, term]);

  const [answer, setAnswer] = useState<{ q: string; data: SearchAnswer | null; error: unknown; loading: boolean }>({ q: '', data: null, error: null, loading: false });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!open || !asking) {
      setAnswer((a) => (a.loading ? { ...a, loading: false } : a));
      return;
    }
    setAnswer((a) => ({ ...a, loading: true, error: null }));
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      searchApi
        .search(term, { limit: PER_SECTION, signal: ac.signal })
        .then((data) => setAnswer({ q: term, data, error: null, loading: false }))
        .catch((e: unknown) => {
          if (isAborted(e)) return;
          setAnswer({ q: term, data: null, error: e, loading: false });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [open, asking, term, nonce]);

  const [recent, setRecent] = useState<RecentTerm[]>(() => readRecent());
  useEffect(() => {
    if (open) setRecent(readRecent());
  }, [open]);
  const trending = useTrending();

  // The highlight belongs to one answer: a new term or a new answer clears it.
  useEffect(() => setActiveId(null), [term, answer.q, open]);

  // The answer, said: how many of each, or that there is nothing.
  useEffect(() => {
    const a = answer.data;
    if (!open || !a || answer.loading || a.q !== term) return;
    if (!hasAnyRow(a)) {
      setAnnouncement(fillIn(s.noResultsFor, { q: a.q }));
      return;
    }
    const parts = SEARCH_TYPES.filter((t) => a.sections[t].rows.length > 0).map((t) => {
      const total = a.sections[t].total;
      return total === null ? s.sections[t] : `${s.sections[t]}: ${boundedCount(total, hubLang(lang))}`;
    });
    setAnnouncement(parts.join(' · '));
  }, [open, answer.data, answer.loading, term, s, lang]);

  // ------------------------------------------------------------ the ghost

  const textDir = textDirection(value, dir);
  const ghostSource = useMemo(() => (asking && sugg.q === term ? sugg.rows.find((r) => ghostFor(value, r.text, textDir)) : undefined), [asking, sugg, term, value, textDir]);
  const ghost = ghostSource ? ghostFor(value, ghostSource.text, textDir) : '';
  // The shared suffix skips the marks after the typed letter — and a space
  // with them, since a catalogue word has none. A project title does, so the
  // DRAWN tail gets its space back; what a key accepts stays the shared word.
  const drawn = ghost && ghostSource && !/^\s/.test(ghost) && /\s/.test(ghostSource.text.charAt(ghostSource.text.length - ghost.length - 1)) ? ` ${ghost}` : ghost;
  const layers = ghostLayers(value, drawn);

  // The grey word, said once when it appears.
  const ghostText = ghostSource?.text ?? '';
  useEffect(() => {
    if (open && ghostText) setAnnouncement(fillIn(s.completes, { text: ghostText }));
  }, [open, ghostText, s]);

  // The input lays its text out the way the typed script runs, and the mirror
  // with it, so the grey tail sits right after the caret. Closing leaves the
  // box on `dir="auto"` (what the page gives it), which resolves the same
  // way for the text that stays in it — the letters do not jump across the
  // field the instant the panel goes.
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !open) return;
    el.dir = textDir;
    return () => {
      el.dir = 'auto';
    };
  }, [open, textDir, inputRef]);

  const [mirror, setMirror] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !open) return;
    const cs = getComputedStyle(el);
    setMirror({ fontSize: cs.fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing });
  }, [open, inputRef]);

  // ------------------------------------------------------------ the keyboard

  /** Every row of the panel, in reading order. */
  const options = useCallback(() => Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []), []);

  /** Open a row the way a click would: the row itself when it is a link or a button, else its first link. */
  const activate = useCallback((row: HTMLElement) => {
    const target = row.matches('a[href],button') ? row : row.querySelector<HTMLElement>('a[href],button');
    target?.click();
  }, []);

  const close = useCallback(() => {
    onClose();
    // Escape from a control inside the panel: the caret goes back to the box.
    if (panelRef.current?.contains(document.activeElement)) inputRef.current?.focus({ preventScroll: true });
  }, [onClose, inputRef]);

  /** Forgets one recent term and says so. */
  const forget = useCallback(
    (t: string) => {
      forgetRecent(t);
      setRecent(readRecent());
      setActiveId(null);
      setAnnouncement(fillIn(s.removedRecent, { q: t }));
    },
    [s]
  );

  const latest = useRef({ value, ghost, ghostSource, activeId, textDir, recent });
  latest.current = { value, ghost, ghostSource, activeId, textDir, recent };

  useEffect(() => {
    const el = inputRef.current;
    if (!el || !open) return;
    const atEnd = () => el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const { value: v, ghost: g, ghostSource: src, activeId: active, textDir: td, recent: terms } = latest.current;
      const accepted = acceptOnKey(e.key, v, g, td, atEnd(), src?.text);
      if (accepted !== null) {
        e.preventDefault();
        onChange(accepted);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = options();
        if (rows.length === 0) return;
        const i = rows.findIndex((r) => r.id === active);
        let next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        if (next >= rows.length) next = -1;
        if (next < -1) next = rows.length - 1;
        setActiveId(next < 0 ? null : rows[next].id);
        return;
      }
      if (e.key === 'Enter' && active) {
        const row = document.getElementById(active);
        if (row) {
          e.preventDefault();
          activate(row);
        }
        return;
      }
      // Delete — or Backspace over an empty box — on a lit recent term forgets it.
      if ((e.key === 'Delete' || (e.key === 'Backspace' && v === '')) && active && active.startsWith(RECENT_PREFIX)) {
        const i = Number(active.slice(RECENT_PREFIX.length).replace(/-x$/, ''));
        const t = terms[i]?.term;
        if (t) {
          e.preventDefault();
          forget(t);
        }
        return;
      }
      if (e.key === 'Escape') {
        // Also stops a search input's native «Escape clears the text».
        e.preventDefault();
        close();
      }
    };
    // Space takes the grey word — read from the edit, not the key, because
    // phone keyboards report most keys as `Unidentified` (search/ghost.ts).
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType !== 'insertText' || e.data !== ' ') return;
      const { value: v, ghost: g, ghostSource: src } = latest.current;
      if (!g || !atEnd()) return;
      const accepted = acceptOnChange(v, `${v} `, g, src?.text);
      if (accepted === null) return;
      e.preventDefault();
      onChange(accepted);
    };
    el.addEventListener('keydown', onKey);
    el.addEventListener('beforeinput', onBeforeInput);
    return () => {
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('beforeinput', onBeforeInput);
    };
  }, [open, inputRef, onChange, options, activate, close, forget]);

  // The input says which row is lit, and the row stays in view.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (activeId && open) {
      el.setAttribute('aria-activedescendant', activeId);
      document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
    } else el.removeAttribute('aria-activedescendant');
  }, [activeId, open, inputRef]);

  // A tap or a focus outside the panel and the bar closes it.
  useEffect(() => {
    if (!open) return;
    const outside = (t: EventTarget | null) => {
      const n = t as Node | null;
      return !!n && !panelRef.current?.contains(n) && !barRef.current?.contains(n);
    };
    const onDown = (e: PointerEvent) => {
      if (outside(e.target)) onClose();
    };
    const onFocus = (e: FocusEvent) => {
      if (outside(e.target)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open, onClose, barRef]);

  // On a phone the panel is the screen: the page behind it holds still and
  // the bottom nav steps aside (the same lock every sheet takes).
  useEffect(() => {
    if (!open || !phone) return;
    return acquireModalLock();
  }, [open, phone]);

  // ------------------------------------------------------------ the rows

  /**
   * A row was chosen. What the browser remembers is the row's own word when
   * it has one (`data-search-remember`: a suggestion's text, a tag), else the
   * term that found it — never the half-typed fragment behind a suggestion.
   */
  const pick = (row: Element) => {
    const own = row.getAttribute('data-search-remember');
    if (own !== null) rememberRecent(own);
    else if (asking) rememberRecent(term);
    onClose();
  };
  const submit = () => {
    rememberRecent(term);
    onSubmit(term);
  };

  /** A card as a row of the listbox: the option wraps it, the highlight is a ring. */
  const opt = (id: string, node: React.ReactNode, className = '') => (
    <div
      key={id}
      id={id}
      role="option"
      aria-selected={activeId === id}
      data-search-pick=""
      onPointerEnter={() => setActiveId(id)}
      className={`rounded-2xl ${activeId === id ? OPTION_RING : ''} ${className}`}
    >
      {node}
    </div>
  );
  const chipState = (id: string) => ({ id, role: 'option' as const, 'aria-selected': activeId === id, 'data-selected': activeId === id ? 'true' : undefined, onPointerEnter: () => setActiveId(id) });

  /** A section's heading: plain text (a listbox owns options and groups only), the count beside it. */
  const groupHead = (type: SearchType, total: number | null) => (
    <span id={`${SEARCH_LIST_ID}-h-${type}`} className="flex items-baseline gap-2 text-[15px] font-black leading-tight text-text-primary">
      {s.sections[type]}
      {total !== null && <span className="text-[12px] font-medium tabular-nums text-text-muted">{boundedCount(total, hubLang(lang))}</span>}
    </span>
  );

  /** «الكل» — the group's last option, to the page or tab that lists the rest with the term. */
  const seeAll = (type: SearchType, more: string) => {
    const id = `${SEARCH_LIST_ID}-all-${type}`;
    return (
      <Link
        to={more}
        {...chipState(id)}
        tabIndex={-1}
        data-search-pick=""
        data-search-more={type}
        className={`${TEXT_ROW} -me-2 text-[12.5px] text-sage hover:underline ${activeId === id ? OPTION_RING : ''}`}
      >
        {s.seeAll}
      </Link>
    );
  };

  const hidden = (authorId: string) => social.blocked.has(authorId) || social.muted.has(authorId);

  const sectionBody = (type: SearchType, a: SearchAnswer): React.ReactNode => {
    const S = a.sections;
    switch (type) {
      case 'projects': {
        const rows = S.projects.rows.filter((p) => !hidden(p.author.id));
        if (rows.length === 0) return null;
        return (
          <Rail>
            {rows.map((p, i) =>
              opt(`${SEARCH_LIST_ID}-projects-${p.id}`, <ProjectCard post={p} variant="rail" eager={i < 3} />, 'shrink-0 snap-start')
            )}
          </Rail>
        );
      }
      case 'stores':
        // No follow pill inside an option: the store's page has it.
        return (
          <div className="flex flex-col gap-2">
            {S.stores.rows.map((raw) => {
              const m = follow.view(raw);
              return opt(`${SEARCH_LIST_ID}-stores-${m.id}`, <StoreCard store={m} canFollow={false} busy={false} onToggleFollow={follow.toggle} />);
            })}
          </div>
        );
      case 'creators': {
        const rows = S.creators.rows.filter((c) => !hidden(c.id));
        if (rows.length === 0) return null;
        return <div className="flex flex-col gap-2">{rows.map((c) => opt(`${SEARCH_LIST_ID}-creators-${c.id}`, <CreatorCard creator={c} follow={false} />))}</div>;
      }
      case 'products':
        return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{S.products.rows.map((p) => opt(`${SEARCH_LIST_ID}-products-${p.id}`, <ProductTile product={p} />, 'min-w-0'))}</div>;
      case 'requests':
        return <div className="flex flex-col">{S.requests.rows.map((r) => opt(`${SEARCH_LIST_ID}-requests-${r.id}`, <RequestCard request={r} compact />, 'rounded-none'))}</div>;
      case 'materials':
      case 'brands':
        return (
          <div className="flex flex-wrap gap-2">
            {S[type].rows.map((row: CatalogueRow) => {
              const id = `${SEARCH_LIST_ID}-${type}-${row.id}`;
              return (
                <Link key={id} to={row.href} {...chipState(id)} tabIndex={-1} data-search-pick="" className={CHIP}>
                  {row.imageUrl && <img src={row.imageUrl} alt="" loading="lazy" decoding="async" className="h-5 w-5 rounded-full object-cover" />}
                  <bdi>{productName(row, lang)}</bdi>
                </Link>
              );
            })}
          </div>
        );
    }
  };

  /** The trending tags as a group of options; `head` is the group's own label, else the caller's. */
  const trendingGroup = (head: React.ReactNode | null, labelledBy = `${SEARCH_LIST_ID}-h-trending`) =>
    trending && trending.tags.length > 0 ? (
      <div role="group" aria-labelledby={labelledBy} data-search-trending="">
        {head}
        <div className="flex flex-wrap gap-2">
          {trending.tags.slice(0, 12).map((t, i) => {
            const id = `${SEARCH_LIST_ID}-tag-${i}`;
            return (
              <Link key={id} to={`/community/projects?tag=${encodeURIComponent(t.tag)}`} {...chipState(id)} tabIndex={-1} data-search-pick="" data-search-remember={t.tag} className={CHIP}>
                <span dir="auto">#{t.tag}</span>
                {t.count > 0 && <span className="tabular-nums text-text-muted">{t.count}</span>}
              </Link>
            );
          })}
        </div>
      </div>
    ) : null;

  const trendingHead = (
    <span id={`${SEARCH_LIST_ID}-h-trending`} className={`mb-2 ${GROUP_HEAD}`}>
      <Hash aria-hidden="true" className="h-3.5 w-3.5" />
      {s.trendingTags}
    </span>
  );

  // The listbox's rows and what sits beside it (never inside it).
  let list: React.ReactNode;
  let aside: React.ReactNode = null;
  if (!asking) {
    const clearId = `${SEARCH_LIST_ID}-recent-clear`;
    list = (
      <>
        {recent.length > 0 && (
          <div role="group" aria-labelledby={`${SEARCH_LIST_ID}-h-recent`} data-search-recent="">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span id={`${SEARCH_LIST_ID}-h-recent`} className={GROUP_HEAD}>
                <Clock aria-hidden="true" className="h-3.5 w-3.5" />
                {s.recent}
              </span>
              <button
                type="button"
                {...chipState(clearId)}
                tabIndex={-1}
                data-search-clear-recent=""
                onClick={() => {
                  clearRecent();
                  setRecent([]);
                  setActiveId(null);
                }}
                className={`${TEXT_ROW} text-[12px] text-text-secondary hover:text-text-primary ${activeId === clearId ? OPTION_RING : ''}`}
              >
                {s.clearRecent}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {recent.map((r, i) => {
                const id = `${RECENT_PREFIX}${i}`;
                const removeId = `${id}-x`;
                return (
                  <span key={r.term} className="inline-flex items-center">
                    <button type="button" {...chipState(id)} tabIndex={-1} aria-describedby={RECENT_HINT_ID} data-search-recent-term="" onClick={() => onChange(r.term)} className={`${CHIP} rounded-e-none`}>
                      <span dir="auto">{r.term}</span>
                    </button>
                    <button
                      type="button"
                      {...chipState(removeId)}
                      tabIndex={-1}
                      aria-label={fillIn(s.removeRecent, { q: r.term })}
                      onClick={() => forget(r.term)}
                      className="lv-choice inline-flex min-w-11 items-center justify-center rounded-s-none border-s-0"
                    >
                      <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {trendingGroup(trendingHead)}
      </>
    );
    if (recent.length === 0 && !(trending && trending.tags.length > 0)) aside = <p className="text-[13px] text-text-muted">{s.typeMore}</p>;
  } else {
    const submitId = `${SEARCH_LIST_ID}-submit`;
    const suggestions = sugg.q === term ? sugg.rows : [];
    const stale = answer.loading && answer.data !== null;
    const a = answer.data;
    let results: React.ReactNode = null;
    if (answer.error && !answer.loading) {
      aside = <ErrorState error={answer.error} compact onRetry={() => setNonce((n) => n + 1)} />;
    } else if (!a) {
      aside = (
        <div className="flex flex-col gap-4" aria-hidden="true" data-search-loading="">
          <ProjectRailSkeleton count={3} />
          <StoreListSkeleton count={2} />
        </div>
      );
    } else if (!hasAnyRow(a)) {
      // «No results» is the trending group's own heading, so the copy and
      // the chips it points to are one thing — and nothing but options and
      // groups is inside the list.
      const noneId = `${SEARCH_LIST_ID}-h-none`;
      results = (
        <div data-search-none="">
          {trendingGroup(
            <span id={noneId} className="mb-3 flex flex-col items-center gap-2 py-4 text-center">
              <PackageSearch aria-hidden="true" className="h-6 w-6 text-text-muted" />
              <span className="text-[14.5px] font-bold text-text-primary">{fillIn(s.noResultsFor, { q: a.q })}</span>
              <span className="text-[12.5px] text-text-secondary">{s.tryShorter}</span>
            </span>,
            noneId
          ) ?? (
            <span id={noneId} className="flex flex-col items-center gap-2 py-6 text-center">
              <PackageSearch aria-hidden="true" className="h-6 w-6 text-text-muted" />
              <span className="text-[14.5px] font-bold text-text-primary">{fillIn(s.noResultsFor, { q: a.q })}</span>
              <span className="text-[12.5px] text-text-secondary">{s.tryShorter}</span>
            </span>
          )}
        </div>
      );
    } else {
      results = (
        <motion.div animate={{ opacity: stale ? 0.6 : 1 }} transition={CROSS_FADE} className="flex flex-col gap-6" data-search-sections="">
          {SEARCH_TYPES.map((type) => {
            const sec = a.sections[type];
            if (sec.rows.length === 0) return null;
            const rows = sectionBody(type, a);
            if (!rows) return null;
            return (
              <div key={type} role="group" aria-labelledby={`${SEARCH_LIST_ID}-h-${type}`} data-search-section={type}>
                <div className="mb-2 flex items-end justify-between gap-3">
                  {groupHead(type, sec.total)}
                  {seeAll(type, sec.more)}
                </div>
                {rows}
              </div>
            );
          })}
        </motion.div>
      );
    }
    list = (
      <>
        <div role="group" aria-label={s.suggestions} className="flex flex-wrap gap-2">
          <button type="button" {...chipState(submitId)} tabIndex={-1} onClick={submit} data-search-submit="" className={`${CHIP} font-semibold`}>
            <Search aria-hidden="true" className="h-3.5 w-3.5" />
            <span dir="auto">{fillIn(s.searchIn, { q: term, tab: scopeLabel })}</span>
          </button>
          {suggestions.map((sg, i) => {
            const id = `${SEARCH_LIST_ID}-sug-${i}`;
            return (
              <Link key={id} to={sg.href} {...chipState(id)} tabIndex={-1} data-search-pick="" data-search-suggestion={sg.type} data-search-remember={sg.text} className={CHIP}>
                <span dir="auto">{sg.type === 'tag' ? `#${sg.text}` : sg.text}</span>
                <span className="sr-only">{s.types[sg.type] ?? ''}</span>
              </Link>
            );
          })}
        </div>
        {results}
      </>
    );
  }

  const bar = barRef.current;
  return (
    <>
      {open && bar
        ? createPortal(
            <div aria-hidden="true" dir={textDir} style={mirror} className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre rounded-full border border-transparent ps-10 pe-10">
              <span className="invisible">{layers.typed}</span>
              <span className="text-text-muted" data-search-ghost>
                {layers.tail}
              </span>
            </div>,
            bar
          )
        : null}
      <Overlay
        open={open}
        onClose={close}
        mode="parallel"
        trapFocus={false}
        restoreFocus={false}
        placement={phone ? 'dock' : 'top'}
        initialFocus={inputRef}
        label={s.panel}
        testId="community-search"
        className="pointer-events-none"
        panelClassName={phone ? 'pointer-events-auto flex h-[calc(100%-4rem)] w-full flex-col pb-[env(safe-area-inset-bottom)]' : 'pointer-events-auto mt-14 flex max-h-[min(72vh,42rem)] w-full max-w-2xl flex-col'}
      >
        <div
          ref={panelRef}
          data-search-panel=""
          className="flex min-h-0 flex-1 flex-col"
          // Keeps the caret in the box while a row is tapped.
          onMouseDown={(e) => e.preventDefault()}
          onClickCapture={(e) => {
            const row = (e.target as HTMLElement).closest('[data-search-pick]');
            if (row && panelRef.current?.contains(row)) pick(row);
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4">
            {/* Said, not shown: the counts, the grey word, a forgotten term. */}
            <div className="sr-only" aria-live="polite">
              {announcement}
            </div>
            <span id={RECENT_HINT_ID} className="sr-only">
              {s.deleteHint}
            </span>
            <div id={SEARCH_LIST_ID} role="listbox" aria-label={s.panel} aria-busy={answer.loading || undefined} className={`flex flex-col ${asking ? 'gap-4' : 'gap-5'}`}>
              {list}
            </div>
            {aside}
          </div>
        </div>
      </Overlay>
    </>
  );
}
