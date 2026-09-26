import React, { useState } from 'react';
import { Compass, Copy, Check, ExternalLink } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { copyText } from '../../lib/copyText';
import {
  IN_APP_NAMES,
  chromeIntentUrl,
  externalAuthUrl,
  safariSchemeUrl,
  type InAppInfo,
} from '../../lib/inAppBrowser';
import './authLeave.css';

/**
 * THE BANNER THAT REPLACES THE GOOGLE BUTTON INSIDE AN IN-APP BROWSER.
 *
 * «عندما يفتح الرابط من الرسالة في الانستغرام او الماسنجر … يكون جوجل عند
 *  التسجيل يظهر حظر access denied»
 *
 * Google refuses sign-in inside embedded WebViews (403 disallowed_useragent),
 * and no code on this page can change that. So the Google button is not shown
 * there (a button that ends in «access denied» is worse than none) and this
 * says, in one line, what to do instead — with a real way out:
 *  - Android: «افتح في Chrome», an intent:// link that opens THIS sign-in page
 *    (return path and referral code included) in Chrome, falling back to the
 *    same page when Chrome is missing;
 *  - iPhone: «انسخ الرابط» plus the two taps (⋯ → «فتح في Safari»), and a
 *    direct x-safari-https:// attempt for iOS versions that honour it;
 *  - everywhere: the link itself, selectable, for when copying is blocked.
 * Every other way in (phone code, Telegram, email) stays usable right here.
 *
 * Self-contained: the caller decides WHEN to mount it (Auth.tsx, with
 * detectInAppBrowser), and passes the sanitized return path.
 */

const AR = {
  title: 'افتح الصفحة في المتصفح لتسجيل الدخول عبر Google',
  whyNamed: 'أنت داخل المتصفح المدمج في {app}، وGoogle لا يسمح بتسجيل الدخول من داخله. طرق الدخول الأخرى تعمل هنا كالمعتاد.',
  whyGeneric: 'أنت داخل متصفح مدمج في تطبيق، وGoogle لا يسمح بتسجيل الدخول من داخله. طرق الدخول الأخرى تعمل هنا كالمعتاد.',
  openChrome: 'افتح في Chrome',
  copy: 'انسخ الرابط',
  copied: 'تم النسخ',
  copyFailed: 'انسخ الرابط يدويًا من الحقل',
  linkLabel: 'رابط صفحة الدخول',
  iosStep1: 'اضغط زر ⋯ أعلى الشاشة أو أسفلها.',
  iosStep2: 'اختر «فتح في Safari» أو «فتح في المتصفح».',
  iosStep3: 'سجّل الدخول عبر Google هناك — ستعود إلى الصفحة نفسها.',
  iosTrySafari: 'أو جرّب الفتح في Safari مباشرةً',
  androidAlt: 'لم يفتح Chrome؟ انسخ الرابط والصقه في متصفحك.',
  otherAlt: 'انسخ الرابط والصقه في متصفح هاتفك (Safari أو Chrome).',
};

const EN: typeof AR = {
  title: 'Open this page in your browser to sign in with Google',
  whyNamed: "You are inside {app}'s built-in browser, and Google does not allow sign-in from it. The other ways to sign in work here as usual.",
  whyGeneric: "You are inside an app's built-in browser, and Google does not allow sign-in from it. The other ways to sign in work here as usual.",
  openChrome: 'Open in Chrome',
  copy: 'Copy link',
  copied: 'Copied',
  copyFailed: 'Copy the link from the field by hand',
  linkLabel: 'Sign-in page link',
  iosStep1: 'Tap the ⋯ button at the top or bottom of the screen.',
  iosStep2: "Choose 'Open in Safari' or 'Open in browser'.",
  iosStep3: 'Sign in with Google there — you will land back on this same page.',
  iosTrySafari: 'Or try opening it in Safari directly',
  androidAlt: "Chrome didn't open? Copy the link and paste it into your browser.",
  otherAlt: "Copy the link and paste it into your phone's browser (Safari or Chrome).",
};

export interface InAppBrowserNoticeProps {
  info: InAppInfo;
  /** Return destination, already through sanitizeNextPath. */
  next: string;
  referralCode?: string;
}

export default function InAppBrowserNotice({ info, next, referralCode = '' }: InAppBrowserNoticeProps) {
  const { lang } = useLanguage();
  // OWNER: Sorani to be written by hand. (ckb reads the Arabic until then.)
  const s = lang === 'en' ? EN : AR;
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');

  const url = externalAuthUrl(window.location.origin, next, referralCode);
  const appName = info.app ? IN_APP_NAMES[info.app] : '';
  const why = appName ? s.whyNamed.replace('{app}', appName) : s.whyGeneric;
  const safari = info.os === 'ios' ? safariSchemeUrl(url) : null;

  const onCopy = async () => {
    const ok = await copyText(url);
    setCopyState(ok ? 'done' : 'failed');
    if (ok) window.setTimeout(() => setCopyState('idle'), 2500);
  };

  const copyRow = (
    <div className="lv-copyrow">
      <input
        className="lv-copyrow__value"
        readOnly
        value={url}
        aria-label={s.linkLabel}
        onFocus={(e) => e.currentTarget.select()}
        translate="no"
      />
      <button type="button" className={`lv-copyrow__btn${copyState === 'done' ? ' is-done' : ''}`} onClick={onCopy}>
        {copyState === 'done' ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span>{copyState === 'done' ? s.copied : s.copy}</span>
      </button>
    </div>
  );

  return (
    <section className="lv-leave" aria-labelledby="lv-leave-title" data-inapp={info.app ?? 'webview'}>
      <div className="lv-leave__head">
        <span className="lv-leave__mark" aria-hidden>
          <Compass />
        </span>
        <div>
          <p id="lv-leave-title" className="lv-leave__title">
            {s.title}
          </p>
          <p className="lv-leave__why">{why}</p>
        </div>
      </div>

      {info.os === 'android' ? (
        <>
          <div className="lv-leave__actions">
            <a className="lv-btn-quiet" href={chromeIntentUrl(url)}>
              <ExternalLink aria-hidden /> {s.openChrome}
            </a>
          </div>
          <p className="lv-leave__alt">{s.androidAlt}</p>
          {copyRow}
        </>
      ) : info.os === 'ios' ? (
        <>
          {copyRow}
          <ol className="lv-leave__steps">
            <li>{s.iosStep1}</li>
            <li>{s.iosStep2}</li>
            <li>{s.iosStep3}</li>
          </ol>
          {safari && (
            <p className="lv-leave__alt">
              <a href={safari}>{s.iosTrySafari}</a>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="lv-leave__alt">{s.otherAlt}</p>
          {copyRow}
        </>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {copyState === 'done' ? s.copied : copyState === 'failed' ? s.copyFailed : ''}
      </p>
    </section>
  );
}
