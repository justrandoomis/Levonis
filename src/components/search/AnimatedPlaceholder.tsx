import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { popularLabel } from './popularLabel';

/**
 * THE PLACEHOLDER THAT TYPES THE SHOP'S POPULAR PRODUCTS (owner, 2026-11-18:
 * «the [search products] show instead animation of popular products»).
 *
 * While the field is empty it reads «ابحث عن  Bambu Lab A1|», typing one
 * popular product's short name, holding it, erasing it, and typing the next
 * (`GET /api/search/popular`: chosen from search this week, then the best
 * sellers). It is drawn UNDER the transparent input exactly where the
 * native placeholder would be (same padding and line box, passed in), and
 * `aria-hidden`: the input keeps its own label, so a screen reader hears
 * «بحث», never a word typed letter by letter.
 *
 * Under reduced motion the names change in place every few seconds, untyped.
 * It stops while the tab is hidden, and the request is one per page view
 * (memoised in the module), cached by the browser for five minutes.
 *
 * A LAZY CHUNK, mounted after the first paint (./LiveSearch.tsx): until it
 * lands, and if it fails or the list is empty, the field shows its ordinary
 * placeholder — `onReady` tells the field when to hand the space over.
 */

let memo: Promise<string[]> | null = null;
export function loadPopular(): Promise<string[]> {
  memo ??= api
    .get<{ items?: Array<{ term?: string }> }>('/api/search/popular', { mascot: 'silent' })
    .then((d) => [...new Set((d.items ?? []).map((i) => popularLabel(String(i.term ?? ''))).filter(Boolean))])
    .catch(() => {
      memo = null;
      return [];
    });
  return memo;
}

const TYPE_MS = 55;
const ERASE_MS = 28;
const HOLD_MS = 1700;
const GAP_MS = 350;
const STILL_MS = 3200;

export default function AnimatedPlaceholder({
  style,
  className,
  onReady,
}: {
  style: React.CSSProperties;
  className: string;
  onReady: (ready: boolean) => void;
}) {
  const { loc } = useLanguage();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [terms, setTerms] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const [phase, setPhase] = useState<'type' | 'hold' | 'erase' | 'gap'>('type');
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);

  useEffect(() => {
    let alive = true;
    void loadPopular().then((list) => {
      if (!alive) return;
      setTerms(list);
      onReady(list.length > 0);
    });
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      onReady(false);
    };
    // onReady is the field's setter: stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const term = terms.length ? terms[index % terms.length] : '';

  useEffect(() => {
    if (!term || !visible) return;
    if (reduced) {
      setShown(term.length);
      const t = window.setTimeout(() => setIndex((i) => i + 1), STILL_MS);
      return () => window.clearTimeout(t);
    }
    let t: number;
    if (phase === 'type') {
      t = shown < term.length ? window.setTimeout(() => setShown((n) => n + 1), TYPE_MS) : window.setTimeout(() => setPhase('hold'), 0);
    } else if (phase === 'hold') {
      t = window.setTimeout(() => setPhase('erase'), HOLD_MS);
    } else if (phase === 'erase') {
      t = shown > 0 ? window.setTimeout(() => setShown((n) => n - 1), ERASE_MS) : window.setTimeout(() => setPhase('gap'), 0);
    } else {
      t = window.setTimeout(() => {
        setIndex((i) => i + 1);
        setPhase('type');
      }, GAP_MS);
    }
    return () => window.clearTimeout(t);
  }, [term, phase, shown, reduced, visible]);

  if (!term) return null;
  return (
    <div aria-hidden="true" style={style} data-testid="search-animated-placeholder" className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre text-text-muted ${className}`}>
      {loc('ابحث عن ', 'Search for ', 'بگەڕێ بۆ ')}
      <bdi dir="ltr" className="text-text-secondary">
        {term.slice(0, reduced ? term.length : shown)}
      </bdi>
      {!reduced && <span className="animate-pulse ms-0.5 inline-block h-4 w-px bg-current align-middle" />}
    </div>
  );
}
