import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, Check, Loader2, ArrowRight, ArrowLeft } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { api, uploadFile } from '../lib/api';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { sanitizeNextPath } from '../components/auth/nextPath';
import UsernameField, { type UsernameState } from '../components/onboarding/UsernameField';
import { onboardingStrings } from '../components/onboarding/strings';
import { COUNTRIES, countryNames, flagOf, COMMON_ISO } from '../components/auth/PhoneField';

/**
 * Account setup, in short steps that can all be skipped.
 *
 * WHAT THIS IS NOT: a gate. The account already exists and is fully usable
 * before this page is ever rendered — signup created it and signed the person
 * in. Every step here is optional, "Skip setup" is on every screen, and
 * nothing on this page is required to browse, buy or hold an account.
 *
 * WHY IT IS SEPARATE FROM SIGNUP. Asking for a display name, a handle, a
 * photo, a country and a language on the signup form makes six fields stand
 * between a person and an account. Three of them are things most people are
 * happy to give once they are already inside, and none of them is needed to
 * create the account. So signup asks for what it needs and this asks for the
 * rest — later, and never twice. It is reached from the one-time «أكمل ملفك
 * الشخصي» sheet (CompleteProfileSheet), which every signup method lands on.
 *
 * WHY THE PHONE IS ONLY MENTIONED HERE. A typed phone number proves nothing.
 * Ownership is proven by Telegram answering on it, which is a flow with its
 * own screens — so this step says where to do it rather than collecting a
 * number it would have to throw away.
 */
