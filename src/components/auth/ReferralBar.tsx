import React, { useEffect, useRef, useState } from 'react';
import { AtSign, UserCheck, X, ChevronDown } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

/**
 * ReferralBar — the compact «لديك كود دعم؟» expander on signup
 * (integrated mandate §2.6).
 *
 * ONLY A SUPPORT CODE. The owner: «الإحالة لا يحصل على أي شيء فقط كود دعم».
 * The code records who brought the account and gives the new account nothing
 * — no delivery waiver, discount, points or membership — so the bar is worded
 * «كود الدعم» and carries a neutral icon, never a gift.
 *
 * - Optional: an empty code never blocks account creation.
 * - An invalid/unknown code shows a clear error but the user can ALWAYS
 *   continue without it — nothing here gates the submit button.
 * - Arriving via ?ref=<code> auto-expands the bar and resolves the
 *   inviter's display name + code from the frozen auth-server contract
 *   GET /api/auth/referrer-info?ref=... — a 404 is shown honestly as
 *   "code not found", never silently swallowed and never invented.
 * - The code value itself lives in the PARENT (the /auth page) so it
 *   survives switching between email/phone/Google/Telegram methods.
 */

const STRINGS = {
  ar: {
    toggle: 'لديك كود دعم؟',
    label: 'كود الدعم',
    optionalNote: 'اختياري — لا يمنح حسابك أي خصم أو ميزة، وتركه فارغًا لا يمنع إنشاء الحساب.',
    checking: 'جارٍ التحقق من الكود…',
    supportOf: (name: string, code: string) => `كود الدعم: ${name} (@${code})`,
    notFound: 'هذا الكود غير موجود. يمكنك المتابعة بدونه.',
    checkFailed: 'تعذر التحقق من الكود الآن — يمكنك المتابعة، وسيتحقق الخادم منه عند التسجيل.',
    remove: 'إزالة كود الدعم',
  },
  en: {
    toggle: 'Have a support code?',
    label: 'Support code',
    optionalNote: 'Optional — it gives your account no discount or perk, and leaving it empty never blocks sign-up.',
    checking: 'Checking the code…',
    supportOf: (name: string, code: string) => `Support code: ${name} (@${code})`,
    notFound: 'This code was not found. You can continue without it.',
    checkFailed: "Couldn't verify the code right now — you can continue; the server re-checks it on sign-up.",
    remove: 'Remove support code',
  },
  ckb: {
    toggle: 'کۆدی پاڵپشتیت هەیە؟',
    label: 'کۆدی پاڵپشتی',
    // «ئەم کۆدە هیچ داشکاندنێک ناکات» is PromoCodeField's own sentence, reused.
    optionalNote: 'ئارەزوومەندانەیە — ئەم کۆدە هیچ داشکاندنێک ناکات. بەجێهێشتنی بەتاڵ ڕێگری لە دروستکردنی هەژمار ناکات.',
    checking: 'کۆدەکە پشکنین دەکرێت…',
    supportOf: (name: string, code: string) => `کۆدی پاڵپشتی: ${name} (@${code})`,
    notFound: 'ئەم کۆدە نەدۆزرایەوە. دەتوانیت بەبێ ئەو بەردەوام بیت.',
    checkFailed: 'ئێستا ناتوانرێت کۆدەکە بپشکنرێت — دەتوانیت بەردەوام بیت؛ ڕاژەکار لە کاتی تۆمارکردن پشکنینی دەکاتەوە.',
    remove: 'لابردنی کۆدی پاڵپشتی',
  },
};

type ResolveStatus = 'idle' | 'checking' | 'found' | 'notfound' | 'checkfailed';

interface ReferrerInfo {
  name: string;
  code: string;
}

/** Defensive parse of the referrer-info payload (frozen server contract). */
function parseReferrerInfo(data: unknown, fallbackCode: string): ReferrerInfo {
  const obj = (data ?? {}) as Record<string, unknown>;
  const r = (obj.referrer && typeof obj.referrer === 'object' ? obj.referrer : obj) as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const code = pick('username', 'code', 'ref') || fallbackCode;
  const name = pick('displayName', 'display_name', 'name') || code;
  return { name, code };
}

