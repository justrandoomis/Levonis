/**
 * INSTALLING THE SHOP AS AN APP — everything about it that can be decided
 * without a browser.
 *
 * «أريد إضافة ميزة تحميل التطبيق للموقع ... وفي جميع المتصفحات» — the owner
 * asked for one feature and named three phone makers, which is the whole
 * difficulty in one sentence: there is no single install API. Chromium hands
 * the page a `beforeinstallprompt` event and one tap does it. Safari on iOS
 * fires nothing at all and exposes no API whatsoever — the only path is the
 * customer tapping Share and then «إضافة إلى الشاشة الرئيسية» themselves.
 * Firefox on a phone has a menu item; Firefox on a desktop has nothing.
 * Instagram's in-app browser can install nothing at all, ever.
 *
 * So the affordance is two things — a real button where the browser gives us
 * one, and an honest set of instructions where it does not — and WHICH of the
 * two a person gets is decided here.
 *
 * WHY THIS FILE HAS NO `window` IN IT. Every function below takes what it
 * needs as an argument: the user-agent string, `navigator.maxTouchPoints`, a
 * `matchMedia` function, a storage object, a clock. That is not ceremony. It
 * is the only way `tests/pwaClient.test.ts` can drive an iPhone, an iPad
 * reporting itself as a Mac, a Huawei phone and Instagram's webview through
 * the same code in one process under `node --test`, where none of those
 * globals exist. A module that read `navigator` at import time would be
 * untestable and would also throw the moment anything server-side imported it.
 *
 * WHAT IS DELIBERATELY NOT HERE: React, the DOM, the `beforeinstallprompt`
 * event itself and the service-worker registration. Those are impure and they
 * live in `src/hooks/useInstallApp.ts` and `src/main.tsx`.
 */

// The key type is borrowed from the translation table itself, as a TYPE ONLY
// import — it is erased at build time, so this module still pulls in no data
// and no runtime dependency. The point is that a step naming a string that
// does not exist in all three languages is a compile error here, in the file
// that named it, rather than a blank line in the sheet on someone's phone.
import type { translations } from '../translations';

export type PwaStringKey = keyof (typeof translations)['en'];

// ------------------------------------------------------------- the platform

/**
 * WHAT THE BROWSER IS, expressed as the only thing the install affordance
 * cares about: which of the mutually exclusive install stories applies.
 *
 * These are not vendor names for their own sake. `ios-safari` and
 * `ios-other-browser` are separate because the menu path differs — Chrome on
 * an iPhone is Safari's engine wearing a different share sheet, and the
 * customer has to be told where ITS button is. `huawei` and `samsung` are
 * separate from `android-chromium` because their menus use different words
 * and a different glyph, and telling someone to look for «⋮» when their
 * browser draws «☰» is worse than saying nothing.
 */
export type Platform =
  | 'ios-safari'
  | 'ios-other-browser'
  | 'mac-safari'
  | 'android-chromium'
  | 'huawei'
  | 'samsung'
  | 'firefox'
  | 'desktop-chromium'
  | 'unknown';

export interface PlatformProbe {
  /** `navigator.userAgent`. */
  userAgent: string;
  /**
   * `navigator.maxTouchPoints`. THIS IS THE iPad TEST AND THERE IS NO OTHER.
   * Since iPadOS 13 an iPad in its default "Request Desktop Website" mode
   * sends a user-agent string that is byte-for-byte a Mac's: no "iPad", no
   * "Mobile", nothing. A UA-only check therefore classifies every iPad as a
   * desktop, tells its owner to look for an install icon in the address bar
   * that does not exist, and hides the Share instructions that would have
   * worked. A Mac reports 0 or 1 touch points; an iPad reports 5.
   */
  maxTouchPoints: number;
}

