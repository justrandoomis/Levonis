/**
 * Merchant onboarding — /merchant/start.
 *
 * Two things get the care here: the ADDRESS and the honesty of the gate.
 *
 * The address becomes a real hostname a customer will type and a link printed
 * on a box, so it is checked live against the server as the merchant types
 * and the result is shown as the value that will ACTUALLY be stored. Typing
 * "Ali 3D" and silently getting "ali-3d" later is the kind of surprise that
 * costs someone their store name; the field shows the normalised slug before
 * they commit.
 *
 * The gate is the server's. This page asks `/api/merchant/me` and renders
 * whatever it says. It never inspects a membership tier itself, because a
 * page that decides eligibility in the browser is a page that can be told a
 * different answer by the browser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { Store, Check, X, Loader2, ArrowRight, Globe } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { ApiError } from '../lib/api';
import { merchantApi, slugMessage, type MerchantMe, type SlugRejection } from '../lib/merchant';
import { GOVERNORATES } from '../lib/governorates';
import { CommunityClosedCard, useCommunityAccess } from './community/access';

type SlugState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; slug: string }
  | { kind: 'bad'; reason: SlugRejection; slug: string };

export default function MerchantStart() {
  const { loc, lang } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { access: communityAccess, reload: recheckCommunity } = useCommunityAccess();

  const [me, setMe] = useState<MerchantMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [governorate, setGovernorate] = useState('');
  const [slugState, setSlugState] = useState<SlugState>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    merchantApi
      .me()
      .then((d) => {
        if (!alive) return;
        setMe(d);
        // Already have a store? There is nothing to create.
        if (d.store) navigate('/merchant', { replace: true });
        if (d.suggested_slug) setSlug(d.suggested_slug);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [navigate]);

  // Debounced availability check. A keystroke is not a question worth asking
  // the server; a pause is.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkSlug = useCallback((value: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (!value) {
      setSlugState({ kind: 'idle' });
      return;
    }
    setSlugState({ kind: 'checking' });
    timer.current = setTimeout(async () => {
      try {
        const r = await merchantApi.checkSlug(value);
        setSlugState(r.ok ? { kind: 'ok', slug: r.slug } : { kind: 'bad', reason: r.reason!, slug: r.slug });
      } catch {
        setSlugState({ kind: 'idle' });
      }
    }, 400);
  }, []);

  useEffect(() => {
    checkSlug(slug);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [slug, checkSlug]);

  const canSubmit = name.trim().length >= 2 && slugState.kind === 'ok' && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      // The normalised slug, not the raw input — what the field showed is
      // what gets created.
      const res = await merchantApi.onboard({
        name: name.trim(),
        slug: slugState.kind === 'ok' ? slugState.slug : slug,
        tagline: tagline.trim(),
        description: description.trim(),
        governorate,
      });
      navigate('/merchant', { replace: true, state: { created: res.store?.slug } });
    } catch (e) {
      // The server's refusals are CODES; each becomes this page's own
      // sentence (never the server's English). A slug lost to a race between
      // the live check and the insert is a 409 SLUG_UNAVAILABLE, and a second
      // tap that finds the store already created is STORE_EXISTS.
      if (e instanceof ApiError && e.code === 'STORE_EXISTS') {
        navigate('/merchant', { replace: true });
        return;
      }
      if (e instanceof ApiError && e.code === 'SLUG_UNAVAILABLE') {
        const reason = (e.details?.reason as SlugRejection | undefined) ?? 'taken';
        setSlugState({ kind: 'bad', reason, slug: slugState.kind === 'ok' ? slugState.slug : slug });
        setError(slugMessage(reason, loc));
      } else if (e instanceof ApiError && e.code === 'GOVERNORATE_INVALID') {
        setError(loc('اختر المحافظة من القائمة.', 'Choose a governorate from the list.')); /* OWNER: Sorani to be written by hand. */
      } else {
        setError(loc('تعذّر إنشاء المتجر. حاول مجددًا.', 'Could not create the store. Try again.', 'نەتوانرا فرۆشگاکە دروست بکرێت.'));
      }
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Gate title={loc('سجّل الدخول أولًا', 'Sign in first', 'سەرەتا بچۆ ژوورەوە')} to="/auth" label={loc('تسجيل الدخول', 'Sign in', 'چوونەژوورەوە')} />;
  }

  // Not eligible: say so and point at the thing that fixes it, rather than
  // showing a form that the server will refuse.
  if (!me?.eligible) {
    return (
      <Gate
        title={loc('متجرك يحتاج عضوية PLUS', 'A store needs LEVO PLUS', 'فرۆشگا پێویستی بە LEVO PLUS هەیە')}
        body={loc(
          'اشترك في LEVO PLUS لفتح متجرك الخاص في مجتمع ليفو.',
          'Subscribe to LEVO PLUS to open your own store in the Levo community.',
          'بەشداری LEVO PLUS بکە بۆ کردنەوەی فرۆشگای تایبەتی خۆت.'
        )}
        to="/subscription"
        label={loc('عرض الاشتراكات', 'View plans', 'بینینی پلانەکان')}
      />
    );
  }

  // A new store is a new community merchant, and the server refuses it while
  // Levo Community is shut to this member (DECISIONS 110). Say so here rather
  // than showing a form whose submit would be refused.
  if (communityAccess?.may_enter === false) {
    return <CommunityClosedCard onRecheck={recheckCommunity} />;
  }

  return (
    <div className="min-h-screen bg-black text-zinc-300 pb-32">
      <div className="fixed top-[15%] left-1/2 -translate-x-1/2 w-full max-w-lg h-[500px] bg-olive/15 rounded-full blur-[120px] pointer-events-none z-0" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="relative z-10 max-w-lg mx-auto px-4 sm:px-6 pt-8"
      >
        <div className="flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-2xl bg-olive/30 border border-gold/20 flex items-center justify-center">
            <Store className="w-5 h-5 text-gold" />
          </div>
          <div>
            <h1 className="text-gold font-bold text-lg leading-tight">
              {loc('أنشئ متجرك', 'Create your store', 'فرۆشگاکەت دروست بکە')}
            </h1>
            <p className="text-zinc-500 text-[12px]">
              {loc('خطوة واحدة، ويمكنك تعديل كل شيء لاحقًا', 'One step — everything is editable later', 'یەک هەنگاو — دواتر هەموو شتێک دەگۆڕدرێت')}
            </p>
          </div>
        </div>

        <Field label={loc('اسم المتجر', 'Store name', 'ناوی فرۆشگا')} required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder={loc('مثال: علي ثري دي', 'e.g. Ali 3D', 'نموونە: Ali 3D')}
            className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40 transition-colors"
          />
        </Field>

        <Field
          label={loc('عنوان المتجر', 'Store address', 'ناونیشانی فرۆشگا')}
          required
          hint={loc(
            'هذا سيصبح رابط متجرك. اختره بعناية — تغييره لاحقًا محدود.',
            'This becomes your store link. Choose carefully — changing it later is limited.',
            'ئەمە دەبێتە بەستەری فرۆشگاکەت. بە وریایی هەڵیبژێرە.'
          )}
        >
          <div className="relative">
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              maxLength={32}
              dir="ltr"
              placeholder="ali3d"
              className={`w-full min-h-[48px] rounded-2xl bg-black/40 border px-4 pe-11 text-white text-[14px] outline-none transition-colors ${
                slugState.kind === 'bad'
                  ? 'border-red-500/50'
                  : slugState.kind === 'ok'
                    ? 'border-emerald-500/40'
                    : 'border-white/10 focus:border-gold/40'
              }`}
            />
            <span className="absolute end-3 top-1/2 -translate-y-1/2">
              {slugState.kind === 'checking' && <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />}
              {slugState.kind === 'ok' && <Check className="w-4 h-4 text-emerald-400" />}
              {slugState.kind === 'bad' && <X className="w-4 h-4 text-red-400" />}
            </span>
          </div>

          {/* The address exactly as it will exist. Shown for the normalised
              value, so "Ali3D" visibly becomes "ali3d" before committing. */}
          {slugState.kind === 'ok' && (
            <div className="flex items-center gap-1.5 mt-2 text-emerald-400/90 text-[12px]" dir="ltr">
              <Globe className="w-3.5 h-3.5 shrink-0" />
              {/* The domain from the SERVER (`/api/merchant/me` root_domain),
                  never typed into the bundle — a staging deployment previews
                  its own domain, not production's (audit 01 B19). */}
              <span className="font-semibold truncate" translate="no">
                {me?.root_domain ? `${slugState.slug}.${me.root_domain}` : `@${slugState.slug}`}
              </span>
            </div>
          )}
          {slugState.kind === 'bad' && (
            <p className="text-red-400/90 text-[12px] mt-2">{slugMessage(slugState.reason, loc)}</p>
          )}
        </Field>

        <Field label={loc('وصف مختصر', 'Short tagline', 'وەسفی کورت')}>
          <input
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            maxLength={140}
            placeholder={loc('طباعة ثلاثية الأبعاد وقطع مخصصة', '3D printing and custom parts', 'چاپی سێ ڕەهەندی و پارچەی تایبەت')}
            className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40 transition-colors"
          />
        </Field>

        <Field label={loc('المحافظة', 'Governorate', 'پارێزگا')}>
          <select
            value={governorate}
            onChange={(e) => setGovernorate(e.target.value)}
            className="w-full min-h-[48px] rounded-2xl bg-black/40 border border-white/10 px-4 text-white text-[14px] outline-none focus:border-gold/40 transition-colors"
          >
            <option value="">{loc('اختر', 'Select', 'هەڵبژێرە')}</option>
            {GOVERNORATES.map((g) => (
              <option key={g.id} value={g.id} className="bg-black">
                {lang === 'ar' ? g.ar : lang === 'ckb' ? g.ckb : g.en}
              </option>
            ))}
          </select>
        </Field>

        <Field label={loc('عن المتجر', 'About the store', 'دەربارەی فرۆشگا')}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
            rows={4}
            className="w-full rounded-2xl bg-black/40 border border-white/10 px-4 py-3 text-white text-[14px] outline-none focus:border-gold/40 transition-colors resize-none"
          />
        </Field>

        {error && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 mb-4">
            <p className="text-red-300 text-[12.5px]">{error}</p>
          </div>
        )}

        <button
          onClick={submit}
          disabled={!canSubmit}
          className="w-full min-h-[52px] rounded-2xl bg-olive text-snow font-bold text-[15px] flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
        >
          {submitting ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              {loc('إنشاء المتجر', 'Create store', 'دروستکردنی فرۆشگا')}
              <ArrowRight className="w-4 h-4 rtl:rotate-180" />
            </>
          )}
        </button>
      </motion.div>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="block text-zinc-400 text-[12.5px] font-semibold mb-2">
        {label}
        {required && <span className="text-gold ms-1">*</span>}
      </label>
      {children}
      {hint && <p className="text-zinc-600 text-[11.5px] mt-2 leading-relaxed">{hint}</p>}
    </div>
  );
}

function Gate({ title, body, to, label }: { title: string; body?: string; to: string; label: string }) {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-6">
      <div className="max-w-sm w-full text-center">
        <div className="w-14 h-14 rounded-2xl bg-olive/30 border border-gold/20 flex items-center justify-center mx-auto mb-5">
          <Store className="w-6 h-6 text-gold" />
        </div>
        <h1 className="text-gold font-bold text-lg mb-2">{title}</h1>
        {body && <p className="text-zinc-400 text-[13px] leading-relaxed mb-6">{body}</p>}
        <Link
          to={to}
          className="inline-flex items-center justify-center gap-2 min-h-[48px] px-6 rounded-2xl bg-olive text-snow font-bold text-[14px] active:scale-[0.98] transition-transform"
        >
          {label}
          <ArrowRight className="w-4 h-4 rtl:rotate-180" />
        </Link>
      </div>
    </div>
  );
}
