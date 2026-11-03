/**
 * ADMIN → المكافآت → المسابقات (migration 0220; docs/DECISIONS.md row 286).
 *
 * The owner's competitions: a draft (any admin), published by the owner once
 * every word is written in Arabic, English and Sorani, entered free or with
 * points, judged here — the owner names the places after it closes; nothing is
 * ever drawn by chance (DECISIONS row 25). Cancelling gives every entry fee
 * back. The server decides each step and says why when it refuses.
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus, Loader2, Trophy, Users } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import SafeImage from '../ui/SafeImage';

type Tri = { ar: string; en: string; ckb: string };
interface AdminCompetition {
  id: string;
  title: Tri;
  description: Tri;
  prize: Tri;
  entry_mode: 'free' | 'points';
  entry_points: number;
  submission: 'none' | 'text' | 'photo' | 'photo_text';
  eligibility: 'everyone' | 'printer_owners';
  prize_points: number[];
  max_entries: number | null;
  starts_at: string;
  ends_at: string;
  phase: string;
  state: 'draft' | 'published' | 'finished' | 'cancelled';
  entries_count: number;
  points_collected: number;
  publish_problem: string | null;
}
interface Entry {
  id: string;
  state: string;
  place: number | null;
  answer: string;
  media_url: string | null;
  entry_points: number;
  user_name: string;
  username: string;
  created_at: string;
}

const label = 'block text-text-secondary text-[11px] font-bold mb-1.5';
const toLocal = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const BLANK = () => {
  const start = new Date();
  const end = new Date(Date.now() + 14 * 86_400_000);
  return {
    title_ar: '', title_en: '', title_ckb: '',
    description_ar: '', description_en: '', description_ckb: '',
    prize_ar: '', prize_en: '', prize_ckb: '',
    entry_mode: 'free' as 'free' | 'points',
    entry_points: '',
    submission: 'photo_text' as AdminCompetition['submission'],
    eligibility: 'everyone' as AdminCompetition['eligibility'],
    prize_points: '',
    max_entries: '',
    starts_at: toLocal(start.toISOString()),
    ends_at: toLocal(end.toISOString()),
  };
};
type Form = ReturnType<typeof BLANK>;

export default function AdminCompetitions() {
  const { loc, lang } = useLanguage();
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as keyof Tri;
  const [rows, setRows] = useState<AdminCompetition[] | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [judging, setJudging] = useState<AdminCompetition | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRows((await api.get<{ competitions: AdminCompetition[] }>('/api/admin/rewards/competitions')).competitions);
    } catch (err) {
      setError(err instanceof Error ? err.message : '');
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const say = (err: unknown) => {
    const code = err instanceof ApiError ? err.code : '';
    setError(
      code === 'OWNER_REQUIRED'
        ? loc('النشر للمالك وحده.', 'Only the owner can publish.', 'تەنها خاوەنەکە دەتوانێت بڵاوی بکاتەوە.')
        : code === 'FINANCIAL_SCOPE_REQUIRED'
          ? loc('دفع الجوائز يحتاج صلاحية مالية.', 'Paying prizes needs the financial scope.', 'پێدانی خەڵات دەسەڵاتی دارایی پێویستە.')
          : err instanceof Error ? err.message : ''
    );
  };

  const body = (f: Form) => ({
    ...f,
    entry_points: f.entry_mode === 'points' ? Math.trunc(Number(f.entry_points) || 0) : 0,
    prize_points: f.prize_points.split(/[,،\s]+/).filter(Boolean).map((x) => Math.trunc(Number(x) || 0)),
    max_entries: f.max_entries.trim() ? Math.trunc(Number(f.max_entries) || 0) : null,
    starts_at: new Date(f.starts_at).toISOString(),
    ends_at: new Date(f.ends_at).toISOString(),
  });

  const save = async () => {
    if (!form) return;
    setBusy('save');
    setError('');
    try {
      if (editing) await api.put(`/api/admin/rewards/competitions/${encodeURIComponent(editing)}`, body(form));
      else await api.post('/api/admin/rewards/competitions', body(form));
      setForm(null);
      setEditing(null);
      await load();
    } catch (err) {
      say(err);
    } finally {
      setBusy('');
    }
  };

  const edit = (c: AdminCompetition) => {
    setEditing(c.id);
    setForm({
      title_ar: c.title.ar, title_en: c.title.en, title_ckb: c.title.ckb,
      description_ar: c.description.ar, description_en: c.description.en, description_ckb: c.description.ckb,
      prize_ar: c.prize.ar, prize_en: c.prize.en, prize_ckb: c.prize.ckb,
      entry_mode: c.entry_mode,
      entry_points: c.entry_points ? String(c.entry_points) : '',
      submission: c.submission,
      eligibility: c.eligibility,
      prize_points: c.prize_points.join(', '),
      max_entries: c.max_entries ? String(c.max_entries) : '',
      starts_at: toLocal(c.starts_at),
      ends_at: toLocal(c.ends_at),
    });
  };

  const act = async (c: AdminCompetition, what: 'publish' | 'cancel') => {
    let payload: Record<string, unknown> = {};
    if (what === 'cancel') {
      const reason = window.prompt(loc('سبب الإلغاء (تُعاد كل نقاط الاشتراك):', 'Why cancel? (every entry fee is returned)', 'هۆکاری هەڵوەشاندنەوە؟ (هەموو خاڵی بەشداریکردن دەگەڕێنرێتەوە)'))?.trim();
      if (!reason) return;
      payload = { reason };
    }
    setBusy(c.id);
    setError('');
    try {
      await api.post(`/api/admin/rewards/competitions/${encodeURIComponent(c.id)}/${what}`, payload);
      await load();
    } catch (err) {
      say(err);
    } finally {
      setBusy('');
    }
  };

  const field = (key: keyof Form, text: string, opts: { area?: boolean; dir?: 'ltr' | 'rtl' } = {}) =>
    form && (
      <div>
        <label className={label}>{text}</label>
        {opts.area ? (
          <textarea className="lv-input text-sm w-full" rows={3} dir={opts.dir} value={String(form[key])} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        ) : (
          <input className="lv-input text-sm" dir={opts.dir} value={String(form[key])} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        )}
      </div>
    );

  /** Why a draft cannot be published yet — the server's code, in the reader's words. */
  const problemText = (p: string) => {
    const m = /^missing:(title|description)_(ar|en|ckb)$/.exec(p);
    if (m) {
      const what = m[1] === 'title' ? loc('العنوان', 'The title', 'ناونیشان') : loc('الوصف', 'The description', 'وەسف');
      const inLang =
        m[2] === 'ar' ? loc('بالعربية', 'in Arabic', 'بە عەرەبی') : m[2] === 'en' ? loc('بالإنكليزية', 'in English', 'بە ئینگلیزی') : loc('بالكردية السورانية', 'in Sorani', 'بە کوردیی سۆرانی');
      return loc(`${what} ${inLang} مطلوب قبل النشر.`, `${what} ${inLang} is needed before publishing.`, `${what} ${inLang} پێویستە پێش بڵاوکردنەوە.`);
    }
    if (p === 'prize_languages') return loc('اكتب الجائزة باللغات الثلاث.', 'Write the prize in all three languages.', 'خەڵاتەکە بە هەر سێ زمانەکە بنووسە.');
    if (p === 'no_prize') return loc('حدّد جائزة: نقاطًا لمركز، أو الجائزة بالكلمات.', 'Set a prize: points for a place, or the prize in words.', 'خەڵاتێک دیاری بکە: خاڵ بۆ پلەیەک، یان خەڵاتەکە بە وشە.');
    if (p === 'ended') return loc('موعد انتهائها مضى.', 'Its end date has passed.', 'کاتی کۆتاییەکەی تێپەڕیوە.');
    if (p === 'sorani_copy') return loc('النص الكردي نسخة من العربي — اكتبه بالسورانية.', 'The Sorani text copies the Arabic — write it in Sorani.', 'دەقی کوردی کۆپیی عەرەبییەکەیە — بە سۆرانی بینووسە.');
    return p;
  };

  const phaseText = (c: AdminCompetition) =>
    c.state === 'draft' ? loc('مسودة', 'Draft', 'ڕەشنووس')
      : c.state === 'cancelled' ? loc('ملغاة', 'Cancelled', 'هەڵوەشاوە')
        : c.state === 'finished' ? loc('انتهت', 'Finished', 'کۆتایی هات')
          : c.phase === 'upcoming' ? loc('لم تبدأ', 'Upcoming', 'هێشتا دەستی پێنەکردووە')
            : c.phase === 'open' ? loc('مفتوحة', 'Open', 'کراوە')
              : loc('أُغلقت — بانتظار الفائزين', 'Closed — name the winners', 'داخرا — براوەکان دیاری بکە');

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="lv-alert lv-alert-danger text-xs text-text-primary">{error}</div>}
      {!form && (
        <button type="button" onClick={() => { setEditing(null); setForm(BLANK()); }} className="lv-button lv-button-primary">
          <Plus className="w-4 h-4" aria-hidden />
          {loc('مسابقة جديدة', 'New competition', 'پێشبڕکێی نوێ')}
        </button>
      )}

      {form && (
        <div className="lv-surface p-4 grid gap-3 sm:grid-cols-3">
          {field('title_ar', loc('العنوان (عربي)', 'Title (Arabic)', 'ناونیشان (عەرەبی)'), { dir: 'rtl' })}
          {field('title_en', loc('العنوان (إنكليزي)', 'Title (English)', 'ناونیشان (ئینگلیزی)'), { dir: 'ltr' })}
          {field('title_ckb', loc('العنوان (كردي سوراني)', 'Title (Sorani)', 'ناونیشان (کوردیی سۆرانی)'), { dir: 'rtl' })}
          {field('description_ar', loc('الوصف والشروط (عربي)', 'Description and rules (Arabic)', 'وەسف و مەرجەکان (عەرەبی)'), { area: true, dir: 'rtl' })}
          {field('description_en', loc('الوصف والشروط (إنكليزي)', 'Description and rules (English)', 'وەسف و مەرجەکان (ئینگلیزی)'), { area: true, dir: 'ltr' })}
          {field('description_ckb', loc('الوصف والشروط (كردي سوراني)', 'Description and rules (Sorani)', 'وەسف و مەرجەکان (کوردیی سۆرانی)'), { area: true, dir: 'rtl' })}
          {field('prize_ar', loc('الجائزة بالكلمات (عربي، اختياري)', 'Prize in words (Arabic, optional)', 'خەڵات بە وشە (عەرەبی، ئارەزوومەندانە)'), { dir: 'rtl' })}
          {field('prize_en', loc('الجائزة بالكلمات (إنكليزي)', 'Prize in words (English)', 'خەڵات بە وشە (ئینگلیزی)'), { dir: 'ltr' })}
          {field('prize_ckb', loc('الجائزة بالكلمات (كردي سوراني)', 'Prize in words (Sorani)', 'خەڵات بە وشە (کوردیی سۆرانی)'), { dir: 'rtl' })}
          <div>
            <label className={label}>{loc('الاشتراك', 'Entry', 'بەشداریکردن')}</label>
            <select className="lv-input text-sm" value={form.entry_mode} onChange={(e) => setForm({ ...form, entry_mode: e.target.value as Form['entry_mode'] })}>
              <option value="free">{loc('مجاني', 'Free', 'بەخۆڕایی')}</option>
              <option value="points">{loc('بالنقاط', 'With points', 'بە خاڵ')}</option>
            </select>
          </div>
          {form.entry_mode === 'points' ? field('entry_points', loc('نقاط الاشتراك', 'Entry points', 'خاڵی بەشداریکردن'), { dir: 'ltr' }) : <div />}
          <div>
            <label className={label}>{loc('ما يرسله المشارك', 'What an entry carries', 'بەشداربوو چی دەنێرێت')}</label>
            <select className="lv-input text-sm" value={form.submission} onChange={(e) => setForm({ ...form, submission: e.target.value as Form['submission'] })}>
              <option value="none">{loc('لا شيء — اشتراك فقط', 'Nothing — just join', 'هیچ — تەنها بەشداریکردن')}</option>
              <option value="text">{loc('إجابة مكتوبة', 'A written answer', 'وەڵامێکی نووسراو')}</option>
              <option value="photo">{loc('صورة', 'A photo', 'وێنەیەک')}</option>
              <option value="photo_text">{loc('صورة وإجابة', 'A photo and an answer', 'وێنە و وەڵام')}</option>
            </select>
          </div>
          <div>
            <label className={label}>{loc('من يشارك', 'Who may enter', 'کێ دەتوانێت بەشداری بکات')}</label>
            <select className="lv-input text-sm" value={form.eligibility} onChange={(e) => setForm({ ...form, eligibility: e.target.value as Form['eligibility'] })}>
              <option value="everyone">{loc('كل الزبائن', 'Every customer', 'هەموو کڕیاران')}</option>
              <option value="printer_owners">{loc('من استلم طابعة منّا', 'Customers who received a printer from us', 'ئەوانەی چاپکەریان لێمان وەرگرتووە')}</option>
            </select>
          </div>
          {field('prize_points', loc('نقاط الجوائز بالترتيب (مثال: 5000, 2000, 1000)', 'Prize points by place (e.g. 5000, 2000, 1000)', 'خاڵی خەڵات بەپێی پلە (بۆ نموونە: 5000, 2000, 1000)'), { dir: 'ltr' })}
          {field('max_entries', loc('أقصى عدد للمشاركين (اختياري)', 'Most entries (optional)', 'زۆرترین بەشداربوو (ئارەزوومەندانە)'), { dir: 'ltr' })}
          <div>
            <label className={label}>{loc('تبدأ', 'Starts', 'دەست پێدەکات')}</label>
            <input type="datetime-local" className="lv-input text-sm" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
          </div>
          <div>
            <label className={label}>{loc('تنتهي', 'Ends', 'کۆتایی دێت')}</label>
            <input type="datetime-local" className="lv-input text-sm" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
          </div>
          <div className="sm:col-span-3 flex justify-end gap-2">
            <button type="button" onClick={() => { setForm(null); setEditing(null); }} className="lv-button lv-button-ghost">{loc('إلغاء', 'Cancel', 'پاشگەزبوونەوە')}</button>
            <button type="button" onClick={() => void save()} disabled={busy === 'save' || !form.title_ar.trim()} className="lv-button lv-button-primary">
              {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {loc('حفظ المسودة', 'Save draft', 'ڕەشنووس پاشەکەوت بکە')}
            </button>
          </div>
        </div>
      )}

      {rows === null ? (
        <p className="text-text-secondary text-sm">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>
      ) : rows.length === 0 ? (
        <p className="text-text-secondary text-sm rounded-xl border border-dashed border-border-subtle p-6 text-center">{loc('لا مسابقات بعد.', 'No competitions yet.', 'هێشتا هیچ پێشبڕکێیەک نییە.')}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((c) => (
            <li key={c.id} className="lv-surface p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-text-primary font-bold flex items-center gap-2"><Trophy className="w-4 h-4 text-gold" aria-hidden />{c.title[l] || c.title.ar}</p>
                  <p className="text-text-secondary text-[12px] mt-1" dir="ltr">{c.starts_at.slice(0, 10)} → {c.ends_at.slice(0, 10)}</p>
                  <p className="text-text-secondary text-[12px] flex items-center gap-1.5 mt-1">
                    <Users className="w-3.5 h-3.5" aria-hidden />
                    {loc(`${c.entries_count} مشارك`, `${c.entries_count} entries`, `${c.entries_count} بەشداربوو`)}
                    {c.points_collected > 0 ? ` · ${loc(`${c.points_collected} نقطة اشتراك`, `${c.points_collected} entry points`, `${c.points_collected} خاڵی بەشداریکردن`)}` : ''}
                  </p>
                  {c.publish_problem && <p className="text-warning text-[11px] mt-1">{problemText(c.publish_problem)}</p>}
                </div>
                <span className="lv-chip [--chip:var(--color-gold)] text-[11px] font-bold rounded-full px-2 py-0.5">{phaseText(c)}</span>
              </div>
              <div className="flex gap-2 mt-3 flex-wrap">
                {c.state === 'draft' && (
                  <>
                    <button type="button" onClick={() => edit(c)} className="lv-button lv-button-secondary lv-button-sm">{loc('تعديل', 'Edit', 'دەستکاری')}</button>
                    <button type="button" disabled={busy === c.id || !!c.publish_problem} onClick={() => void act(c, 'publish')} className="lv-button lv-button-primary lv-button-sm">{loc('نشر', 'Publish', 'بڵاوکردنەوە')}</button>
                  </>
                )}
                {c.state === 'published' && (
                  <button type="button" onClick={() => setJudging(c)} className="lv-button lv-button-secondary lv-button-sm">
                    {c.phase === 'closed' ? loc('المشاركات والفائزون', 'Entries & winners', 'بەشدارییەکان و براوەکان') : loc('المشاركات', 'Entries', 'بەشدارییەکان')}
                  </button>
                )}
                {(c.state === 'draft' || c.state === 'published') && (
                  <button type="button" disabled={busy === c.id} onClick={() => void act(c, 'cancel')} className="lv-button lv-button-ghost lv-button-sm text-danger">{loc('إلغاء المسابقة', 'Cancel competition', 'هەڵوەشاندنەوەی پێشبڕکێ')}</button>
                )}
              </div>
              {judging?.id === c.id && <Judging c={c} onDone={async () => { setJudging(null); await load(); }} onError={say} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Judging({ c, onDone, onError }: { c: AdminCompetition; onDone: () => Promise<void>; onError: (e: unknown) => void }) {
  const { loc } = useLanguage();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [places, setPlaces] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const closed = c.phase === 'closed';

  const load = useCallback(async () => {
    try {
      setEntries((await api.get<{ entries: Entry[] }>(`/api/admin/rewards/competitions/${encodeURIComponent(c.id)}/entries`)).entries);
    } catch (err) {
      onError(err);
      setEntries([]);
    }
  }, [c.id, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  const disqualify = async (e: Entry) => {
    const note = window.prompt(loc('لماذا لا تُقبل هذه المشاركة؟', 'Why is this entry not accepted?', 'بۆچی ئەم بەشدارییە پەسەند ناکرێت؟'))?.trim();
    if (!note) return;
    try {
      await api.post(`/api/admin/rewards/competitions/${encodeURIComponent(c.id)}/entries/${encodeURIComponent(e.id)}/disqualify`, { note });
      await load();
    } catch (err) {
      onError(err);
    }
  };

  const finish = async () => {
    const winners = Object.entries(places)
      .filter(([, p]) => p)
      .map(([entry_id, p]) => ({ entry_id, place: Math.trunc(Number(p)) }));
    setBusy(true);
    try {
      await api.post(`/api/admin/rewards/competitions/${encodeURIComponent(c.id)}/finish`, { winners });
      await onDone();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!entries) return <p className="text-text-secondary text-sm mt-3">{loc('جارٍ التحميل…', 'Loading…', 'بار دەکرێت…')}</p>;
  return (
    <div className="mt-4 space-y-2">
      {entries.length === 0 && <p className="text-text-secondary text-sm">{loc('لا مشاركات بعد.', 'No entries yet.', 'هێشتا هیچ بەشدارییەک نییە.')}</p>}
      {entries.map((e) => (
        <div key={e.id} className="lv-well rounded-lg p-3 flex items-start gap-3">
          {e.media_url && <a href={e.media_url} target="_blank" rel="noreferrer"><SafeImage src={e.media_url} alt="" className="size-16 rounded-md object-cover" /></a>}
          <div className="min-w-0 flex-1 text-[13px]">
            <p className="text-text-primary font-bold">{e.user_name || e.username}</p>
            {e.answer && <p className="text-text-secondary whitespace-pre-line">{e.answer}</p>}
            <p className="text-text-muted text-[11px]">{e.state}{e.entry_points ? ` · ${e.entry_points}` : ''}</p>
          </div>
          {e.state === 'entered' && (
            <div className="flex flex-col gap-1 items-end">
              {closed && (
                <select aria-label={loc('المركز', 'Place', 'پلە')} className="lv-input text-xs w-24" value={places[e.id] ?? ''} onChange={(ev) => setPlaces({ ...places, [e.id]: ev.target.value })}>
                  <option value="">—</option>
                  {Array.from({ length: Math.max(3, c.prize_points.length) }, (_, i) => (
                    <option key={i + 1} value={i + 1}>{loc(`المركز ${i + 1}`, `Place ${i + 1}`, `پلەی ${i + 1}`)}</option>
                  ))}
                </select>
              )}
              <button type="button" onClick={() => void disqualify(e)} className="lv-button lv-button-ghost lv-button-sm text-danger">{loc('رفض', 'Refuse', 'ڕەتکردنەوە')}</button>
            </div>
          )}
        </div>
      ))}
      {closed && (
        <div className="flex justify-end">
          <button type="button" disabled={busy} onClick={() => void finish()} className="lv-button lv-button-primary">
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
            {loc('أعلن الفائزين وادفع الجوائز', 'Announce the winners and pay the prizes', 'براوەکان ڕابگەیەنە و خەڵاتەکان بدە')}
          </button>
        </div>
      )}
    </div>
  );
}
