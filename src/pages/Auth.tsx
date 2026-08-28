import React, { useState } from 'react';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useLanguage } from '../LanguageContext';
import { motion, AnimatePresence } from 'motion/react';
import { useGoogleLogin } from '@react-oauth/google';

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');
  const navigate = useNavigate();
  const { login, register } = useAuth();
  const { t } = useLanguage();
  const [error, setError] = useState<string>('');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setIsLoading(true);
    setError('');
    e.preventDefault();
    setError('');
    try {
      if (isLogin) {
        await login({ email, password });
        navigate('/profile');
      } else {
        if (password !== confirmPassword) { throw new Error('Passwords do not match'); }
        await register(username, name, email, password);
        navigate('/profile');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

const handleGoogleAuth = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      try {
        const userInfo = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        }).then(res => res.json());
        
        await login({ email: userInfo.email, name: userInfo.name });
        navigate('/profile');
      } catch (err: any) {
        setError('Google login failed: ' + (err.message || 'Unknown error'));
      } finally { setIsLoading(false); }
    },
    onError: (err: any) => { setError('Google Login Failed: ' + (err?.message || 'Unknown error')); setIsLoading(false); }
  });

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
          {!isLogin && (
            <button 
              onClick={() => setIsLogin(true)} 
              className="absolute left-6 top-10 text-gold p-2 z-20"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
          )}

          <AnimatePresence mode="wait">
            {isLogin ? (
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
            {isLogin && (
              <motion.h2 
                key="login-title"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="text-[28px] font-medium text-center mb-8 text-black tracking-wide"
              >{t('signIn')}</motion.h2>
            )}
          </AnimatePresence>

                    <form className="flex-1 flex flex-col" onSubmit={handleSubmit}>

            {isForgotPassword ? (
              <div className="flex-1 flex flex-col">
                <button type="button" onClick={() => setIsForgotPassword(false)} className="flex items-center text-sm font-medium text-gray-500 mb-6 hover:text-black">
                  <ArrowLeft className="w-4 h-4 mr-1" /> Back to login
                </button>
                <h3 className="text-xl font-medium mb-2 text-black">Reset Password</h3>
                <p className="text-sm text-gray-500 mb-6">Enter your email address and we'll send you a link to reset your password.</p>
                
                {error && <div className="mb-4 text-red-500 text-xs font-medium text-center">{error}</div>}
                {forgotMessage && <div className="mb-4 text-green-600 text-xs font-medium text-center">{forgotMessage}</div>}
                
                <div className="space-y-4">
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 mb-1.5 block ml-1">{t('email')}</label>
                    <input type="email" placeholder="email@example.com" value={email} onChange={e => setEmail(e.target.value)} className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm" required />
                  </div>
                </div>
                
                <div className="mt-8">
                  <button type="button" onClick={async () => {
                    if (isLoading) return;
                    setIsLoading(true);
                    setError('');
                    setForgotMessage('');
                    if (!email) { setError('Email is required'); return; }
                    try {
                      const res = await fetch('/api/auth/forgot-password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email })
                      });
                      const text = await res.text();
                      let data;
                      try {
                        data = JSON.parse(text);
                      } catch (e) {
                        throw new Error(`Server error: ${text.substring(0, 100)}`);
                      }
                      if (!res.ok) {
                        throw new Error(data.error || data.message || `Server error ${res.status}`);
                      }
                      if (data.success) {
                        setForgotMessage('Password reset link sent to your email.');
                      } else {
                        setError(data.error || 'Failed to send reset link');
                      }
                    } catch (err: any) {
                      setError(err.message || 'Failed to send reset link');
                    } finally { setIsLoading(false); }
                  }} disabled={isLoading} className="w-full bg-[#111111] text-gold border border-gold/20 py-4 rounded-[14px] font-medium hover:bg-black/90 transition-colors">
                    Send Reset Link
                  </button>
                </div>
              </div>
            ) : (
<>
            <AnimatePresence>
              {error && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 text-red-500 text-xs font-medium text-center">
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
                    <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm pr-12" required />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors">
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </motion.div>
                {isLogin && (
                  <div className="flex justify-end">
                    <button 
                      type="button"
                      onClick={() => { setIsForgotPassword(true); setError(''); setForgotMessage(''); }}
                      className="text-[11px] text-gray-500 hover:text-black font-medium"
                    >
                      Forgot Password?
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
                      <input type={showConfirmPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" className="w-full bg-[#F8F9FA] border border-gray-100 rounded-[14px] px-5 py-3.5 text-black placeholder-gray-300 focus:outline-none focus:border-gray-300 transition-colors text-sm pr-12" required />
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

              <button type="button" onClick={handleGoogleAuth} className="w-full bg-white border border-gray-200 text-black py-3.5 rounded-[14px] font-medium text-sm flex items-center justify-center gap-2 hover:bg-gray-50 transition-colors">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25C22.56 11.47 22.49 10.72 22.36 10H12V14.26H17.92C17.67 15.63 16.89 16.81 15.72 17.59V20.34H19.28C21.36 18.42 22.56 15.6 22.56 12.25Z" fill="#4285F4"/>
                  <path d="M12 23C14.97 23 17.46 22.02 19.28 20.34L15.72 17.59C14.73 18.25 13.48 18.66 12 18.66C9.14 18.66 6.71 16.73 5.84 14.15H2.18V16.99C4.01 20.61 7.7 23 12 23Z" fill="#34A853"/>
                  <path d="M5.84 14.15C5.62 13.49 5.49 12.77 5.49 12C5.49 11.23 5.62 10.51 5.84 9.85V7.01H2.18C1.43 8.5 1 10.19 1 12C1 13.81 1.43 15.5 2.18 16.99L5.84 14.15Z" fill="#FBBC05"/>
                  <path d="M12 5.34C13.62 5.34 15.07 5.9 16.21 6.99L19.36 3.84C17.46 2.07 14.97 1 12 1C7.7 1 4.01 3.39 2.18 7.01L5.84 9.85C6.71 7.27 9.14 5.34 12 5.34Z" fill="#EA4335"/>
                </svg>
                Google
              </button>
            </motion.div>

            <motion.p layout className="text-center mt-auto pt-8 text-[12px] text-gray-500">
              {isLogin ? t('dontHaveAccount') : t('alreadyHaveAccount')}
              <button 
                type="button" 
                onClick={() => setIsLogin(!isLogin)} 
                className="text-black font-medium hover:underline"
              >
                {isLogin ? t('signUp') : t('signIn')}
              </button>
            </motion.p>
            </>
            )}
          </form>
        </motion.div>
      </div>
    </div>
  );
}
