import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, MessageCircle, AlertCircle } from 'lucide-react';
import { api, ApiError, isNotConfigured, isServiceOutage } from '../../lib/api';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import OtpBoxes from './OtpBoxes';
import PhoneField, { emptyPhoneValue, type PhoneValue } from './PhoneField';
import AuthTextField from './AuthTextField';
import FillButton, { lengthProgress } from './FillButton';

/**
 * SIGNING IN WITH A CODE — email or WhatsApp, no password.
 *
 * Two screens and nothing else: say where the code should go, then type the
 * code. It is deliberately the same two-beat shape as the Telegram flow next
 * to it, so a customer who has done one already knows this one.
 *
 * WHAT THIS SCREEN WILL NOT DO, and why it is not a bug:
 *
 *   IT NEVER SAYS WHETHER THE ACCOUNT EXISTS. `/otp/start` answers the same
 *   way for an unknown address as for a known one — that is the whole point
 *   of the endpoint — so this screen moves to the code step either way. A
 *   customer who mistyped their address finds out at the code step, which is
 *   the cost of not handing an attacker a way to test a list of addresses
 *   against the shop's user table.
 *
 *   ON THE SIGN-IN PATH IT STILL DOES NOT CREATE ACCOUNTS, and `/otp/start`
 *   still sends nothing to a destination with no account — the decoy that
 *   stops the endpoint answering "does this address exist" is exactly that
 *   property and it is not given up.
 *
 * `mode="signup"` IS THE OTHER HALF, and it is a different question, not a
 * relaxed version of the same one. There the destination is a stranger by
 * definition, so the code is really sent, and proving it earns a TICKET rather
 * than a session: an account still needs a name, and that is the third screen
 * here. A person who turns out to already have an account on that number is
 * simply signed in — they proved the number, which is all signing in ever
 * required.
 */

