import React, { useEffect, useRef, useState } from 'react';
import { Gift, X, ChevronDown } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';

/**
 * ReferralBar — the compact "لديك كود إحالة؟" expander on signup
 * (integrated mandate §2.6).
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
    toggle: 'لديك كود إحالة؟',
    label: 'كود الإحالة',
    optionalNote: 'اختياري — تركه فارغًا لا يمنع إنشاء الحساب.',
    checking: 'جارٍ التحقق من الكود…',
    invited: (name: string, code: string) => `دعوة من ${name} (@${code})`,
    notFound: 'هذا الكود غير موجود. يمكنك المتابعة بدونه.',
    checkFailed: 'تعذر التحقق من الكود الآن — يمكنك المتابعة، وسيتحقق الخادم منه عند التسجيل.',
    remove: 'إزالة كود الإحالة',
  },
  en: {
    toggle: 'Have a referral code?',
    label: 'Referral code',
    optionalNote: 'Optional — leaving it empty never blocks sign-up.',
    checking: 'Checking the code…',
    invited: (name: string, code: string) => `Invited by ${name} (@${code})`,
    notFound: 'This code was not found. You can continue without it.',
    checkFailed: "Couldn't verify the code right now — you can continue; the server re-checks it on sign-up.",
    remove: 'Remove referral code',
  },
  ckb: {
    toggle: 'کۆدی بانگهێشتت هەیە؟',
    label: 'کۆدی بانگهێشت',
    optionalNote: 'ئارەزوومەندانەیە — بەجێهێشتنی بەتاڵ ڕێگری لە دروستکردنی هەژمار ناکات.',
    checking: 'کۆدەکە پشکنین دەکرێت…',
    invited: (name: string, code: string) => `بانگهێشت لە ${name} (@${code})`,
    notFound: 'ئەم کۆدە نەدۆزرایەوە. دەتوانیت بەبێ ئەو بەردەوام بیت.',
    checkFailed: 'ئێستا ناتوانرێت کۆدەکە بپشکنرێت — دەتوانیت بەردەوام بیت؛ ڕاژەکار لە کاتی تۆمارکردن پشکنینی دەکاتەوە.',
    remove: 'لابردنی کۆدی بانگهێشت',
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
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3.5 text-[13px] font-semibold text-zinc-300 transition-colors hover:border-gold/40 hover:text-gold disabled:opacity-60"
      >
        <span className="inline-flex items-center gap-2">
          <Gift className="h-4 w-4 text-gold" aria-hidden />
          {s.toggle}
        </span>
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Collapsed content is visibility:hidden via CSS (removed from the
          tab order) — the grid-rows transition keeps the expand smooth. */}
      <div id={panelId} className={`lv-refbar__panel${open ? ' is-open' : ''}`}>
        <div className="lv-refbar__inner">
          <div className="pt-3">
            {status === 'found' && info ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-gold/30 bg-gold/10 px-3.5 py-2.5">
                <span className="inline-flex min-w-0 items-center gap-2 text-[13px] font-medium text-gold">
                  <Gift className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{s.invited(info.name, info.code)}</span>
                </span>
                <button
                  type="button"
                  onClick={clear}
                  aria-label={s.remove}
                  disabled={disabled}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gold/80 transition-colors hover:bg-gold/15 hover:text-gold"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : (
              <>
                <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-semibold text-zinc-300">
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
                  className="w-full min-h-[48px] rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3 text-[15px] text-white placeholder-zinc-600 outline-none transition-colors focus:border-gold/70 focus:ring-1 focus:ring-gold/40 disabled:opacity-60"
                />
                <p id={`${inputId}-status`} className="mt-1.5 text-xs leading-relaxed" aria-live="polite">
                  {status === 'checking' ? (
                    <span className="text-zinc-400">{s.checking}</span>
                  ) : status === 'notfound' ? (
                    <span className="font-medium text-red-400">{s.notFound}</span>
                  ) : status === 'checkfailed' ? (
                    <span className="font-medium text-amber-300">{s.checkFailed}</span>
                  ) : (
                    <span className="text-zinc-500">{s.optionalNote}</span>
                  )}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
