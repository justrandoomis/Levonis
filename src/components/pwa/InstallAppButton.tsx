/**
 * The one entry point to «تحميل التطبيق».
 *
 * IT DISAPPEARS WHEN THE APP IS ALREADY INSTALLED. Offering to install the
 * thing the customer is currently standing inside is the clearest possible
 * signal that a feature does not know what it is doing, and on iOS it is not
 * even detectable from the display-mode query — `navigator.standalone` is the
 * only signal there, which is why `src/lib/pwa.ts` checks it first.
 *
 * THE SHEET IS LAZY, THE BUTTON IS NOT. `tests/bundleBudget.test.ts` holds the
 * entry chunk to 120 KB gzip and the whole first payload to 240 KB, and this
 * button is reachable from Settings — a lazy route — but the update toast
 * beside it is mounted at the root of the app. Keeping the sheet's markup,
 * its icon set and its five branches behind `React.lazy` means none of it is
 * a static dependency of the entry, while the trigger stays synchronous so it
 * never flashes in after the page has settled.
 *
 * ONCE OPENED IT STAYS MOUNTED. Unmounting the sheet the instant `open` goes
 * false would skip its exit animation entirely — `AnimatePresence` inside the
 * primitive needs the element to survive the close in order to animate it
 * out, and a window that vanishes is the defect Overlay.tsx exists to remove.
 */
import { Download } from 'lucide-react';
import React, { Suspense, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { useInstallApp } from '../../hooks/useInstallApp';

const InstallAppSheet = React.lazy(() => import('./InstallAppSheet'));

export interface InstallAppButtonProps {
  /** Geometry and variant only; the caller owns where this sits. */
  className?: string;
}

export default function InstallAppButton({
  className = 'lv-button lv-button-secondary mt-2',
}: InstallAppButtonProps) {
  const { t } = useLanguage();
  const { standalone } = useInstallApp();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);

  if (standalone) return null;

  const show = () => {
    setEverOpened(true);
    setOpen(true);
  };

  return (
    <>
      <button type="button" onClick={show} className={className}>
        <Download aria-hidden="true" className="w-4 h-4" />
        {t('pwaInstallTitle')}
      </button>
      {everOpened ? (
        // No fallback: the sheet IS the window, so a spinner in its place
        // would be a second, differently-shaped window arriving first.
        <Suspense fallback={null}>
          <InstallAppSheet open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
