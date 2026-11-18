/**
 * «حدّك من هذا النوع» — the short note on a filament product page (owner
 * 2026-11-19; migration 0245): the account's limit for this filament kind per
 * window and what is left (GET /api/cart/filament-limit). Draws nothing for a
 * product that is not filament, a signed-out visitor, a rule switched off, or
 * a failed read — it is a note, never a gate (the cart and the checkout judge).
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { api } from '../../lib/api';

interface LimitAnswer {
  applies: boolean;
  tier?: string;
  window_days?: number;
  limit?: number | null;
  used?: number;
  remaining?: number | null;
  next_tier?: { tier: string; limit: number | null } | null;
}

const TIER_NAME: Record<string, string> = { plus: 'PLUS', prime: 'PREMIUM', pro: 'PRO' };

export default function FilamentLimitNote({ productId }: { productId: string }) {
  const { loc } = useLanguage();
  const [answer, setAnswer] = useState<LimitAnswer | null>(null);

  useEffect(() => {
    let live = true;
    setAnswer(null);
    api
      .get<LimitAnswer>(`/api/cart/filament-limit?productId=${encodeURIComponent(productId)}`)
      .then((r) => live && setAnswer(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [productId]);

  if (!answer?.applies || typeof answer.window_days !== 'number') return null;
  const days = answer.window_days;
  if (answer.limit === null || answer.limit === undefined) {
    return (
      <p className="text-[12px] text-text-muted" data-filament-limit-note="unlimited">
        {loc('لا حد لكمية هذا النوع من الفلامنت مع اشتراكك.', 'No limit on this filament kind with your membership.', 'لەگەڵ بەشدارییەکەت هیچ سنوورێک بۆ ئەم جۆرە فیلامێنتە نییە.')}
      </p>
    );
  }
  const limit = answer.limit;
  const left = Math.max(0, Number(answer.remaining ?? 0));
  const next = answer.next_tier && TIER_NAME[answer.next_tier.tier] ? answer.next_tier : null;
  const tier = next ? TIER_NAME[next.tier] : '';
  const up = !next
    ? ''
    : next.limit === null
      ? ' ' + loc(`اشترك في ${tier} لتشتري بلا حد.`, `Join ${tier} to buy without a limit.`, `بەشداری ${tier} بکە بۆ کڕینی بێسنوور.`)
      : ' ' + loc(`اشترك في ${tier} لترفعه إلى ${next.limit}.`, `Join ${tier} to raise it to ${next.limit}.`, `بەشداری ${tier} بکە بۆ ئەوەی بیگەیەنیتە ${next.limit}.`);
  return (
    <p className={`text-[12px] ${left === 0 ? 'text-warning font-semibold' : 'text-text-muted'}`} data-filament-limit-note={left}>
      {loc(
        `حدّك من هذا النوع ${limit} قطعة كل ${days} يومًا — بقي لك ${left}.`,
        `Your limit for this kind is ${limit} pieces every ${days} days — ${left} left.`,
        `سنووری تۆ بۆ ئەم جۆرە ${limit} پارچەیە بۆ هەر ${days} ڕۆژێک — ${left} ماوە.`
      )}
      {up}
    </p>
  );
}
