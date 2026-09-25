import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, WifiOff, PackageSearch, LogIn, RefreshCw, Inbox, ShieldAlert, ArrowRight } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { authPathWithSupportRef } from '../../lib/supportRef';

/**
 * Unified async states for the storefront. loading / empty / error(retry) /
 * not-found / unauthorized are DISTINCT states:
 *
 * - 401 renders a sign-in prompt (never "no items"),
 * - 404 renders not-found,
 * - status 0 (network) and 5xx render an error with a retry button,
 * - other 4xx render the server's real message (no invented text).
 *
 * `classifyError` is the single mapping from a thrown error to a state kind;
 * `ErrorState` dispatches on it so pages can simply do
 * `<ErrorState error={err} onRetry={reload} />`.
 */

export type AsyncErrorKind =
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'server'
  | 'error';

export function classifyError(err: unknown): AsyncErrorKind {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'network';
    if (err.status === 401) return 'unauthorized';
    if (err.status === 403) return 'forbidden';
    if (err.status === 404) return 'not-found';
    if (err.status >= 500) return 'server';
    return 'error';
  }
  // fetch() rejections outside the ApiError wrapper are network failures.
  if (err instanceof TypeError) return 'network';
  return 'error';
}

/**
 * WHICH 500 THIS IS, WHEN THE SERVER COULD SAY SAFELY.
 *
 * THE DEFECT. The cart answered 500 for days and every customer who reached it
 * read «خطأ في الخادم / حدث خطأ من جهتنا» beside a retry button that could not
 * possibly work: the worker had been deployed ahead of its migrations, so one
 * SELECT was naming a table the database did not have. "Something went wrong
 * on our side" is true of that, and of a five-second lock, and of a bug — three
 * situations with three different right answers for the person reading it.
 *
 * `app.onError` in `worker/index.ts` now puts exactly two of them on the
 * refusal as a code — SERVICE_SETUP and SERVICE_BUSY, decided by
 * `safeErrorCode` in worker/lib/membershipBenefits.ts — and deliberately
 * nothing else: no table name, no column name, no SQL and no stack ever
 * reaches a customer. This turns that code into the right sentence in the
 * customer's own language, which is why the mapping lives here and not in the
 * worker's one English string.
 *
 * Anything else, including an unknown code from an older or newer worker, keeps
 * the generic server message it has always had.
 */
export type ServerCause = 'setup' | 'busy';

export function serverCause(err: unknown): ServerCause | null {
  if (!(err instanceof ApiError) || err.status < 500) return null;
  if (err.code === 'SERVICE_SETUP') return 'setup';
  if (err.code === 'SERVICE_BUSY') return 'busy';
  return null;
}

