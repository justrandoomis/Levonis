import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, ClipboardCheck, Loader2, RotateCcw, ShieldCheck, Upload } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { ApiError } from '../../lib/api';
import { apiRefusal, refusalLang } from '../../lib/refusalStrings';
import { GOVERNORATES } from '../../lib/governorates';
import {
  ACTIVITY_KINDS,
  MIN_APPLICANT_AGE,
  ageOn,
  applicationApi,
  baghdadToday,
  latestAdultDob,
  namePartOk,
  newOperationId,
  socialLinkOk,
  type ApplicantAnswer,
  type ApplicantView,
  type DraftPatch,
} from '../../lib/merchantApplication';
import type { ApplicationState } from '../../lib/merchant';
import { APPLICANT_STRINGS } from './applicantStrings';

/**
 * THE MERCHANT APPLICATION — FORM AND TRACKER (Community V3 push 1.2,
 * DECISIONS row 257). Mounted by /merchant/start for anyone a reviewer has not
 * approved yet, PLUS or not (owner decision C3: applying needs no
 * subscription, so this screen sells none).
 *
 * THE STATE IS THE SERVER'S, SAID AS IT IS. Draft, sent, in review, changes
 * requested (with the reviewer's public reason), approved (→ the store setup),
 * rejected (with the reason, and «قدّم من جديد» right away — owner decision
 * C8), withdrawn. A button that would be refused is not shown; the few rules
 * the browser can check (three name parts, 18+, an Instagram/Facebook link)
 * are checked here first and again on the server.
 *
 * PRIVATE VALUES. The legal name, the date of birth, the activity link and the
 * photo go to the server and never come back: the server answers whether each
 * was PROVIDED. So a saved value is shown as «محفوظ», its field stays empty,
 * and typing into it replaces it. What was typed is cleared the moment the
 * server accepted it; nothing is put in storage.
 */
