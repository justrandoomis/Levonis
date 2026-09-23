/**
 * «تحميل التطبيق» — the window that either installs the shop in one tap or
 * teaches the customer the five taps their browser requires instead.
 *
 * IT IS THE APP'S OWN SHEET, not a new panel. `Sheet` (src/components/ui/
 * Overlay.tsx) already owns the material, the spring, the grabber, the
 * drag-to-dismiss and the Escape key; the header comment on that file exists
 * because twenty-four screens once hand-rolled `fixed inset-0 bg-black/80`
 * and every one of them appeared from nowhere and vanished to nowhere.
 * Inventing a panel here would be re-creating the exact defect the primitive
 * was written to delete.
 *
 * ON A MERCHANT SUBDOMAIN IT NAMES THE MERCHANT. ali3d.levonis-iq.com runs
 * this same bundle (§10) and presents itself as that shop; a sheet offering
 * to install "LEVONIS" there would be offering the customer a different shop
 * than the one they are standing in, with a different icon. The name and the
 * mark come from `useStore()`, which the app has already resolved before
 * anything renders — and the manifest the browser then reads is the Worker's
 * per-host one, so the two agree.
 *
 * WHAT IT DOES NOT PROMISE. Not offline shopping. The service worker never
 * caches `/api/*` or `/files/*` — prices, stock and carts are fetched every
 * time — so the honest line is "it opens like an app", never "it works
 * without internet". A customer who installs this expecting an offline
 * catalogue has been lied to by the install sheet.
 */
import { Check, Download, Globe, Menu, MoreVertical, Plus, Share } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useStore } from '../../StoreContext';
import { PLATFORM_APP_ICON } from '../../lib/siteLogo';
import { Sheet } from '../ui/Overlay';
import { useInstallApp } from '../../hooks/useInstallApp';
import type { StepGlyph } from '../../lib/pwa';

/**
 * The picture beside a step. `src/lib/pwa.ts` names a glyph and never draws
 * one: the platform table is data, so a new browser is one row there rather
 * than a new branch of JSX here.
 */
function Glyph({ glyph }: { glyph: StepGlyph }) {
  const common = 'w-4 h-4';
  switch (glyph) {
    case 'share':
      return <Share aria-hidden="true" className={common} />;
    case 'menu':
      return <MoreVertical aria-hidden="true" className={common} />;
    // «☰», and it is a separate case from `menu` on purpose: the Samsung step
    // text names a hamburger, and drawing «⋮» next to it pointed the customer
    // at the wrong button on the browser where they are already hunting.
    case 'lines':
      return <Menu aria-hidden="true" className={common} />;
    case 'plus':
      return <Plus aria-hidden="true" className={common} />;
    case 'check':
      return <Check aria-hidden="true" className={common} />;
    case 'browser':
      return <Globe aria-hidden="true" className={common} />;
    case 'install':
      return <Download aria-hidden="true" className={common} />;
    default:
      return null;
  }
}

export interface InstallAppSheetProps {
  open: boolean;
  onClose: () => void;
}