const APPLE_DEVICE = /iphone|ipad|ipod/i;
const MAC = /macintosh|mac os x/i;
// Every iOS browser that is NOT Safari, by its own token. All of them run
// WebKit underneath — Apple requires it — so none of them can offer a real
// install button either, but their share menus sit in different places.
const IOS_NON_SAFARI = /crios|fxios|edgios|opios|opt\/|yabrowser|duckduckgo|mercury|coast/i;
// Huawei's own browsers. Matched on the BROWSER token, never on the device
// name: "HUAWEI ELS-NX9" appears in the user-agent of Chrome running on a
// Huawei phone too, and that Chrome does fire `beforeinstallprompt` — sending
// its owner down the manual path would take away the one-tap button they had.
const HUAWEI_BROWSER = /huaweibrowser|petalbrowser|petalsearch/i;
const SAMSUNG_BROWSER = /samsungbrowser/i;
const FIREFOX = /firefox\/|\bfxios\b/i;
const CHROMIUM = /chrome\/|chromium\/|crios|edg[ea]?\//i;

/** True for an iPhone, an iPod, or an iPad in either of its two disguises. */
export function isApplePlatform(probe: PlatformProbe): boolean {
  if (APPLE_DEVICE.test(probe.userAgent)) return true;
  // A Mac user-agent WITH a touchscreen is an iPad. A real Mac is not a
  // touchscreen, and Apple has never shipped one.
  return MAC.test(probe.userAgent) && probe.maxTouchPoints > 1;
}

/**
 * Is this a phone or a tablet? Only used to answer "can this browser install
 * anything at all" — Firefox on Android has a menu item for it and Firefox on
 * a desktop has nothing, and they share a user-agent token.
 */
export function isMobilePlatform(probe: PlatformProbe): boolean {
  if (isApplePlatform(probe)) return true;
  return /android|mobile|tablet|silk|kindle/i.test(probe.userAgent);
}

/**
 * ORDER IS THE WHOLE ALGORITHM, because these tokens nest. Samsung Internet's
 * user-agent contains "Chrome". Huawei Browser's contains "Chrome". Chrome on
 * an iPhone contains "Safari" AND "CriOS" and is neither. Each branch below
 * therefore removes a case the branches under it would otherwise swallow, and
 * the cheapest way to break this function is to reorder it.
 */
export function detectPlatform(probe: PlatformProbe): Platform {
  const ua = probe.userAgent || '';

  // Apple first and unconditionally. Every browser on iOS is WebKit, so the
  // install story is Safari's story no matter whose name is on the icon.
  if (isApplePlatform(probe)) {
    if (IOS_NON_SAFARI.test(ua)) return 'ios-other-browser';
    // Real Safari always carries a "Safari" token. An embedded webview — the
    // one inside Instagram, for instance — does not, and it is not Safari in
    // any sense that matters: it has no share button of its own.
    return /safari/i.test(ua) ? 'ios-safari' : 'ios-other-browser';
  }

  if (HUAWEI_BROWSER.test(ua)) return 'huawei';
  if (SAMSUNG_BROWSER.test(ua)) return 'samsung';
  if (FIREFOX.test(ua)) return 'firefox';

  if (/android/i.test(ua)) {
    // Chrome, Edge, Opera, Brave, Vivaldi and the stock WebView on Android
    // are one story: a menu with an install entry, and usually a real
    // `beforeinstallprompt` as well.
    return CHROMIUM.test(ua) ? 'android-chromium' : 'unknown';
  }

  if (CHROMIUM.test(ua)) return 'desktop-chromium';

  // SAFARI ON A MAC INSTALLS WEB APPS, AND THIS BRANCH IS THE APOLOGY FOR
  // SAYING IT DID NOT.
  //
  // Everything above has already failed, so what is left is a desktop that is
  // not Chromium. A Mac user-agent with a Safari token and no touchscreen is
  // real Safari on a real Mac — the iPad was taken by `isApplePlatform` at the
  // top of this function, which is the ONLY reason the touch check can be
  // trusted this far down.
  //
  // Without this branch that machine fell through to `'unknown'`, and
  // `installGuidance` answers a non-mobile `'unknown'` with `{kind:'none'}` —
  // «هذا المتصفح على الحاسوب لا يثبّت المواقع كتطبيقات. استخدم Chrome أو Edge».
  // That was false. Safari has installed web apps since Sonoma (Safari 17,
  // September 2023) through File ▸ Add to Dock, and `none` is documented here
  // as the branch for where inventing steps would be lying. It was the `none`
  // that lied: it told a Mac owner with a working install path to go and get
  // another browser.
  //
  // The menu is named rather than an address-bar icon, because Safari has no
  // install icon in the address bar — that is Chrome's affordance, and sending
  // someone to look for it is the failure this whole platform table exists to
  // avoid.
  if (MAC.test(ua) && /safari/i.test(ua)) return 'mac-safari';

  return 'unknown';
}