const STRINGS = {
  ar: {
    networkTitle: 'لا يوجد اتصال',
    networkDesc: 'تحقق من اتصالك بالإنترنت ثم أعد المحاولة.',
    serverTitle: 'خطأ في الخادم',
    serverDesc: 'حدث خطأ من جهتنا. حاول مرة أخرى.',
    setupTitle: 'جزء من المتجر قيد التجهيز',
    setupDesc: 'هذه الصفحة تعتمد على جزء من المتجر لم يكتمل تجهيزه بعد. إعادة المحاولة لن تفيد قبل اكتماله — أبلغ المتجر إن استمر الأمر.',
    busyTitle: 'المتجر مزدحم الآن',
    busyDesc: 'تعذّر الوصول إلى بياناتك للحظة. أعد المحاولة بعد ثوانٍ.',
    errorTitle: 'تعذر التحميل',
    forbiddenTitle: 'غير مصرّح',
    forbiddenDesc: 'ليس لديك صلاحية لعرض هذا المحتوى.',
    notFoundTitle: 'غير موجود',
    notFoundDesc: 'العنصر الذي تبحث عنه غير متوفر أو تمت إزالته.',
    unauthorizedTitle: 'سجّل الدخول للمتابعة',
    unauthorizedDesc: 'تحتاج إلى تسجيل الدخول لعرض هذا المحتوى.',
    retry: 'إعادة المحاولة',
    signIn: 'تسجيل الدخول',
    back: 'رجوع',
    emptyTitle: 'لا توجد عناصر',
  },
  en: {
    networkTitle: 'No connection',
    networkDesc: 'Check your internet connection and try again.',
    serverTitle: 'Server error',
    serverDesc: 'Something went wrong on our side. Please try again.',
    setupTitle: 'Part of the store is still being set up',
    setupDesc:
      'This page depends on a part of the store that is not finished yet. Retrying will not help until it is — tell the shop if it keeps happening.',
    busyTitle: 'The store is busy right now',
    busyDesc: 'We could not reach your data for a moment. Please try again in a few seconds.',
    errorTitle: 'Failed to load',
    forbiddenTitle: 'Not allowed',
    forbiddenDesc: 'You do not have permission to view this content.',
    notFoundTitle: 'Not found',
    notFoundDesc: 'The item you are looking for is unavailable or was removed.',
    unauthorizedTitle: 'Sign in to continue',
    unauthorizedDesc: 'You need to sign in to view this content.',
    retry: 'Retry',
    signIn: 'Sign in',
    back: 'Back',
    emptyTitle: 'Nothing here yet',
  },
  ckb: {
    networkTitle: 'پەیوەندی نییە',
    networkDesc: 'پەیوەندیت بە ئینتەرنێتەوە بپشکنە و دووبارە هەوڵ بدەوە.',
    serverTitle: 'هەڵەی ڕاژەکار',
    serverDesc: 'هەڵەیەک لە لای ئێمە ڕوویدا. دووبارە هەوڵ بدەوە.',
    // THESE FOUR CARRY THE ARABIC TEXT ON PURPOSE. Sorani is never generated
    // here; a Kurdish sentence nobody who speaks Kurdish wrote is worse than
    // an Arabic one the reader can follow. The owner writes these four by
    // hand — setupTitle, setupDesc, busyTitle, busyDesc — and the Arabic
    // stands in until they do.
    setupTitle: 'جزء من المتجر قيد التجهيز',
    setupDesc: 'هذه الصفحة تعتمد على جزء من المتجر لم يكتمل تجهيزه بعد. إعادة المحاولة لن تفيد قبل اكتماله — أبلغ المتجر إن استمر الأمر.',
    busyTitle: 'المتجر مزدحم الآن',
    busyDesc: 'تعذّر الوصول إلى بياناتك للحظة. أعد المحاولة بعد ثوانٍ.',
    errorTitle: 'بارکردن سەرکەوتوو نەبوو',
    forbiddenTitle: 'ڕێگەپێنەدراوە',
    forbiddenDesc: 'دەسەڵاتت نییە بۆ بینینی ئەم ناوەڕۆکە.',
    notFoundTitle: 'نەدۆزرایەوە',
    notFoundDesc: 'ئەو شتەی بەدوایدا دەگەڕێیت بەردەست نییە یان لابراوە.',
    unauthorizedTitle: 'بچۆ ژوورەوە بۆ بەردەوامبوون',
    unauthorizedDesc: 'پێویستە بچیتە ژوورەوە بۆ بینینی ئەم ناوەڕۆکە.',
    retry: 'دووبارە هەوڵ بدەوە',
    signIn: 'چوونەژوورەوە',
    back: 'گەڕانەوە',
    emptyTitle: 'هیچ شتێک نییە',
  },
} as const;

function useStrings() {
  const { lang } = useLanguage();
  return STRINGS[lang];
}

function StateShell({
  icon,
  title,
  description,
  children,
  className = '',
  compact = false,
  role,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
  compact?: boolean;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      role={role}
      className={`flex flex-col items-center justify-center text-center gap-3 rounded-xl border border-zinc-800/50 bg-zinc-900/50 ${
        compact ? 'px-4 py-6' : 'px-6 py-12'
      } ${className}`}
    >
      <div className="w-12 h-12 rounded-full bg-zinc-800/60 flex items-center justify-center text-zinc-500">
        {icon}
      </div>
      <p className="text-white font-bold text-[15px]">{title}</p>
      {description ? (
        <p className="text-text-muted text-sm max-w-xs leading-relaxed">{description}</p>
      ) : null}
      {children}
    </div>
  );
}

function RetryButton({ onRetry, label }: { onRetry: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="mt-1 min-h-[44px] px-5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-bold flex items-center gap-2 transition-colors"
    >
      <RefreshCw aria-hidden="true" className="w-4 h-4" />
      {label}
    </button>
  );
}

/**
 * Smart error state: classifies the thrown error and renders the right state.
 * 401 → sign-in prompt, 404 → not-found, network/5xx → message + retry,
 * other 4xx → the server's real error message.
 */
