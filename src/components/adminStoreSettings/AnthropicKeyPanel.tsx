import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, KeyRound, RotateCcw } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Switch } from '../ui/Switch';
import { provider, type SearchImageSettings } from '../creativeStudio/client';
import type { ModelDto, ProviderStatusDto } from '../../../packages/creativeDoc/src/api';

/**
 * THE ANTHROPIC KEY IN «إعدادات المتجر» (owner, 2026-11-18: «Anthropic key
 * make it on store_settings»).
 *
 * One key for the whole shop: search by photo, the support chat and the
 * Creative Studio all use it. This card writes through the SAME owner-only
 * doors as the studio's provider page (`/api/admin/creative/provider/*`), so
 * the key is sealed with CREATIVE_STUDIO_ENC_KEY before it reaches the
 * database, the browser only ever gets its hint back, and saving it asks for a
 * fresh sign-in (REAUTH_REQUIRED). Nothing here stores the key in
 * `admin_settings` — that table is not encrypted.
 *
 * Below the key: the model (from the provider's live list, with whether it can
 * read pictures — search by photo needs one that can), a connection test,
 * and search by photo's switch and daily total.
 */
type Busy = null | 'key' | 'remove' | 'model' | 'test' | 'search';

export default function AnthropicKeyPanel() {
  const { loc } = useLanguage();
  const [status, setStatus] = useState<ProviderStatusDto | null>(null);
  const [search, setSearch] = useState<SearchImageSettings | null>(null);
  const [models, setModels] = useState<ModelDto[] | null>(null);
  const [keyText, setKeyText] = useState('');
  const [daily, setDaily] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState(false);

  const errorText = (e: unknown): string => {
    const code = e instanceof ApiError ? e.code : '';
    if (code === 'REAUTH_REQUIRED') return loc('سجّل الدخول من جديد ثم احفظ المفتاح', 'Sign in again, then save the key', 'دووبارە بچۆ ژوورەوە، پاشان کلیلەکە پاشەکەوت بکە');
    if (code === 'ENCRYPTION_NOT_CONFIGURED') return loc('حفظ المفتاح يحتاج سر الخادم CREATIVE_STUDIO_ENC_KEY', 'Saving a key needs the Worker secret CREATIVE_STUDIO_ENC_KEY', 'پاشەکەوتکردنی کلیل نهێنیی CREATIVE_STUDIO_ENC_KEY ی دەوێت');
    if (code === 'INVALID_INPUT') return loc('هذا لا يبدو مفتاح Anthropic صحيحًا', 'That does not look like an Anthropic key', 'ئەمە وەک کلیلی Anthropic دیار نییە');
    return e instanceof ApiError && e.message ? e.message : loc('تعذّر الحفظ', 'Could not save', 'پاشەکەوت نەکرا');
  };

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const [st, si] = await Promise.all([provider.status(), provider.searchImage()]);
      setStatus(st);
      setSearch(si.search_image);
      setDaily(String(si.search_image.daily));
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (kind: Busy, work: () => Promise<void>, okText: string) => {
    setBusy(kind);
    setNote(null);
    try {
      await work();
      setNote({ ok: true, text: okText });
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const saveKey = () =>
    run(
      'key',
      async () => {
        await provider.saveKey(keyText.trim());
        setKeyText('');
        setStatus(await provider.status());
      },
      loc('حُفظ المفتاح مشفّرًا', 'Key saved, encrypted', 'کلیل بە شێوەی نهێنی پاشەکەوت کرا')
    );

  const removeKey = () =>
    run(
      'remove',
      async () => {
        await provider.removeKey();
        setStatus(await provider.status());
      },
      loc('حُذف المفتاح', 'Key removed', 'کلیل سڕایەوە')
    );

  const loadModels = () =>
    run(
      'model',
      async () => {
        setModels(await provider.models());
      },
      loc('تم تحميل قائمة النماذج', 'Model list loaded', 'لیستی مۆدێلەکان بارکرا')
    );

  const chooseModel = (id: string) =>
    run(
      'model',
      async () => {
        await provider.saveSettings({ model: id || null });
        setStatus(await provider.status());
      },
      loc('حُفظ النموذج', 'Model saved', 'مۆدێل پاشەکەوت کرا')
    );

  const test = () =>
    run(
      'test',
      async () => {
        await provider.test();
        setStatus(await provider.status());
      },
      loc('الاتصال يعمل', 'The connection works', 'پەیوەندییەکە کار دەکات')
    );

  const saveSearch = (patch: Partial<Pick<SearchImageSettings, 'enabled' | 'daily'>>) =>
    run(
      'search',
      async () => {
        const res = await provider.saveSearchImage(patch);
        setSearch(res.search_image);
        setDaily(String(res.search_image.daily));
      },
      loc('حُفظ البحث بالصورة', 'Photo search saved', 'گەڕان بە وێنە پاشەکەوت کرا')
    );

  if (loadError) {
    return (
      <div className="lv-surface flex items-center justify-between gap-3 p-6">
        <span className="text-sm text-text-secondary">{loc('تعذّر تحميل إعدادات Anthropic', 'Could not load the Anthropic settings', 'ڕێکخستنەکانی Anthropic بار نەکران')}</span>
        <button type="button" onClick={() => void load()} className="lv-button lv-button-secondary lv-button-sm">
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          {loc('إعادة المحاولة', 'Retry', 'دووبارە')}
        </button>
      </div>
    );
  }
  if (!status || !search) return <div className="lv-surface p-6 text-sm text-text-muted">{loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}</div>;
  if (!status.can_manage) return null;

  const source = status.key.source;
  const keyLine =
    source === 'stored'
      ? loc(`مفتاح محفوظ ومشفّر (${status.key.hint ?? '…'})`, `Saved, encrypted key (${status.key.hint ?? '…'})`, `کلیلی پاشەکەوتکراو و نهێنی (${status.key.hint ?? '…'})`)
      : source === 'worker_secret'
        ? loc('يُستخدم سر الخادم ANTHROPIC_API_KEY', 'Using the Worker secret ANTHROPIC_API_KEY', 'نهێنیی سێرڤەر ANTHROPIC_API_KEY بەکاردێت')
        : loc('لا يوجد مفتاح بعد', 'No key yet', 'هێشتا کلیل نییە');
  const vision = status.capabilities.vision;
  const modelOptions = models ?? (status.model ? [{ id: status.model, display_name: status.model, vision } as ModelDto] : []);

  return (
    <div className="lv-surface space-y-4 p-6" data-testid="anthropic-key-panel">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold">
          <KeyRound className="h-5 w-5" aria-hidden="true" />
          {loc('مفتاح Anthropic (الذكاء الاصطناعي)', 'Anthropic key (AI)', 'کلیلی Anthropic (زیرەکی دەستکرد)')}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          {loc(
            'مفتاح واحد للمتجر كله: البحث بالصورة، ومساعد الدعم، واستوديو التصميم. يُحفظ مشفّرًا ولا يظهر مرة أخرى.',
            'One key for the whole shop: photo search, the support assistant and the Creative Studio. It is stored encrypted and never shown again.',
            'یەک کلیل بۆ هەموو فرۆشگاکە: گەڕان بە وێنە، یاریدەدەری پشتگیری و ستۆدیۆی دیزاین. بە نهێنی پاشەکەوت دەکرێت و جارێکی تر نیشان نادرێت.'
          )}
        </p>
      </div>

      <div className="space-y-2">
        <p className={`text-sm font-semibold ${source === 'none' ? 'text-warning' : 'text-success'}`} data-key-source={source}>
          {keyLine}
        </p>
        {!status.encryption_ready && (
          <p className="flex items-center gap-2 text-sm text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {loc('حفظ مفتاح هنا يحتاج سر الخادم CREATIVE_STUDIO_ENC_KEY', 'Saving a key here needs the Worker secret CREATIVE_STUDIO_ENC_KEY', 'پاشەکەوتکردنی کلیل لێرە نهێنیی CREATIVE_STUDIO_ENC_KEY ی دەوێت')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            className="lv-input min-w-0 flex-1"
            type="password"
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            value={keyText}
            onChange={(e) => setKeyText(e.target.value)}
            placeholder="sk-ant-…"
            aria-label={loc('مفتاح Anthropic الجديد', 'New Anthropic key', 'کلیلی نوێی Anthropic')}
          />
          <button type="button" className="lv-button lv-button-primary" disabled={!keyText.trim() || busy !== null || !status.encryption_ready} onClick={() => void saveKey()}>
            {source === 'stored' ? loc('استبدال المفتاح', 'Replace key', 'گۆڕینی کلیل') : loc('حفظ المفتاح', 'Save key', 'پاشەکەوتکردنی کلیل')}
          </button>
          {source === 'stored' && (
            <button type="button" className="lv-button lv-button-secondary" disabled={busy !== null} onClick={() => void removeKey()}>
              {loc('حذف', 'Remove', 'سڕینەوە')}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="lv-input min-w-0 flex-1"
            dir="ltr"
            value={status.model ?? ''}
            disabled={busy !== null || source === 'none'}
            onFocus={() => {
              if (!models && source !== 'none') void loadModels();
            }}
            onChange={(e) => void chooseModel(e.target.value)}
            aria-label={loc('النموذج', 'Model', 'مۆدێل')}
          >
            <option value="">{loc('اختر نموذجًا', 'Choose a model', 'مۆدێلێک هەڵبژێرە')}</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name || m.id}
                {m.vision === true ? ' · 👁' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="lv-button lv-button-secondary" disabled={busy !== null || source === 'none' || !status.model} onClick={() => void test()}>
            {loc('اختبار الاتصال', 'Test connection', 'تاقیکردنەوەی پەیوەندی')}
          </button>
        </div>
        {status.model && vision === false && (
          <p className="flex items-center gap-2 text-sm text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {loc('هذا النموذج لا يقرأ الصور: البحث بالصورة يحتاج نموذجًا عليه 👁', 'This model cannot read pictures: photo search needs one marked 👁', 'ئەم مۆدێلە وێنە ناخوێنێتەوە: گەڕان بە وێنە مۆدێلێکی 👁 ی دەوێت')}
          </p>
        )}
        {status.last_test && (
          <p className={`text-sm ${status.last_test.ok ? 'text-success' : 'text-danger'}`}>
            {status.last_test.ok
              ? loc('آخر اختبار: يعمل', 'Last test: working', 'دوایین تاقیکردنەوە: کار دەکات')
              : loc(`آخر اختبار: فشل (${status.last_test.code ?? '—'})`, `Last test: failed (${status.last_test.code ?? '—'})`, `دوایین تاقیکردنەوە: سەرنەکەوت (${status.last_test.code ?? '—'})`)}
          </p>
        )}
      </div>

      <div className="space-y-2 rounded-lg bg-surface-raised p-4">
        <Switch
          checked={search.enabled}
          busy={busy === 'search'}
          disabled={busy !== null && busy !== 'search'}
          onChange={(next) => void saveSearch({ enabled: next })}
          label={loc('البحث بالصورة للزبائن', 'Photo search for customers', 'گەڕان بە وێنە بۆ کڕیاران')}
          description={loc(
            `اليوم: ${search.today} من ${search.daily} صورة`,
            `Today: ${search.today} of ${search.daily} photos`,
            `ئەمڕۆ: ${search.today} لە ${search.daily} وێنە`
          )}
        />
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary" htmlFor="search-image-daily">
            {loc('الحد اليومي للمتجر', 'Shop daily limit', 'سنووری ڕۆژانەی فرۆشگا')}
          </label>
          <input
            id="search-image-daily"
            className="lv-input w-28"
            type="number"
            inputMode="numeric"
            min={0}
            max={5000}
            dir="ltr"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
          />
          <button
            type="button"
            className="lv-button lv-button-secondary lv-button-sm"
            disabled={busy !== null || daily === String(search.daily) || !/^\d{1,4}$/.test(daily)}
            onClick={() => void saveSearch({ daily: Number(daily) })}
          >
            {loc('حفظ', 'Save', 'پاشەکەوت')}
          </button>
        </div>
      </div>

      {note && (
        <p role="status" className={`flex items-center gap-2 text-sm ${note.ok ? 'text-success' : 'text-danger'}`}>
          {note.ok ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />}
          {note.text}
        </p>
      )}
    </div>
  );
}
