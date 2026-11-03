/**
 * ONE COMPETITION ON /points (migration 0220; docs/DECISIONS.md row 286):
 * its window, its prize, how to enter (free or with points), the customer's
 * own entry and — once the owner has named them — the winners.
 *
 * Entering is one request (POST /api/rewards/program/competitions/:id/enter)
 * carrying only what the competition asks for: a written answer, a photo, or
 * both. A photo is uploaded first through the ordinary public upload door
 * (`purpose=post`, the entrant's own `users/<uid>/posts/…`), and the entry
 * names its key; the server checks it is theirs. Whether it is open, whether
 * this customer may enter and what it costs are the server's answer.
 */
import { useRef, useState } from 'react';
import { Trophy, ImagePlus, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { formatFigure } from '../../lib/localeNumber';
import SafeImage from '../ui/SafeImage';
import type { Competition } from './types';

type Lang = 'ar' | 'en' | 'ckb';
const langOf = (l: string): Lang => (l === 'en' || l === 'ckb' ? l : 'ar');
const pick = (t: { ar: string; en: string; ckb: string }, l: Lang) => t[l] || t.ar || t.en;

function dayOf(iso: string, l: Lang): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(l === 'en' ? 'en-GB' : l === 'ckb' ? ['ckb-IQ-u-nu-latn', 'ar-IQ-u-nu-latn'] : 'ar-IQ-u-nu-latn', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function CompetitionCard({ c, balance, onChanged }: { c: Competition; balance: number; onChanged: () => Promise<void> | void }) {
  const { loc, lang } = useLanguage();
  const l = langOf(lang);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [photo, setPhoto] = useState<{ key: string; url: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const wantsText = c.submission === 'text' || c.submission === 'photo_text';
  const wantsPhoto = c.submission === 'photo' || c.submission === 'photo_text';
  const fee = c.entry_mode === 'points' ? c.entry_points : 0;
  const canEnter = c.phase === 'open' && !c.my_entry && c.eligible && (fee === 0 || balance >= fee);

  const phase =
    c.phase === 'upcoming'
      ? loc(`تبدأ ${dayOf(c.starts_at, l)}`, `Starts ${dayOf(c.starts_at, l)}`, `${dayOf(c.starts_at, l)} دەست پێدەکات`)
      : c.phase === 'open'
        ? loc(`مفتوحة حتى ${dayOf(c.ends_at, l)}`, `Open until ${dayOf(c.ends_at, l)}`, `تا ${dayOf(c.ends_at, l)} کراوەیە`)
        : c.phase === 'closed'
          ? loc('أُغلقت — النتائج قريبًا', 'Closed — results soon', 'داخرا — ئەنجامەکان بەم زووانە')
          : loc('انتهت', 'Finished', 'کۆتایی هات');

  const refusal = (code: string | undefined) => {
    switch (code) {
      case 'COMPETITION_ANSWER_REQUIRED':
        return loc('اكتب إجابتك أولًا.', 'Write your answer first.', 'سەرەتا وەڵامەکەت بنووسە.');
      case 'COMPETITION_PHOTO_INVALID':
        return loc('ارفع الصورة أولًا ثم أرسل المشاركة.', 'Upload the photo first, then send the entry.', 'سەرەتا وێنەکە باربکە، پاشان بەشدارییەکە بنێرە.');
      case 'COMPETITION_ALREADY_ENTERED':
        return loc('شاركت في هذه المسابقة من قبل.', 'You have already entered this competition.', 'پێشتر بەشداری ئەم پێشبڕکێیەت کردووە.');
      case 'INSUFFICIENT_POINTS':
        return loc('نقاطك لا تكفي للاشتراك.', 'You do not have enough points to enter.', 'خاڵەکانت بەس نین بۆ بەشداریکردن.');
      case 'COMPETITION_FULL':
        return loc('اكتمل عدد المشاركين.', 'This competition is full.', 'ژمارەی بەشداربووان تەواو بوو.');
      case 'COMPETITION_NOT_ELIGIBLE':
        return loc('هذه المسابقة لمن استلم طابعة من Levonis.', 'This competition is for customers who received a printer from Levonis.', 'ئەم پێشبڕکێیە بۆ ئەوانەیە کە چاپکەرێکیان لە Levonis وەرگرتووە.');
      case 'COMPETITION_CLOSED':
      case 'COMPETITION_NOT_OPEN':
        return loc('المسابقة ليست مفتوحة الآن.', 'The competition is not open now.', 'پێشبڕکێکە ئێستا کراوە نییە.');
      default:
        return loc('تعذّر إرسال المشاركة.', 'The entry could not be sent.', 'بەشدارییەکە نەنێردرا.');
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.set('purpose', 'post');
      form.set('file', file);
      const res = await api.post<{ key: string; url: string }>('/api/uploads', form);
      setPhoto({ key: res.key, url: res.url });
    } catch {
      setError(loc('تعذّر رفع الصورة.', 'The photo could not be uploaded.', 'وێنەکە بار نەکرا.'));
    } finally {
      setUploading(false);
    }
  };

  const enter = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/rewards/program/competitions/${encodeURIComponent(c.id)}/enter`, {
        ...(wantsText ? { answer: answer.trim() } : {}),
        ...(wantsPhoto && photo ? { media_key: photo.key } : {}),
      });
      setOpen(false);
      await onChanged();
    } catch (err) {
      setError(refusal(err instanceof ApiError ? err.code : undefined));
    } finally {
      setBusy(false);
    }
  };

  const prizes = c.prize_points
    .map((p, i) => (p > 0 ? loc(`المركز ${i + 1}: ${formatFigure(p, l)} نقطة`, `Place ${i + 1}: ${formatFigure(p, l)} pts`, `پلەی ${i + 1}: ${formatFigure(p, l)} خاڵ`) : ''))
    .filter(Boolean);

  const mine = c.my_entry;
  const mineText = !mine
    ? ''
    : mine.state === 'winner'
      ? loc(`فزت بالمركز ${mine.place}`, `You won place ${mine.place}`, `پلەی ${mine.place}ت بردەوە`)
      : mine.state === 'refunded'
        ? loc('أُعيدت نقاط اشتراكك', 'Your entry points were returned', 'خاڵەکانی بەشداریکردنت گەڕێنرانەوە')
        : mine.state === 'disqualified'
          ? loc('لم تُقبل مشاركتك', 'Your entry was not accepted', 'بەشدارییەکەت پەسەند نەکرا')
          : loc('أنت مشارك', 'You are in', 'تۆ بەشداریت کردووە');

  return (
    <li className="lv-surface p-4" data-testid="reward-competition">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-text-primary font-bold text-[15px]">{pick(c.title, l)}</h3>
        <span className={`lv-chip ${c.phase === 'open' ? '[--chip:var(--color-gold)]' : '[--chip:var(--color-text-secondary)]'} text-[11px] font-bold rounded-full px-2 py-0.5 shrink-0`}>{phase}</span>
      </div>
      {pick(c.description, l) && <p className="text-text-secondary text-[13px] leading-relaxed mt-2 whitespace-pre-line">{pick(c.description, l)}</p>}
      {(prizes.length > 0 || pick(c.prize, l)) && (
        <div className="mt-3 lv-well rounded-lg p-3 text-[12px]">
          <p className="font-bold text-text-primary flex items-center gap-1.5 mb-1">
            <Trophy aria-hidden="true" className="w-4 h-4 text-gold" />
            {loc('الجوائز', 'Prizes', 'خەڵاتەکان')}
          </p>
          {prizes.length > 0 && <p className="text-text-secondary tabular-nums">{prizes.join(' · ')}</p>}
          {pick(c.prize, l) && <p className="text-text-secondary mt-0.5">{pick(c.prize, l)}</p>}
        </div>
      )}
      <p className="text-text-muted text-[11px] mt-2">
        {fee > 0
          ? loc(`الاشتراك بـ ${formatFigure(fee, l)} نقطة`, `Entry: ${formatFigure(fee, l)} points`, `بەشداریکردن: ${formatFigure(fee, l)} خاڵ`)
          : loc('الاشتراك مجاني', 'Free to enter', 'بەشداریکردن بەخۆڕاییە')}
        {' · '}
        {loc(`${formatFigure(c.entries_count, l)} مشارك`, `${formatFigure(c.entries_count, l)} entered`, `${formatFigure(c.entries_count, l)} بەشداربوو`)}
        {c.eligibility === 'printer_owners' ? ` · ${loc('لمن استلم طابعة من Levonis', 'For Levonis printer owners', 'بۆ خاوەنانی چاپکەری Levonis')}` : ''}
        {' · '}
        {loc('الفائزون يختارهم فريق Levonis', 'Winners chosen by the Levonis team', 'براوەکان تیمی Levonis هەڵیاندەبژێرێت')}
      </p>

      {mine && <p className="mt-3 text-[13px] font-bold text-gold">{mineText}</p>}
      {c.phase === 'open' && !mine && !c.eligible && (
        <p className="mt-3 text-[12px] text-text-secondary">{refusal('COMPETITION_NOT_ELIGIBLE')}</p>
      )}
      {c.phase === 'open' && !mine && c.eligible && fee > balance && (
        <p className="mt-3 text-[12px] text-text-secondary">
          {loc(`تحتاج ${formatFigure(fee - balance, l)} نقطة أخرى للاشتراك.`, `You need ${formatFigure(fee - balance, l)} more points to enter.`, `${formatFigure(fee - balance, l)} خاڵی ترت پێویستە بۆ بەشداریکردن.`)}
        </p>
      )}

      {canEnter && !open && (
        <button type="button" onClick={() => setOpen(true)} className="lv-button lv-button-primary w-full min-h-11 mt-3 text-[14px]">
          {fee > 0
            ? loc(`شارك بـ ${formatFigure(fee, l)} نقطة`, `Enter for ${formatFigure(fee, l)} points`, `بە ${formatFigure(fee, l)} خاڵ بەشداری بکە`)
            : loc('شارك الآن', 'Enter now', 'ئێستا بەشداری بکە')}
        </button>
      )}

      {canEnter && open && (
        <div className="mt-3 space-y-3">
          {wantsText && (
            <label className="block">
              <span className="block text-[12px] font-bold text-text-primary mb-1">{loc('إجابتك', 'Your answer', 'وەڵامەکەت')}</span>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value.slice(0, 1000))}
                rows={3}
                className="lv-input w-full text-[14px]"
              />
            </label>
          )}
          {wantsPhoto && (
            <div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
              {photo ? (
                <div className="relative w-32">
                  <SafeImage src={photo.url} alt="" className="w-32 h-32 rounded-lg object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhoto(null)}
                    aria-label={loc('إزالة الصورة', 'Remove the photo', 'وێنەکە لابە')}
                    className="absolute top-1 end-1 size-8 rounded-full bg-surface grid place-items-center shadow-1"
                  >
                    <X aria-hidden="true" className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="lv-button lv-button-secondary min-h-11 px-4 text-[13px]">
                  <ImagePlus aria-hidden="true" className="w-4 h-4" />
                  {uploading ? loc('جارٍ الرفع…', 'Uploading…', 'بار دەکرێت…') : loc('أضف صورة', 'Add a photo', 'وێنەیەک زیاد بکە')}
                </button>
              )}
            </div>
          )}
          {error && <p role="alert" className="text-danger text-[12px]">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void enter()}
              disabled={busy || uploading || (wantsText && !answer.trim()) || (wantsPhoto && !photo)}
              className="lv-button lv-button-primary flex-1 min-h-11 text-[14px] disabled:opacity-60"
            >
              {busy ? loc('جارٍ الإرسال…', 'Sending…', 'دەنێردرێت…') : loc('أرسل المشاركة', 'Send my entry', 'بەشدارییەکەم بنێرە')}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="lv-button lv-button-ghost min-h-11 px-4 text-[14px]">
              {loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}
            </button>
          </div>
        </div>
      )}
      {!open && error && <p role="alert" className="text-danger text-[12px] mt-2">{error}</p>}

      {c.phase === 'finished' && c.winners.length > 0 && (
        <div className="mt-4">
          <p className="text-[12px] font-bold text-text-primary mb-2">{loc('الفائزون', 'Winners', 'براوەکان')}</p>
          <ol className="space-y-2">
            {c.winners.map((w) => (
              <li key={w.place} className="flex items-center gap-3 text-[13px]">
                <span className="size-7 rounded-full bg-gold text-accent-contrast grid place-items-center font-bold text-[12px] shrink-0 tabular-nums">{w.place}</span>
                {w.media_url && <SafeImage src={w.media_url} alt="" className="size-10 rounded-md object-cover shrink-0" />}
                <span className="text-text-primary font-medium">{w.name}</span>
                {w.prize_points > 0 && (
                  <span className="ms-auto text-gold font-bold tabular-nums">
                    {loc(`${formatFigure(w.prize_points, l)} نقطة`, `${formatFigure(w.prize_points, l)} pts`, `${formatFigure(w.prize_points, l)} خاڵ`)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}
