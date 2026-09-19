/**
 * WHICH INSTALL STORY EACH BROWSER GETS.
 *
 * The owner asked for one feature — «تحميل التطبيق» — and named three phone
 * makers in the same sentence. There is no single install API behind that
 * request: Chromium hands the page an event, Safari on iOS hands it nothing
 * at all and expects the customer to tap Share themselves, Firefox has a menu
 * item on a phone and no install whatsoever on a desktop, and a link opened
 * from an Instagram story runs in a webview that can install nothing, ever.
 *
 * Every one of those is a different sentence on the customer's screen, and
 * the way this feature fails is not a crash. It is a button that does nothing
 * on the phone the owner is holding, or iPhone instructions naming a Share
 * button that is not on that screen — silent, device-specific, and impossible
 * to reproduce on the machine it was written on.
 *
 * So the classification is a pure function and this file drives it with REAL
 * user-agent strings, one per browser the shop actually meets in Iraq. The
 * iPad case is the one that is worth the whole file on its own: since iPadOS
 * 13 an iPad in its default mode sends a user-agent that is byte-for-byte a
 * Mac's, so every UA-only check calls it a desktop and hides the only
 * instructions that would have worked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translations } from '../src/translations';
import {
  INSTALL_DISMISS_KEY,
  INSTALL_DISMISS_MS,
  clearInstallDismissal,
  detectPlatform,
  installGuidance,
  isApplePlatform,
  isInAppWebView,
  isMobilePlatform,
  isStandalone,
  isInstallDismissed,
  readDismissedUntil,
  recordInstallDismissal,
  stepsFor,
  type Platform,
  type StorageLike,
} from '../src/lib/pwa';

// Real strings, copied from the browsers they name. They are verbose on
// purpose: a trimmed-down "Mozilla/5.0 (iPhone) Safari" would pass a test that
// the real thing fails, which is the only way this file could be worse than
// having no tests at all.
const UA = {
  iosSafari17:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iosFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  iosEdge:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 EdgiOS/125.0.2535.60 Mobile/15E148 Safari/604.1',
  // An iPad, "Request Desktop Website" (the DEFAULT since iPadOS 13). Note
  // that there is no "iPad" and no "Mobile" anywhere in it.
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36',
  huaweiBrowser:
    'Mozilla/5.0 (Linux; Android 10; HUAWEI ELS-NX9; HMSCore 6.11.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.88 HuaweiBrowser/13.0.5.303 Mobile Safari/537.36',
  // A Huawei HANDSET running ordinary Chrome. The device name says HUAWEI and
  // this browser DOES fire beforeinstallprompt — classifying it by the device
  // would take the one-tap button away from its owner.
  huaweiDeviceChrome:
    'Mozilla/5.0 (Linux; Android 12; HUAWEI ELS-NX9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  samsungInternet:
    'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 13; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
  firefoxDesktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  desktopEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.68',
  instagramIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 334.0.0.34.105 (iPhone14,3; iOS 17_5; en_US; en; scale=3.00; 1170x2532; 606904933)',
  facebookAndroid:
    'Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.193 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/443.0.0.32.117;]',
  tiktokAndroid:
    'Mozilla/5.0 (Linux; Android 13; V2111 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 BytedanceWebview/d8a21c6 musical_ly_2022905030',
} as const;

const PHONE = 5; // navigator.maxTouchPoints on any iPhone or iPad
const DESKTOP = 0; // and on a Mac

// ------------------------------------------------------------ the platform

test('an iPhone is an iPhone whichever browser icon the customer tapped', () => {
  assert.equal(detectPlatform({ userAgent: UA.iosSafari17, maxTouchPoints: PHONE }), 'ios-safari');
  // Chrome, Firefox and Edge on iOS are all WebKit — Apple requires it — so
  // none of them can offer a one-tap install either. They are a separate
  // branch only because their Share button is in a different place.
  for (const ua of [UA.iosChrome, UA.iosFirefox, UA.iosEdge]) {
    assert.equal(detectPlatform({ userAgent: ua, maxTouchPoints: PHONE }), 'ios-other-browser', ua);
  }
});

test('an iPad reports a Mac, and maxTouchPoints is the only thing that knows', () => {
  // THE SAME STRING, twice. Everything that separates these two lines is the
  // touch count, and getting it wrong sends every iPad owner to instructions
  // about an address-bar icon their screen does not have.
  assert.equal(UA.ipadSafari, UA.macSafari, 'the fixtures are deliberately identical');
  assert.equal(detectPlatform({ userAgent: UA.ipadSafari, maxTouchPoints: PHONE }), 'ios-safari');
  // The Mac is `mac-safari`, and it used to be `unknown` — which routed it to
  // `{kind:'none'}` and told a Mac owner «استخدم Chrome أو Edge» although
  // Safari has installed web apps through File ▸ Add to Dock since Sonoma.
  // The two lines still differ by nothing but the touch count; what changed is
  // that the desktop half is now identified rather than given up on.
  assert.equal(detectPlatform({ userAgent: UA.macSafari, maxTouchPoints: DESKTOP }), 'mac-safari');
  assert.equal(isApplePlatform({ userAgent: UA.ipadSafari, maxTouchPoints: PHONE }), true);
  assert.equal(isApplePlatform({ userAgent: UA.macSafari, maxTouchPoints: DESKTOP }), false);
  // A Mac with a drawing tablet plugged in reports 1, not 5.
  assert.equal(isApplePlatform({ userAgent: UA.macSafari, maxTouchPoints: 1 }), false);
});

test('Android, Huawei, Samsung and Firefox are told apart despite all saying Chrome', () => {
  assert.equal(detectPlatform({ userAgent: UA.androidChrome, maxTouchPoints: PHONE }), 'android-chromium');
  assert.equal(detectPlatform({ userAgent: UA.huaweiBrowser, maxTouchPoints: PHONE }), 'huawei');
  assert.equal(detectPlatform({ userAgent: UA.samsungInternet, maxTouchPoints: PHONE }), 'samsung');
  assert.equal(detectPlatform({ userAgent: UA.firefoxAndroid, maxTouchPoints: PHONE }), 'firefox');
  // Both of these carry "Chrome/" too. Order is the algorithm.
  assert.ok(UA.huaweiBrowser.includes('Chrome/'));
  assert.ok(UA.samsungInternet.includes('Chrome/'));
});

test('a Huawei HANDSET running plain Chrome keeps its one-tap install', () => {
  // Matching the device name rather than the browser token would classify
  // this as `huawei`, hide the real button and hand its owner a menu path.
  assert.ok(/HUAWEI/i.test(UA.huaweiDeviceChrome));
  assert.equal(detectPlatform({ userAgent: UA.huaweiDeviceChrome, maxTouchPoints: PHONE }), 'android-chromium');
});

test('a desktop is a desktop, and Edge is Chromium', () => {
  assert.equal(detectPlatform({ userAgent: UA.desktopChrome, maxTouchPoints: DESKTOP }), 'desktop-chromium');
  assert.equal(detectPlatform({ userAgent: UA.desktopEdge, maxTouchPoints: DESKTOP }), 'desktop-chromium');
  assert.equal(detectPlatform({ userAgent: UA.firefoxDesktop, maxTouchPoints: DESKTOP }), 'firefox');
  assert.equal(detectPlatform({ userAgent: '', maxTouchPoints: 0 }), 'unknown');
});

test('mobile and desktop are separated, because Firefox installs on one and not the other', () => {
  assert.equal(isMobilePlatform({ userAgent: UA.firefoxAndroid, maxTouchPoints: PHONE }), true);
  assert.equal(isMobilePlatform({ userAgent: UA.firefoxDesktop, maxTouchPoints: DESKTOP }), false);
  assert.equal(isMobilePlatform({ userAgent: UA.ipadSafari, maxTouchPoints: PHONE }), true);
  assert.equal(isMobilePlatform({ userAgent: UA.desktopChrome, maxTouchPoints: DESKTOP }), false);
});

// ------------------------------------------------------- the in-app webview

test('a link opened from a story is a webview that can install nothing', () => {
  // The most common way an Iraqi customer reaches this shop. There is no
  // address bar, no browser menu, no Share-to-home-screen and no
  // beforeinstallprompt in any of these.
  assert.equal(isInAppWebView(UA.instagramIos), true);
  assert.equal(isInAppWebView(UA.facebookAndroid), true);
  assert.equal(isInAppWebView(UA.tiktokAndroid), true);

  // And a real browser is not one.
  for (const ua of [
    UA.iosSafari17,
    UA.iosChrome,
    UA.androidChrome,
    UA.huaweiBrowser,
    UA.samsungInternet,
    UA.firefoxAndroid,
    UA.desktopChrome,
    UA.desktopEdge,
  ]) {
    assert.equal(isInAppWebView(ua), false, ua);
  }
});

test("Instagram's iOS webview is not mistaken for Safari", () => {
  // It has no "Safari" token, which is exactly how it is told apart — and it
  // is still an Apple platform, so the manual path would otherwise be the
  // iPhone one, naming a Share button this screen does not have.
  assert.ok(!/safari/i.test(UA.instagramIos));
  assert.equal(detectPlatform({ userAgent: UA.instagramIos, maxTouchPoints: PHONE }), 'ios-other-browser');
});

// ---------------------------------------------------------- already an app

test('an installed app never offers to install itself', () => {
  const mm = (matching: string) => (query: string) => ({ matches: query === matching });

  assert.equal(isStandalone({ matchMedia: mm('(display-mode: standalone)') }), true);
  assert.equal(isStandalone({ matchMedia: mm('(display-mode: minimal-ui)') }), true, 'Firefox installs to minimal-ui');
  assert.equal(isStandalone({ matchMedia: mm('(display-mode: browser)') }), false);

  // iOS: Safari has never implemented the display-mode query, so an installed
  // iPhone app answers `false` to every one of them. `navigator.standalone` is
  // the only signal there and it has to win on its own.
  assert.equal(isStandalone({ matchMedia: mm('(display-mode: browser)'), appleStandalone: true }), true);
  assert.equal(isStandalone({ appleStandalone: true }), true);
  assert.equal(isStandalone({ appleStandalone: false }), false);
});

test('a matchMedia that throws or is missing does not take the shell down', () => {
  assert.equal(
    isStandalone({
      matchMedia: () => {
        throw new Error('unsupported media feature');
      },
    }),
    false
  );
  assert.equal(isStandalone({}), false);
  assert.equal(isStandalone({ matchMedia: null }), false);
});

// ---------------------------------------------------------- the five states

function guidance(platform: Platform, over: Partial<Parameters<typeof installGuidance>[0]> = {}) {
  return installGuidance({
    platform,
    mobile: true,
    inAppWebView: false,
    hasPrompt: false,
    standalone: false,
    ...over,
  });
}

test('the strongest true thing wins, in this order', () => {
  // Already installed beats everything, including a captured event.
  assert.deepEqual(guidance('android-chromium', { standalone: true, hasPrompt: true }), { kind: 'installed' });
  // A webview beats a captured event: it may surface one it cannot act on.
  assert.deepEqual(guidance('android-chromium', { inAppWebView: true, hasPrompt: true }), { kind: 'open-in-browser' });
  // One tap beats five.
  assert.deepEqual(guidance('android-chromium', { hasPrompt: true }), { kind: 'prompt' });
});

test('every browser without an event gets a real menu path, in its own words', () => {
  for (const platform of [
    'ios-safari',
    'ios-other-browser',
    'android-chromium',
    'huawei',
    'samsung',
    'firefox',
    'desktop-chromium',
  ] as const) {
    const result = guidance(platform, { mobile: platform !== 'desktop-chromium' });
    assert.equal(result.kind, 'steps', platform);
    if (result.kind !== 'steps') continue;
    assert.equal(result.platform, platform);
    assert.ok(result.steps.length >= 2, `${platform} needs a usable path, not one line`);
  }
});

test('iOS is never offered a button it cannot have, and Safari and the rest differ', () => {
  const safari = guidance('ios-safari');
  const other = guidance('ios-other-browser');
  assert.equal(safari.kind, 'steps');
  assert.equal(other.kind, 'steps');
  // Safari's bar is named; another browser's is not, and it gets the
  // open-in-Safari escape hatch instead of a confirm step.
  assert.notDeepEqual(stepsFor('ios-safari'), stepsFor('ios-other-browser'));
  assert.ok(stepsFor('ios-safari').some((s) => s.glyph === 'share'));
  assert.ok(stepsFor('ios-other-browser').some((s) => s.key === 'pwaStepIosUseSafari'));

  // SAFARI GETS THE ESCAPE HATCH TOO, and this is the single most common
  // arrival path for this shop. Telegram and friends open links in an
  // SFSafariViewController, which sends an ordinary Mobile Safari user-agent
  // with no app token — `isInAppWebView` cannot see it and this branch is what
  // the customer gets. Apple gates «إضافة إلى الشاشة الرئيسية» behind an
  // entitlement the host app does not have, so the item the first steps
  // describe is simply absent from the share sheet. Without this last step
  // there is nothing else on the screen to read.
  assert.ok(stepsFor('ios-safari').some((s) => s.key === 'pwaStepIosUseSafari'));
});

test('macOS Safari installs web apps and is told so', () => {
  // Safari has had File ▸ Add to Dock since Sonoma (Safari 17). This platform
  // used to fall through to `unknown`, which on a desktop is `{kind:'none'}` —
  // «هذا المتصفح على الحاسوب لا يثبّت المواقع كتطبيقات. استخدم Chrome أو Edge».
  // That sentence was false, and it was told to a machine with a working
  // install path.
  const mac = guidance('mac-safari', { mobile: false });
  assert.equal(mac.kind, 'steps');
  assert.ok(stepsFor('mac-safari').length > 0);

  // It must NOT be handed Chromium's first step: Safari has no install icon in
  // the address bar, and sending someone to look for one is the exact failure
  // the platform table exists to prevent.
  assert.ok(!stepsFor('mac-safari').some((step) => step.key === 'pwaStepDesktopIcon'));
  assert.notDeepEqual(stepsFor('mac-safari'), stepsFor('desktop-chromium'));
});

test('a hamburger step draws a hamburger', () => {
  // The Samsung string names «☰» and the `menu` glyph draws «⋮», so the
  // picture and the sentence beside it pointed at two different buttons on the
  // one screen where the customer is hunting for a button.
  const samsungMenu = stepsFor('samsung').find((step) => step.key === 'pwaStepSamsungMenu');
  assert.ok(samsungMenu);
  assert.equal(samsungMenu.glyph, 'lines');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok((translations[lang] as Record<string, string>).pwaStepSamsungMenu.includes('☰'));
  }

  // Android's string names «⋮» and keeps the dots, which is the other half of
  // the same rule.
  const androidMenu = stepsFor('android-chromium').find((step) => step.key === 'pwaStepAndroidMenu');
  assert.ok(androidMenu);
  assert.equal(androidMenu.glyph, 'menu');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok((translations[lang] as Record<string, string>).pwaStepAndroidMenu.includes('⋮'));
  }
});

test('the iPad is not told about a bottom bar it does not have', () => {
  // `detectPlatform` deliberately classifies an iPad as `ios-safari`, which is
  // the case this file exists for — and the reward for getting it right was a
  // sentence naming «شريط Safari بالأسفل». iPadOS Safari puts Share in the TOP
  // toolbar and has no bottom browser bar at all, so the step described a
  // control that is not on the screen. The wording is device-neutral now: the
  // button is named by what it LOOKS like, which is true on both.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const step = (translations[lang] as Record<string, string>).pwaStepIosShare;
    assert.doesNotMatch(step, /بالأسفل|bottom|خوارەوە/i, `${lang}.pwaStepIosShare names a bottom bar`);
  }
});

test('a desktop with no install path is told so rather than given invented steps', () => {
  assert.deepEqual(guidance('firefox', { mobile: false }), { kind: 'none' });
  assert.deepEqual(guidance('unknown', { mobile: false }), { kind: 'none' });
  // The SAME platforms on a phone do have a menu item, and get one.
  assert.equal(guidance('firefox', { mobile: true }).kind, 'steps');
  assert.equal(guidance('unknown', { mobile: true }).kind, 'steps');
});

test('every step names a string that exists in all three languages', () => {
  // A step whose key is missing from `ar` or `ckb` is a blank line in the
  // sheet on a customer's phone — silent, and only in one language.
  const platforms: Platform[] = [
    'ios-safari',
    'ios-other-browser',
    'android-chromium',
    'huawei',
    'samsung',
    'mac-safari',
    'firefox',
    'desktop-chromium',
    'unknown',
  ];
  for (const platform of platforms) {
    for (const step of stepsFor(platform)) {
      for (const lang of ['ar', 'en', 'ckb'] as const) {
        const value = (translations[lang] as Record<string, string>)[step.key];
        assert.equal(typeof value, 'string', `${lang}.${step.key}`);
        assert.ok(value.length > 0, `${lang}.${step.key} is empty`);
      }
    }
  }
});

// ------------------------------------------------------------ the "not now"

/** A working localStorage, in memory. */
function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/** Safari in a private window, and an iframe with third-party storage
 *  blocked. It does not return null — it THROWS. */
