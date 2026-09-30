/**
 * MEDIA EVERYWHERE ON THE STORE PAGE, IN A BROWSER (P5, storefront L3/L4/L6/
 * L7/L8) — the real renderer (src/components/storefront/StoreRenderer.tsx)
 * with a fixed store and layout, no Worker behind it, so the hero video, the
 * page background, the notice, the footer links and scheduled blocks can be
 * seen, pressed and photographed by scripts/e2e-storefront-media.mjs:
 *
 *   /tests/browser/storefront-media.html
 *     ?lang=ar|en|ckb
 *     &mode=live|preview      the live page (videos may mount) or the builder's preview (never)
 *     &bg=none|image|video    the page background (video: poster + clip)
 *     &phones=1               the background video plays on phones too
 *     &hero=profile|cover|split   the hero variant (it carries a video + its poster)
 *     &onphone=1              the hero's video is offered on phones too
 *     &header=overlay|bar     the header variant (the notice sits under the bar, or after the hero)
 *     &dim=light|medium|heavy
 *     &theme=light            the app's «cream» theme (the store stays a dark island)
 *
 * Media keys are the owner's own (`merchants/owner/public/…`); the e2e script
 * answers `/files/*` with a picture or a small WebM.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import StoreRenderer from '../../src/components/storefront/StoreRenderer';
import { StorefrontRuntimeProvider } from '../../src/components/storefront/runtime';
import { previewRuntime } from '../../src/components/storefront/preview';
import type { StorefrontStore } from '../../src/components/storefront/types';
import '../../src/components/storefront/styles';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const mode = params.get('mode') === 'preview' ? 'preview' : 'live';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');

const K = (name: string) => `merchants/owner/public/${name}`;
const PIC = (n: number) => `/files/${K(`prod000${n}.webp`)}`;
const T = (ar: string, en: string, ckb: string) => ({ ar, en, ckb });
const day = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const STORE = {
  id: 'st_media',
  slug: 'raf3d',
  url: 'https://raf3d.levonis-iq.com',
  name: 'مطبعة الرافدين',
  tagline: 'ورشة طباعة ثلاثية الأبعاد في بغداد',
  description: 'نطبع قطع الغيار والمجسمات بدقة عالية، ونوصل لكل العراق.',
  logoUrl: null,
  bannerUrl: null,
  accent: 'gold',
  categories: [],
  governorate: 'baghdad',
  service_areas: [],
  contact_phone: null,
  business_hours: [],
  policies: {},
  social_links: {},
  profile_links: [],
  profile_facts: [],
  profile_facts_configured: false,
  delivery_settings: {},
  accepts_custom_requests: true,
  sells_direct_products: true,
  open: true,
  status: 'active',
  merchant: { id: 'm1', name: 'Rafidain 3D', verified: true, pro_badge: false, premium_badge: false, badge: 'trusted', rating: 4.7, rating_count: 31, completed_orders: 41 },
  created_at: '2024-03-01T00:00:00.000Z',
  product_count: 12,
  followers: 87,
  positive_pct: 96,
  blocks_data: {
    picked: [1, 2, 3].map((n) => ({
      id: `p${n}`,
      slug: `raf3d-p${n}`,
      name: ['Dragon figure', 'Name lamp', 'Phone stand'][n - 1],
      name_ar: ['مجسم تنين مفصلي', 'مصباح بالاسم', 'حامل هاتف قابل للطي'][n - 1],
      images: [PIC(n)],
      price_iqd: [18000, 30000, 7000][n - 1],
      original_price_iqd: n === 1 ? 25000 : null,
      in_stock: true,
    })),
  },
} as unknown as StorefrontStore;

const bg = params.get('bg') ?? 'video';
const background =
  bg === 'none'
    ? { kind: 'none', media: '', poster: '', dim: 'medium', phones: false }
    : bg === 'image'
      ? { kind: 'image', media: K('bgpic001.webp'), poster: '', dim: params.get('dim') ?? 'medium', phones: false }
      : { kind: 'video', media: K('bgclip01.webm'), poster: K('bgpost01.webp'), dim: params.get('dim') ?? 'medium', phones: params.get('phones') === '1' };

const LAYOUT = {
  schema_version: 1,
  theme: 'classic',
  header: {
    variant: params.get('header') === 'bar' ? 'bar' : 'overlay',
    notice: T('توصيل مجاني لكل بغداد هذا الأسبوع', 'Free delivery across Baghdad this week', 'گەیاندنی بێ بەرامبەر بۆ هەموو بەغدا ئەم هەفتەیە'),
    notice_link: { kind: 'route', route: 'products' },
    notice_from: iso(-day),
    notice_until: iso(6 * day),
  },
  footer: {
    variant: 'standard',
    links: [
      { label: T('الأسئلة الشائعة', 'FAQ', 'پرسیارە باوەکان'), link: { kind: 'route', route: 'about' } },
      { label: T('ساعات العمل: ٩ص–٩م', 'Hours: 9am–9pm', 'کاتژمێرەکانی کار: ٩–٩'), link: { kind: 'none' } },
      { label: T('إنستغرام', 'Instagram', 'ئینستاگرام'), link: { kind: 'external', url: 'https://instagram.com/raf3d' } },
    ],
  },
  background,
  blocks: [
    {
      id: 'hero',
      type: 'hero',
      variant: params.get('hero') ?? 'profile',
      settings: { image: K('herocov1.webp'), video: K('heroclip.webm'), video_on_phone: params.get('onphone') === '1' },
    },
    { id: 'featured', type: 'featured_products', variant: 'grid', settings: { title: T('اختياراتنا', 'Our picks', 'هەڵبژاردەکانمان'), product_ids: ['p1', 'p2', 'p3'] } },
    {
      id: 'text',
      type: 'text',
      settings: { title: T('عن الورشة', 'About the workshop', 'دەربارەی وەرشەکە'), body: T('نطبع كل قطعة بعناية، ونرسل صورة قبل التسليم.', 'We print every part with care and send a photo before delivery.', 'هەموو پارچەیەک بە وردی چاپ دەکەین و پێش گەیاندن وێنەیەک دەنێرین.') },
    },
    {
      id: 'past-sale',
      type: 'cta',
      schedule: { from: iso(-10 * day), until: iso(-3 * day) },
      settings: { title: T('تخفيضات انتهت', 'A sale that ended', 'داشکاندنێک کە تەواو بوو'), label: T('تسوّق', 'Shop', 'بیکڕە'), link: { kind: 'route', route: 'deals' } },
    },
    {
      id: 'live-sale',
      type: 'cta',
      schedule: { from: iso(-day), until: iso(2 * day) },
      settings: { title: T('خصم الأسبوع على الريزن', 'This week: resin prints off', 'داشکاندنی ئەم هەفتەیە بۆ ڕەزین'), label: T('اطلب الآن', 'Order now', 'ئێستا داوا بکە'), link: { kind: 'route', route: 'products' } },
    },
    {
      id: 'gallery',
      type: 'gallery',
      variant: 'grid',
      settings: { title: T('من أعمالنا', 'Our work', 'لە کارەکانمان'), images: [4, 5, 6].map((n) => ({ image: K(`prod000${n}.webp`), caption: T('', '', '') })) },
    },
  ],
};

const runtime = previewRuntime({ mode, routeHref: (r) => `#${r}`, productHref: (s) => `#p/${s}` });

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <MemoryRouter>
      <main data-scene="storefront-media" data-mode={mode}>
        <StorefrontRuntimeProvider value={runtime}>
          <StoreRenderer store={STORE} layout={LAYOUT} className="min-h-screen pb-24" />
        </StorefrontRuntimeProvider>
      </main>
    </MemoryRouter>
  </LanguageProvider>
);