/**
 * THE BROWSER INSIDE ANOTHER APP, WHICH CAN INSTALL NOTHING.
 *
 * A link opened from Instagram, Facebook, Messenger, TikTok, Snapchat, LINE
 * or a Telegram in-app view runs in a webview the host app owns. There is no
 * address bar, no browser menu, no share-to-home-screen and no
 * `beforeinstallprompt` — the install feature does not exist there, at all,
 * on any operating system. It matters because it is the single most common
 * way an Iraqi customer reaches this shop: they tap the link in the story.
 *
 * Showing that customer a dead install button, or iPhone instructions naming
 * a Share button their screen does not have, is the failure this predicate
 * exists to prevent. The honest answer is «افتح الرابط في المتصفح».
 */
export function isInAppWebView(userAgent: string): boolean {
  const ua = userAgent || '';
  return (
    // Facebook's family: FBAN (app name) / FBAV (app version) / FB_IAB.
    /\bfban\b|\bfbav\b|fb_iab|fbios|messengerforios|\[fb/i.test(ua) ||
    /\binstagram\b/i.test(ua) ||
    // TikTok ships as musical_ly on iOS and BytedanceWebview on Android.
    /bytedancewebview|musical_ly|\btiktok\b/i.test(ua) ||
    /\bsnapchat\b/i.test(ua) ||
    // LINE, WeChat, KakaoTalk — the same pattern in other markets.
    /\bline\//i.test(ua) ||
    /micromessenger/i.test(ua) ||
    /kakaotalk/i.test(ua) ||
    // Telegram's in-app browser on Android identifies itself this way.
    /\btelegram\b/i.test(ua) ||
    // Android's generic embedded WebView: "; wv)" in the platform section.
    /;\s*wv\)/i.test(ua)
  );
}

// -------------------------------------------------------------- standalone

export interface StandaloneProbe {
  /**
   * `window.matchMedia`, passed rather than read. It is OPTIONAL because some
   * embedded webviews do not expose it at all, and calling a function that is
   * not there would take down the whole app shell over a cosmetic question.
   */
  matchMedia?: ((query: string) => { matches: boolean }) | null;
  /**
   * `navigator.standalone`. iOS-only, and the ONLY signal there: Safari on
   * iOS has never implemented the `display-mode` media query, so an installed
   * iPhone app reports `matches: false` for every query below and would be
   * offered the install sheet again from inside itself.
   */
  appleStandalone?: boolean | undefined;
}

/**
 * Is the page ALREADY running as an installed app? If it is, every install
 * affordance in the application must disappear — offering someone the chance
 * to install the thing they are currently standing inside is the clearest
 * possible sign that the feature does not know what it is doing.
 *
 * `minimal-ui` is included because Firefox and a few Android browsers install
 * to that display mode rather than `standalone`, and `window-controls-overlay`
 * because that is what a desktop Chromium install reports.
 */
export function isStandalone(probe: StandaloneProbe): boolean {
  if (probe.appleStandalone === true) return true;
  const mm = probe.matchMedia;
  if (typeof mm !== 'function') return false;
  for (const query of [
    '(display-mode: standalone)',
    '(display-mode: minimal-ui)',
    '(display-mode: window-controls-overlay)',
    '(display-mode: fullscreen)',
  ]) {
    try {
      if (mm(query)?.matches) return true;
    } catch {
      // Some embedded webviews throw on an unknown media feature instead of
      // returning `matches: false`. A browser that cannot answer the question
      // is a browser that is not an installed app, which is the safe answer:
      // the worst outcome is showing the install row to someone who does not
      // need it, and the alternative is a thrown error inside a render.
      return false;
    }
  }
  return false;
}

// -------------------------------------------------------------- the advice

/** Which picture sits beside a step. The SHEET owns the drawing; this file
 *  owns only the name, so no platform hard-codes any markup. */
