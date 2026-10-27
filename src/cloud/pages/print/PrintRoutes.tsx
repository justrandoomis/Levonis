/**
 * PRINT — uploading a model, building a project, starting and following a
 * print: every address under /print, /files, /projects and /jobs
 * (src/cloud/routes.ts). The shell mounts this module behind
 * `<RequireSignIn>`, so whoever reaches it is signed in.
 *
 * A PLACEHOLDER. The section's builder replaces this whole file, keeping
 * the default export: a component that takes no props and renders its own
 * `<Routes>` with FULL paths (`/jobs/:id`, not `:id`). Until then every
 * address of the section says plainly that its screens are not built yet,
 * and points at what already works — never a mock-up with numbers in it.
 */
import { Link } from 'react-router-dom';
import { common, nav } from '../../strings/common';
import { useCloudText } from '../../text';
import type { Tri } from '../../types';
import { CloudEmptyState, PageHeader, Upload } from '../../ui';

const words = {
  title: { ar: 'شاشات الطباعة قيد الإنشاء', en: 'The print screens are being built', ckb: 'پەڕەکانی چاپ هێشتا دروست دەکرێن' },
  body: {
    ar: 'هنا سترفع نماذجك وتتابع مهام طباعتك. حتى تجهز، يمكنك تصفّح الطابعات أو قراءة كيف تعمل الخدمة.',
    en: 'This is where you will upload your models and follow your print jobs. Until it is ready, you can browse the printers or read how the service works.',
    ckb: 'لێرە مۆدێلەکانت بار دەکەیت و بەدواداچوون بۆ کارەکانی چاپت دەکەیت. تا ئامادە دەبێت، دەتوانیت سەیری چاپکەرەکان بکەیت یان بخوێنیتەوە خزمەتگوزارییەکە چۆن کار دەکات.',
  },
} satisfies Record<string, Tri>;

export default function PrintRoutes() {
  const { t } = useCloudText();
  return (
    <div>
      <PageHeader title={t(nav.print)} back={{ to: '/', label: t(nav.home) }} />
      <CloudEmptyState
        icon={<Upload className="h-6 w-6" />}
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
