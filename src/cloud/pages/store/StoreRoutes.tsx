/**
 * STORE — printing hours, filament and accessories, the cart and the
 * customer's orders: every address under /store and /orders
 * (src/cloud/routes.ts). The shell mounts this module WITHOUT a sign-in
 * gate: a visitor may browse, and the screens that need an account (an
 * order, a payment) ask for one themselves with `useSignIn()` or
 * `<RequireSignIn>` (src/cloud/auth.tsx).
 *
 * A PLACEHOLDER. The section's builder replaces this whole file, keeping
 * the default export: a component that takes no props and renders its own
 * `<Routes>` with FULL paths (`/orders/:id`, not `:id`). Until then every
 * address of the section says plainly that the store is not built yet and
 * points at what already works — each printer's page lists the hour
 * packages of its class with the server's prices.
 */
import { Link } from 'react-router-dom';
import { common, nav } from '../../strings/common';
import { useCloudText } from '../../text';
import type { Tri } from '../../types';
import { CloudEmptyState, PageHeader, ShoppingBag } from '../../ui';

const words = {
  title: { ar: 'المتجر قيد الإنشاء', en: 'The store is being built', ckb: 'فرۆشگاکە هێشتا دروست دەکرێت' },
  body: {
    ar: 'هنا ستشتري ساعات الطباعة والخيوط وتتابع طلباتك. حتى يجهز، تعرض صفحة كل طابعة باقات الساعات لفئتها.',
    en: 'This is where you will buy printing hours and filament and follow your orders. Until it is ready, each printer’s page lists the hour packages of its class.',
    ckb: 'لێرە کاتژمێری چاپ و فیلامێنت دەکڕیت و بەدواداچوون بۆ داواکارییەکانت دەکەیت. تا ئامادە دەبێت، پەڕەی هەر چاپکەرێک پاکێجەکانی کاتژمێری پۆلەکەی پیشان دەدات.',
  },
} satisfies Record<string, Tri>;

export default function StoreRoutes() {
  const { t } = useCloudText();
  return (
    <div>
      <PageHeader title={t(nav.store)} back={{ to: '/', label: t(nav.home) }} />
      <CloudEmptyState
        icon={<ShoppingBag className="h-6 w-6" />}
        title={t(words.title)}
        body={t(words.body)}
        action={
          <>
            <Link to="/printers" className="lv-button lv-button-secondary">
              {t(nav.printers)}
            </Link>
            <Link to="/how-it-works" className="lv-button lv-button-ghost">
              {t(nav.howItWorks)}
            </Link>
            <Link to="/" className="lv-button lv-button-ghost">
              {t(common.backHome)}
            </Link>
          </>
        }
      />
    </div>
  );
}
