/**
 * «عندما يفتح الرابط من الرسالة في الانستغرام او الماسنجر … يكون جوجل عند
 *  التسجيل يظهر حظر access denied»
 *
 * Google refuses OAuth inside embedded WebViews (403 disallowed_useragent).
 * src/lib/inAppBrowser.ts decides when the /auth page swaps the Google button
 * for the "open in your browser" banner. A miss leaves the dead-end button; a
 * false positive hides Google from someone who could have used it — so both
 * directions are pinned here against real user-agent strings.
 *
 * Run: node --import tsx --test tests/inAppBrowser.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectInAppBrowser,
  chromeIntentUrl,
  externalAuthUrl,
  safariSchemeUrl,
  type InAppApp,
  type InAppOs,
} from '../src/lib/inAppBrowser';
import { sanitizeNextPath } from '../src/components/auth/nextPath';

type Row = [label: string, ua: string, inApp: boolean, app: InAppApp | null, os: InAppOs];

const IN_APP: Row[] = [
  ['Instagram iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone15,3; iOS 17_5_1; en_US; en; scale=3.00; 1290x2796; 620529431)', true, 'instagram', 'ios'],
  ['Instagram Android', 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 Instagram 339.0.0.34.107 Android (34/14; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; en_US; 620191834)', true, 'instagram', 'android'],
  ['Facebook iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/466.0.0.36.106;FBBV/594331429;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBID/phone;FBLC/ar_AR;FBOP/5;FBRV/596093468]', true, 'facebook', 'ios'],
  ['Facebook Android', 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.43.113;]', true, 'facebook', 'android'],
  ['Messenger iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LightSpeed [FBAN/MessengerLiteForiOS;FBAV/466.0.0.39.108;FBBV/594658006;FBDV/iPhone13,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/0]', true, 'messenger', 'ios'],
  ['Messenger iOS (classic)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/430.0.0.30.107;FBBV/524785542;FBDV/iPhone12,1;FBMD/iPhone;FBSN/iOS;FBSV/16.6;FBSS/2;FBID/phone;FBLC/ar;FBOP/5]', true, 'messenger', 'ios'],
  ['Messenger Android', 'Mozilla/5.0 (Linux; Android 12; SM-A525F Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.179 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/455.0.0.44.108;]', true, 'messenger', 'android'],
  ['TikTok iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_33.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/IQ ByteFullLocale/ar RevealType/Dialog isDarkMode/1 WKWebView/1 BytedanceWebview/d8a21c6', true, 'tiktok', 'ios'],
  ['TikTok Android', 'Mozilla/5.0 (Linux; Android 13; 23028RA60L Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 trill_330203 JsSdk/1.0 NetType/4G Channel/googleplay AppName/trill app_version/33.2.3 ByteLocale/ar ByteFullLocale/ar Region/IQ BytedanceWebview/d8a21c6', true, 'tiktok', 'android'],
  ['Snapchat iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.2.0.40 (like Safari/8617.2.4.10.8, panda)', true, 'snapchat', 'ios'],
  ['LINE iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.20.0', true, 'line', 'ios'],
  ['LINE Android', 'Mozilla/5.0 (Linux; Android 11; SM-G991B Build/RP1A.200720.012; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.5993.80 Mobile Safari/537.36 Line/13.19.1/IAB', true, 'line', 'android'],
  ['WhatsApp Android in-app', 'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 WhatsApp/2.24.13.78', true, 'whatsapp', 'android'],
  ['X/Twitter Android', 'Mozilla/5.0 (Linux; Android 13; Pixel 6 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/115.0.5790.166 Mobile Safari/537.36 TwitterAndroid', true, 'twitter', 'android'],
  ['X/Twitter iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/9.61', true, 'twitter', 'ios'],
  ['LinkedIn iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.3', true, 'linkedin', 'ios'],
  ['WeChat Android', 'Mozilla/5.0 (Linux; Android 10; MI 8 Build/QKQ1.190828.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.99 XWEB/4317 MMWEBSDK/20220903 Mobile Safari/537.36 MMWEBID/6294 MicroMessenger/8.0.28.2240(0x28001C57) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64', true, 'wechat', 'android'],
  ['Telegram Android in-app browser', 'Mozilla/5.0 (Linux; Android 14; 2201116SG Build/UKQ1.231003.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36 Telegram-Android/11.0.0 (Xiaomi 2201116SG; Android 14; SDK 34; AVERAGE)', true, 'telegram', 'android'],
  ['generic Android WebView', 'Mozilla/5.0 (Linux; Android 12; SM-A135F Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36', true, 'webview', 'android'],
  ['generic iOS WKWebView (no Safari/ token)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', true, 'webview', 'ios'],
];

const REAL_BROWSERS: Row[] = [
  ['Safari iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', false, null, 'ios'],
  ['Chrome iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1', false, null, 'ios'],
  ['Firefox iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15', false, null, 'ios'],
  ['Edge iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.2592.56 Mobile/15E148 Safari/605.1.15', false, null, 'ios'],
  ['Google app iOS (GSA, Safari token)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/322.0.648915268 Mobile/15E148 Safari/604.1', false, null, 'ios'],
  ['Telegram iOS (SFSafariViewController = Safari UA)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', false, null, 'ios'],
  ['Safari iPad (desktop-class UA)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', false, null, 'other'],
  ['Chrome Android', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', false, null, 'android'],
  ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', false, null, 'android'],
  ['Firefox Android', 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0', false, null, 'android'],
  ['Chrome desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', false, null, 'other'],
  ['Safari macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', false, null, 'other'],
  ['empty UA', '', false, null, 'other'],
];

for (const [label, ua, inApp, app, os] of [...IN_APP, ...REAL_BROWSERS]) {
  test(`${inApp ? 'IN-APP' : 'real browser'}: ${label}`, () => {
    const got = detectInAppBrowser(ua);
    assert.deepEqual(got, { inApp, app, os });
  });
}

test('a home-screen web app on iOS (no Safari/ token either) is NOT an in-app browser', () => {
  const pwa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  assert.equal(detectInAppBrowser(pwa, { standalone: true }).inApp, false);
  assert.equal(detectInAppBrowser(pwa, { standalone: false }).inApp, true);
  // …but a NAMED app is an app even if something reports standalone.
  assert.equal(detectInAppBrowser(IN_APP[0][1], { standalone: true }).inApp, true);
});

test('an iPad WebView with a desktop-class UA counts only when the device has touch', () => {
  const ipadWebView = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  assert.deepEqual(detectInAppBrowser(ipadWebView, { maxTouchPoints: 5 }), { inApp: true, app: 'webview', os: 'ios' });
  assert.equal(detectInAppBrowser(ipadWebView, { maxTouchPoints: 0 }).inApp, false, 'a Mac app is not an iPad');
  const ipadSafari = REAL_BROWSERS.find((r) => r[0].startsWith('Safari iPad'))![1];
  assert.deepEqual(detectInAppBrowser(ipadSafari, { maxTouchPoints: 5 }), { inApp: false, app: null, os: 'ios' });
});

// ----------------------------------------------------------- the way out

test('Android: the Chrome intent URL opens THIS page (path + query) with a same-page fallback', () => {
  const url = 'https://levonis-iq.com/auth?next=%2Fcheckout%3Fstep%3D2&ref=ALI7';
  const intent = chromeIntentUrl(url);
  assert.equal(
    intent,
    'intent://levonis-iq.com/auth?next=%2Fcheckout%3Fstep%3D2&ref=ALI7#Intent;scheme=https;package=com.android.chrome;' +
      `S.browser_fallback_url=${encodeURIComponent(url)};end`
  );
  assert.match(intent, /^intent:\/\/levonis-iq\.com\/auth\?/);
  assert.ok(intent.endsWith(';end'));
  assert.throws(() => chromeIntentUrl('javascript:alert(1)'));
});

test('iOS: x-safari-https wraps only https', () => {
  assert.equal(safariSchemeUrl('https://levonis-iq.com/auth?next=%2Forders'), 'x-safari-https://levonis-iq.com/auth?next=%2Forders');
  assert.equal(safariSchemeUrl('http://localhost:5173/auth'), null);
});

test('the return path survives the switch to a real browser — and only a safe one', () => {
  const O = 'https://levonis-iq.com';
  // A ProtectedRoute redirect (router state) is written into ?next=.
  const dest = sanitizeNextPath({ pathname: '/checkout', search: '?step=2', hash: '#pay' });
  const u = new URL(externalAuthUrl(O, dest, ' ALI7 '));
  assert.equal(u.origin, O);
  assert.equal(u.pathname, '/auth');
  assert.equal(u.searchParams.get('next'), '/checkout?step=2#pay');
  assert.equal(u.searchParams.get('ref'), 'ALI7');
  assert.equal(sanitizeNextPath(u.searchParams.get('next')), '/checkout?step=2#pay', 'round-trips through the sanitizer');
  // Nothing to carry → a clean /auth.
  assert.equal(externalAuthUrl(O, '/'), `${O}/auth`);
  // Hostile destinations never leave sanitizeNextPath as anything but "/".
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)']) {
    assert.equal(externalAuthUrl(O, sanitizeNextPath(bad)), `${O}/auth`);
  }
  // Defence in depth: even an unsanitized protocol-relative value is dropped.
  assert.equal(externalAuthUrl(O, '//evil.com'), `${O}/auth`);
});

// ------------------------------------------------------------- wiring

test('the /auth page hides the Google button in an in-app browser and shows the banner instead', () => {
  const src = readFileSync(new URL('../src/pages/Auth.tsx', import.meta.url), 'utf8');
  assert.match(src, /detectInAppBrowser\(/);
  assert.match(src, /googleUsable\s*=\s*googleConfigured\s*&&\s*!inApp\.inApp/);
  assert.match(src, /\{googleUsable && \(\s*<div>\s*<GoogleAuthButton/);
  assert.match(src, /googleConfigured && inApp\.inApp && \(\s*<InAppBrowserNotice info=\{inApp\} next=\{dest\}/);
  // The other ways in are not gated on the browser.
  assert.doesNotMatch(src, /telegramConfigured && !inApp/);
  assert.doesNotMatch(src, /phoneEntry && !inApp/);
});
