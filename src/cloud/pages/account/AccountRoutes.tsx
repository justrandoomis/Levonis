/**
 * ACCOUNT — the customer's hours ledger, filament, shipments, buybacks,
 * transactions and settings: every address under /account
 * (src/cloud/routes.ts). The shell mounts this module behind
 * `<RequireSignIn>`, so whoever reaches it is signed in.
 *
 * A PLACEHOLDER. The section's builder replaces this whole file, keeping
 * the default export: a component that takes no props and renders its own
 * `<Routes>` with FULL paths (`/account/shipments/:id`, not `:id`). Until
 * then every address of the section says plainly that its pages are not
 * built yet and points at what already works — the home shows the
 * customer's balances and jobs.
 */
import { Link } from 'react-router-dom';
import { common, nav } from '../../strings/common';
import { useCloudText } from '../../text';
import type { Tri } from '../../types';
import { CloudEmptyState, PageHeader, User } from '../../ui';

const words = {
  title: { ar: 'صفحات الحساب قيد الإنشاء', en: 'The account pages are being built', ckb: 'پەڕەکانی هەژمار هێشتا دروست دەکرێن' },
  body: {
    ar: 'هنا سترى سجل ساعاتك وخيوطك وشحناتك والخيوط التي تبيعها للورشة. حتى تجهز، تعرض الرئيسية أرصدتك ومهامك.',
    en: 'This is where you will see your hours ledger, your filament, your shipments and the filament you sell back to the workshop. Until it is ready, your home shows your balances and your jobs.',
    ckb: 'لێرە تۆماری کاتژمێرەکانت و فیلامێنتەکەت و ناردنەکانت و ئەو فیلامێنتەی بە کارگەی دەفرۆشیتەوە دەبینیت. تا ئامادە دەبێت، پەڕەی سەرەکی باڵانس و کارەکانت پیشان دەدات.',
  },
} satisfies Record<string, Tri>;

export default function AccountRoutes() {
  const { t } = useCloudText();
  return (
    <div>
      <PageHeader title={t(nav.account)} back={{ to: '/', label: t(nav.home) }} />
      <CloudEmptyState
        icon={<User className="h-6 w-6" />}
        title={t(words.title)}
        body={t(words.body)}
        action={
          <>
            <Link to="/" className="lv-button lv-button-secondary">
              {t(common.backHome)}
            </Link>
            <Link to="/printers" className="lv-button lv-button-ghost">
              {t(nav.printers)}
            </Link>
          </>
        }
      />
    </div>
  );
}