// `menu` is «⋮» (three vertical dots) and `lines` is «☰» (a hamburger). They
// are two glyphs rather than one because the step text names the character the
// customer is looking for, and drawing the other one beside it sends them
// hunting for a button that is not the button.
export type StepGlyph = 'share' | 'menu' | 'lines' | 'plus' | 'check' | 'browser' | 'install';

export interface InstallStep {
  /** A key in `src/translations.ts`, present in ar, en and ckb. */
  key: PwaStringKey;
  glyph: StepGlyph;
}

/**
 * WHAT TO SHOW. A discriminated union rather than a pile of booleans, because
 * these five states are mutually exclusive and the sheet must render exactly
 * one of them — a boolean soup is how a screen ends up showing an install
 * button and a "you already installed this" line at the same time.
 */
export type InstallGuidance =
  | { kind: 'installed' }
  | { kind: 'open-in-browser' }
  | { kind: 'prompt' }
  | { kind: 'steps'; platform: Platform; steps: readonly InstallStep[] }
  | { kind: 'none' };

// THE LAST STEP IS FOR THE BROWSER THAT IS NOT THE BROWSER IT SAYS IT IS.
//
// Telegram, and a long tail of other iOS apps, open links in an
// SFSafariViewController. That view reports a completely ordinary Mobile
// Safari user-agent — no app token at all — so `isInAppWebView` cannot see it
// and `detectPlatform` correctly, and uselessly, answers `'ios-safari'`.
// Apple gates «إضافة إلى الشاشة الرئيسية» in the share sheet behind the
// `com.apple.developer.web-browser` entitlement, which a host app embedding
// that view does not have, so the menu item the first two steps describe is
// simply absent.
//
// It is the commonest arrival path there is — the customer taps the shop's
// link inside a chat — and without this line it is a dead end: they tap Share,
// scroll a menu that does not contain the item, and there is nothing else to
// read. The escape hatch already existed for `ios-other-browser`; it belongs
// here for the same reason, and it costs a line that a genuine Safari user
// reaching step two never needs to read.
const IOS_SAFARI_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepIosShare', glyph: 'share' },
  { key: 'pwaStepIosAdd', glyph: 'plus' },
  { key: 'pwaStepIosConfirm', glyph: 'check' },
  { key: 'pwaStepIosUseSafari', glyph: 'browser' },
];

// File ▸ Add to Dock. Two steps, and no address-bar icon: Safari does not
// have one, and `desktop-chromium`'s first step names exactly that.
const MAC_SAFARI_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepMacSafariShare', glyph: 'share' },
  { key: 'pwaStepMacSafariAdd', glyph: 'install' },
];

// Chrome, Edge and Firefox on an iPhone all have "Add to Home Screen" in
// their OWN share menu on current iOS, and all of them have had releases
// where it was missing. The last step is the escape hatch for that, and it is
// the truth rather than a guess about which version they are on.
const IOS_OTHER_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepIosOtherShare', glyph: 'share' },
  { key: 'pwaStepIosAdd', glyph: 'plus' },
  { key: 'pwaStepIosUseSafari', glyph: 'browser' },
];

const ANDROID_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepAndroidMenu', glyph: 'menu' },
  { key: 'pwaStepAndroidAdd', glyph: 'plus' },
  { key: 'pwaStepAndroidConfirm', glyph: 'check' },
];

const HUAWEI_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepHuaweiMenu', glyph: 'menu' },
  { key: 'pwaStepHuaweiAdd', glyph: 'plus' },
];

// `lines`, not `menu`. The Samsung string names «☰» and the `menu` glyph draws
// three vertical dots, so the picture and the sentence beside it pointed at two
// different buttons — on the one screen where the customer is being asked to
// hunt for a button they have not found yet.
const SAMSUNG_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepSamsungMenu', glyph: 'lines' },
  { key: 'pwaStepSamsungAdd', glyph: 'plus' },
];

const FIREFOX_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepFirefoxMenu', glyph: 'menu' },
  { key: 'pwaStepFirefoxAdd', glyph: 'plus' },
];

const DESKTOP_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepDesktopIcon', glyph: 'install' },
  { key: 'pwaStepDesktopConfirm', glyph: 'check' },
];

