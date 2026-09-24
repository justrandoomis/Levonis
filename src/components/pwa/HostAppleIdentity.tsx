/**
 * THE ONE THING iOS READS INSTEAD OF THE MANIFEST THAT ONLY THE PAGE CAN SET.
 *
 * `worker/routes/manifest.ts` exists for one reason, and its own comment says
 * it plainly: a static manifest «would install `ali3d.levonis-iq.com` as
 * "LEVONIS", with the platform's mark, on the phone of a customer who believes
 * they are installing that shop». It answers per host, out of the merchant's
 * own row, and it works — on Android.
 *
 * iOS does not read it for the two things the customer actually sees: the
 * home-screen ICON (it prefers an `apple-touch-icon` link) and, on older
 * versions, the LABEL (it falls back to `<title>`). Both live in `index.html`,
 * ONE shared document served byte-identically on every host.
 *
 * THE ICON IS NO LONGER THIS COMPONENT'S JOB. It used to repoint
 * `apple-touch-icon` at the merchant's raw logo — and only when that logo was
 * a PNG or JPEG, because iOS refuses WebP and then uses a SCREENSHOT OF THE
 * PAGE; a WebP logo (the common case) kept the platform PNG. The follow-up
 * that note asked for now exists: `index.html` links `/store-icon/apple-touch.png`,
 * which the Worker answers PER HOST with the store's own 180 px PNG rendition
 * of its current logo (worker/lib/storeIcons.ts) — square, padded on the
 * store's ground, and a PNG whatever the logo was uploaded as. Repointing the
 * link here would now REPLACE that rendition with the raw upload, so the link
 * is left alone.
 *
 * THE TITLE STILL IS. `apple-mobile-web-app-title` is gone from index.html,
 * which leaves iOS falling back to the manifest's per-host `short_name` on
 * modern versions and to `<title>` on older ones. Safari reads it out of the
 * LIVE DOM at the moment «إضافة إلى الشاشة الرئيسية» is tapped, not out of
 * the bytes that arrived, so setting it from the resolved store is enough.
 *
 * It renders nothing, and it restores what it changed on unmount, because this
 * component is mounted inside the storefront shell and the main site's own
 * title must survive a client-side navigation back out of it.
 */
import { useEffect } from 'react';
import { useStore } from '../../StoreContext';

export default function HostAppleIdentity() {
  const { store } = useStore();
  const name = store?.name || '';

  useEffect(() => {
    if (typeof document === 'undefined' || !name) return;
    const previousTitle = document.title;
    document.title = name;
    return () => {
      document.title = previousTitle;
    };
  }, [name]);

  return null;
}