export default function MerchantApplicationPanel({ onApproved }: { onApproved: () => void }) {
  const { lang } = useLanguage();
  const t = APPLICANT_STRINGS[lang] ?? APPLICANT_STRINGS.ar;
  const rl = refusalLang(lang);

  const [answer, setAnswer] = useState<ApplicantAnswer | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  /** The form is open: always for a draft or changes asked; on request for a sent one or a fresh start. */
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'send' | 'photo' | 'withdraw'>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Private fields: typed only, never filled from the server.
  const [given, setGiven] = useState('');
  const [father, setFather] = useState('');
  const [grandfather, setGrandfather] = useState('');
  const [dob, setDob] = useState('');
  const [social, setSocial] = useState('');
  // Review context and the public draft: the applicant's own words, echoed back by the server.
  const [governorate, setGovernorate] = useState('');
  const [activityKind, setActivityKind] = useState('');
  const [activityDescription, setActivityDescription] = useState('');
  const [publicName, setPublicName] = useState('');
  const [publicBio, setPublicBio] = useState('');
  const [publicLinks, setPublicLinks] = useState('');

  const operations = useRef(new Map<string, string>());
  const operationFor = (app: ApplicantView, action: string) => {
    const key = `${app.id}:${app.revision}:${action}`;
    let id = operations.current.get(key);
    if (!id) {
      id = newOperationId();
      operations.current.set(key, id);
    }
    return id;
  };

  const fillFrom = useCallback((app: ApplicantView | null) => {
    setGovernorate(app?.review.governorate ?? '');
    setActivityKind(app?.review.activity_kind ?? '');
    setActivityDescription(app?.review.activity_description ?? '');
    setPublicName(app?.public.name ?? '');
    setPublicBio(app?.public.bio ?? '');
    setPublicLinks((app?.public.links ?? []).join('\n'));
  }, []);

  const clearPrivate = () => {
    setGiven('');
    setFather('');
    setGrandfather('');
    setDob('');
    setSocial('');
  };

  const take = useCallback(
    (next: ApplicantAnswer) => {
      setAnswer(next);
      fillFrom(next.application);
      const state = next.application?.state;
      setEditing(state === 'draft' || state === 'changes_requested' || (!next.application && next.can?.apply === true));
    },
    [fillFrom]
  );

  useEffect(() => {
    let alive = true;
    applicationApi
      .get()
      .then((d) => {
        if (!alive) return;
        take(d);
        setLoadError(null);
      })
      .catch((e: unknown) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [attempt, take]);

  const reload = useCallback(async () => {
    const d = await applicationApi.get();
    take(d);
    return d;
  }, [take]);

  const app = answer?.application ?? null;
  const state: ApplicationState | 'none' = app ? app.state : 'none';
  const finished = state === 'rejected' || state === 'withdrawn';
  const today = baghdadToday();

  /** The fields that changed, checked — or a sentence saying what is wrong. */
  function patch(): DraftPatch | string {
    const p: DraftPatch = {};
    const nameTyped = [given, father, grandfather].some((v) => v.trim() !== '');
    if (nameTyped) {
      if (![given, father, grandfather].every(namePartOk)) return t.invalidName;
      p.legal_name = { given: given.trim(), father: father.trim(), grandfather: grandfather.trim() };
    }
    if (dob) {
      const age = ageOn(dob, today);
      if (age === null) return t.invalidDob;
      if (age < MIN_APPLICANT_AGE) return t.underAge;
      p.dob = dob;
    }
    if (social.trim()) {
      if (!socialLinkOk(social)) return t.invalidSocial;
      p.social_link = social.trim();
    }
    const name = publicName.replace(/\s+/g, ' ').trim();
    if (name.length === 1 || name.length > 60) return t.invalidPublicName;
    const links = publicLinks
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (links.length > 5 || links.some((l) => !/^https:\/\/\S+$/i.test(l))) return t.invalidLinks;
    p.governorate = governorate;
    p.activity_kind = activityKind;
    p.activity_description = activityDescription.trim();
    p.public_name = name;
    p.public_bio = publicBio.trim();
    p.public_links = links;
    return p;
  }

  function refusal(e: unknown): string {
    if (e instanceof ApiError && e.code === 'APPLICATION_INCOMPLETE' && Array.isArray(e.details?.missing)) {
      const names = (e.details!.missing as string[]).map((m) => t.missingNames[m] ?? m);
      return `${t.missing} ${names.join('، ')}`;
    }
    return apiRefusal(e, rl, t.failed);
  }

  async function save(): Promise<boolean> {
    const p = patch();
    if (typeof p === 'string') {
      setError(p);
      return false;
    }
    setBusy('save');
    setError('');
    setInfo('');
    try {
      await applicationApi.save(p);
      clearPrivate();
      await reload();
      setInfo(t.saved);
      return true;
    } catch (e) {
      setError(refusal(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    // Unsaved words are saved first, so what is sent is what is on screen.
    if (!(await save())) return;
    const current = (await applicationApi.get()).application;
    if (!current || current.state !== 'draft') return;
    setBusy('send');
    setError('');
    try {
      await applicationApi.submit(operationFor(current, 'submit'));
      await reload();
      setInfo(t.sent);
    } catch (e) {
      setError(refusal(e));
    } finally {
      setBusy(null);
    }
  }

  async function uploadPhoto(file: File | undefined) {
    if (!file) return;
    setBusy('photo');
    setError('');
    setInfo('');
    try {
      await applicationApi.photo(file);
      await reload();
    } catch (e) {
      setError(refusal(e));
    } finally {
      setBusy(null);
    }
  }

  async function withdraw() {
    if (!app) return;
    setBusy('withdraw');
    setError('');
    try {
      await applicationApi.withdraw(operationFor(app, 'withdraw'));
      setConfirmWithdraw(false);
      await reload();
    } catch (e) {
      setError(refusal(e));
    } finally {
      setBusy(null);
    }
  }

  if (!answer && loadError) {
    return (
      <div className="max-w-lg mx-auto px-4 pt-10 text-center" data-application-load-failed>
        <p className="text-text-secondary text-[13px] mb-4">{apiRefusal(loadError, rl, t.loadError)}</p>
        <button onClick={() => setAttempt((n) => n + 1)} className="lv-button lv-button-secondary">
          <RotateCcw className="w-4 h-4" /> {t.retry}
        </button>
      </div>
    );
  }
  if (!answer) {
    return (
      <div className="flex justify-center pt-16" role="status" aria-label={t.loading}>
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }
  if (!answer.available) {
    return (
      <div className="max-w-lg mx-auto px-4 pt-10 text-center" data-application-unavailable>
        <p className="text-text-secondary text-[13px]">{t.unavailable}</p>
      </div>
    );
  }

  const provided = app && !finished ? app.provided : { legal_name: false, dob: false, social_link: false, photo: false };
  const ready = answer.requirements?.ready !== false;
  const phoneOk = answer.requirements?.phone_verified === true;
  const live = state === 'draft' || state === 'submitted' || state === 'in_review' || state === 'changes_requested';

  return (
    <div className="relative z-10 max-w-lg mx-auto px-4 sm:px-6 pt-8 pb-32" data-merchant-application data-application-state={state}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-11 h-11 rounded-md lv-well flex items-center justify-center">
          <ClipboardCheck className="w-5 h-5 text-gold" />
        </div>
        <div>
          <h1 className="text-text-primary font-bold text-lg leading-tight">{t.title}</h1>
          <p className="text-text-muted text-[12px]">{t.intro}</p>
        </div>
      </div>

      {/* THE TRACKER: the state as the server holds it, and what it means. */}
      <div className="lv-surface p-4 mb-5" data-application-tracker>
        <p className="text-[12px] text-text-muted">{t.stateLabel}</p>
        <p className="text-text-primary font-bold text-[15px] mb-1">{state === 'none' ? t.title : t.states[state]}</p>
        <p className="text-text-secondary text-[12.5px] leading-relaxed">{t.explain[state]}</p>
        {app?.reason_public && (state === 'changes_requested' || state === 'rejected' || state === 'approved') && (
          <div className="mt-3 lv-alert text-[12.5px] text-text-primary" data-reason-public>
            <span className="font-bold">{t.reviewerSays}:</span> <span className="whitespace-pre-line">{app.reason_public}</span>
          </div>
        )}
        <div className="flex gap-2 flex-wrap mt-3">
          {state === 'approved' && (
            <button onClick={onApproved} className="lv-button lv-button-primary lv-button-sm">
              {t.continueSetup} <ArrowRight className="w-4 h-4 rtl:rotate-180" />
            </button>
          )}
          {finished && !editing && answer.can?.apply !== false && (
            <button
              onClick={() => {
                clearPrivate();
                setEditing(true);
                setInfo('');
                setError('');
              }}
              className="lv-button lv-button-primary lv-button-sm"
            >
              <RotateCcw className="w-4 h-4" /> {t.applyAgain}
            </button>
          )}
          {state === 'submitted' && !editing && (
            <button onClick={() => setEditing(true)} className="lv-button lv-button-secondary lv-button-sm">
              {t.edit}
            </button>
          )}
          {live && !confirmWithdraw && (
            <button onClick={() => setConfirmWithdraw(true)} disabled={!!busy} className="lv-button lv-button-secondary lv-button-sm">
              {t.withdraw}
            </button>
          )}
        </div>
        {confirmWithdraw && (
          <div className="mt-3 space-y-2">
            <p className="text-[12.5px] text-text-primary">{t.withdrawConfirm}</p>
            <div className="flex gap-2">
              <button onClick={() => void withdraw()} disabled={!!busy} className="lv-button lv-button-danger lv-button-sm">
                {busy === 'withdraw' ? <Loader2 className="w-4 h-4 animate-spin" /> : t.confirm}
              </button>
              <button onClick={() => setConfirmWithdraw(false)} className="lv-button lv-button-secondary lv-button-sm">
                {t.cancel}
              </button>
            </div>
          </div>
        )}
      </div>

      {!ready && <p className="lv-alert lv-alert-danger text-[12.5px] text-text-primary mb-4">{t.notReady}</p>}
      {error && (
        <div className="lv-alert lv-alert-danger mb-4" role="alert">
          <p className="text-red-300 text-[12.5px]">{error}</p>
        </div>
      )}
      {info && (
        <p className="lv-alert text-[12.5px] text-text-primary mb-4" role="status">
          {info}
        </p>
      )}

      {editing && state !== 'in_review' && state !== 'approved' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          data-application-form
        >
          <fieldset className="lv-surface p-4 mb-5" disabled={!!busy}>
            <legend className="text-text-primary font-bold text-[14px] flex items-center gap-1.5 px-1">
              <ShieldCheck className="w-4 h-4 text-gold" /> {t.privateTitle}
            </legend>
            <p className="text-text-muted text-[11.5px] mb-4 leading-relaxed">{t.privateHint}</p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-2">
              {(
                [
                  [t.given, given, setGiven, 'given-name'],
                  [t.father, father, setFather, 'off'],
                  [t.grandfather, grandfather, setGrandfather, 'off'],
                ] as const
              ).map(([label, value, set, auto]) => (
                <label key={label} className="block">
                  <span className="block text-text-secondary text-[12px] font-semibold mb-1">{label}</span>
                  <input
                    className="lv-input px-3 text-[14px]"
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    maxLength={60}
                    autoComplete={auto}
                    placeholder={provided.legal_name ? t.savedReplace : ''}
                  />
                </label>
              ))}
            </div>
            <p className="text-text-muted text-[11.5px] mb-4">{t.nameHint}</p>
            {provided.legal_name && <Saved label={t.savedReplace} />}

            <label className="block mb-4">
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">{t.dob}</span>
              <input
                type="date"
                className="lv-input px-3 text-[14px]"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                min="1900-01-01"
                max={latestAdultDob(today)}
                dir="ltr"
              />
              <span className="block text-text-muted text-[11.5px] mt-1">{t.dobHint}</span>
              {provided.dob && <Saved label={t.savedReplace} />}
            </label>

            <label className="block mb-4">
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">{t.socialLink}</span>
              <input
                className="lv-input px-3 text-[14px]"
                value={social}
                onChange={(e) => setSocial(e.target.value)}
                maxLength={300}
                dir="ltr"
                inputMode="url"
                placeholder={provided.social_link ? t.savedReplace : 'https://instagram.com/…'}
              />
              <span className="block text-text-muted text-[11.5px] mt-1">{t.socialHint}</span>
              {provided.social_link && <Saved label={t.savedReplace} />}
            </label>

            <div>
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">{t.photo}</span>
              <label className="lv-button lv-button-secondary lv-button-sm cursor-pointer">
                {busy === 'photo' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {busy === 'photo' ? t.uploading : provided.photo ? t.photoReplace : t.photoChoose}
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  className="sr-only"
                  onChange={(e) => {
                    void uploadPhoto(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
              {provided.photo && <Saved label={t.photoUploaded} />}
              <span className="block text-text-muted text-[11.5px] mt-1">{t.photoHint}</span>
            </div>
          </fieldset>

          <fieldset className="lv-surface p-4 mb-5" disabled={!!busy}>
            <legend className="text-text-primary font-bold text-[14px] px-1">{t.reviewTitle}</legend>
            <label className="block mb-4">
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">{t.governorate}</span>
              <select className="lv-input px-3 text-[14px]" value={governorate} onChange={(e) => setGovernorate(e.target.value)}>
                <option value="">{t.choose}</option>
                {GOVERNORATES.map((g) => (
                  <option key={g.id} value={g.id} className="bg-black">
                    {lang === 'ar' ? g.ar : lang === 'ckb' ? g.ckb : g.en}
                  </option>
                ))}
              </select>
            </label>
            <label className="block mb-4">
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">{t.activityKind}</span>
              <select className="lv-input px-3 text-[14px]" value={activityKind} onChange={(e) => setActivityKind(e.target.value)}>
                <option value="">{t.choose}</option>
                {ACTIVITY_KINDS.map((k) => (
                  <option key={k} value={k} className="bg-black">
                    {t.kinds[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">{t.activityDescription}</span>
              <textarea
                className="lv-input px-3 py-2 text-[14px] leading-relaxed resize-none"
                rows={3}
                maxLength={1000}
                value={activityDescription}
                onChange={(e) => setActivityDescription(e.target.value)}
              />
            </label>
          </fieldset>

          <fieldset className="lv-surface p-4 mb-5" disabled={!!busy}>
            <legend className="text-text-primary font-bold text-[14px] px-1">{t.publicTitle}</legend>
            <p className="text-text-muted text-[11.5px] mb-4 leading-relaxed">{t.publicHint}</p>
            <label className="block mb-4">
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">
                {t.publicName}
                <span className="text-gold ms-1">*</span>
              </span>
              <input className="lv-input px-3 text-[14px]" value={publicName} onChange={(e) => setPublicName(e.target.value)} maxLength={60} />
            </label>
            <label className="block mb-4">
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">{t.publicBio}</span>
              <textarea
                className="lv-input px-3 py-2 text-[14px] leading-relaxed resize-none"
                rows={3}
                maxLength={500}
                value={publicBio}
                onChange={(e) => setPublicBio(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="block text-text-secondary text-[12px] font-semibold mb-1">{t.publicLinks}</span>
              <textarea
                className="lv-input px-3 py-2 text-[13px] leading-relaxed resize-none"
                rows={3}
                value={publicLinks}
                onChange={(e) => setPublicLinks(e.target.value)}
                dir="ltr"
              />
            </label>
          </fieldset>

          {!phoneOk && (
            <p className="lv-alert text-[12.5px] text-text-primary mb-4" data-phone-needed>
              {t.phoneNeeded}{' '}
              <Link to="/settings" className="text-gold underline">
                {t.phoneLink}
              </Link>
            </p>
          )}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!!busy || !ready}
              className="lv-button lv-button-secondary w-full min-h-[48px]"
            >
              {busy === 'save' ? t.saving : t.save}
            </button>
            <button type="submit" disabled={!!busy || !ready || !phoneOk} className="lv-button lv-button-primary w-full min-h-[52px] text-[15px]">
              {busy === 'send' ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  {t.send}
                  <ArrowRight className="w-4 h-4 rtl:rotate-180" />
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Saved({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-emerald-400/90 text-[11.5px] mt-1">
      <Check className="w-3.5 h-3.5" /> {label}
    </span>
  );
}