const STRINGS = {
  ar: {
    introSignupWhatsapp: 'سنرسل رمزاً من ٦ أرقام إلى واتساب على هذا الرقم لتأكيد ملكيته.',
    introSignupEmail: 'سنرسل رمزاً من ٦ أرقام إلى بريدك لتأكيد ملكيته.',
    sentForSignup: 'أرسلنا رمزاً الآن. اكتبه لإكمال إنشاء حسابك.',
    profileTitle: 'بقي اسمك فقط',
    profileHint: 'تم توثيق الرقم. اختر الاسم الذي سيظهر للآخرين.',
    nameLabel: 'الاسم',
    namePlaceholder: 'مثال: علي حسن',
    usernameLabel: 'اسم المستخدم',
    usernameOptional: 'اختياري',
    usernamePlaceholder: 'ali3d',
    createCta: 'إنشاء الحساب',
    creating: 'جارٍ الإنشاء…',
    createdLabel: 'تم',
    nameRequired: 'اكتب اسمك لإكمال الحساب.',
    introEmail: 'سنرسل رمزاً من ٦ أرقام إلى بريدك. لا حاجة لكلمة المرور.',
    introWhatsapp: 'سنرسل رمزاً من ٦ أرقام إلى واتساب على رقم حسابك الموثّق.',
    emailLabel: 'البريد الإلكتروني',
    emailPlaceholder: 'you@example.com',
    phoneLabel: 'رقم الهاتف',
    countryLabel: 'الدولة',
    commonCountries: 'الأكثر استخداماً',
    allCountries: 'كل الدول',
    countrySearch: 'ابحث عن دولة أو رمز',
    countryEmpty: 'لا توجد دولة بهذا الاسم أو الرمز',
    phoneHint: 'الرقم نفسه الموثّق على حسابك. تُقبل الأرقام العربية أيضاً.',
    phoneInvalid: 'هذا الرقم غير صحيح للدولة المختارة.',
    emailInvalid: 'اكتب بريداً إلكترونياً صحيحاً.',
    send: 'إرسال الرمز',
    sending: 'جارٍ الإرسال…',
    sent: 'أُرسل',
    sentToEmail: 'إذا كان لديك حساب بهذا البريد، فقد وصله رمز الآن.',
    sentToWhatsapp: 'إذا كان لديك حساب بهذا الرقم، فقد وصلك رمز على واتساب.',
    codeLabel: 'الرمز (٦ أرقام)',
    verify: 'تسجيل الدخول',
    verifying: 'جارٍ التحقق…',
    verified: 'تم',
    resend: 'إعادة إرسال الرمز',
    resendIn: 'إعادة الإرسال بعد {s} ثانية',
    changeTarget: 'تغيير العنوان',
    wrongCode: 'الرمز غير صحيح أو انتهت صلاحيته. اطلب رمزاً جديداً.',
    notConfiguredEmail: 'الدخول برمز عبر البريد غير مُفعّل بعد — لم يهيّئه المسؤول.',
    notConfiguredWhatsapp: 'الدخول برمز عبر واتساب غير مُفعّل بعد — لم يهيّئه المسؤول.',
    outageWhatsapp: 'واتساب متوقف مؤقتًا الآن. جرّب تيليغرام أو البريد.',
    outageTelegram: 'تيليغرام لا يستجيب الآن. جرّب البريد أو أعد المحاولة بعد قليل.',
    sendFailed: 'تعذّر إرسال الرمز الآن. حاول بعد قليل.',
    tooMany: 'محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.',
    loadFailed: 'حدث خطأ. أعد المحاولة.',
    expiryNote: 'الرمز صالح ١٠ دقائق ويُستعمل مرة واحدة.',
    neverShare: 'لا تشارك الرمز مع أحد. فريق Levonis لن يطلبه منك أبداً.',
    noAccountHint: 'لا يوجد حساب؟ أنشئ حساباً أولاً.',
    createAccount: 'إنشاء حساب',
  },
  en: {
    introSignupWhatsapp: 'We will send a 6-digit code on WhatsApp to this number to confirm it is yours.',
    introSignupEmail: 'We will send a 6-digit code to your email to confirm it is yours.',
    sentForSignup: 'A code is on its way. Type it to finish creating your account.',
    profileTitle: 'Just your name left',
    profileHint: 'The number is confirmed. Choose the name other people will see.',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Ali Hassan',
    usernameLabel: 'Username',
    usernameOptional: 'optional',
    usernamePlaceholder: 'ali3d',
    createCta: 'Create the account',
    creating: 'Creating…',
    createdLabel: 'Done',
    nameRequired: 'Type your name to finish the account.',
    introEmail: 'We will send a 6-digit code to your email. No password needed.',
    introWhatsapp: "We will send a 6-digit code on WhatsApp to your account's verified number.",
    emailLabel: 'Email',
    emailPlaceholder: 'you@example.com',
    phoneLabel: 'Phone number',
    countryLabel: 'Country',
    commonCountries: 'Most used',
    allCountries: 'All countries',
    countrySearch: 'Search a country or code',
    countryEmpty: 'No country matches that',
    phoneHint: 'The same number verified on your account.',
    phoneInvalid: 'That number is not valid for the selected country.',
    emailInvalid: 'Enter a valid email address.',
    send: 'Send the code',
    sending: 'Sending…',
    sent: 'Sent',
    sentToEmail: 'If you have an account with that address, a code is on its way.',
    sentToWhatsapp: 'If you have an account with that number, a code has arrived on WhatsApp.',
    codeLabel: 'Code (6 digits)',
    verify: 'Sign in',
    verifying: 'Checking…',
    verified: 'Done',
    resend: 'Send another code',
    resendIn: 'Resend in {s}s',
    changeTarget: 'Change address',
    wrongCode: 'That code is wrong or has expired. Request a new one.',
    notConfiguredEmail: 'Sign-in codes by email are not enabled yet — the administrator has not configured it.',
    notConfiguredWhatsapp: 'Sign-in codes by WhatsApp are not enabled yet — the administrator has not configured it.',
    outageWhatsapp: 'WhatsApp is down right now. Try Telegram or email instead.',
    outageTelegram: 'Telegram is not answering right now. Try email, or again shortly.',
    sendFailed: 'The code could not be sent right now. Try again shortly.',
    tooMany: 'Too many attempts. Wait a moment and try again.',
    loadFailed: 'Something went wrong. Try again.',
    expiryNote: 'The code is valid for 10 minutes and works once.',
    neverShare: 'Never share the code. LEVONIS staff will never ask you for it.',
    noAccountHint: 'No account yet? Create one first.',
    createAccount: 'Create an account',
  },
  ckb: {
    introSignupWhatsapp: 'کۆدێکی ٦ ژمارەیی بۆ ئەم ژمارەیە لە واتساپ دەنێرین بۆ دڵنیابوون لێی.',
    introSignupEmail: 'کۆدێکی ٦ ژمارەیی بۆ ئیمەیڵەکەت دەنێرین بۆ دڵنیابوون لێی.',
    sentForSignup: 'کۆدەکە نێردرا. بینووسە بۆ تەواوکردنی هەژمارەکەت.',
    profileTitle: 'تەنها ناوەکەت ماوە',
    profileHint: 'ژمارەکە پشتڕاست کرایەوە. ئەو ناوە هەڵبژێرە کە خەڵک دەیبینێت.',
    nameLabel: 'ناو',
    namePlaceholder: 'نموونە: عەلی حەسەن',
    usernameLabel: 'ناوی بەکارهێنەر',
    usernameOptional: 'ئارەزوومەندانە',
    usernamePlaceholder: 'ali3d',
    createCta: 'دروستکردنی هەژمار',
    creating: 'دروست دەکرێت…',
    createdLabel: 'تەواو',
    nameRequired: 'ناوەکەت بنووسە بۆ تەواوکردنی هەژمارەکە.',
    introEmail: 'کۆدێکی ٦ ژمارەیی بۆ ئیمەیڵەکەت دەنێرین. پێویست بە وشەی نهێنی ناکات.',
    introWhatsapp: 'کۆدێکی ٦ ژمارەیی بە واتساپ دەنێرین بۆ ژمارە پشتڕاستکراوەکەی هەژمارەکەت.',
    emailLabel: 'ئیمەیڵ',
    emailPlaceholder: 'you@example.com',
    phoneLabel: 'ژمارەی تەلەفۆن',
    countryLabel: 'وڵات',
    commonCountries: 'زۆرترین بەکارهاتوو',
    allCountries: 'هەموو وڵاتان',
    countrySearch: 'گەڕان بە ناوی وڵات یان کۆد',
    countryEmpty: 'هیچ وڵاتێک نەدۆزرایەوە',
    phoneHint: 'هەمان ژمارەی پشتڕاستکراو لەسەر هەژمارەکەت.',
    phoneInvalid: 'ئەم ژمارەیە بۆ ئەم وڵاتە دروست نییە.',
    emailInvalid: 'ئیمەیڵێکی دروست بنووسە.',
    send: 'ناردنی کۆد',
    sending: 'دەنێردرێت…',
    sent: 'نێردرا',
    sentToEmail: 'ئەگەر هەژمارت هەیە بەم ئیمەیڵە، کۆدەکە نێردرا.',
    sentToWhatsapp: 'ئەگەر هەژمارت هەیە بەم ژمارەیە، کۆدێکت بۆ هات لە واتساپ.',
    codeLabel: 'کۆد (٦ ژمارە)',
    verify: 'چوونەژوورەوە',
    verifying: 'پشکنین…',
    verified: 'تەواو',
    resend: 'ناردنی کۆدێکی نوێ',
    resendIn: 'دووبارە ناردن دوای {s} چرکە',
    changeTarget: 'گۆڕینی ناونیشان',
    wrongCode: 'کۆدەکە هەڵەیە یان بەسەرچووە. کۆدێکی نوێ داوا بکە.',
    notConfiguredEmail: 'چوونەژوورەوە بە کۆدی ئیمەیڵ هێشتا چالاک نەکراوە.',
    notConfiguredWhatsapp: 'چوونەژوورەوە بە کۆدی واتساپ هێشتا چالاک نەکراوە.',
    outageWhatsapp: 'واتساپ ئێستا لەکارکەوتووە. تیلێگرام یان ئیمەیڵ تاقی بکەرەوە.',
    outageTelegram: 'تیلێگرام وەڵام ناداتەوە. ئیمەیڵ تاقی بکەرەوە یان دواتر.',
    sendFailed: 'کۆدەکە ئێستا نەنێردرا. کەمێک دواتر هەوڵ بدەرەوە.',
    tooMany: 'هەوڵی زۆر. کەمێک چاوەڕێ بکە.',
    loadFailed: 'هەڵەیەک ڕوویدا. هەوڵ بدەرەوە.',
    expiryNote: 'کۆدەکە ١٠ خولەک کاردەکات و جارێک بەکاردێت.',
    neverShare: 'کۆدەکە لەگەڵ کەس بەشی مەکە. ستافی Levonis هەرگیز داوای لێ ناکات.',
    noAccountHint: 'هەژمارت نییە؟ سەرەتا هەژمارێک دروست بکە.',
    createAccount: 'دروستکردنی هەژمار',
  },
} as const;