export default function InstallAppSheet({ open, onClose }: InstallAppSheetProps) {
  const { t } = useLanguage();
  const { store } = useStore();
  const { guidance, promptInstall, dismiss, confirmInstalled } = useInstallApp();

  const name = store?.name || 'LEVONIS';
  // The merchant's own logo where there is one, the platform mark otherwise.
  // A store logo lives at a public R2 key, so it loads for a signed-out
  // visitor exactly as it does inside the shop.
  //
  // The fallback is NOT spelled out here any more. `/icons/icon-192.png` is
  // one of the seven committed PNGs that `scripts/build-pwa-icons.mjs` forks
  // from the logo in R2, and a path typed into a component is exactly how the
  // mark came to have three independent spellings and one of them stale —
  // src/lib/siteLogo.ts is the only place that names it now.
  const icon = store?.logoUrl || PLATFORM_APP_ICON;

  // «ليس الآن» is an ANSWER, not a close. It records the dismissal, and the
  // dismissal is READ — by every `InstallAppButton` the app volunteered
  // (`offered`), which is the Profile card and the storefront row. Those go
  // quiet for the thirty days `INSTALL_DISMISS_MS` argues for, which is the
  // difference between an offer and a nag.
  //
  // The Settings row deliberately keeps its button: the customer who opened
  // Settings and scrolled to Preferences came looking for that control, and
  // hiding a setting from the person who came to change it is not restraint,
  // it is a missing control.
  //
  // The X and the drag-away call `onClose` alone: those mean "not this
  // window", not "stop asking".
  const later = () => {
    dismiss();
    onClose();
  };

  /**
   * «التطبيق مثبّت على هذا الجهاز» — THE CUSTOMER'S OWN ANSWER, in the branch
   * where the platform has none.
   *
   * On Apple browsers there is no `beforeinstallprompt` and no `appinstalled`.
   * The customer follows the steps, the icon lands on their home screen, and
   * Safari — the window they are still in — is not standalone and never will
   * be. So the offer came back on the next visit, correctly and uselessly, and
   * the only button that silenced it said «ليس الآن».
   *
   * There is no API that can ask iOS whether an icon exists, so this is not a
   * detection we are skipping: the customer is the only source. The label is
   * the existing `pwaInstallDone` string — "the app is installed on this
   * device" — because that is exactly the statement they are making, and it
   * already exists in all three languages.
   *
   * It does not expire. See INSTALL_CONFIRMED_KEY in src/lib/pwa.ts for why
   * that is a different key from the thirty-day «ليس الآن», and for the way
   * back (the Settings row, which is not an offered surface).
   */
  const alreadyAdded = () => {
    confirmInstalled();
    onClose();
  };

  const install = () => {
    void promptInstall().then((outcome) => {
      // Whatever the browser's dialog returned, this window has said its
      // piece. `accepted` installs the app and `appinstalled` hides every
      // affordance; `dismissed` is the customer's answer to the browser, not
      // to us, so it is deliberately NOT recorded as a month of silence.
      if (outcome !== 'unavailable') onClose();
    });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={t('pwaInstallClose')}
      labelledBy="install-app-title"
      testId="install-app-sheet"
      // Geometry only. The glass, the border and the rounding are the
      // primitive's, and they must stay that way.
      panelClassName="w-full sm:max-w-md"
    >
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5">
        <div className="flex items-center gap-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border-subtle bg-black">
            {/* `object-contain`, NOT `object-cover`. A merchant's logo is whatever
                they uploaded, and shop logos are very often wide wordmarks:
                `cover` scales to fill this 56px square and clips the overflow,
                so a horizontal wordmark loses its left and right thirds in the
                window that is asking the customer to install that shop. The
                container is already `bg-black`, which is the same black the
                platform icons carry baked in, so the letterboxing `contain`
                leaves is invisible. */}
            <img src={icon} alt="" className="h-full w-full object-contain" />
          </span>
          <div className="min-w-0">
            <h2 id="install-app-title" className="text-[16px] font-bold text-white">
              {t('pwaInstallHeading').replace('{name}', name)}
            </h2>
            <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">{t('pwaInstallWhy')}</p>
          </div>
        </div>

        {/* The limit, stated next to the offer rather than discovered on a
            train with no signal. */}
        <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">{t('pwaInstallHonesty')}</p>

        {guidance.kind === 'prompt' ? (
          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={install}
              className="min-h-[48px] rounded-xl bg-gold px-5 text-[14px] font-bold text-black transition-opacity duration-200 hover:opacity-90 inline-flex items-center justify-center gap-2"
            >
              <Download aria-hidden="true" className="w-4 h-4" />
              {t('pwaInstallNow')}
            </button>
            <button
              type="button"
              onClick={later}
              className="min-h-[44px] rounded-xl px-5 text-[13px] font-medium text-zinc-400 transition-colors duration-200 hover:text-white"
            >
              {t('pwaInstallLater')}
            </button>
          </div>
        ) : null}

        {guidance.kind === 'steps' ? (
          <div className="mt-5">
            <p className="text-[13px] font-bold text-white">{t('pwaInstallStepsTitle')}</p>
            {/* An ordered list, because the order is the instruction. The
                numbers are the list's own, so a screen reader announces
                "1 of 3" rather than reading a decorative character. */}
            <ol className="mt-3 space-y-3">
              {guidance.steps.map((step, index) => (
                <li key={step.key} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
                    <Glyph glyph={step.glyph} />
                  </span>
                  <span className="min-w-0 text-[13px] leading-relaxed text-zinc-300">
                    <span className="font-bold text-white">{index + 1}. </span>
                    {t(step.key)}
                  </span>
                </li>
              ))}
            </ol>
            {/* The primary action in this branch is the customer telling us
                they are done, because nothing else can. «ليس الآن» stays,
                quieter, for the person who is not going to do it now — the two
                are different answers and the thirty-day silence belongs only
                to the second one. */}
            <button
              type="button"
              data-install-already-added
              onClick={alreadyAdded}
              className="mt-5 min-h-[48px] w-full rounded-xl bg-white/10 px-5 text-[13px] font-bold text-white transition-colors duration-200 hover:bg-white/15 inline-flex items-center justify-center gap-2"
            >
              <Check aria-hidden="true" className="w-4 h-4" />
              {t('pwaInstallDone')}
            </button>
            <button
              type="button"
              onClick={later}
              className="mt-2 min-h-[44px] w-full rounded-xl px-5 text-[13px] font-medium text-zinc-400 transition-colors duration-200 hover:text-white"
            >
              {t('pwaInstallLater')}
            </button>
          </div>
        ) : null}

        {guidance.kind === 'open-in-browser' ? (
          <div className="mt-5">
            <p className="text-[13px] font-bold text-white">{t('pwaInstallInAppTitle')}</p>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-300">{t('pwaInstallInAppHow')}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 min-h-[44px] w-full rounded-xl px-5 text-[13px] font-medium text-zinc-400 transition-colors duration-200 hover:text-white"
            >
              {t('pwaInstallClose')}
            </button>
          </div>
        ) : null}

        {guidance.kind === 'none' ? (
          <div className="mt-5">
            <p className="text-[13px] leading-relaxed text-zinc-300">{t('pwaInstallNoneHere')}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 min-h-[44px] w-full rounded-xl px-5 text-[13px] font-medium text-zinc-400 transition-colors duration-200 hover:text-white"
            >
              {t('pwaInstallClose')}
            </button>
          </div>
        ) : null}

        {/* `installed` is here for completeness only — the button that opens
            this sheet does not render at all once the app is installed, so
            reaching this branch means the display mode changed while the
            window was open. Saying so is better than an empty sheet. */}
        {guidance.kind === 'installed' ? (
          <div className="mt-5">
            <p className="text-[13px] leading-relaxed text-zinc-300">{t('pwaInstallDone')}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 min-h-[44px] w-full rounded-xl px-5 text-[13px] font-medium text-zinc-400 transition-colors duration-200 hover:text-white"
            >
              {t('pwaInstallClose')}
            </button>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