function throwingStorage(): StorageLike {
  const boom = (): never => {
    throw new Error('The quota has been exceeded.');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

test('the dismissal survives, and expires, at exactly the documented boundary', () => {
  const storage = memoryStorage();
  const now = 1_700_000_000_000;

  assert.equal(isInstallDismissed(storage, now), false, 'nothing recorded yet');

  const until = recordInstallDismissal(storage, now);
  assert.equal(until, now + INSTALL_DISMISS_MS);
  assert.equal(storage.map.get(INSTALL_DISMISS_KEY), String(until));
  assert.equal(readDismissedUntil(storage), until);

  assert.equal(isInstallDismissed(storage, now), true);
  assert.equal(isInstallDismissed(storage, until - 1), true, 'one millisecond inside the quiet period');
  assert.equal(isInstallDismissed(storage, until), false, 'the boundary is exclusive: at `until` it is over');
  assert.equal(isInstallDismissed(storage, until + 1), false);

  clearInstallDismissal(storage);
  assert.equal(readDismissedUntil(storage), 0);
  assert.equal(isInstallDismissed(storage, now), false);
});

test('thirty days, and it is stored as an absolute expiry rather than a start', () => {
  assert.equal(INSTALL_DISMISS_MS, 30 * 24 * 60 * 60 * 1000);
  const storage = memoryStorage();
  const now = 1_700_000_000_000;
  recordInstallDismissal(storage, now);
  // Reading is a comparison, never arithmetic on the stored number — so a
  // corrupted or hostile value can shift the expiry but can never be
  // multiplied into one far in the future by this code.
  assert.equal(Number(storage.map.get(INSTALL_DISMISS_KEY)), now + INSTALL_DISMISS_MS);
});

test('a storage that throws leaves the shop drawing', () => {
  const storage = throwingStorage();
  assert.equal(readDismissedUntil(storage), 0);
  assert.equal(isInstallDismissed(storage, Date.now()), false);
  // The write throws inside and is swallowed: the customer said "not now",
  // the sheet closes, and all that is lost is the memory on this one device.
  assert.doesNotThrow(() => recordInstallDismissal(storage, 1_700_000_000_000));
  assert.doesNotThrow(() => clearInstallDismissal(storage));
  // And no storage at all — a server render, or a browser that exposes none.
  assert.equal(readDismissedUntil(null), 0);
  assert.equal(isInstallDismissed(undefined, Date.now()), false);
  assert.doesNotThrow(() => recordInstallDismissal(null, 0));
  assert.doesNotThrow(() => clearInstallDismissal(undefined));
});

test('a garbage value in storage is read as "never dismissed", not as a date', () => {
  const storage = memoryStorage();
  for (const junk of ['', 'soon', 'NaN', '-1', '0', '{}']) {
    storage.map.set(INSTALL_DISMISS_KEY, junk);
    assert.equal(readDismissedUntil(storage), 0, junk);
    assert.equal(isInstallDismissed(storage, Date.now()), false, junk);
  }
});

test('the storage key is namespaced and versioned', () => {
  // `lv.` and a `v1` suffix, following the two most recent keys in the app.
  // The version is what lets a later change to the shape retire the old value
  // instead of misreading it.
  assert.match(INSTALL_DISMISS_KEY, /^lv\..*\.v1$/);
});
