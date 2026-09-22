import React, { useEffect, useState } from 'react';
import { Search, Plus, X } from 'lucide-react';
import SafeImage from '../ui/SafeImage';
import { Sheet } from '../ui/Overlay';
import { ErrorState } from '../ui/AsyncStates';
import { useLanguage } from '../../LanguageContext';
import {
  fetchCandidates,
  tri,
  type CompareLang,
  type CompareProductCard,
} from '../../lib/compare';
import { compareStrings, type CompareStrings } from './strings';

/**
 * PICKING A MACHINE IS ONE TAP.
 *
 * THE DEFECT THIS AVOIDS. The obvious second slot is a search box. It asks the
 * customer to type the name of a printer they half remember, in a shop whose
 * product names are half Latin and half Arabic, on a phone keyboard — and the
 * feature goes unused, because a comparison is something you reach for when you
 * are ALREADY looking at one machine and wondering about another. So the list
 * arrives already populated, from `GET /api/compare/candidates`, which ranks
 * same TYPE first and same SECTION first within that, and which never offers a
 * product with no spec sheet — a tap that ends in `COMPARE_NO_SPECS` is a tap
 * that teaches people not to tap.
 *
 * THE SEARCH BOX IS STILL THERE, and it is deliberately secondary: it filters a
 * list that was already useful, rather than being the only way in. The server
 * treats the text as a tie-breaker for the same reason — a search for «بامبو»
 * inside the printers still puts printers first.
 *
 * SIGNED-OUT WORKS. Neither endpoint is behind `requireAuth`, and nothing here
 * reads the session. A comparison is a reason to visit the shop; a sign-in wall
 * in front of it turns the page that answers «أي وحدة أشتري؟» into a page that
 * asks for an email address first.
 */

/** Long enough that a phone typist is not searching per keystroke, short
 *  enough that the list feels attached to the box. */
const SEARCH_DEBOUNCE_MS = 300;

export function CandidateGrid({
  cards,
  excluded,
  onPick,
  s,
}: {
  cards: CompareProductCard[];
  excluded: string[];
  onPick: (card: CompareProductCard) => void;
  s: CompareStrings;
}) {
  const { lang } = useLanguage();
  const l = lang as CompareLang;
  const offered = cards.filter((c) => !excluded.includes(c.id));

  if (offered.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-[13px] text-[var(--color-text-secondary)]">{s.pickNone}</p>
        <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">{s.pickNoneHint}</p>
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {offered.map((card) => (
        <li key={card.id}>
          {/* The whole row is the tap target, and it is a button rather than a
              link: choosing a machine changes THIS comparison, it does not
              navigate away from it. */}
          <button
            type="button"
            onClick={() => onPick(card)}
            className="lv-choice flex w-full items-center gap-3 p-2 text-start"
          >
            <SafeImage
              src={card.image}
              alt=""
              aspect="square"
              fit="contain"
              className="w-12 shrink-0 overflow-hidden rounded-[var(--radius-sm)]"
              bgClassName="bg-[var(--color-surface-raised)]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-bold text-[var(--color-text-primary)]">
                {tri(card.name, l)}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]">
                {card.section ? tri(card.section.label, l) : ''}
                {card.graded ? ` · ${s.graded}` : ''}
              </span>
            </span>
            <Plus aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function ProductPicker({
  open,
  onClose,
  anchorId,
  exclude,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** The machine the visitor arrived with; the ranking is relative to it.
   *  NULL asks for the catalogue instead — see fetchCandidates. */
  anchorId: string | null;
  exclude: string[];
  onPick: (card: CompareProductCard) => void;
}) {
  const { lang } = useLanguage();
  const s = compareStrings(lang);
  const [q, setQ] = useState('');
  const [cards, setCards] = useState<CompareProductCard[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  /** Re-asking the same question needs a dependency that changed; writing the
   *  same search term back does not. */
  const [attempt, setAttempt] = useState(0);

  // A fresh open is a fresh question: an old search term and an old list from a
  // previous slot would both be wrong for this one.
  useEffect(() => {
    if (!open) {
      setQ('');
      setCards(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    // A null anchor is not a reason to show nothing: it is the «إضافة طابعة»
    // case, and the server answers it with the catalogue. The guard used to be
    // `!anchorId` and that is why the sheet could only ever open from a
    // product page.
    if (!open) return;
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      fetchCandidates(anchorId, q, { signal: controller.signal, mascot: 'silent' })
        .then((res) => {
          setCards(res.products);
          setError(null);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setError(err);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, q ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, anchorId, q, attempt]);

  return (
    <Sheet open={open} onClose={onClose} label={s.pickTitle} panelClassName="max-h-[85dvh]">
      <div className="flex max-h-[85dvh] flex-col p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-[var(--color-text-primary)]">{s.pickTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={s.back}
            className="lv-button lv-button-ghost min-h-[44px] min-w-[44px] px-0"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        <label className="relative mt-3 block">
          <span className="sr-only">{s.pickSearch}</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={s.pickSearch}
            className="lv-input ps-10"
          />
        </label>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <ErrorState error={error} onRetry={() => setAttempt((n) => n + 1)} compact />
          ) : cards === null ? (
            <p aria-live="polite" className="py-6 text-center text-[12px] text-[var(--color-text-muted)]">
              {s.pickSearching}
            </p>
          ) : (
            <div aria-busy={busy}>
              <CandidateGrid cards={cards} excluded={exclude} onPick={onPick} s={s} />
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