export default function Welcome() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, refreshUser } = useAuth();
  const { lang, dir, setLang } = useLanguage();
  const s = onboardingStrings(lang);
  const reduceMotion = useReducedMotion();

  const dest = sanitizeNextPath(params.get('next'));

  const [step, setStep] = useState(0);
  const TOTAL = 2; // two asking steps; the third screen is the confirmation

  const [name, setName] = useState('');
  const [usernameValue, setUsernameValue] = useState('');
  const [usernameState, setUsernameState] = useState<UsernameState>('idle');
  const [country, setCountry] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Prefill from whatever the account already has, so a Google signup — which
  // arrives with a name and often a handle — does not ask for them again.
  useEffect(() => {
    if (!user) return;
    setName((n) => n || user.name || '');
    setUsernameValue((u) => u || user.username || '');
    setCountry((c) => c || user.country || '');
    setAvatarUrl((a) => a ?? (user.avatar_key ? `/files/${user.avatar_key}` : null));
  }, [user]);

  // Somebody who already finished (or skipped) setup — or closed the
  // first-run sheet that leads here — has answered this. It is never asked
  // twice; the account page is where the fields live from then on.
  useEffect(() => {
    if (user && user.onboarding !== 'new') navigate(dest, { replace: true });
  }, [user, dest, navigate]);

  const { common, rest, nameOf } = useMemo(() => {
    const nameOf = countryNames(lang);
    const commonSet = new Set(COMMON_ISO);
    const common = COMMON_ISO.map((iso) => COUNTRIES.find((c) => c.iso === iso)).filter(Boolean) as typeof COUNTRIES;
    const rest = COUNTRIES.filter((c) => !commonSet.has(c.iso)).sort((a, b) =>
      nameOf(a.iso).localeCompare(nameOf(b.iso), lang)
    );
    return { common, rest, nameOf };
  }, [lang]);

  const pickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    // Checked here for a quick, clear message; the server checks again and is
    // the one that actually decides.
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type)) {
      setError(s.photoBadType);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError(s.photoTooBig);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const { key, url } = await uploadFile(file, 'avatar');
      await api.patch('/api/profile', { avatarKey: key });
      setAvatarUrl(url);
      await refreshUser();
    } catch (err) {
      setError(err instanceof Error ? err.message : s.saveFailed);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** Save whatever this step collected, then move on. Never blocks on a
   *  field the person left alone. */
  const saveAndAdvance = async (patch: Record<string, unknown>, next: number) => {
    setSaving(true);
    setError('');
    try {
      if (Object.keys(patch).length > 0) {
        await api.patch('/api/profile', patch);
        await refreshUser();
      }
      setStep(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : s.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const finish = async (state: 'done' | 'skipped') => {
    setSaving(true);
    try {
      await api.post('/api/profile/onboarding', { state });
      await refreshUser();
    } catch {
      // The account is fine either way; not being able to record that the
      // wizard was finished is not a reason to trap somebody in it.
    } finally {
      setSaving(false);
      navigate(dest, { replace: true });
    }
  };

  const initials = (name || user?.name || user?.email || '?').trim().slice(0, 1).toUpperCase();

  const dots = (
    <div className="mb-5 flex items-center gap-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all duration-200 ${
            i === step ? 'w-7 bg-gold' : i < step ? 'w-4 bg-gold/50' : 'w-4 bg-border-subtle'
          }`}
        />
      ))}
    </div>
  );

  const skipAll = (
    <button
      type="button"
      onClick={() => finish('skipped')}
      disabled={saving}
      className="inline-flex min-h-[44px] items-center px-1 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
    >
      {s.skipAll}
    </button>
  );

  const Arrow = dir === 'rtl' ? ArrowLeft : ArrowRight;

  let body: React.ReactNode;
  if (step === 0) {
    body = (
      <>
        <h1 className="text-[22px] font-bold text-text-primary">{s.stepProfile}</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{s.stepProfileHint}</p>

        <div className="mt-5 flex items-center gap-4">
          <span className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-subtle bg-surface-raised text-[22px] font-bold text-gold">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              initials
            )}
          </span>
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || saving}
              className="lv-button lv-button-secondary lv-button-sm"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Camera className="h-4 w-4" aria-hidden />
              )}
              {uploading ? s.photoUploading : avatarUrl ? s.photoChange : s.photoAdd}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={pickPhoto}
              aria-label={s.photo}
            />
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="ob-name" className="mb-1.5 block text-[13px] font-semibold text-text-secondary">
              {s.displayName}
            </label>
            <input
              className="lv-input min-h-12 py-3 text-[15px] disabled:opacity-60"
              id="ob-name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              disabled={saving}
            />
          </div>
          <UsernameField
            value={usernameValue}
            onChange={setUsernameValue}
            onStateChange={setUsernameState}
            lang={lang}
            disabled={saving}
          />
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={saving || usernameState === 'unavailable' || usernameState === 'checking'}
            onClick={() => {
              const patch: Record<string, unknown> = {};
              if (name.trim() && name.trim() !== user?.name) patch.name = name.trim();
              const u = usernameValue.trim().toLowerCase();
              if (u && u !== (user?.username ?? '')) patch.username = u;
              void saveAndAdvance(patch, 1);
            }}
            className="lv-button lv-button-primary min-h-12 flex-1"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {saving ? s.saving : s.continue}
            {!saving && <Arrow className="h-4 w-4" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={() => setStep(1)}
            disabled={saving}
            className="inline-flex min-h-[48px] items-center px-3 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            {s.skip}
          </button>
        </div>
      </>
    );
  } else if (step === 1) {
    body = (
      <>
        <h1 className="text-[22px] font-bold text-text-primary">{s.stepDetails}</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{s.stepDetailsHint}</p>

        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="ob-country" className="mb-1.5 block text-[13px] font-semibold text-text-secondary">
              {s.country}
            </label>
            <select
              className="lv-input min-h-12 py-3 text-[15px] disabled:opacity-60"
              id="ob-country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              disabled={saving}
            >
              <option value="">{s.countryPlaceholder}</option>
              {common.map((c) => (
                <option key={c.iso} value={c.iso}>
                  {flagOf(c.iso)} {nameOf(c.iso)}
                </option>
              ))}
              {rest.map((c) => (
                <option key={c.iso} value={c.iso}>
                  {flagOf(c.iso)} {nameOf(c.iso)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-text-secondary">{s.language}</span>
            <div className="grid grid-cols-3 gap-2">
              {(['ar', 'en', 'ckb'] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLang(code)}
                  disabled={saving}
                  aria-pressed={lang === code}
                  className="lv-choice min-h-12 px-3 text-[13px] font-bold disabled:opacity-50"
                >
                  {code === 'ar' ? 'العربية' : code === 'en' ? 'English' : 'کوردی'}
                </button>
              ))}
            </div>
          </div>

          <p className="lv-alert lv-alert-info text-[12px] leading-relaxed text-text-secondary">
            <span className="font-semibold text-text-primary">{s.phone}: </span>
            {s.phoneNote}
          </p>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              const patch: Record<string, unknown> = { locale: lang };
              if (country !== (user?.country ?? '')) patch.country = country;
              void saveAndAdvance(patch, 2);
            }}
            className="lv-button lv-button-primary min-h-12 flex-1"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {saving ? s.saving : s.continue}
            {!saving && <Arrow className="h-4 w-4" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={() => setStep(2)}
            disabled={saving}
            className="inline-flex min-h-[48px] items-center px-3 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            {s.skip}
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full lv-chip [--chip:var(--color-success)]">
          <Check className="h-6 w-6" aria-hidden />
        </span>
        <h1 className="text-[22px] font-bold text-text-primary">{s.stepDone}</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{s.stepDoneHint}</p>
        <button
          type="button"
          onClick={() => finish('done')}
          disabled={saving}
          className="lv-button lv-button-primary mt-6 min-h-12 w-full"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {s.finish}
        </button>
      </>
    );
  }

  return (
    <div dir={dir} className="min-h-[70vh] w-full px-4 py-8 text-text-primary">
      <div className="mx-auto w-full max-w-md">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-text-muted">
          {step < TOTAL ? s.step.replace('{n}', String(step + 1)).replace('{total}', String(TOTAL)) : s.welcome}
        </p>
        {dots}
        <div className="lv-surface p-5 sm:p-6">
          {/* Height is not animated and the panel is not absolutely
              positioned: the card grows to its content once, so nothing
              under the thumb moves after a tap. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
            >
              {body}
            </motion.div>
          </AnimatePresence>
          <p className="mt-3 min-h-[16px] text-xs font-medium text-danger" role="alert">
            {error}
          </p>
        </div>
        {step < 2 && <div className="mt-4 text-center">{skipAll}</div>}
      </div>
    </div>
  );
}
