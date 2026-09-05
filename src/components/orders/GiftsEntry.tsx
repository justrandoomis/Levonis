/**
 * The quiet way into /gifts — the review "rating gifts" screen, which was
 * mounted and linked from nowhere. One row; the count appears only when the
 * server said there is something to redeem.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gift, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { asLang } from './format';

const STRINGS = {
  ar: { title: 'هدايا التقييم', available: (n: number) => (n === 1 ? 'هدية واحدة متاحة' : n === 2 ? 'هديتان متاحتان' : `${n} هدايا متاحة`) },
  en: { title: 'Rating gifts', available: (n: number) => (n === 1 ? '1 available' : `${n} available`) },
  ckb: { title: 'دیاری هەڵسەنگاندن', available: (n: number) => `${n} بەردەست` },
} as const;

export default function GiftsEntry({ className = '' }: { className?: string }) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ gifts: Array<{ state: string }> }>('/api/reviews/gifts')
      .then((r) => alive && setCount((r.gifts || []).filter((g) => g.state === 'available').length))
      .catch(() => alive && setCount(null));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Link
      to="/gifts"
      data-gifts-entry
      className={`flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 min-h-[52px] hover:bg-zinc-800/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] ${className}`}
    >
      <Gift className="w-4 h-4 text-[#BAA369] shrink-0" aria-hidden />
      <span className="flex-1 min-w-0 text-[13px] text-zinc-300 truncate">{s.title}</span>
      {count !== null && count > 0 && (
        <span className="text-[11px] font-bold text-[#BAA369] tabular-nums shrink-0" data-gifts-count={count}>
          {s.available(count)}
        </span>
      )}
      <ChevronRight className="w-4 h-4 text-zinc-600 rtl:rotate-180 shrink-0" aria-hidden />
    </Link>
  );
}
