import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Gift } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleLogin } from '@react-oauth/google';
import { api, ApiError } from '../lib/api';

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');
  const [emailNotConfigured, setEmailNotConfigured] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const resetToken = searchParams.get('reset') || '';
  // Friend-invite referral code from ?ref=CODE — kept in state so it survives
  // later URL cleanups (e.g. clearing the reset token param).
  const [referralCode] = useState(() => searchParams.get('ref') || '');
  const { login, loginWithGoogle, register, refreshUser } = useAuth();
  const { t, lang, dir } = useLanguage();
  const [error, setError] = useState<string>('');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetDone, setResetDone] = useState(false);
  const [resetTokenError, setResetTokenError] = useState<'' | 'used' | 'expired'>('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setIsLoading(true);
    setError('');
    try {
      if (isLogin) {
        await login(email, password);
        navigate('/');
      } else {
        if (password.length < 8) { throw new Error('Password must be at least 8 characters'); }
        if (password !== confirmPassword) { throw new Error('Passwords do not match'); }
        if (referralCode) {
          // Referral-aware signup: send the invite code so the server can
          // attribute it, then refresh the session user from /me.
          await api.post('/api/auth/register', { username, name, email, password, referralCode });
          await refreshUser();
        } else {
          await register(username, name, email, password);
        }
        navigate('/');
      }
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleCredential = async (credential: string | undefined) => {
    setError('');
    if (!credential) {
      setError('Google sign-in did not return a credential. Please try again.');
      return;
    }
    setIsLoading(true);
    try {
      if (referralCode) {
        // The server attributes the referral only when this sign-in CREATES
        // a new account; existing accounts are never re-attributed.
        await api.post('/api/auth/google', { credential, referralCode });
        await refreshUser();
      } else {
        await loginWithGoogle(credential);
      }
      navigate('/');
    } catch (err: any) {
      if (err instanceof ApiError && (err.status === 503 || err.code === 'GOOGLE_NOT_CONFIGURED')) {
        setError("Google sign-in isn't configured yet");
      } else {
        setError(err?.message || 'Google sign-in failed');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (isLoading) return;
    setError('');
    setForgotMessage('');
    setEmailNotConfigured(false);
    if (!email) { setError(dir === 'rtl' ? 'البريد الإلكتروني مطلوب' : 'Email is required'); return; }
    setIsLoading(true);
    try {
      // lang tells the server which language to write the reset email in.
      const data = await api.post<{ message?: string }>('/api/auth/forgot-password', { email, lang });
      setForgotMessage(
        dir === 'rtl'
          ? 'إذا كان هناك حساب بهذا البريد، فقد أُرسل إليه رابط إعادة التعيين.'
          : (data.message || 'If an account exists for that email, a reset link has been sent.')
      );
    } catch (err: any) {
      if (err instanceof ApiError && (err.status === 503 || err.code === 'EMAIL_NOT_CONFIGURED')) {
        // Honest disabled state: the server has no email service configured.
        setEmailNotConfigured(true);
      } else {
        setError(err?.message || (dir === 'rtl' ? 'تعذر إرسال رابط إعادة التعيين' : 'Failed to send reset link'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setError('');
    if (password.length < 8) { setError(dir === 'rtl' ? 'كلمة المرور يجب ألا تقل عن 8 أحرف' : 'Password must be at least 8 characters'); return; }
    if (password !== confirmPassword) { setError(dir === 'rtl' ? 'كلمتا المرور غير متطابقتين' : 'Passwords do not match'); return; }
    setIsLoading(true);
    try {
      // The reset token is consumed ONLY here, on explicit submit — the page
      // never verifies (and therefore never burns) the token on load.
      await api.post('/api/auth/reset-password', { token: resetToken, password });
      setPassword('');
      setConfirmPassword('');
      setResetDone(true);
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'TOKEN_USED') {
        setResetTokenError('used');
      } else if (err instanceof ApiError && err.code === 'TOKEN_EXPIRED') {
        setResetTokenError('expired');
      } else {
        setError(err?.message || (dir === 'rtl' ? 'تعذر إعادة تعيين كلمة المرور' : 'Failed to reset password'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const switchToForgotForm = () => {
    // Leaves the dead-token screen for the forgot form: clear the token from
    // the URL and open the "send me a new link" flow.
    setSearchParams({}, { replace: true });
    setResetTokenError('');
    setResetDone(false);
    setError('');
    setForgotMessage('');
    setEmailNotConfigured(false);
    setIsLogin(true);
    setIsForgotPassword(true);
  };

  const backToLoginFromReset = () => {
    setSearchParams({}, { replace: true });
    setResetTokenError('');
    setResetDone(false);
    setError('');
    setIsForgotPassword(false);
    setIsLogin(true);
  };

  return (
    <div className="w-full min-h-screen bg-[#A1B58B] font-sans flex flex-col relative overflow-hidden">
      {/* Black Top Section with Pattern */}
      <div className="absolute top-0 left-0 right-0 h-[45vh] bg-[#111111] z-0 overflow-hidden">
        <div className="absolute inset-0 opacity-[0.03]">
          <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="geomPattern" x="0" y="0" width="120" height="120" patternUnits="userSpaceOnUse">
                {/* Circle */}
                <circle cx="30" cy="30" r="30" fill="#ffffff" />
                {/* Quarter Circle */}
                <path d="M60,0 A60,60 0 0,1 120,60 L60,60 Z" fill="#ffffff" />
                {/* Triangle */}
                <path d="M0,60 L60,120 L0,120 Z" fill="#ffffff" />
                {/* Cross/Plus */}
                <path d="M80,80 h10 v-10 h10 v10 h10 v10 h-10 v10 h-10 v-10 h-10 Z" fill="#ffffff" />
              </pattern>
            </defs>
            <rect x="0" y="0" width="100%" height="100%" fill="url(#geomPattern)" />
          </svg>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative z-10">

        {/* Top Header / Logo Area */}
        <div className="h-[32vh] flex flex-col items-center justify-center relative">
          {!isLogin && !resetToken && (
            <button
              onClick={() => setIsLogin(true)}
              className="absolute left-6 top-10 text-gold p-2 z-20"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
          )}

          <AnimatePresence mode="wait">
            {isLogin || resetToken ? (
              <motion.div
                key="logo"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="w-20 h-20 bg-white rounded-3xl flex items-center justify-center relative z-10 mt-8"
              >
                {/* Reference Logo Shape: a leaf-like black shape */}
                <div className="w-9 h-9 bg-[#111111] rounded-tl-[1.2rem] rounded-br-[1.2rem] rounded-tr-sm rounded-bl-sm transform rotate-45"></div>
              </motion.div>
            ) : (
              <motion.h2
                key="signup-title"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="text-gold text-[28px] font-bold relative z-10 mt-6 tracking-wide drop-shadow-md"
              >{t('signUp')}</motion.h2>
            )}
          </AnimatePresence>
        </div>

        {/* White Curved Container */}
        <motion.div
          layout
          className="bg-[#A1B58B] flex-1 rounded-tl-[70px] px-8 pt-10 pb-8 shadow-[0_-10px_40px_rgba(0,0,0,0.15)] flex flex-col relative overflow-hidden"
        >
          <AnimatePresence mode="wait">
            {isLogin && !resetToken && (
              <motion.h2
                key="login-title"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="text-[28px] font-medium text-center mb-8 text-black tracking-wide"
              >{t('signIn')}</motion.h2>
            )}
          </AnimatePresence>

          {resetToken ? (
            resetDone ? (
              /* Reset success screen */
              <div className="flex-1 flex flex-col items-center text-center pt-6">
                <CheckCircle2 className="w-14 h-14 text-[#111111] mb-5" />
                <h3 className="text-xl font-medium mb-2 text-black">
                  {dir === 'rtl' ? 'تم تغيير كلمة المرور بنجاح' : 'Password Updated'}
                </h3>
                <p className="text-sm text-gray-600 mb-8 max-w-xs">
                  {dir === 'rtl'
                    ? 'يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.'
                    : 'You can now sign in with your new password.'}
                </p>
                <button
                  type="button"
                  onClick={backToLoginFromReset}
                  className="w-full bg-[#111111] text-gold border border-gold/20 py-4 rounded-[14px] font-medium hover:bg-black/90 transition-colors"
                >
                  {t('signIn')}
                </button>
              </div>
            ) : resetTokenError ? (
              /* Dead-token screen: used vs expired, each with a way forward */
              <div className="flex-1 flex flex-col items-center text-center pt-6">
                <h3 className="text-xl font-medium mb-2 text-black">
                  {resetTokenError === 'used'
                    ? (dir === 'rtl' ? 'استُخدم هذا الرابط سابقًا' : 'This link has already been used')
                    : (dir === 'rtl' ? 'انتهت صلاحية الرابط' : 'This link has expired')}
                </h3>
                <p className="text-sm text-gray-600 mb-8 max-w-xs">
                  {dir === 'rtl'
                    ? 'روابط إعادة التعيين تصلح لمرة واحدة ولمدة 30 دقيقة فقط. اطلب رابطًا جديدًا للمتابعة.'
                    : 'Reset links work once and expire after 30 minutes. Request a new link to continue.'}
                </p>
                <button
                  type="button"
                  onClick={switchToForgotForm}
                  className="w-full bg-[#111111] text-gold border border-gold/20 py-4 rounded-[14px] font-medium hover:bg-black/90 transition-colors"
                >
                  {dir === 'rtl' ? 'طلب رابط جديد' : 'Request a new link'}
                </button>
                <button
                  type="button"
                  onClick={backToLoginFromReset}
                  className="flex items-center justify-center text-sm font-medium text-gray-600 mt-6 hover:text-black"
                >
                  <ArrowLeft className="w-4 h-4 mr-1" /> {dir === 'rtl' ? 'العودة لتسجيل الدخول' : 'Back to login'}
                </button>
              </div>
            ) : (
            <form className="flex-1 flex flex-col" onSubmit={handleResetPassword}>
              <h3 className="text-xl font-medium mb-2 text-black">{dir === 'rtl' ? 'اختر كلمة مرور جديدة' : 'Choose a New Password'}</h3>
              <p className="text-sm text-gray-600 mb-6">
                {dir === 'rtl'
                  ? 'أدخل كلمة مرور جديدة لحسابك. رابط إعادة التعيين يصلح لمرة واحدة فقط.'
                  : 'Enter a new password for your account. The reset link can only be used once.'}
              </p>

              {error && <div className="mb-4 text-red-600 text-xs font-medium text-center">{error}</div>}

              <div className="space-y-4">
                <div>
                  <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{t('password')}</label>
                  <div className="relative">
                    <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" minLength={8} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm pr-12" required />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors">
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{t('confirmPassword')}</label>
                  <div className="relative">
                    <input type={showConfirmPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" minLength={8} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm pr-12" required />
                    <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors">
                      {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-8">
                <button type="submit" disabled={isLoading} className="w-full bg-[#111111] text-gold border border-gold/20 py-4 rounded-[14px] font-medium hover:bg-black/90 transition-colors flex justify-center items-center gap-2">
                  {isLoading ? <div className="w-5 h-5 border-2 border-gold/20 border-t-white rounded-full animate-spin" /> : (dir === 'rtl' ? 'تعيين كلمة المرور الجديدة' : 'Set New Password')}
                </button>
              </div>
              <button type="button" onClick={backToLoginFromReset} className="flex items-center justify-center text-sm font-medium text-gray-600 mt-6 hover:text-black">
                <ArrowLeft className="w-4 h-4 mr-1" /> {dir === 'rtl' ? 'العودة لتسجيل الدخول' : 'Back to login'}
              </button>
            </form>
            )
          ) : (
          <form className="flex-1 flex flex-col" onSubmit={handleSubmit}>

            {isForgotPassword ? (
              <div className="flex-1 flex flex-col">
                <button type="button" onClick={() => { setIsForgotPassword(false); setError(''); setForgotMessage(''); setEmailNotConfigured(false); }} className="flex items-center text-sm font-medium text-gray-500 mb-6 hover:text-black">
                  <ArrowLeft className="w-4 h-4 mr-1" /> {dir === 'rtl' ? 'العودة لتسجيل الدخول' : 'Back to login'}
                </button>
                <h3 className="text-xl font-medium mb-2 text-black">{dir === 'rtl' ? 'إعادة تعيين كلمة المرور' : 'Reset Password'}</h3>
                <p className="text-sm text-gray-500 mb-6">
                  {dir === 'rtl'
                    ? 'أدخل بريدك الإلكتروني وسنرسل لك رابطًا لإعادة تعيين كلمة المرور.'
                    : "Enter your email address and we'll send you a link to reset your password."}
                </p>

                {emailNotConfigured && (
                  /* Honest disabled state — the email service is not configured
                     on the server, so no reset link can be sent yet. */
                  <div className="mb-4 rounded-[14px] border border-amber-400/60 bg-amber-50 px-4 py-3 text-amber-800 text-xs font-medium text-center">
                    {dir === 'rtl'
                      ? 'إرسال بريد إعادة التعيين غير متاح بعد لأن خدمة البريد غير مهيأة. يرجى التواصل مع الدعم.'
                      : 'Password reset email is not available yet because no email service is configured. Please contact support.'}
                  </div>
                )}
                {error && <div className="mb-4 text-red-600 text-xs font-medium text-center">{error}</div>}
                {forgotMessage && <div className="mb-4 text-green-700 text-xs font-medium text-center">{forgotMessage}</div>}

                <div className="space-y-4">
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{t('email')}</label>
                    <input type="email" placeholder="email@example.com" value={email} onChange={e => setEmail(e.target.value)} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm" required />
                  </div>
                </div>

                <div className="mt-8">
                  <button type="button" onClick={handleForgotPassword} disabled={isLoading} className="w-full bg-[#111111] text-gold border border-gold/20 py-4 rounded-[14px] font-medium hover:bg-black/90 transition-colors flex justify-center items-center gap-2">
                    {isLoading ? <div className="w-5 h-5 border-2 border-gold/20 border-t-white rounded-full animate-spin" /> : (dir === 'rtl' ? 'إرسال رابط إعادة التعيين' : 'Send Reset Link')}
                  </button>
                </div>
              </div>
            ) : (
<>
            {referralCode && (
              /* Friend-invite chip: the ?ref=CODE is attributed server-side
                 when this visit ends in a NEW account. */
              <div className="mb-4 flex justify-center">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#111111]/10 border border-[#111111]/15 px-3 py-1 text-[11px] font-medium text-[#111111]">
                  <Gift className="w-3.5 h-3.5" />
                  {dir === 'rtl' ? `دعوة صديق: ${referralCode}` : `Friend invite: ${referralCode}`}
                </span>
              </div>
            )}
            <AnimatePresence>
              {error && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 text-red-600 text-xs font-medium text-center">
                  {error}
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence mode="popLayout">
              <div className="space-y-4">
                {!isLogin && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.3 }}
                    className="space-y-4 overflow-hidden"
                  >
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{t('firstName')}</label>
                      <input type="text" minLength={3} placeholder="username123" value={username} onChange={e => setUsername(e.target.value)} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm" required />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{t('lastName')}</label>
                      <input type="text" placeholder="John Doe" value={name} onChange={e => setName(e.target.value)} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm" required />
                    </div>
                  </motion.div>
                )}

                <motion.div layout>
                  <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{isLogin ? (t('emailOrUsername') || 'Email or Username') : t('email')}</label>
                  <input type={isLogin ? "text" : "email"} placeholder={isLogin ? "email@example.com or username" : "email@example.com"} value={email} onChange={e => setEmail(e.target.value)} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm" required />
                </motion.div>

                <motion.div layout>
                  <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{t('password')}</label>
                  <div className="relative">
                    <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" minLength={isLogin ? undefined : 8} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm pr-12" required />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors">
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </motion.div>
                {isLogin && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => { setIsForgotPassword(true); setError(''); setForgotMessage(''); setEmailNotConfigured(false); }}
                      className="text-[11px] text-gray-500 hover:text-black font-medium"
                    >
                      {dir === 'rtl' ? 'هل نسيت كلمة المرور؟' : 'Forgot Password?'}
                    </button>
                  </div>
                )}
                {!isLogin && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.3 }}
                    className="overflow-hidden"
                  >
                    <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{t('confirmPassword')}</label>
                    <div className="relative">
                      <input type={showConfirmPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" minLength={8} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm pr-12" required />
                      <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors">
                        {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </motion.div>
                )}
              </div>
            </AnimatePresence>

            <motion.div layout className="mt-8 space-y-4">
              <button type="submit" disabled={isLoading} className="w-full bg-[#111111] text-gold border border-gold/20 py-4 rounded-[14px] font-medium hover:bg-black/90 transition-colors flex justify-center items-center gap-2">
                {isLoading ? <div className="w-5 h-5 border-2 border-gold/20 border-t-white rounded-full animate-spin" /> : (isLogin ? t("signIn") : t("signUp"))}
              </button>

              <div className="relative flex items-center justify-center py-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-100"></div>
                </div>
                <div className="relative bg-[#A1B58B] px-4 text-[11px] text-gray-400">{t('orContinueWith')}</div>
              </div>

              <div className="flex justify-center">
                <GoogleLogin
                  onSuccess={(credentialResponse) => handleGoogleCredential(credentialResponse.credential)}
                  onError={() => setError('Google sign-in failed. Please try again.')}
                  width="300"
                />
              </div>
            </motion.div>

            <motion.p layout className="text-center mt-auto pt-8 text-[12px] text-gray-500">
              {isLogin ? t('dontHaveAccount') : t('alreadyHaveAccount')}
              <button
                type="button"
                onClick={() => { setIsLogin(!isLogin); setError(''); }}
                className="text-black font-medium hover:underline"
              >
                {isLogin ? t('signUp') : t('signIn')}
              </button>
            </motion.p>
            </>
            )}
          </form>
          )}
        </motion.div>
      </div>
    </div>
  );
}
