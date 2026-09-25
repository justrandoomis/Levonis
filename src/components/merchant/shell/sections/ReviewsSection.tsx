/**
 * `/merchant/reviews` — the store's reviews and the one reply each may get.
 *
 * Moved out of the old dashboard page unchanged in what it shows. One defect
 * fixed on the way (audit 01 B18): the reply had no error handling — a 409
 * (already replied, or not this store's review) became an unhandled rejection
 * and the merchant saw nothing. Now the refusal is said in a toast, in the
 * merchant's language, and the text they typed stays in the box.
 */
import { useCallback, useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { merchantApi } from '../../../../lib/merchant';
import { useToast } from '../../../ui/Toast';
import { ListRowsSkeleton } from '../../../ui/DashboardSkeletons';
import { Btn, Empty } from '../../dashboard/ui';
import { useWorkspace } from '../context';
import { merchantRefusal } from '../refusal';

export default function ReviewsSection() {
  const { loc, lang } = useLanguage();
  const toast = useToast();
  const ws = useWorkspace();
  const [reviews, setReviews] = useState<Record<string, unknown>[] | null>(null);
  const [replying, setReplying] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    merchantApi.reviews().then((d) => setReviews(d.reviews)).catch(() => setReviews([]));
  }, []);
  useEffect(load, [load]);

  async function send(id: string) {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await merchantApi.replyReview(id, text.trim());
      setReplying('');
      setText('');
      load();
      ws.attention.refresh(true);
    } catch (e) {
      // OWNER: Sorani to be written by hand.
      toast.error(merchantRefusal(e, lang, loc('تعذّر إرسال الرد. ربما رددت عليه من قبل — حدّث الصفحة.', 'Could not send the reply. You may have replied already — refresh the page.')), { id: `review-reply-${id}` });
    } finally {
      setSending(false);
    }
  }

  if (reviews === null) return <ListRowsSkeleton rows={3} thumbnail={false} />;
  if (!reviews.length) {
    return (
      <Empty
        text={loc('لا توجد تقييمات بعد', 'No reviews yet', 'هێشتا هەڵسەنگاندن نییە')}
        hint={loc(
          'التقييمات تصل من طلبات مكتملة فقط.',
          'Reviews arrive only from completed orders.',
          'هەڵسەنگاندن تەنها لە داواکاریە تەواوکراوەکانەوە دێت.'
        )}
      />
    );
  }

  return (
    <div className="space-y-3">
      {reviews.map((r) => {
        const id = String(r.id);
        return (
          <div key={id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-white text-[12.5px] font-semibold">{String(r.customer_name)}</span>
              <div className="flex gap-0.5" role="img" aria-label={`${Number(r.rating)}/5`}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} aria-hidden="true" className={`w-3.5 h-3.5 ${n <= Number(r.rating) ? 'text-gold fill-gold' : 'text-zinc-700'}`} />
                ))}
              </div>
            </div>
            {!!r.body && <p className="text-zinc-300 text-[12.5px] leading-relaxed mb-2">{String(r.body)}</p>}

            {r.merchant_reply ? (
              <div className="ps-3 border-s-2 border-gold/30">
                <p className="text-gold/80 text-[11px] font-semibold mb-0.5">{loc('ردك', 'Your reply', 'وەڵامەکەت')}</p>
                <p className="text-zinc-400 text-[12px]">{String(r.merchant_reply)}</p>
              </div>
            ) : replying === id ? (
              <div className="space-y-2">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  maxLength={1500}
                  aria-label={loc('ردك', 'Your reply', 'وەڵامەکەت')}
                  className="w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white text-[13px] outline-none focus:border-gold/40 resize-none"
                />
                <div className="flex gap-2">
                  <Btn small disabled={sending || !text.trim()} onClick={() => void send(id)}>
                    {loc('إرسال', 'Send', 'ناردن')}
                  </Btn>
                  <Btn small kind="ghost" onClick={() => setReplying('')}>
                    {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
                  </Btn>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setReplying(id);
                  setText('');
                }}
                className="min-h-11 min-w-11 rounded-lg px-2 text-gold text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {loc('رد', 'Reply', 'وەڵام')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