export interface ReferralBarProps {
  code: string;
  onCodeChange: (code: string) => void;
  /** True when the code arrived via a ?ref= link (auto-expand + resolve). */
  fromLink?: boolean;
  disabled?: boolean;
}

export default function ReferralBar({ code, onCodeChange, fromLink, disabled }: ReferralBarProps) {
  const { lang } = useLanguage();
  const s = STRINGS[lang] || STRINGS.ar;

  const [open, setOpen] = useState(() => !!(fromLink && code));
  const [status, setStatus] = useState<ResolveStatus>('idle');
  const [info, setInfo] = useState<ReferrerInfo | null>(null);
  const seq = useRef(0);

  // Resolve the inviter whenever the code settles (debounced for typing;
  // immediate for the initial ?ref= value). Resolution is informational
  // only — it never gates the signup submit.
  useEffect(() => {
    const trimmed = code.trim();
    seq.current += 1;
    const mySeq = seq.current;
    if (!trimmed) {
      setStatus('idle');
      setInfo(null);
      return;
    }
    setStatus('checking');
    const timer = window.setTimeout(async () => {
      try {
        const data = await api.get<unknown>(`/api/auth/referrer-info?ref=${encodeURIComponent(trimmed)}`);
        if (seq.current !== mySeq) return;
        setInfo(parseReferrerInfo(data, trimmed));
        setStatus('found');
      } catch (err) {
        if (seq.current !== mySeq) return;
        setInfo(null);
        if (err instanceof ApiError && err.status === 404) {
          setStatus('notfound');
        } else {
          setStatus('checkfailed');
        }
      }
    }, fromLink && mySeq === 1 ? 0 : 600);
    return () => window.clearTimeout(timer);
  }, [code, fromLink]);

  const clear = () => {
    onCodeChange('');
    setInfo(null);
    setStatus('idle');
  };

  const panelId = 'referral-panel';
  const inputId = 'referral-code';

  return (
    <div className="lv-refbar">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="lv-refbar__toggle"
      >
        <span className="inline-flex items-center gap-2">
          <AtSign className="lv-refbar__toggle-icon" aria-hidden />
          {s.toggle}
        </span>
        <ChevronDown aria-hidden className="lv-refbar__chev" />
      </button>

      {/* Collapsed content is visibility:hidden via CSS (removed from the
          tab order) — the grid-rows transition keeps the expand smooth. */}
      <div id={panelId} className={`lv-refbar__panel${open ? ' is-open' : ''}`}>
        <div className="lv-refbar__inner">
          <div className="pt-3">
            {status === 'found' && info ? (
              <div className="lv-refbar__found">
                <span className="lv-refbar__found-text">
                  <UserCheck aria-hidden />
                  <span>{s.supportOf(info.name, info.code)}</span>
                </span>
                <button
                  type="button"
                  onClick={clear}
                  aria-label={s.remove}
                  disabled={disabled}
                  className="lv-refbar__clear"
                >
                  <X aria-hidden />
                </button>
              </div>
            ) : (
              <>
                <label htmlFor={inputId} className="lv-field__label">
                  {s.label}
                </label>
                <input
                  id={inputId}
                  name={inputId}
                  type="text"
                  dir="ltr"
                  value={code}
                  onChange={(e) => onCodeChange(e.target.value)}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  disabled={disabled}
                  placeholder="username"
                  aria-describedby={`${inputId}-status`}
                  className="lv-field__input"
                />
                <p
                  id={`${inputId}-status`}
                  className={`lv-field__help${status === 'notfound' ? ' is-bad' : status === 'checkfailed' ? ' is-warn' : ''}`}
                  aria-live="polite"
                >
                  {status === 'checking'
                    ? s.checking
                    : status === 'notfound'
                      ? s.notFound
                      : status === 'checkfailed'
                        ? s.checkFailed
                        : s.optionalNote}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