export type CodeChannel = 'email' | 'whatsapp';

interface CodeAuthProps {
  channel: CodeChannel;
  /** 'signin' asks for a session; 'signup' asks for an account. */
  mode?: 'signin' | 'signup';
  /** A number already chosen on the screen before this one. When it is given,
   *  the destination step is skipped — asking twice for something the person
   *  just typed is how a flow loses people. */
  initialPhone?: PhoneValue | null;
  /** Carried into the account this flow may create. */
  referralCode?: string;
  onSuccess?: (created: boolean) => void;
  onSwitchMode?: (view: 'signup') => void;
}

type Phase = 'target' | 'code' | 'profile' | 'done';

export default function CodeAuth({
  channel,
  mode = 'signin',
  initialPhone = null,
  referralCode = '',
  onSuccess,
  onSwitchMode,
}: CodeAuthProps) {
  const { lang } = useLanguage();
  const s = STRINGS[lang] || STRINGS.ar;
  const { refreshUser } = useAuth();
  const navigate = useNavigate();

  const signup = mode === 'signup';
  const [phase, setPhase] = useState<Phase>('target');
  const [emailValue, setEmailValue] = useState('');
  const [phone, setPhone] = useState<PhoneValue>(() => initialPhone ?? emptyPhoneValue());
  const [code, setCode] = useState('');
  /** The proof, once the code is spent. Never a session — see the note. */
  const [ticket, setTicket] = useState('');
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The resend timer is the SERVER's number counted down locally, never a
  // locally invented one: a client-side guess that runs short produces a 429
  // the customer cannot explain.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  /** The identifier in the shape the server wants. Null while incomplete. */
  const identifier = channel === 'email' ? emailValue.trim() : phone.e164;
  const targetReady =
    channel === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailValue.trim()) : phone.valid;

  const describeError = useCallback(
    (e: unknown): string => {
      /**
       * A CHANNEL THAT IS DOWN IS NOT A CHANNEL NOBODY SET UP, and the screen
       * must not react to them the same way.
       *
       * `setNotConfigured(true)` replaces this whole component with a warning
       * (below), which is right when the deployment has no provider: there is
       * nothing here to try. It is wrong — and was what the owner reported —
       * when the provider IS configured and merely down, because it also
       * removes the channel switcher, the retry, and the alternative road the
       * server just named in its own sentence. An outage keeps the screen.
       */
      if (isServiceOutage(e)) {
        return channel === 'email'
          ? s.sendFailed
          : (e as ApiError).code === 'TELEGRAM_UNAVAILABLE'
            ? s.outageTelegram
            : s.outageWhatsapp;
      }
      if (isNotConfigured(e)) {
        setNotConfigured(true);
        return channel === 'email' ? s.notConfiguredEmail : s.notConfiguredWhatsapp;
      }
      if (e instanceof ApiError) {
        if (e.code === 'OTP_COOLDOWN') {
          const after = Number((e.details as { retry_after_seconds?: unknown })?.retry_after_seconds);
          if (Number.isFinite(after) && after > 0) setCooldown(Math.ceil(after));
          return s.resendIn.replace('{s}', String(Math.max(1, Math.ceil(after || 60))));
        }
        if (e.code === 'OTP_SEND_FAILED') return s.sendFailed;
        if (e.code === 'OTP_FAILED') return s.wrongCode;
        if (e.status === 429) return s.tooMany;
        if (e.message) return e.message;
      }
      return s.loadFailed;
    },
    [channel, s]
  );

  const send = useCallback(async () => {
    if (!identifier || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ resend_after_seconds?: number }>('/api/auth/otp/start', {
        channel,
        identifier,
        lang,
        // The one field that decides whether a stranger's phone rings. On the
        // sign-in path the server keeps its decoy; here it must really send,
        // because reaching somebody with no account is the entire point.
        intent: signup ? 'signup' : 'signin',
      });
      if (!mounted.current) return;
      setPhase('code');
      setCode('');
      setCooldown(Math.max(1, Number(res?.resend_after_seconds) || 60));
      // On the sign-up path the code REALLY went out, so the hedged "if you
      // have an account…" wording would be a lie. It exists on the sign-in
      // path because there the message is deliberately identical whether or
      // not anything was sent.
      setNotice(signup ? s.sentForSignup : channel === 'email' ? s.sentToEmail : s.sentToWhatsapp);
    } catch (e) {
      if (mounted.current) setError(describeError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [identifier, busy, channel, lang, s, describeError, signup]);

  /**
   * The number was chosen on the screen before this one, so send immediately
   * rather than showing the same field again. Runs once; `sentOnce` is a ref
   * because React 18 mounts effects twice in development and a code sent
   * twice burns the resend cooldown the person is about to need.
   */
  const sentOnce = useRef(false);
  useEffect(() => {
    if (!initialPhone?.valid || sentOnce.current) return;
    sentOnce.current = true;
    void send();
    // `send` is stable enough for this one-shot; re-running on its identity
    // would re-send on every keystroke it closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = useCallback(async () => {
    if (code.length !== 6 || busy || !identifier) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ signup?: boolean; ticket?: string }>('/api/auth/otp/verify', {
        channel,
        identifier,
        code,
        // Without this the server answers a code for an unknown destination
        // the way it always has — a failure. Sign-up is the only caller that
        // asks for the other answer.
        ...(signup ? { allow_signup: true } : {}),
      });
      if (!mounted.current) return;
      // A ticket means there was no account on this destination, so the next
      // question is what to call the one about to exist. There is no session
      // yet and nothing to refresh.
      if (res?.signup && typeof res.ticket === 'string') {
        setTicket(res.ticket);
        setPhase('profile');
        return;
      }
      await refreshUser();
      if (!mounted.current) return;
      setPhase('done');
      if (onSuccess) onSuccess(false);
      else navigate('/');
    } catch (e) {
      if (!mounted.current) return;
      setError(describeError(e));
      // The code is spent either way (an attempt was claimed server-side), so
      // clearing it is honest rather than tidy — retyping the same six digits
      // could never work.
      setCode('');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [code, busy, identifier, channel, refreshUser, onSuccess, navigate, describeError, signup]);

  /**
   * Spend the ticket. The destination is NOT sent: the server reads it from the
   * ticket, which is what stops a proof earned on one number from creating an
   * account on another.
   */
  const createAccount = useCallback(async () => {
    if (busy || !ticket) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/signup/otp-complete', {
        ticket,
        name: newName.trim(),
        username: newUsername.trim() || undefined,
        lang,
        referral_code: referralCode || undefined,
      });
      await refreshUser();
      if (!mounted.current) return;
      setPhase('done');
      if (onSuccess) onSuccess(true);
      else navigate('/');
    } catch (e) {
      if (mounted.current) setError(describeError(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, ticket, newName, newUsername, lang, referralCode, refreshUser, onSuccess, navigate, describeError]);

  if (notConfigured) {
    return (
      <div className="lv-alert lv-alert-warning flex items-start gap-2" role="status">
        <AlertCircle aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{channel === 'email' ? s.notConfiguredEmail : s.notConfiguredWhatsapp}</span>
      </div>
    );
  }

  const Icon = channel === 'email' ? Mail : MessageCircle;

  /**
   * THE THIRD SCREEN, and only on the sign-up path. The number is proven; what
   * is missing is what to call the person. Username is optional because a
   * handle is a public thing somebody may want to think about, and the account
   * works without one.
   */
  if (phase === 'profile') {
    return (
      <div>
        <h2 className="lv-title" style={{ fontSize: 22 }}>
          {s.profileTitle}
        </h2>
        <p className="lv-sub">{s.profileHint}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createAccount();
          }}
          noValidate
          aria-busy={busy}
        >
          <div className="lv-fields">
            <AuthTextField
              id="otp-signup-name"
              label={s.nameLabel}
              value={newName}
              onChange={setNewName}
              autoComplete="name"
              placeholder={s.namePlaceholder}
              disabled={busy}
            />
            <AuthTextField
              id="otp-signup-username"
              label={`${s.usernameLabel} · ${s.usernameOptional}`}
              value={newUsername}
              onChange={setNewUsername}
              autoComplete="username"
              placeholder={s.usernamePlaceholder}
              valueDir="ltr"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
            />
          </div>
          {error ? (
            <p className="lv-alert lv-alert-danger mt-3 text-xs" role="alert">
              {error}
            </p>
          ) : null}
          <div className="lv-cta">
            <FillButton
              id="otp-signup-create"
              label={s.createCta}
              workingLabel={s.creating}
              successLabel={s.createdLabel}
              progress={lengthProgress(newName.trim(), 2)}
              ready={newName.trim().length >= 2}
              status={busy ? 'submitting' : 'idle'}
              hint={newName.trim().length >= 2 ? '' : s.nameRequired}
            />
          </div>
        </form>
      </div>
    );
  }

  if (phase === 'code') {
    return (
      <div>
        <p className="text-sm text-text-muted mb-3">{notice}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          noValidate
          aria-busy={busy}
        >
          <OtpBoxes
            value={code}
            onChange={setCode}
            label={s.codeLabel}
            disabled={busy}
            error={error}
            idPrefix="signin-code"
            autoFocus
          />
          <div className="lv-cta">
            <FillButton
              id="code-verify"
              label={s.verify}
              workingLabel={s.verifying}
              successLabel={s.verified}
              progress={lengthProgress(code, 6)}
              ready={code.length === 6}
              status={busy ? 'submitting' : 'idle'}
            />
          </div>
        </form>
        <p className="mt-3 text-[12px] text-text-muted leading-relaxed">{s.expiryNote}</p>
        <p className="mt-1 text-[12px] text-text-muted leading-relaxed">{s.neverShare}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || cooldown > 0}
            className="lv-link disabled:opacity-50"
          >
            {cooldown > 0 ? s.resendIn.replace('{s}', String(cooldown)) : s.resend}
          </button>
          <button
            type="button"
            onClick={() => {
              setPhase('target');
              setCode('');
              setError('');
              setNotice('');
            }}
            className="lv-link"
          >
            {s.changeTarget}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm text-text-muted mb-3 flex items-start gap-2">
        <Icon aria-hidden="true" className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          {signup
            ? channel === 'email'
              ? s.introSignupEmail
              : s.introSignupWhatsapp
            : channel === 'email'
              ? s.introEmail
              : s.introWhatsapp}
        </span>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        noValidate
        aria-busy={busy}
      >
        <div className="lv-fields">
          {channel === 'email' ? (
            <AuthTextField
              id="code-email"
              label={s.emailLabel}
              value={emailValue}
              onChange={setEmailValue}
              autoComplete="email"
              inputMode="email"
              placeholder={s.emailPlaceholder}
              valueDir="ltr"
              autoCapitalize="none"
              spellCheck={false}
              icon={<Mail />}
              disabled={busy}
              error={error && !targetReady ? s.emailInvalid : ''}
            />
          ) : (
            <PhoneField
              id="code-phone"
              label={s.phoneLabel}
              countryLabel={s.countryLabel}
              commonLabel={s.commonCountries}
              allLabel={s.allCountries}
              searchLabel={s.countrySearch}
              emptyLabel={s.countryEmpty}
              value={phone}
              onChange={setPhone}
              lang={lang}
              hint={s.phoneHint}
              disabled={busy}
              error={error && !targetReady ? s.phoneInvalid : ''}
            />
          )}
        </div>
        {error && targetReady ? (
          <p className="lv-alert lv-alert-danger mt-3 text-xs" role="alert">
            {error}
          </p>
        ) : null}
        <div className="lv-cta">
          <FillButton
            id="code-send"
            label={s.send}
            workingLabel={s.sending}
            successLabel={s.sent}
            progress={channel === 'email' ? lengthProgress(emailValue, 8) : phone.progress}
            ready={targetReady && cooldown === 0}
            status={busy ? 'submitting' : 'idle'}
          />
        </div>
      </form>
      {onSwitchMode ? (
        <p className="lv-foot">
          {s.noAccountHint}{' '}
          <button type="button" onClick={() => onSwitchMode('signup')} className="lv-link">
            {s.createAccount}
          </button>
        </p>
      ) : null}
    </div>
  );
}
