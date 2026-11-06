/**
 * ADMIN → المكافآت → الإعلانات (owner, 2026-11-05: «add this as first ads i give a
 * video»; migration 0227; docs/DECISIONS.md row 300).
 *
 * The ads of «شاهد إعلانًا»: each with three titles, an MP4, an optional poster,
 * a window, how many views one customer gets and the seconds a view must last.
 * The video's size and length are read here, in the browser, from the file itself;
 * the server validates them and decides everything else. Creating, editing and
 * switching on are the owner's (the server says so: OWNER_REQUIRED), switching off
 * is any admin's, and a refusal is shown in the shop's own three sentences.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Film, ImagePlus, Loader2, Megaphone, Plus, X } from 'lucide-react';
import { api, uploadFile } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { apiRefusal } from '../../lib/refusalStrings';
import { fileExtension, pickUpload, type UploadLargeResult } from '../../lib/uploadSession';
import { formatDate } from '../orders/format';
import { UploadTile } from '../upload/UploadTile';
import { adWindowIso, defaultAdWindow, toLocalInput as toLocal } from './adForm';
import { Switch } from '../ui/Switch';
import SafeImage from '../ui/SafeImage';

type Tri = { ar: string; en: string; ckb: string };
type Phase = 'off' | 'upcoming' | 'live' | 'ended';

interface AdminAd {
  id: string;
  title: Tri;
  video_url: string;
  poster_url: string | null;
  width: number;
  height: number;
  duration_seconds: number;
  required_seconds: number;
  starts_at: string;
  ends_at: string;
  max_views: number;
  active: boolean;
  sort: number;
  phase: Phase;
  views: number;
  viewers: number;
  points_paid: number;
}

const label = 'block text-text-secondary text-[11px] font-bold mb-1.5';

/** The owner's first ad runs ten days and two views: the form starts there, and they may change it. */
const blank = () => ({
  title_ar: '',
  title_en: '',
  title_ckb: '',
  video_url: '',
  poster_url: '',
  width: 0,
  height: 0,
  duration_seconds: 0,
  required_seconds: '',
  ...defaultAdWindow(),
  max_views: '2',
  active: true,
  sort: 0,
});
type Form = ReturnType<typeof blank>;

