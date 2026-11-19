/**
 * «حد الفلامنت الشهري» — the owner's four numbers and the switch (owner
 * 2026-11-19; migration 0245, worker/lib/filamentLimits.ts).
 *
 * Pieces of ONE filament product (all its colours) per rolling window, per
 * plan; an empty field is «unlimited». Saved through
 * PUT /api/admin/settings/filamentMonthlyLimits, which is the owner's alone
 * and refuses junk in three languages; this card only reads and sends.
 */
import { useEffect, useState } from 'react';
import { Check, Layers, Save } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useOptionalAuth } from '../../AuthContext';
import { api, ApiError } from '../../lib/api';

type TierKey = 'none' | 'plus' | 'prime' | 'pro';
const TIERS: readonly TierKey[] = ['none', 'plus', 'prime', 'pro'];
const DEFAULTS = { enabled: true, window_days: 30, per_tier: { none: 50, plus: 100, prime: 250, pro: null as number | null } };

/** The stored setting → the form's strings (an unlimited plan is an empty field). */
export function filamentFormFrom(raw: unknown): { enabled: boolean; days: string; tiers: Record<TierKey, string> } {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const per = o.per_tier && typeof o.per_tier === 'object' ? (o.per_tier as Record<string, unknown>) : {};
  const tiers = {} as Record<TierKey, string>;
  for (const t of TIERS) {
    const v = t in per ? per[t] : DEFAULTS.per_tier[t];
    tiers[t] = typeof v === 'number' ? String(v) : '';
  }
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULTS.enabled,
    days: String(typeof o.window_days === 'number' ? o.window_days : DEFAULTS.window_days),
    tiers,
  };
}

/** The form → the value the server stores, or null when a field is not a whole number. */
export function filamentValueFrom(form: { enabled: boolean; days: string; tiers: Record<TierKey, string> }) {
  const whole = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const days = whole(form.days);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) return null;
  const per_tier = {} as Record<TierKey, number | null>;
  for (const t of TIERS) {
    if (form.tiers[t].trim() === '') per_tier[t] = null;
    else {
      const n = whole(form.tiers[t]);
      if (!Number.isSafeInteger(n) || n > 100_000) return null;
      per_tier[t] = n;
    }
  }
  return { enabled: form.enabled, window_days: days, per_tier };
}

const TIER_NAME: Record<TierKey, string> = { none: 'FREE', plus: 'PLUS', prime: 'PREMIUM', pro: 'PRO' };

export default function FilamentLimitsCard() {
  const { loc } = useLanguage();
  // A HINT, NEVER THE GATE: the settings route refuses anyone but the owner.
  const owner = useOptionalAuth()?.user?.is_owner === true;
  const [form, setForm] = useState(() => filamentFormFrom(null));
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<{ settings?: Record<string, unknown> }>('/api/admin/settings')
      .then((r) => {
        if (!live) return;
        setForm(filamentFormFrom(r.settings?.filamentMonthlyLimits));
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    const value = filamentValueFrom(form);
    if (!value) {
      setState('error');
      setError(loc('اكتب أعدادًا صحيحة (المدة من 1 إلى 365 يومًا).', 'Enter whole numbers (the window is 1 to 365 days).', 'ژمارەی تەواو بنووسە (ماوەکە لە 1 بۆ 365 ڕۆژە).'));
      return;
    }
    setState('saving');
    setError(null);
    try {
      await api.put('/api/admin/settings/filamentMonthlyLimits', { value });
      setState('saved');
    } catch (e) {
      setState('error');
      setError(e instanceof ApiError ? e.message : loc('تعذّر الحفظ', 'Save failed', 'پاشەکەوتکردن سەرکەوتوو نەبوو'));
    }
  };

  const disabled = !loaded || !owner;
  const edit = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setState('idle');
    setError(null);
  };

  return (
    <div className="lv-surface p-6" data-filament-limits>
      <div className="flex items-center gap-3 mb-2">
        <Layers className="w-5 h-5 shrink-0 text-text-secondary" aria-hidden="true" />
        <h3 className="text-lg font-bold text-text-primary">{loc('حد الفلامنت الشهري', 'Monthly filament limit', 'سنووری مانگانەی فیلامێنت')}</h3>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        {loc(
          'أقصى عدد قطع من نوع فلامنت واحد (كل ألوانه) خلال المدة، لكل باقة. يُحسب على الحساب وعلى رقم هاتف التوصيل معًا. اترك الحقل فارغًا لجعله بلا حد.',
          'The most pieces of one filament kind (all its colours) in the window, per plan. Counted per account and per delivery phone together. Leave a field empty for no limit.',
          'زۆرترین ژمارەی پارچە لە یەک جۆری فیلامێنت (هەموو ڕەنگەکانی) لەو ماوەیەدا، بۆ هەر پلانێک. لەسەر هەژمار و ژمارەی تەلەفۆنی گەیاندن پێکەوە دەژمێردرێت. خانەکە بەتاڵ بهێڵەوە بۆ بێسنوور.'
        )}
      </p>
      <label className="flex items-center gap-2 mb-4 text-sm font-bold text-text-primary">
        <input type="checkbox" checked={form.enabled} disabled={disabled} onChange={(e) => edit({ enabled: e.target.checked })} data-filament-limits-enabled />
        {loc('مفعّل', 'On', 'چالاکە')}
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <label className="space-y-2">
          <span className="block text-sm font-bold text-text-secondary">{loc('المدة (يوم)', 'Window (days)', 'ماوە (ڕۆژ)')}</span>
          <input className="lv-input font-bold tabular-nums disabled:opacity-50" type="number" inputMode="numeric" min={1} max={365} dir="ltr"
            value={form.days} disabled={disabled} onChange={(e) => edit({ days: e.target.value })} data-filament-limits-days />
        </label>
        {TIERS.map((t) => (
          <label key={t} className="space-y-2">
            <span className="block text-sm font-bold text-text-secondary">{t === 'none' ? loc('بدون اشتراك', 'No membership', 'بێ بەشداری') : TIER_NAME[t]}</span>
            <input className="lv-input font-bold tabular-nums disabled:opacity-50" type="number" inputMode="numeric" min={0} dir="ltr"
              placeholder={loc('بلا حد', 'Unlimited', 'بێسنوور')}
              value={form.tiers[t]} disabled={disabled} onChange={(e) => edit({ tiers: { ...form.tiers, [t]: e.target.value } })} data-filament-limits-tier={t} />
          </label>
        ))}
      </div>
      <div className="mt-4">
        {owner ? (
          <button type="button" onClick={save} disabled={state === 'saving' || !loaded} className="lv-button lv-button-primary w-full">
            <Save className="w-4 h-4" aria-hidden="true" /> {loc('حفظ', 'Save', 'پاشەکەوتکردن')}
          </button>
        ) : (
          <p className="text-[12px] leading-snug font-semibold text-text-secondary">{loc('يعدّلها المالك فقط.', 'Only the owner can change this.', 'تەنها خاوەن دەتوانێت ئەمە بگۆڕێت.')}</p>
        )}
        {state === 'saved' && (
          <p className="text-xs font-semibold text-text-muted flex items-center gap-1 mt-2">
            <Check className="w-3 h-3 text-success" aria-hidden="true" /> {loc('تم الحفظ', 'Saved', 'پاشەکەوت کرا')}
          </p>
        )}
        {state === 'error' && error && <p className="text-xs font-semibold text-danger mt-2" role="alert">{error}</p>}
      </div>
    </div>
  );
}
