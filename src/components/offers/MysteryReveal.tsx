import React from 'react';
import { Gift, Lock, Sparkles } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import SafeImage from '../ui/SafeImage';
import type { ApiOrderItem } from '../../lib/api';

/**
 * THE MYSTERY LINE ON AN ORDER (docs/BUNDLES_MYSTERY.md §8, §13.2).
 *
 * BEFORE THE MILESTONE it shows the offer's own cover, "your selection is
 * confirmed", and WHEN the customer will find out — rendered from the server's
 * `reveal_stage_label`, never from a second client-side stage table.
 *
 * That last point is the whole reason this component is small. A five-stages-
 * by-three-languages table in the browser would drift from `OrderTracker` on
 * the very same screen, and would re-encode §8.1's `'preparing' →
 * supplier_preparing` mapping a second time — the mapping that differs between
 * the five-stage direct path and the fourteen-stage pre-order one. The server
 * computes the label with the same `stageLabel` the tracker uses and ships it
 * beside `reveal_at`.
 *
 * AFTER THE MILESTONE it renders the picks from the allocation's FROZEN
 * snapshots — name, image and variant as they were at the moment of the draw —
 * so a later rename or a re-shot photo cannot rewrite what someone was told
 * they received.
 *
 * There is no client-side reveal logic here at all: `revealed` is a server
 * verdict, and a browser that decided it had "waited long enough" would be a
 * second opinion the invoice would then contradict.
 */

const STRINGS = {
  ar: {
    pending: 'اختيارك مؤكَّد',
    hidden: 'المحتوى مخفي حتى الآن',
    revealAt: 'سيُكشف عند:',
    spools: 'عدد القطع',
    revealed: 'محتوى عرضك',
    adminChip: 'لم يُكشف للعميل بعد',
  },
  en: {
    pending: 'Your selection is confirmed',
    hidden: 'The contents stay hidden for now',
    revealAt: 'Revealed at:',
    spools: 'Items',
    revealed: 'What you got',
    adminChip: 'not yet revealed to the customer',
  },
  ckb: {
    pending: 'هەڵبژاردنەکەت پەسەند کرا',
    hidden: 'ناوەڕۆکەکە تا ئێستا شاراوەیە',
    revealAt: 'ئاشکرا دەکرێت لە:',
    spools: 'ژمارەی دانەکان',
    revealed: 'ئەوەی وەرتگرت',
    adminChip: 'هێشتا بۆ کڕیار ئاشکرا نەکراوە',
  },
} as const;

type MysteryBlock = NonNullable<ApiOrderItem['mystery']>;

export default function MysteryReveal({
  mystery,
  cover = '',
  viewer = 'customer',
  className = '',
}: {
  mystery: MysteryBlock;
  /** The OFFER's cover — the only image a pre-reveal line may carry. */
  cover?: string;
  viewer?: 'customer' | 'admin';
  className?: string;
}) {
  const { lang, dir } = useLanguage();
  const s = STRINGS[lang];
  const picks = mystery.picks ?? [];

  // The pre-reveal panel. `picks` is ABSENT on a customer payload before the
  // milestone, so there is nothing here that could be filled in by accident.
  if (picks.length === 0) {
    return (
      <div
        className={`mt-2 rounded-xl border border-zinc-800/70 bg-zinc-900/50 p-3 ${className}`}
        data-mystery-state="pending"
      >
        <div className="flex items-center gap-2">
          <Lock size={14} className="text-gold shrink-0" aria-hidden />
          <span className="text-[12px] font-bold text-zinc-200">{s.pending}</span>
        </div>
        <p className="mt-1 text-[11px] text-zinc-400">{s.hidden}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
          <span>
            {s.spools}: <bdi dir="ltr" className="tabular-nums text-zinc-200">{mystery.spools}</bdi>
          </span>
          {mystery.reveal_stage_label && (
            <span>
              {s.revealAt} <span className="text-zinc-200">{mystery.reveal_stage_label}</span>
            </span>
          )}
        </div>
        {cover && (
          <div className="mt-2 h-16 w-16 overflow-hidden rounded-lg bg-zinc-800" dir={dir}>
            <SafeImage src={cover} alt="" className="h-full w-full object-cover" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`mt-2 rounded-xl border border-emerald-600/30 bg-emerald-500/5 p-3 ${className}`}
      data-mystery-state={mystery.revealed ? 'revealed' : 'admin-preview'}
    >
      <div className="flex items-center gap-2">
        {mystery.revealed ? (
          <Sparkles size={14} className="text-emerald-300 shrink-0" aria-hidden />
        ) : (
          <Gift size={14} className="text-amber-300 shrink-0" aria-hidden />
        )}
        <span className="text-[12px] font-bold text-zinc-100">{s.revealed}</span>
        {/* The admin chip §8.2 asks for, on the screen staff read when packing.
            It is driven by the SERVER's flag, so it cannot say "revealed" for
            a customer who has not been told. */}
        {viewer === 'admin' && mystery.pending_customer_reveal && (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
            {s.adminChip}
          </span>
        )}
      </div>
      <ul className="mt-2 space-y-2">
        {picks.map((p) => (
          <li key={`${p.spool_index}-${p.product_id}`} className="flex items-center gap-2">
            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-zinc-800">
              <SafeImage src={p.image} alt="" className="h-full w-full object-cover" />
            </div>
            <div className="min-w-0">
              {/* Product names stay English in every language (§13.3), and
                  `dir="ltr"` keeps them from being bidi-reordered inside an
                  Arabic or Sorani paragraph. */}
              <div className="truncate text-[12px] font-bold text-zinc-100" dir="ltr">
                {p.name}
              </div>
              {p.variant && (
                <div className="truncate text-[11px] text-zinc-400" dir="ltr">
                  {p.variant}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