/** What the browser reads from the file itself: null when it cannot play it. */
function readVideoFacts(file: File): Promise<{ width: number; height: number; duration: number } | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (out: { width: number; height: number; duration: number } | null) => {
      URL.revokeObjectURL(url);
      resolve(out);
    };
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () =>
      done(video.videoWidth > 0 && Number.isFinite(video.duration) ? { width: video.videoWidth, height: video.videoHeight, duration: video.duration } : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

export default function AdminAds() {
  const { loc, lang } = useLanguage();
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as keyof Tri;
  const [rows, setRows] = useState<AdminAd[] | null>(null);
  const [installed, setInstalled] = useState(true);
  const [missionOn, setMissionOn] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Each refusal, even one that repeats the last sentence: see the effect below.
  const [refusals, setRefusals] = useState(0);
  const alertRef = useRef<HTMLDivElement>(null);
  const [largeVideo, setLargeVideo] = useState<File | null>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const posterInput = useRef<HTMLInputElement>(null);

  const refuse = useCallback((text: string) => {
    setError(text);
    setRefusals((n) => n + 1);
  }, []);
  const say = useCallback((err: unknown) => refuse(apiRefusal(err, lang, loc('تعذّر إتمام العملية', 'That did not go through', 'کردارەکە تەواو نەبوو'))), [refuse, lang, loc]);

  // THE SENTENCE SITS ABOVE A FORM TALLER THAN A PHONE, AND «SAVE» AT ITS FOOT: a refusal
  // said where nobody is looking reads as nothing having happened. It comes into view.
  useEffect(() => {
    if (refusals > 0) alertRef.current?.scrollIntoView({ block: 'center' });
  }, [refusals]);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ ads: AdminAd[]; installed: boolean; mission_enabled: boolean }>('/api/admin/rewards/ads');
      setRows(res.ads);
      setInstalled(res.installed);
      setMissionOn(res.mission_enabled);
    } catch (err) {
      say(err);
      setRows([]);
    }
  }, [say]);
  useEffect(() => {
    void load();
  }, [load]);

  const patch = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));

  const videoStored = (result: Pick<UploadLargeResult, 'url'>) => {
    setLargeVideo(null);
    patch({ video_url: result.url });
  };

  const pickVideo = async (file: File) => {
    setError('');
    if (fileExtension(file.name) !== 'mp4') {
      refuse(apiRefusal({ code: 'REWARD_AD_MP4_REQUIRED' }, lang));
      return;
    }
    const facts = await readVideoFacts(file);
    if (!facts) {
      refuse(apiRefusal({ code: 'REWARD_AD_SIZE_INVALID' }, lang));
      return;
    }
    // Whole seconds it surely runs: 47.5 is 47, so the default minimum is never longer than the film.
    const duration = Math.floor(facts.duration);
    patch({ width: facts.width, height: facts.height, duration_seconds: duration, required_seconds: String(Math.max(5, duration - 2)), video_url: '' });
    // Above 8 MiB the resumable door (the tile retries, resumes and says why); below it, the whole body.
    if (pickUpload(file) === 'session') {
      setLargeVideo(file);
      return;
    }
    setBusy('video');
    try {
      videoStored(await uploadFile(file, 'reward_ad'));
    } catch (err) {
      say(err);
    } finally {
      setBusy('');
    }
  };

  const pickPoster = async (file: File) => {
    setError('');
    setBusy('poster');
    try {
      patch({ poster_url: (await uploadFile(file, 'reward_ad')).url });
    } catch (err) {
      say(err);
    } finally {
      setBusy('');
    }
  };

  const edit = (ad: AdminAd) => {
    setError('');
    setEditing(ad.id);
    setLargeVideo(null);
    setForm({
      title_ar: ad.title.ar,
      title_en: ad.title.en,
      title_ckb: ad.title.ckb,
      video_url: ad.video_url,
      poster_url: ad.poster_url ?? '',
      width: ad.width,
      height: ad.height,
      duration_seconds: ad.duration_seconds,
      required_seconds: String(ad.required_seconds),
      starts_at: toLocal(ad.starts_at),
      ends_at: toLocal(ad.ends_at),
      max_views: String(ad.max_views),
      active: ad.active,
      sort: ad.sort,
    });
  };

  const closeForm = () => {
    setForm(null);
    setEditing(null);
    setLargeVideo(null);
  };

  const save = async () => {
    if (!form) return;
    setError('');
    // Asked first: a date that is empty is a sentence, never a spinner left turning.
    const dates = adWindowIso(form);
    if (!dates) {
      refuse(apiRefusal({ code: 'REWARD_AD_WINDOW_INVALID' }, lang));
      return;
    }
    setBusy('save');
    const body = {
      ...form,
      required_seconds: form.required_seconds.trim() ? Number(form.required_seconds) : undefined,
      max_views: form.max_views.trim() ? Number(form.max_views) : undefined,
      ...dates,
    };
    try {
      if (editing) await api.put(`/api/admin/rewards/ads/${encodeURIComponent(editing)}`, body);
      else await api.post('/api/admin/rewards/ads', body);
      closeForm();
      await load();
    } catch (err) {
      say(err);
    } finally {
      setBusy('');
    }
  };

  const toggle = async (ad: AdminAd, active: boolean) => {
    setBusy(ad.id);
    setError('');
    try {
      await api.post(`/api/admin/rewards/ads/${encodeURIComponent(ad.id)}/toggle`, { active });
      await load();
    } catch (err) {
      say(err);
    } finally {
      setBusy('');
    }
  };

  const phaseText = (p: Phase) =>
    p === 'live'
      ? loc('يعمل الآن', 'Running', 'ئێستا کاردەکات')
      : p === 'upcoming'
        ? loc('لم يبدأ', 'Upcoming', 'هێشتا دەستی پێنەکردووە')
        : p === 'ended'
          ? loc('انتهى', 'Ended', 'کۆتایی هات')
          : loc('متوقف', 'Off', 'وەستاوە');

  const titleField = (key: 'title_ar' | 'title_en' | 'title_ckb', text: string, dir: 'rtl' | 'ltr') =>
    form && (
      <div>
        <label className={label} htmlFor={`ad-${key}`}>{text}</label>
        <input id={`ad-${key}`} className="lv-input text-sm" dir={dir} maxLength={120} value={form[key]} onChange={(e) => patch({ [key]: e.target.value })} />
      </div>
    );

  return (
    <div className="space-y-4" data-admin-ads>
      <p className="text-text-secondary text-xs">
        {loc(
          'إعلانات مهمة «شاهد إعلانًا» في صفحة النقاط: مشاهدة واحدة في اليوم لكل زبون، حتى يبلغ عدد المشاهدات الذي تحدده هنا. النقاط هي نقاط المهمة نفسها.',
          'The ads of the «Watch Ad» mission on the points page: one view a day per customer, up to the number of views you set here. The points are the mission’s own.',
          'ڕیکلامەکانی ئەرکی «ڕیکلامێک ببینە» لە پەڕەی خاڵەکان: هەر کڕیارێک ڕۆژانە یەک جار، تا ئەو ژمارەیەی لێرە دیاری دەکەیت. خاڵەکان هەمان خاڵی ئەرکەکەن.'
        )}
      </p>
      {!installed && (
        <div className="lv-alert lv-alert-danger text-xs text-text-primary">
          {loc('جدول الإعلانات غير مثبّت على هذه القاعدة بعد (الترحيل 0227).', 'The ads table is not on this database yet (migration 0227).', 'خشتەی ڕیکلامەکان هێشتا لەم داتابەیسەدا نییە (کۆچی 0227).')}
        </div>
      )}
      {!missionOn && (
        <div className="lv-alert lv-alert-danger text-xs text-text-primary">
          {loc('مهمة «شاهد إعلانًا» مطفأة في إعدادات المهام، فلن يرى الزبائن أي إعلان.', 'The «Watch Ad» mission is switched off in the task settings, so customers will see no ad.', 'ئەرکی «ڕیکلامێک ببینە» لە ڕێکخستنەکانی ئەرکدا کوژاوەتەوە، بۆیە کڕیاران هیچ ڕیکلامێک نابینن.')}
        </div>
      )}
      {error && <div ref={alertRef} role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}

      {!form && (
        <button type="button" onClick={() => { setError(''); setEditing(null); setForm(blank()); }} className="lv-button lv-button-primary">
          <Plus className="w-4 h-4" aria-hidden />
          {loc('إعلان جديد', 'New ad', 'ڕیکلامی نوێ')}
        </button>
      )}

      {form && (
        <div className="lv-surface p-4 grid grid-cols-1 gap-4 sm:grid-cols-3" data-ad-form>
          {titleField('title_ar', loc('العنوان (عربي)', 'Title (Arabic)', 'ناونیشان (عەرەبی)'), 'rtl')}
          {titleField('title_en', loc('العنوان (إنكليزي)', 'Title (English)', 'ناونیشان (ئینگلیزی)'), 'ltr')}
          {titleField('title_ckb', loc('العنوان (كردي سوراني)', 'Title (Sorani)', 'ناونیشان (کوردیی سۆرانی)'), 'rtl')}

          <div className="sm:col-span-2 min-w-0 space-y-2">
            <p className={label}>{loc('فيديو الإعلان (MP4)', 'The ad’s video (MP4)', 'ڤیدیۆی ڕیکلام (MP4)')}</p>
            <input ref={videoInput} type="file" accept="video/mp4,.mp4" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickVideo(f); }} />
            {largeVideo ? (
              <UploadTile file={largeVideo} purpose="reward_ad" onDone={videoStored} onCancel={() => setLargeVideo(null)} />
            ) : (
              <button type="button" disabled={busy === 'video'} onClick={() => videoInput.current?.click()} className="lv-button lv-button-secondary">
                {busy === 'video' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Film className="w-4 h-4" aria-hidden />}
                {busy === 'video'
                  ? loc('جارٍ الرفع…', 'Uploading…', 'بار دەکرێت…')
                  : form.video_url
                    ? loc('تغيير الفيديو', 'Change the video', 'گۆڕینی ڤیدیۆ')
                    : loc('اختر الفيديو', 'Choose the video', 'ڤیدیۆکە هەڵبژێرە')}
              </button>
            )}
            {form.width > 0 && (
              <p className="text-text-muted text-[11px]" dir="auto">
                {loc(`الأبعاد ${form.width}×${form.height} · المدة ${form.duration_seconds} ثانية`, `${form.width}×${form.height} · ${form.duration_seconds} seconds`, `قەبارە ${form.width}×${form.height} · ماوە ${form.duration_seconds} چرکە`)}
              </p>
            )}
            <p className="text-text-muted text-[11px]">
              {loc('يُقبل MP4 المحسَّن للويب فقط (Fast start)، ليبدأ التشغيل فور فتحه على الهاتف.', 'Only an MP4 optimized for the web (Fast start) is accepted, so it plays as soon as a phone opens it.', 'تەنها MP4ی باشکراو بۆ وێب (Fast start) وەردەگیرێت، بۆ ئەوەی هەر کە مۆبایل کردییەوە دەست بە لێدان بکات.')}
            </p>
          </div>

          <div className="space-y-2">
            <p className={label}>{loc('صورة الغلاف (اختيارية)', 'Poster (optional)', 'وێنەی بەرگ (ئارەزوومەندانە)')}</p>
            <input ref={posterInput} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickPoster(f); }} />
            <div className="flex items-center gap-2 flex-wrap">
              {form.poster_url && <SafeImage src={form.poster_url} alt="" className="w-10 h-16 rounded-md" />}
              <button type="button" disabled={busy === 'poster'} onClick={() => posterInput.current?.click()} className="lv-button lv-button-secondary">
                {busy === 'poster' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ImagePlus className="w-4 h-4" aria-hidden />}
                {form.poster_url ? loc('تغيير', 'Change', 'گۆڕین') : loc('اختر صورة', 'Choose a picture', 'وێنەیەک هەڵبژێرە')}
              </button>
              {form.poster_url && (
                <button type="button" onClick={() => patch({ poster_url: '' })} aria-label={loc('حذف الغلاف', 'Remove the poster', 'سڕینەوەی بەرگ')} className="lv-button lv-button-ghost">
                  <X className="w-4 h-4" aria-hidden />
                </button>
              )}
            </div>
          </div>

          <div>
            <label className={label} htmlFor="ad-starts">{loc('يبدأ', 'Starts', 'دەست پێدەکات')}</label>
            <input id="ad-starts" type="datetime-local" className="lv-input text-sm" value={form.starts_at} onChange={(e) => patch({ starts_at: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="ad-ends">{loc('ينتهي', 'Ends', 'کۆتایی دێت')}</label>
            <input id="ad-ends" type="datetime-local" className="lv-input text-sm" value={form.ends_at} onChange={(e) => patch({ ends_at: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="ad-views">{loc('مشاهدات لكل زبون', 'Views per customer', 'بینین بۆ هەر کڕیارێک')}</label>
              <input id="ad-views" className="lv-input text-sm" dir="ltr" type="number" min={1} max={50} value={form.max_views} onChange={(e) => patch({ max_views: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="ad-secs">{loc('أقل مدة (ثانية)', 'Minimum (seconds)', 'کەمترین (چرکە)')}</label>
              <input id="ad-secs" className="lv-input text-sm" dir="ltr" type="number" min={5} max={600} value={form.required_seconds} onChange={(e) => patch({ required_seconds: e.target.value })} />
            </div>
          </div>
          <div className="sm:col-span-3">
            <Switch
              checked={form.active}
              onChange={(active) => patch({ active })}
              label={loc('يعمل', 'On', 'چالاکە')}
              description={loc('يظهر للزبائن خلال المدة التي حددتها.', 'Customers see it during the window you set.', 'کڕیاران لەو ماوەیەدا دەیبینن کە دیاریت کردووە.')}
            />
          </div>
          <div className="sm:col-span-3 flex justify-end gap-2 flex-wrap">
            <button type="button" onClick={closeForm} className="lv-button lv-button-ghost">{loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}</button>
            <button type="button" onClick={() => void save()} disabled={busy === 'save' || !form.video_url} className="lv-button lv-button-primary">
              {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {loc('حفظ الإعلان', 'Save the ad', 'ڕیکلامەکە پاشەکەوت بکە')}
            </button>
          </div>
        </div>
      )}

      {rows === null ? (
        <p className="text-text-secondary text-sm">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>
      ) : rows.length === 0 ? (
        <p className="text-text-secondary text-sm rounded-xl border border-dashed border-border-subtle p-6 text-center">
          {loc('لا إعلانات بعد.', 'No ads yet.', 'هێشتا هیچ ڕیکلامێک نییە.')}
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((ad) => (
            <li key={ad.id} className="lv-surface p-3 flex gap-3" data-ad-row={ad.phase}>
              <div className="w-16 shrink-0">
                {ad.poster_url ? (
                  <SafeImage src={ad.poster_url} alt="" className="w-16 h-28 rounded-lg" />
                ) : (
                  <div className="w-16 h-28 rounded-lg lv-well grid place-items-center text-text-muted">
                    <Megaphone className="w-5 h-5" aria-hidden />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-text-primary font-bold text-[14px] leading-snug">{ad.title[l] || ad.title.ar}</p>
                  <span className={`lv-chip ${ad.phase === 'live' ? '[--chip:var(--color-gold)]' : '[--chip:var(--color-text-secondary)]'} text-[11px] font-bold rounded-full px-2 py-0.5 shrink-0`}>{phaseText(ad.phase)}</span>
                </div>
                <p className="text-text-secondary text-[12px] mt-1">
                  {loc(
                    `${formatDate(ad.starts_at, lang)} حتى ${formatDate(ad.ends_at, lang)}`,
                    `${formatDate(ad.starts_at, lang)} to ${formatDate(ad.ends_at, lang)}`,
                    `${formatDate(ad.starts_at, lang)} تا ${formatDate(ad.ends_at, lang)}`
                  )}
                </p>
                <p className="text-text-secondary text-[12px] mt-1">
                  {loc(
                    `لكل زبون: ${ad.max_views} · مرة في اليوم · ${ad.required_seconds} ثانية على الأقل`,
                    `Per customer: ${ad.max_views} · once a day · ${ad.required_seconds}s minimum`,
                    `بۆ هەر کڕیارێک: ${ad.max_views} · ڕۆژی یەک جار · لانیکەم ${ad.required_seconds} چرکە`
                  )}
                </p>
                <p className="text-text-primary text-[12px] font-medium mt-1 tabular-nums">
                  {loc(
                    `المشاهدات ${ad.views} · المشاهدون ${ad.viewers} · النقاط المدفوعة ${ad.points_paid}`,
                    `Views ${ad.views} · Viewers ${ad.viewers} · Points paid ${ad.points_paid}`,
                    `بینینەکان ${ad.views} · بینەران ${ad.viewers} · خاڵی دراو ${ad.points_paid}`
                  )}
                </p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <button type="button" onClick={() => edit(ad)} className="lv-button lv-button-secondary lv-button-sm">{loc('تعديل', 'Edit', 'دەستکاری')}</button>
                  <button
                    type="button"
                    disabled={busy === ad.id}
                    onClick={() => void toggle(ad, !ad.active)}
                    className={`lv-button lv-button-sm ${ad.active ? 'lv-button-ghost text-danger' : 'lv-button-primary'}`}
                  >
                    {ad.active ? loc('إيقاف', 'Switch off', 'وەستاندن') : loc('تشغيل', 'Switch on', 'چالاککردن')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
