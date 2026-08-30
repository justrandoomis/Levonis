import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, Star, RefreshCw, ChevronRight } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

/**
 * "My reviews" profile tab — REAL data from GET /api/reviews/mine (the
 * signed-in user's reviews with moderation + reward state). Replaces the
 * previous hardcoded "coming soon" placeholder that existed despite the
 * endpoint being live. Honest loading / error+retry / empty / guest states.
 */

interface MyReview {
  id: string;
  product_name: string | null;
  product_name_ar: string | null;
  product_slug: string | null;
  stars: number;
  body: string;
  status: 'pending' | 'published' | 'rejected' | string;
  moderation_note: string;
  created_at: string;
  reward: {
    kind: 'printer_gift' | 'points' | string;
    state: string;
    points_awarded: number;
  } | null;
}

const STRINGS = {
  ar: {
    signIn: 'سجل الدخول لعرض مراجعاتك',
    signInCta: 'تسجيل الدخول',
    empty: 'لا توجد مراجعات بعد — يمكنك كتابة مراجعة من صفحة أي منتج استلمته.',
    error: 'تعذر تحميل مراجعاتك.',
    retry: 'إعادة المحاولة',
    status: { pending: 'قيد المراجعة', published: 'منشورة', rejected: 'مرفوضة' } as Record<string, string>,
    pointsAwarded: (n: number) => `+${n} نقطة`,
    giftReward: 'مكافأة هدية',
    viewProduct: 'عرض المنتج',
  },
  en: {
    signIn: 'Sign in to see your reviews',
    signInCta: 'Sign in',
    empty: 'No reviews yet — you can write one from the page of any product you received.',
    error: 'Could not load your reviews.',
    retry: 'Retry',
    status: { pending: 'Under review', published: 'Published', rejected: 'Rejected' } as Record<string, string>,
    pointsAwarded: (n: number) => `+${n} points`,
    giftReward: 'Gift reward',
    viewProduct: 'View product',
  },
  ckb: {
    signIn: 'بچۆ ژوورەوە بۆ بینینی پێداچوونەوەکانت',
    signInCta: 'چوونەژوورەوە',
    empty: 'هێشتا هیچ پێداچوونەوەیەک نییە — دەتوانیت لە پەڕەی هەر بەرهەمێک کە وەرتگرتووە بینووسیت.',
    error: 'پێداچوونەوەکانت بار نەبوون.',
    retry: 'هەوڵدانەوە',
    status: { pending: 'لە پێداچوونەوەدایە', published: 'بڵاوکراوەتەوە', rejected: 'ڕەتکراوەتەوە' } as Record<string, string>,
    pointsAwarded: (n: number) => `+${n} خاڵ`,
    giftReward: 'خەڵاتی دیاری',
    viewProduct: 'بینینی بەرهەم',
  },
};

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  published: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

export default function MyReviewsTab({ isAuthenticated }: { isAuthenticated: boolean }) {
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const s = STRINGS[lang] ?? STRINGS.ar;

  const [reviews, setReviews] = useState<MyReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const d = await api.get<{ reviews: MyReview[] }>('/api/reviews/mine');
      setReviews(d.reviews || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.error);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, s.error]);

  useEffect(() => {
    load();
  }, [load]);

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" aria-hidden="true" />
        <p className="text-[13px] font-medium mb-3">{s.signIn}</p>
        <button
          type="button"
          onClick={() => navigate('/auth?next=%2Fprofile')}
          className="min-h-[44px] px-6 rounded-xl bg-olive text-[#BAA369] text-[13px] font-bold hover:opacity-90 active:opacity-75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
        >
          {s.signInCta}
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12" role="status" aria-busy="true">
        <div className="w-7 h-7 border-2 border-[#BAA369]/20 border-t-[#BAA369] rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <p className="text-[13px] text-red-500 mb-3">{error}</p>
        <button
          type="button"
          onClick={load}
          className="min-h-[44px] px-6 inline-flex items-center gap-1.5 rounded-xl border border-black/10 dark:border-white/15 text-[13px] font-bold text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" />
          {s.retry}
        </button>
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-500">
        <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" aria-hidden="true" />
        <p className="text-[13px] font-medium px-6 leading-relaxed">{s.empty}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {reviews.map((r) => {
        // §3/§12: the product name is English in every language and is never translated.
        const name = r.product_name || '';
        const statusCls = STATUS_STYLES[r.status] ?? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => {
              if (r.product_slug) navigate(`/product/${r.product_slug}`);
            }}
            className="bg-white dark:bg-[#1a1a1a] rounded-[10px] p-3 text-start shadow-sm border border-black/5 dark:border-white/5 text-black dark:text-white hover:bg-black/[0.02] dark:hover:bg-white/[0.03] active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="font-bold text-[13px] truncate">{name}</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 ${statusCls}`}>
                {s.status[r.status] ?? r.status}
              </span>
            </div>
            <div className="flex items-center gap-0.5 mb-1.5" aria-label={`${r.stars}/5`}>
              {[1, 2, 3, 4, 5].map((i) => (
                <Star
                  key={i}
                  className={`w-3.5 h-3.5 ${i <= r.stars ? 'text-[#BAA369] fill-[#BAA369]' : 'text-zinc-300 dark:text-zinc-700'}`}
                  aria-hidden="true"
                />
              ))}
            </div>
            <p className="text-[12px] text-zinc-600 dark:text-zinc-400 line-clamp-2 leading-snug mb-1.5">{r.body}</p>
            <div className="flex items-center justify-between text-[10px] text-zinc-500">
              <span>{fmtDate(r.created_at)}</span>
              <span className="flex items-center gap-1">
                {r.reward?.state === 'approved' && r.reward.kind === 'points' && r.reward.points_awarded > 0 && (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                    {s.pointsAwarded(r.reward.points_awarded)}
                  </span>
                )}
                {r.reward?.state === 'approved' && r.reward.kind === 'printer_gift' && (
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">{s.giftReward}</span>
                )}
                {r.product_slug && (
                  <span className="flex items-center gap-0.5">
                    {s.viewProduct}
                    <ChevronRight className={`w-3 h-3 ${dir === 'rtl' ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </span>
                )}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
