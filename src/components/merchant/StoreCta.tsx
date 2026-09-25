/**
 * The bridge from a paid PLUS membership to an actual shop.
 *
 * Shown on /subscription. It has four states and each is a real answer, not
 * a placeholder:
 *
 *   - not eligible  → nothing is rendered. Advertising a store button to
 *                     someone who cannot open one is the kind of dead control
 *                     the mandate is explicitly about.
 *   - eligible, no store → "Create your store", the actual next step.
 *   - has a store   → its address, and a way into managing it.
 *   - restricted    → why, in plain words, and what to do about it.
 *
 * Every one of those comes from the SERVER (`/api/merchant/me`), which reads
 * the memberships ledger. The component never inspects a tier string of its
 * own and never decides eligibility for itself.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { Store, ArrowRight, ExternalLink, AlertCircle } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { merchantApi, type MerchantMe } from '../../lib/merchant';

export default function StoreCta() {
  const { loc } = useLanguage();
  const { isAuthenticated, isLoaded: authLoaded } = useAuth();

  const [me, setMe] = useState<MerchantMe | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Now that this component renders on pages a guest can browse, asking
    // "which merchant am I?" without a session is a request whose only
    // possible answer is 401. Don't send it.
    if (!authLoaded) return;
    if (!isAuthenticated) {
      setMe(null);
      setLoaded(true);
      return;
    }
    let alive = true;
    merchantApi
      .me()
      .then((d) => alive && setMe(d))
      // A stale session can still answer 401 here, which is not an error
      // worth showing — it just means there is nothing to offer yet.
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [authLoaded, isAuthenticated]);

  if (!loaded || !me) return null;
  if (!me.eligible && !me.store) return null;

  const restricted = me.store && !me.selling.canSell;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="px-4 sm:px-6 mb-10 max-w-lg mx-auto relative z-10"
    >
      <div className="rounded-[24px] border border-white/10 bg-white/[0.03] backdrop-blur-2xl p-5 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.5)]">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-2xl bg-olive/30 border border-gold/20 flex items-center justify-center shrink-0">
            <Store className="w-5 h-5 text-gold" />
          </div>
          <div className="min-w-0">
            <h3 className="text-gold font-bold text-[15px] leading-tight">
              {me.store
                ? loc('متجرك في مجتمع ليفو', 'Your store in the Levo community', 'فرۆشگاکەت لە کۆمەڵگەی Levo')
                : loc('أنشئ متجرك في ليفو', 'Create your Levo store', 'فرۆشگای Levo خۆت دروست بکە')}
            </h3>
            <p className="text-zinc-400 text-[12px] mt-1 leading-relaxed">
              {me.store
                ? loc(
                    'أدر منتجاتك وطلباتك وعروضك من لوحة تحكم متجرك.',
                    'Manage your products, orders and offers from your store dashboard.',
                    'بەرهەم و داواکاری و ئۆفەرەکانت لە داشبۆردی فرۆشگاکەتەوە بەڕێوە ببە.'
                  )
                : loc(
                    'عضويتك PLUS فعّالة. اختر اسمًا وعنوانًا وابدأ البيع.',
                    'Your PLUS membership is active. Pick a name and an address, and start selling.',
                    'ئەندامێتی PLUS چالاکە. ناو و ناونیشانێک هەڵبژێرە و دەست بە فرۆشتن بکە.'
                  )}
            </p>
          </div>
        </div>

        {/* A restriction is explained, never left as a missing button. §84. */}
        {restricted && (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 mb-4">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-amber-200/90 text-[11.5px] leading-relaxed">{reasonText(me.selling.reason, loc)}</p>
          </div>
        )}

        {me.store ? (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-black/30 border border-white/10 px-3 py-2.5">
              <span className="text-zinc-500 text-[11px] shrink-0">
                {loc('العنوان', 'Address', 'ناونیشان')}
              </span>
              <a
                href={me.store.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gold text-[12px] font-semibold truncate flex items-center gap-1.5 min-w-0"
                dir="ltr"
              >
                <span className="truncate">{me.store.url.replace(/^https?:\/\//, '')}</span>
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              </a>
            </div>
            <Link
              to="/merchant"
              className="w-full min-h-[48px] rounded-2xl bg-olive text-snow font-bold text-[14px] flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              {loc('لوحة تحكم المتجر', 'Store dashboard', 'داشبۆردی فرۆشگا')}
              <ArrowRight className="w-4 h-4 rtl:rotate-180" />
            </Link>
          </div>
        ) : (
          <Link
            to="/merchant/start"
            className="w-full min-h-[48px] rounded-2xl bg-olive text-snow font-bold text-[14px] flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
          >
            {loc('أنشئ متجرك', 'Create your store', 'فرۆشگاکەت دروست بکە')}
            <ArrowRight className="w-4 h-4 rtl:rotate-180" />
          </Link>
        )}
      </div>
    </motion.div>
  );
}

/** Each reason gets its own sentence — "unavailable" tells a merchant nothing. */
function reasonText(reason: string, loc: (ar: string, en: string, ckb?: string) => string): string {
  switch (reason) {
    case 'subscription_inactive':
      return loc(
        'اشتراك PLUS غير فعّال. متجرك وسجلّه محفوظان — جدّد الاشتراك للبيع من جديد.',
        'Your PLUS subscription is not active. Your store and its history are kept — renew to sell again.',
        'ئەندامێتی PLUS چالاک نییە. فرۆشگا و مێژووەکەی پارێزراون — نوێی بکەرەوە بۆ فرۆشتنەوە.'
      );
    case 'store_paused':
      return loc(
        'متجرك متوقّف مؤقتًا بطلبك. أعِد فتحه من إعدادات المتجر.',
        'You paused your store. Re-open it from store settings.',
        'فرۆشگاکەت لەلایەن خۆتەوە ڕاگیراوە. لە ڕێکخستنەکانەوە بیکەرەوە.'
      );
    case 'store_suspended':
    case 'merchant_suspended':
      return loc(
        'المتجر موقوف من إدارة Levonis. تواصل مع الدعم لمعرفة التفاصيل.',
        'This store is suspended by Levonis. Contact support for details.',
        'فرۆشگاکە لەلایەن LEVONIS ڕاگیراوە. پەیوەندی بە پشتیوانییەوە بکە.'
      );
    case 'benefit_restricted':
      return loc(
        'تم تقييد ميزة المتجر مؤقتًا. اشتراكك المدفوع لم يُلغَ — تواصل مع الدعم.',
        'The store benefit is temporarily restricted. Your paid membership is not cancelled — contact support.',
        'تایبەتمەندی فرۆشگا کاتی سنووردارکراوە. ئەندامێتییە پارەدراوەکەت هەڵنەوەشێنراوەتەوە — پەیوەندی بکە.'
      );
    default:
      return loc('لا يمكن البيع حاليًا.', 'Selling is not available right now.', 'لە ئێستادا فرۆشتن بەردەست نییە.');
  }
}
