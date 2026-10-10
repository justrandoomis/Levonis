/**
 * The quiet way into /gifts — «هداياي». One row; the count appears only when
 * the server said there is something for the customer to do (choose, redeem,
 * add to cart, or open an old review box).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gift, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { asLang } from './format';

const STRINGS = {
  ar: { title: 'هداياي', available: (n: number) => (n === 1 ? 'هدية بانتظارك' : n === 2 ? 'هديتان بانتظارك' : `${n} هدايا بانتظارك`) },
  en: { title: 'My gifts', available: (n: number) => (n === 1 ? '1 waiting' : `${n} waiting`) },
  ckb: { title: 'دیارییەکانم', available: (n: number) => `${n} چاوەڕێتن` },
} as const;

/** The statuses that ask the customer to act (mirrors ACTIONABLE_GIFT_STATUSES in reviews/gifts/GiftCard.tsx). */
const ACTIONABLE = new Set(['GRANTED', 'READY_TO_REDEEM', 'REDEEMED']);

type Row = { status?: string; legacy?: { state?: string } | null };

export default function GiftsEntry({ className = '' }: { className?: string }) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ gifts: Row[] }>('/api/gifts')
      .then(
        (r) =>
          alive &&
          setCount((r.gifts || []).filter((g) => ACTIONABLE.has(String(g.status)) || (g.status === 'LEGACY' && g.legacy?.state === 'available')).length)
      )
      .catch(() => alive && setCount(null));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Link
      to="/gifts"
      data-gifts-entry
      className={`lv-surface flex items-center gap-3 px-4 min-h-[52px] hover:bg-surface-raised active:shadow-press transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
    >
      <Gift className="w-4 h-4 text-gold shrink-0" aria-hidden />
      <span className="flex-1 min-w-0 text-[13px] text-text-secondary truncate">{s.title}</span>
      {count !== null && count > 0 && (
        <span className="text-[11px] font-bold text-gold tabular-nums shrink-0" data-gifts-count={count}>
          {s.available(count)}
        </span>
      )}
      <ChevronRight className="w-4 h-4 text-text-muted rtl:rotate-180 shrink-0" aria-hidden />
    </Link>
  );
}