export function ErrorState({
  error,
  onRetry,
  next,
  className = '',
  compact = false,
}: {
  error?: unknown;
  onRetry?: () => void;
  /** Return destination for the 401 sign-in prompt (defaults to the current path). */
  next?: string;
  className?: string;
  compact?: boolean;
}) {
  const s = useStrings();
  const kind = classifyError(error);

  if (kind === 'unauthorized') return <UnauthorizedState next={next} className={className} compact={compact} />;
  if (kind === 'not-found') return <NotFoundState className={className} compact={compact} />;

  const serverMessage =
    kind === 'error' && error instanceof ApiError && error.message ? error.message : '';
  // A 500 the server was able to name gets the sentence that names it; every
  // other 500 keeps the generic one.
  const cause = kind === 'server' ? serverCause(error) : null;
  const serverTitle = cause === 'setup' ? s.setupTitle : cause === 'busy' ? s.busyTitle : s.serverTitle;
  const serverDesc = cause === 'setup' ? s.setupDesc : cause === 'busy' ? s.busyDesc : s.serverDesc;
  const title =
    kind === 'network'
      ? s.networkTitle
      : kind === 'server'
        ? serverTitle
        : kind === 'forbidden'
          ? s.forbiddenTitle
          : s.errorTitle;
  const description =
    kind === 'network'
      ? s.networkDesc
      : kind === 'server'
        ? serverDesc
        : kind === 'forbidden'
          ? s.forbiddenDesc
          : serverMessage || undefined;
  const icon =
    kind === 'network' ? (
      <WifiOff aria-hidden="true" className="w-6 h-6" />
    ) : kind === 'forbidden' ? (
      <ShieldAlert aria-hidden="true" className="w-6 h-6" />
    ) : (
      <AlertTriangle aria-hidden="true" className="w-6 h-6" />
    );

  return (
    <StateShell role="alert" icon={icon} title={title} description={description} className={className} compact={compact}>
      {onRetry && kind !== 'forbidden' ? <RetryButton onRetry={onRetry} label={s.retry} /> : null}
    </StateShell>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
  compact = false,
}: {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const s = useStrings();
  return (
    <StateShell
      role="status"
      icon={icon ?? <Inbox aria-hidden="true" className="w-6 h-6" />}
      title={title || s.emptyTitle}
      description={description}
      className={className}
      compact={compact}
    >
      {action}
    </StateShell>
  );
}

export function NotFoundState({
  title,
  description,
  onBack,
  className = '',
  compact = false,
}: {
  title?: string;
  description?: string;
  onBack?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const s = useStrings();
  const { dir } = useLanguage();
  return (
    <StateShell
      role="status"
      icon={<PackageSearch aria-hidden="true" className="w-6 h-6" />}
      title={title || s.notFoundTitle}
      description={description ?? s.notFoundDesc}
      className={className}
      compact={compact}
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="mt-1 min-h-[44px] px-5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-bold flex items-center gap-2 transition-colors"
        >
          <ArrowRight aria-hidden="true" className={`w-4 h-4 ${dir === 'ltr' ? 'rotate-180' : ''}`} />
          {s.back}
        </button>
      ) : null}
    </StateShell>
  );
}

/**
 * 401 state: an honest sign-in prompt (never "no items"). The sign-in link
 * carries the current path as `?next=` so Auth.tsx (via sanitizeNextPath)
 * returns the user right back here.
 */
export function UnauthorizedState({
  title,
  description,
  next,
  className = '',
  compact = false,
}: {
  title?: string;
  description?: string;
  next?: string;
  className?: string;
  compact?: boolean;
}) {
  const s = useStrings();
  const location = useLocation();
  const dest = next ?? `${location.pathname}${location.search}`;
  return (
    <StateShell
      role="status"
      icon={<LogIn aria-hidden="true" className="w-6 h-6" />}
      title={title || s.unauthorizedTitle}
      description={description ?? s.unauthorizedDesc}
      className={className}
      compact={compact}
    >
      <Link
        to={authPathWithSupportRef(dest)}
        className="mt-1 min-h-[44px] px-6 rounded-xl bg-gold text-black text-sm font-bold flex items-center justify-center gap-2 hover:brightness-110 transition-all"
      >
        <LogIn aria-hidden="true" className="w-4 h-4" />
        {s.signIn}
      </Link>
    </StateShell>
  );
}
