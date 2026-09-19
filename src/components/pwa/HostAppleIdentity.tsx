/**
 * THE TWO THINGS iOS READS INSTEAD OF THE MANIFEST, MADE PER-HOST.
 *
 * `worker/routes/manifest.ts` exists for one reason, and its own comment says
 * it plainly: a static manifest «would install `ali3d.levonis-iq.com` as
 * "LEVONIS", with the platform's mark, on the phone of a customer who believes
 * they are installing that shop». It answers per host, out of the merchant's
 * own row, and it works — on Android.
 *
 * iOS does not read it for the two things the customer actually sees. Given an
 * `apple-touch-icon` link it prefers that link over the manifest's `icons`
 * array, and given `apple-mobile-web-app-title` it prefers that over the
 * manifest's `short_name`. Both of those lived in `index.html`, which is ONE
 * shared document served byte-identically on every host — so an iPhone
 * customer on a merchant subdomain read «ثبّت متجر علي على جهازك» in the
 * install sheet, followed the steps, and got the LEVONIS trefoil labelled
 * LEVONIS on their home screen. The exact deception the Worker route was
 * written to prevent, reintroduced on the one platform whose install flow has
 * no one-tap alternative.
 *
 * `apple-mobile-web-app-title` is gone from index.html, which leaves iOS
 * falling back to the manifest's per-host `short_name` on modern versions and
 * to `<title>` on older ones. This component owns that `<title>`, and the
 * icon, for as long as a merchant host is being rendered. Safari reads both
 * out of the LIVE DOM at the moment «إضافة إلى الشاشة الرئيسية» is tapped, not
 * out of the bytes that arrived, so rewriting them from the resolved store is
 * enough — no server-side rewrite of the shell, and no second source of truth.
 *
 * WHY THE ICON IS NOT ALWAYS REPOINTED, which is the decision to question.
 *
 * `store.logoUrl` is `/files/<logo_key>`, and that key's extension is whatever
 * `storeMedia` sniffed on upload: webp, png, jpg, gif or avif. Conversion to
 * WebP happens only where the Images binding is present, so a merchant logo is
 * very often a WebP — and iOS does not accept WebP for `apple-touch-icon`. It
 * does not fall back to the next link either; it gives up and uses a
 * SCREENSHOT OF THE PAGE as the home-screen icon. That bug is the one the
 * owner could already see, and it is why index.html stopped pointing this link
 * at `/files/UiUx/Logo/Logo.webp` in the first place.
 *
 * So the repoint happens only for the formats iOS genuinely accepts. A WebP
 * or AVIF logo keeps the platform PNG: the merchant's mark is not on the home
 * screen, but their NAME is, and a real icon beats a photograph of a web page.
 * Recording dimensions and serving a PNG rendition for merchant logos is the
 * follow-up that removes the compromise.
 *
 * It renders nothing, and it restores what it changed on unmount, because this
 * component is mounted inside the storefront shell and the main site's own
 * title and icon must survive a client-side navigation back out of it.
 */
import { useEffect } from 'react';
import { useStore } from '../../StoreContext';

/**
 * The formats iOS will actually decode for a home-screen icon. Deliberately a
 * short allow-list rather than a deny-list of WebP: a format nobody has
 * thought about yet must land on the safe side, which is "leave the platform
 * PNG alone", not "hand iOS something it may refuse".
 */
const APPLE_ICON_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

function appleUsableIcon(logoUrl: string | null | undefined): string | null {
  if (!logoUrl) return null;
  // The query and fragment are stripped before the extension is read, so a
  // cache-busted `?v=2` cannot hide the real suffix.
  const path = logoUrl.split('?')[0].split('#')[0].toLowerCase();
  return APPLE_ICON_EXTENSIONS.some((ext) => path.endsWith(ext)) ? logoUrl : null;
}

export default function HostAppleIdentity() {
  const { store } = useStore();
  const name = store?.name || '';
  const icon = appleUsableIcon(store?.logoUrl);

  useEffect(() => {
    if (typeof document === 'undefined' || !name) return;

    const previousTitle = document.title;
    document.title = name;

    const link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    const previousHref = link?.getAttribute('href') ?? null;
    if (link && icon) link.setAttribute('href', icon);

    return () => {
      document.title = previousTitle;
      // Restored by the value that was there, not by a hard-coded path: this
      // component must not become a second place that knows what the platform
      // icon is called.
      if (link && previousHref !== null) link.setAttribute('href', previousHref);
    };
  }, [name, icon]);

  return null;
}