const GENERIC_STEPS: readonly InstallStep[] = [
  { key: 'pwaStepGenericMenu', glyph: 'menu' },
  { key: 'pwaStepGenericAdd', glyph: 'plus' },
];

/** The manual path for a browser that gave us no event, as data. */
export function stepsFor(platform: Platform): readonly InstallStep[] {
  switch (platform) {
    case 'ios-safari':
      return IOS_SAFARI_STEPS;
    case 'ios-other-browser':
      return IOS_OTHER_STEPS;
    case 'mac-safari':
      return MAC_SAFARI_STEPS;
    case 'android-chromium':
      return ANDROID_STEPS;
    case 'huawei':
      return HUAWEI_STEPS;
    case 'samsung':
      return SAMSUNG_STEPS;
    case 'firefox':
      return FIREFOX_STEPS;
    case 'desktop-chromium':
      return DESKTOP_STEPS;
    default:
      return GENERIC_STEPS;
  }
}

export interface GuidanceInput {
  platform: Platform;
  /** A phone or tablet. See `isMobilePlatform` — it decides Firefox's story. */
  mobile: boolean;
  inAppWebView: boolean;
  /** A `beforeinstallprompt` event was captured and has not been used yet. */
  hasPrompt: boolean;
  standalone: boolean;
}

/**
 * THE ONE DECISION, IN ONE PLACE.
 *
 * The order of these five branches is the order of certainty, strongest
 * first. "You are already inside the app" beats everything. "This browser
 * cannot install anything" beats a captured event, because a webview can in
 * rare cases surface a stale event it cannot act on. A real captured event
 * beats written instructions, because one tap beats five. Written
 * instructions beat nothing. And `none` is reserved for the case where there
 * is genuinely no install path — desktop Firefox, and a desktop this file
 * could not identify at all — where inventing steps would be lying to the
 * customer.
 *
 * DESKTOP SAFARI USED TO BE IN THAT LIST AND IS NOT ANY MORE. It reached
 * `none` by falling through `detectPlatform` to `'unknown'`, and `none` then
 * told a Mac owner to install a different browser. Safari has had File ▸ Add
 * to Dock since Sonoma; `'mac-safari'` now catches it above and it gets steps
 * like everyone else.
 */
export function installGuidance(input: GuidanceInput): InstallGuidance {
  if (input.standalone) return { kind: 'installed' };
  if (input.inAppWebView) return { kind: 'open-in-browser' };
  if (input.hasPrompt) return { kind: 'prompt' };
  // Firefox and the unrecognised browsers install nothing on a desktop. On a
  // phone both do, through a menu item, so the same platform gets different
  // advice depending on the size of the machine — which is why `mobile` is an
  // input rather than something derived from the platform name.
  if (!input.mobile && (input.platform === 'firefox' || input.platform === 'unknown')) {
    return { kind: 'none' };
  }
  return { kind: 'steps', platform: input.platform, steps: stepsFor(input.platform) };
}

// ------------------------------------------------------- the "not now" memory

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `lv.` and a version suffix, following the two most recent keys in the app
 *  (`lv.verify-email.snooze.<email>`, `levonis.recentlyViewed.v1`). The `v1`
 *  is what lets a later change to the shape retire the old value instead of
 *  misreading it. */
export const INSTALL_DISMISS_KEY = 'lv.pwa.install.dismissed.v1';

/**
 * THIRTY DAYS, and here is the argument for the number.
 *
 * A customer who said «ليس الآن» said something real, and asking again on
 * their next visit turns an offer into a nag — the exact defect
 * `CompleteProfileSheet` was rebuilt to avoid. But "never again" is wrong
 * too: the person who declined on their first visit is a different person
 * three purchases later, and 3D-printing supplies are re-bought on roughly a
 * monthly cycle. Thirty days is long enough that the ask reads as occasional
 * to a weekly visitor, and short enough that a returning customer is offered
 * it again inside one buying cycle rather than never.
 *
 * It is stored as an ABSOLUTE expiry timestamp, not as "dismissed at", so
 * reading it is a comparison and never arithmetic on a value a hostile or
 * corrupted storage could have supplied.
 */
export const INSTALL_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Every read is wrapped, and it returns 0 rather than throwing.
 * `localStorage` throws — not returns null, THROWS — in a Safari private
 * window and inside an iframe with third-party storage blocked, and the rule
 * this codebase already wrote down for that (src/lib/recentlyViewed.ts) is
 * that a surface which cannot read a preference must still draw. The worst
 * outcome of returning 0 is that the install row is offered to someone who
 * dismissed it; the worst outcome of letting the throw escape is a blank app.
 */
export function readDismissedUntil(storage: StorageLike | null | undefined): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(INSTALL_DISMISS_KEY);
    const until = raw ? Number(raw) : 0;
    return Number.isFinite(until) && until > 0 ? until : 0;
  } catch {
    return 0;
  }
}

/** Dismissed AND still inside the quiet period. The boundary is deliberately
 *  exclusive: at exactly `until` the quiet period is over. */
export function isInstallDismissed(storage: StorageLike | null | undefined, now: number): boolean {
  return now < readDismissedUntil(storage);
}

/** Records the answer. A write that throws is not an error worth showing
 *  anyone — the customer said "not now" and the sheet closes either way; all
 *  that is lost is the memory of it on this one device. */
export function recordInstallDismissal(
  storage: StorageLike | null | undefined,
  now: number
): number {
  const until = now + INSTALL_DISMISS_MS;
  if (!storage) return until;
  try {
    storage.setItem(INSTALL_DISMISS_KEY, String(until));
  } catch {
    // Private mode, or storage the browser has blocked. Memory-only is a
    // working fallback for a preference, not a failure worth reporting.
  }
  return until;
}

/**
 * THE CUSTOMER'S OWN "I ADDED IT", AND WHY IT HAS TO EXIST.
 *
 * «وبالرغم من تحميل التطبيق والضغط على تثبيت الآن إلا أنه يعود الظهور مرة أخرى».
 *
 * On every Apple browser, and on Firefox, there IS no `beforeinstallprompt`
 * and there IS no `appinstalled`. The customer follows the steps, the icon
 * appears on their home screen — and Safari, the browser they are still
 * standing in, is not standalone and never will be. `isStandalone` is right
 * to say so: it is a fact about THIS window, not about the device. So the
 * offer came back on the next visit, correctly and uselessly, and the only
 * button that silenced it was labelled «ليس الآن» — which is not what
 * somebody who has just installed it wants to say.
 *
 * There is no API to ask iOS whether an icon exists. The only truthful source
 * is the customer, so the sheet asks them, in the branch where the platform
 * cannot answer: a button carrying `pwaInstallDone` — "the app is installed
 * on this device" — which is a statement they are making, not a dismissal.
 *
 * It is a SEPARATE key from the dismissal, not a very large `until`:
 *
 *   * it has no expiry. Thirty days is the right answer to "not now" and the
 *     wrong answer to "I already have it" — re-offering an app the customer
 *     installed is the same defect in a slower form.
 *   * `appinstalled` clears the dismissal (a real install answers the
 *     question), and it must NOT clear this one. The two facts are different
 *     and a device can hold either without the other.
 *
 * The way back is the Settings row, which is not an `offered` surface and so
 * renders regardless: a customer who taps it gets the sheet and the steps
 * again, which is the escape hatch for having answered too soon.
 */
export const INSTALL_CONFIRMED_KEY = 'lv.pwa.install.confirmed.v1';

/** Wrapped for the same reason every read here is: the access itself throws
 *  in a Safari private window, and an unreadable preference must still draw. */
export function readInstallConfirmed(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(INSTALL_CONFIRMED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Records it. A write that throws costs the memory on this one device and
 *  nothing else, so it is not reported. */
export function recordInstallConfirmed(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(INSTALL_CONFIRMED_KEY, '1');
  } catch {
    // Same reasoning as recordInstallDismissal.
  }
}

/** Forgets the dismissal — used when the app is actually installed, so a
 *  device that later uninstalls it starts from a clean answer. */
export function clearInstallDismissal(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(INSTALL_DISMISS_KEY);
  } catch {
    // Same reasoning as the write.
  }
}
