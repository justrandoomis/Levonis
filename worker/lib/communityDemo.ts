/**
 * COMMUNITY DEMO DATA — «أضف بيانات وهمية للمجتمع للتجربة، وأحذفها كلها بسهولة».
 *
 * The owner tests Levo Community on the live site while it is CLOSED
 * (worker/lib/communityGate.ts). This seeds a coherent set of demo makers,
 * workshops, projects, social activity, print requests and pending offers in
 * ONE batch, and removes every one of them in ONE batch.
 *
 * HOW A DEMO ROW IS KNOWN. By its primary id alone: `demo_` + the shape
 * `newId()` mints (packages/contracts/src/demoData.ts). The ids here are
 * FIXED, not random — the seed is the same set every time, so a second
 * press (or two presses racing) cannot create a second copy: a race ends on
 * the primary keys and the loser reports «already present». Rows without an
 * id of their own (a like, a save, a follow, a workshop's preferences) are
 * demo because the user, post or merchant they name is.
 *
 * WHAT IS NEVER CREATED. No product (nothing enters the catalogue, a feed, a
 * sitemap or a cart), no accepted offer, no order, no escrow, no wallet or
 * ledger row, no chat, no notification, no outbox row, no session. Demo users
 * have no password, no Google subject, no phone and a `.invalid` address, and
 * worker/lib/session.ts refuses to open a session for one anyway.
 *
 * WHO TOUCHES WHAT. Demo users interact only with demo content, so seeding
 * moves no real counter. Real testers may interact with demo content (like a
 * demo project, follow a demo shop, offer on a demo request); the removal
 * deletes those interactions WITH the demo content, and the counters the
 * triggers of 0154 keep move only on the demo rows being deleted. A real
 * request's `offer_count` is recomputed if a demo merchant's offer is ever
 * found on one.
 *
 * WHERE IT MAY NOT REACH. Seeding is refused while the community is open to
 * the public, and opening the gate is refused while demo rows exist
 * (worker/routes/adminCommunity.ts). Outside the wall, a demo store is hidden
 * like a sanctioned one (`storeHiddenFromPublic`), the public API and the
 * share cards leave demo rows out, the matcher never pairs a demo row with a
 * real one, and email to a demo address is never sent.
 */
import { DEMO_EMAIL_DOMAIN, DEMO_ID_PREFIX, isDemoId } from '../../packages/contracts/src/demoData';
import { HttpError } from './http';
import { storeUrl } from './hosts';

/**
 * A store's address as the community hands it out. A community DEMO store has
 * no public storefront (`storeHiddenFromPublic`), so its links stay on the
 * in-site page, which /api/community/store/:id serves by store id too.
 * (worker/lib/hosts.ts stays a byte-identical copy of the edge package's, so
 * the rule lives here, at the community's call sites.)
 */
export function communityStoreUrl(slug: string, rootDomain: string | null, storeId: string): string {
  return isDemoId(storeId) ? `/community/store/${storeId}` : storeUrl(slug, rootDomain, storeId);
}

/**
 * NO MONEY ON A DEMO ROW. A ledger line, a payout or a wallet line naming a
 * demo merchant or account would block «حذف كل البيانات التجريبية» for good
 * (DEMO_REMOVE_BLOCKED) and so keep the community shut; the admin money doors
 * that take an id (merchant payout and adjustment, the wallet adjustment)
 * refuse one first.
 */
export function refuseDemoMoney(id: unknown): void {
  if (isDemoId(id)) {
    throw new HttpError(409, 'هذا حساب تجريبي، لا تُسجَّل له أموال / This is community demo data; no money is recorded for it', 'DEMO_NO_MONEY');
  }
}

/** A column holds a demo id. `substr`, not LIKE: `_` is a LIKE wildcard. */
export const demoIdSql = (col: string) => `substr(${col}, 1, ${DEMO_ID_PREFIX.length}) = '${DEMO_ID_PREFIX}'`;
/** A column holds no demo id (NULL counts as not demo). */
export const notDemoSql = (col: string) => `COALESCE(substr(${col}, 1, ${DEMO_ID_PREFIX.length}), '') <> '${DEMO_ID_PREFIX}'`;

/** A fixed demo id with `newId()`'s shape: `demo_<tag>_` + twenty characters. */
export const demoId = (tag: string, n: number) => `${DEMO_ID_PREFIX}${tag}_${String(n).padStart(20, '0')}`;

// ------------------------------------------------------------------ the set

type Lang = 'ar' | 'en' | 'ku';
interface DemoUser {
  n: number;
  name: string;
  username: string;
  locale: Lang;
  gov: string;
  bio: string;
  maker: boolean;
  printers?: string[];
  materials?: string[];
}

const USERS: DemoUser[] = [
  { n: 1, name: 'نور الهدى', username: 'demo_noor_prints', locale: 'ar', gov: 'baghdad', maker: true, bio: 'أطبع قطعًا عملية للبيت والسيارة من ورشتي في الكرادة. PETG وPLA غالبًا.', printers: ['Bambu Lab P1S', 'Bambu Lab X1 Carbon'], materials: ['PLA', 'PETG'] },
  { n: 2, name: 'Karwan Aziz', username: 'demo_karwan3d', locale: 'ku', gov: 'erbil', maker: true, bio: 'دیزاینەر و چاپکەری سێ ڕەهەندی لە هەولێر. مۆدێلی بیناسازی و دیاری.', printers: ['Prusa MK4'], materials: ['PLA', 'PETG'] },
  { n: 3, name: 'مصطفى الساعدي', username: 'demo_mustafa_basra', locale: 'ar', gov: 'basra', maker: true, bio: 'قطع غيار ومستلزمات صيانة من البصرة. أحب المواد المقاومة للحرارة.', printers: ['Creality K1 Max'], materials: ['ASA', 'PETG', 'PLA'] },
  { n: 4, name: 'Sara Hameed', username: 'demo_sara_makes', locale: 'en', gov: 'baghdad', maker: true, bio: 'Hobby maker in Baghdad. Lamps, desk things and the odd cosplay prop.', printers: ['Bambu Lab A1'], materials: ['PLA'] },
  { n: 5, name: 'هێڤی عومەر', username: 'demo_hevi_designs', locale: 'ku', gov: 'sulaymaniyah', maker: true, bio: 'چاپی ڕێزن و پەیکەری بچووک لە سلێمانی.', printers: ['Elegoo Saturn 3', 'Creality Ender 3 V3'], materials: ['Resin', 'PLA'] },
  { n: 6, name: 'علي النجفي', username: 'demo_ali_najaf', locale: 'ar', gov: 'najaf', maker: true, bio: 'مجسمات تراثية ونماذج تعليمية للمدارس.', printers: ['Anycubic Kobra 2', 'Anycubic Photon Mono X'], materials: ['PLA', 'Resin'] },
  { n: 7, name: 'زينب كريم', username: 'demo_zainab_k', locale: 'ar', gov: 'baghdad', maker: false, bio: '' },
  { n: 8, name: 'Ahmed Jabbar', username: 'demo_ahmed_j', locale: 'en', gov: 'basra', maker: false, bio: '' },
  { n: 9, name: 'ڕێژنە ئەحمەد', username: 'demo_rezhna_a', locale: 'ku', gov: 'erbil', maker: false, bio: '' },
  { n: 10, name: 'حسين علي', username: 'demo_hussein_ali', locale: 'ar', gov: 'karbala', maker: false, bio: '' },
];

interface DemoShop {
  n: number;
  owner: number;
  name: string;
  slug: string;
  tagline: string;
  description: string;
  gov: string;
  areas: string[];
  delivery: string[];
  turnaround: number;
  intro: string;
  printers: Array<{ n: number; name: string; brand: string; model: string; tech: 'fdm' | 'resin'; x: number; y: number; z: number; materials: string[]; enclosed?: boolean }>;
}

const SHOPS: DemoShop[] = [
  {
    n: 1, owner: 1, name: 'ورشة نور للطباعة', slug: 'demo-noor-prints', gov: 'baghdad', areas: ['baghdad', 'babil'], delivery: ['delivery', 'pickup'], turnaround: 4,
    tagline: 'طباعة ثلاثية الأبعاد عملية — بغداد', description: 'ورشة صغيرة في الكرادة. قطع للبيت والسيارة، نماذج تخرج، وطلبات خاصة.',
    intro: 'نطبع PLA وPETG بجودة عالية، والتسليم داخل بغداد خلال يومين من الانتهاء.',
    printers: [
      { n: 1, name: 'P1S', brand: 'Bambu Lab', model: 'P1S', tech: 'fdm', x: 256, y: 256, z: 256, materials: ['pla', 'petg'], enclosed: true },
      { n: 2, name: 'X1 Carbon', brand: 'Bambu Lab', model: 'X1 Carbon', tech: 'fdm', x: 256, y: 256, z: 256, materials: ['pla', 'petg', 'abs'], enclosed: true },
    ],
  },
  {
    n: 2, owner: 2, name: 'کارگەی کاروان', slug: 'demo-karwan-3d', gov: 'erbil', areas: ['erbil', 'duhok'], delivery: ['pickup'], turnaround: 5,
    tagline: 'مۆدێلی بیناسازی و دیاری — هەولێر', description: 'Architectural models, gifts and name keychains, printed in Erbil.',
    intro: 'وەرگرتن لە کارگە لە هەولێر. مۆدێلی گەورە تا ٣٦ سم.',
    printers: [{ n: 3, name: 'MK4', brand: 'Prusa', model: 'MK4', tech: 'fdm', x: 250, y: 210, z: 220, materials: ['pla', 'petg'] }],
  },
  {
    n: 3, owner: 3, name: 'بصرة ميكر', slug: 'demo-basra-maker', gov: 'basra', areas: ['basra', 'maysan', 'dhi_qar'], delivery: ['delivery', 'pickup'], turnaround: 3,
    tagline: 'قطع غيار ومواد تتحمل حر البصرة', description: 'نطبع بـ ASA وPETG للقطع التي تعيش في الشمس والحرارة.',
    intro: 'قطع غيار للمكيفات والأجهزة المنزلية. توصيل داخل البصرة وميسان وذي قار.',
    printers: [{ n: 4, name: 'K1 Max', brand: 'Creality', model: 'K1 Max', tech: 'fdm', x: 300, y: 300, z: 300, materials: ['pla', 'petg', 'asa', 'abs'], enclosed: true }],
  },
];

interface DemoPost {
  n: number;
  author: number;
  kind: 'project' | 'tutorial' | 'timelapse' | 'before_after';
  title: string;
  body: string;
  printer: string;
  material: string;
  color: string;
  minutes: number | null;
  tags: string[];
  dims?: Record<string, number>;
  shop?: number;
}

const POSTS: DemoPost[] = [
  { n: 1, author: 1, shop: 1, kind: 'project', title: 'حامل هاتف للسيارة يتحمل حرارة الصيف', body: 'صممته بعد أن ذاب حامل PLA على الزجاج في تموز. PETG أسود، جدران 4، وحشوة 30٪. يثبت على فتحة المكيف.', printer: 'Bambu Lab P1S', material: 'PETG', color: 'أسود', minutes: 95, tags: ['car', 'petg', 'functional'], dims: { x: 80, y: 60, z: 45 } },
  { n: 2, author: 1, shop: 1, kind: 'tutorial', title: 'كيف تمنع الالتواء (Warping) في صيف بغداد', body: '١) نظّف السطح بالكحول. ٢) أطفئ المروحة في أول طبقتين. ٣) استعمل حافة (brim) 5 ملم للقطع الطويلة. ٤) أغلق الباب إن كانت الطابعة مغلقة.', printer: 'Bambu Lab X1 Carbon', material: 'ABS', color: '', minutes: null, tags: ['tips', 'warping', 'abs'] },
  { n: 3, author: 2, shop: 2, kind: 'project', title: 'مۆدێلی قەڵای هەولێر', body: 'مۆدێلێکی بچووکی قەڵای هەولێر بە PLA ی زێڕینی ئاوریشمی. لە چوار پارچە چاپکراوە و پێکەوە لکێنراوە.', printer: 'Prusa MK4', material: 'PLA Silk', color: 'زێڕین', minutes: 720, tags: ['erbil', 'architecture', 'pla'], dims: { x: 200, y: 200, z: 90 } },
  { n: 4, author: 2, shop: 2, kind: 'timelapse', title: 'Timelapse: a 30 cm vase in vase mode', body: 'Single wall, 0.6 mm nozzle, matte PLA. Seven hours squeezed into thirty seconds.', printer: 'Prusa MK4', material: 'PLA Matte', color: 'Terracotta', minutes: 410, tags: ['vase', 'timelapse', 'pla'], dims: { x: 140, y: 140, z: 300 } },
  { n: 5, author: 3, shop: 3, kind: 'before_after', title: 'قبل وبعد: مقبض باب مكسور منذ سنتين', body: 'قست المقبض القديم بالكاليبر ورسمته من جديد. الجديد من PETG رمادي ويتحمل الشد أكثر من الأصلي.', printer: 'Creality K1 Max', material: 'PETG', color: 'رمادي', minutes: 60, tags: ['repair', 'petg', 'home'] },
  { n: 6, author: 3, shop: 3, kind: 'project', title: 'مروحة بديلة لمكيف سبليت', body: 'المروحة الأصلية غير متوفرة في السوق. طبعتها بـ ASA لأنها تعمل في الشمس، ووازنتها قبل التركيب.', printer: 'Creality K1 Max', material: 'ASA', color: 'أبيض', minutes: 180, tags: ['repair', 'asa', 'ac'], dims: { x: 160, y: 160, z: 40 } },
  { n: 7, author: 4, kind: 'project', title: 'Ramadan fanous with an LED tea light', body: 'Printed the frame in white PLA and the panels in translucent PLA. A battery tea light fits inside.', printer: 'Bambu Lab A1', material: 'PLA', color: 'White + translucent', minutes: 300, tags: ['ramadan', 'lamp', 'pla'], dims: { x: 120, y: 120, z: 220 } },
  { n: 8, author: 4, kind: 'tutorial', title: 'Calibrating flow rate in ten minutes', body: 'Print a single-wall cube, measure the wall with calipers in four places, then flow = old flow × target / measured.', printer: 'Bambu Lab A1', material: 'PLA', color: '', minutes: 15, tags: ['calibration', 'tips'] },
  { n: 9, author: 5, kind: 'project', title: 'جاکلیتی کوردی بە نەخشی تەقلیدی', body: 'نەخشی کڵاوەکی کوردی لەسەر جاکلیت. سێ ڕەنگ بە گۆڕینی فیلامێنت.', printer: 'Creality Ender 3 V3', material: 'PLA', color: 'سوور و سەوز', minutes: 240, tags: ['kurdish', 'keychain', 'pla'] },
  { n: 10, author: 5, kind: 'timelapse', title: 'تایملاپسی چاپکردنی پەیکەرێکی بچووک بە ڕێزن', body: 'پەیکەری ١٢ سم، چینی ٠.٠٥ ملم. شەش کاتژمێر و ۲۰ خولەک.', printer: 'Elegoo Saturn 3', material: 'Resin', color: 'خۆڵەمێشی', minutes: 380, tags: ['resin', 'miniature', 'timelapse'] },
  { n: 11, author: 6, kind: 'project', title: 'مجسم مصغر لبوابة عشتار', body: 'نموذج تعليمي لمدرسة في النجف: البوابة بثلاث قطع، والأسود والثيران مطبوعة بارزة.', printer: 'Anycubic Kobra 2', material: 'PLA', color: 'أزرق', minutes: 900, tags: ['babylon', 'education', 'pla'], dims: { x: 250, y: 80, z: 180 } },
  { n: 12, author: 6, kind: 'before_after', title: 'Before/after: sanding and painting a resin bust', body: 'Straight off the printer, then primer, two coats and a dry brush. The supports left no marks on the face.', printer: 'Anycubic Photon Mono X', material: 'Resin', color: 'Grey → painted', minutes: 260, tags: ['resin', 'painting', 'bust'] },
  { n: 13, author: 1, shop: 1, kind: 'project', title: 'منظم أدوات مكتبي قابل للتركيب', body: 'وحدات صغيرة تتعشق مع بعض. اطبع ما تحتاج فقط. الملفات مناسبة لأي طابعة 220 ملم.', printer: 'Bambu Lab P1S', material: 'PLA', color: 'بيج', minutes: 150, tags: ['desk', 'organizer', 'pla'] },
  { n: 14, author: 2, shop: 2, kind: 'tutorial', title: 'چۆن فیلامێنت وشک بکەینەوە لە زستاندا', body: 'PETG و نایلۆن شێ هەڵدەمژن. ٦٥ پلە بۆ چوار کاتژمێر لە وشککەرەوە، پاشان لە قوتووی داخراو لەگەڵ سیلیکا.', printer: 'Prusa MK4', material: 'PETG', color: '', minutes: null, tags: ['tips', 'filament', 'petg'] },
  { n: 15, author: 3, shop: 3, kind: 'project', title: 'Name keychains for a Basra school graduation', body: 'Sixty keychains, two colours, each with a student name. Printed in two plates overnight.', printer: 'Bambu Lab P1S', material: 'PLA', color: 'Blue + white', minutes: 45, tags: ['keychain', 'graduation', 'basra'] },
];

const COMMENTS: Array<{ n: number; post: number; author: number; body: string; parent?: number }> = [
  { n: 1, post: 1, author: 7, body: 'هل يناسب سيارة كيا سيراتو؟' },
  { n: 2, post: 1, author: 1, body: 'نعم، يثبت على أي فتحة مكيف عرضها بين 8 و14 ملم.', parent: 1 },
  { n: 3, post: 3, author: 9, body: 'زۆر جوانە! چەند ڕۆژی خایاند؟' },
  { n: 4, post: 3, author: 2, body: 'دوو ڕۆژ بە چاپ و پێکەوەنان.', parent: 3 },
  { n: 5, post: 4, author: 4, body: 'That layer consistency is lovely. What speed?' },
  { n: 6, post: 6, author: 8, body: 'I need the same fan for a Gree unit — can you do it?' },
  { n: 7, post: 7, author: 10, body: 'فكرة حلوة لرمضان، أريد اثنين للبيت.' },
  { n: 8, post: 8, author: 5, body: 'سوپاس، ئەمە زۆر یارمەتیدەرە.' },
  { n: 9, post: 11, author: 7, body: 'عمل رائع، الأطفال سيحبونه.' },
  { n: 10, post: 12, author: 3, body: 'The dry brush really brings out the detail.' },
  { n: 11, post: 13, author: 4, body: 'Printed four of these, they snap together perfectly.' },
  { n: 12, post: 15, author: 8, body: 'My nephew got one of these, great quality.' },
];

const REQUESTS: Array<{ n: number; customer: number; title: string; description: string; category: string; quantity: number; material: string; color: string; dimensions: string; budget: number | null; gov: string; delivery: string; days: number }> = [
  { n: 1, customer: 7, title: 'مجسم معماري لمشروع تخرج بمقياس 1:200', description: 'عندي ملف STL لمبنى من ثلاثة طوابق، أحتاجه مطبوعًا بلون أبيض ونظيف للعرض أمام اللجنة.', category: 'architecture', quantity: 1, material: 'PLA', color: 'أبيض', dimensions: '30 × 20 × 12 سم', budget: 150000, gov: 'baghdad', delivery: 'delivery', days: 30 },
  { n: 2, customer: 8, title: 'Replacement gear for a washing machine', description: 'The plastic drive gear of a Daewoo top-loader cracked. I have the broken part and can send photos with measurements.', category: 'spare_parts', quantity: 2, material: 'PETG', color: 'Any', dimensions: '6 cm diameter', budget: 25000, gov: 'basra', delivery: 'pickup', days: 21 },
  { n: 3, customer: 9, title: '١٠٠ کلیلەی ناو بۆ ئاهەنگی هاوسەرگیری', description: 'سەد جاکلیت بە ناوی بووک و زاوا و بەروار. دوو ڕەنگ: سپی و زێڕین.', category: 'gifts', quantity: 100, material: 'PLA', color: 'سپی و زێڕین', dimensions: '5 سم', budget: 200000, gov: 'erbil', delivery: 'pickup', days: 25 },
  { n: 4, customer: 10, title: 'أحرف بارزة للافتة محل', description: 'اسم المحل بالعربي بأحرف بارزة طولها 60 سم تقريبًا، تثبت على لوح خشبي. يفضل لون ذهبي.', category: 'signage', quantity: 1, material: 'PLA', color: 'ذهبي', dimensions: '60 × 15 سم', budget: 100000, gov: 'karbala', delivery: 'delivery', days: 28 },
  { n: 5, customer: 7, title: 'غطاء لعدسة كاميرا قديمة', description: 'كاميرا Zenit قديمة فقدت غطاء العدسة. القطر الداخلي 52 ملم. أريده بدقة عالية.', category: 'spare_parts', quantity: 1, material: 'Resin', color: 'أسود', dimensions: '52 ملم', budget: null, gov: 'baghdad', delivery: 'delivery', days: 20 },
  { n: 6, customer: 8, title: 'Drone frame arms in carbon-fibre nylon', description: 'Four arms for a 5-inch FPV frame. I can share the STEP file. Needs to survive crashes.', category: 'functional', quantity: 4, material: 'PA-CF', color: 'Black', dimensions: '15 cm each', budget: 60000, gov: 'basra', delivery: 'delivery', days: 30 },
];

const OFFERS: Array<{ n: number; request: number; shop: number; price: number; fee: number; method: 'delivery' | 'pickup'; days: number; message: string }> = [
  { n: 1, request: 1, shop: 1, price: 135000, fee: 5000, method: 'delivery', days: 6, message: 'نطبعه بطبقة 0.12 ملم ونصنفره قبل التسليم. التوصيل داخل بغداد.' },
  { n: 2, request: 1, shop: 3, price: 120000, fee: 10000, method: 'delivery', days: 8, message: 'أستطيع إرساله إلى بغداد مع شركة التوصيل خلال يومين من الانتهاء.' },
  { n: 3, request: 2, shop: 3, price: 18000, fee: 0, method: 'pickup', days: 2, message: 'PETG أسود، نسختان. الاستلام من الورشة في العشار.' },
  { n: 4, request: 3, shop: 2, price: 175000, fee: 0, method: 'pickup', days: 5, message: 'وەرگرتن لە کارگە لە هەولێر. نموونەیەک پێش چاپی هەمووی دەنێرم.' },
  { n: 5, request: 3, shop: 1, price: 190000, fee: 7000, method: 'delivery', days: 7, message: 'نرسل إلى أربيل عبر شركة التوصيل، والطباعة بلونين.' },
  { n: 6, request: 4, shop: 1, price: 95000, fee: 5000, method: 'delivery', days: 5, message: 'الأحرف بـ PLA ذهبي حريري مع ثقوب للتثبيت.' },
];

// who follows whom, who likes and saves what — demo users only, demo content only
const USER_FOLLOWS: Array<[number, number]> = [
  [7, 1], [7, 4], [8, 3], [8, 4], [9, 2], [9, 5], [10, 6], [10, 1],
  [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 1],
];
const STORE_FOLLOWS: Array<[number, number]> = [[7, 1], [8, 3], [9, 2], [10, 1], [4, 1]];

const likesFor = (post: DemoPost) => USERS.filter((u) => u.n !== post.author && (post.n + u.n) % 3 === 0).map((u) => u.n);
const savesFor = (post: DemoPost) => USERS.filter((u) => u.n !== post.author && (post.n + u.n) % 5 === 0).map((u) => u.n);

const uid = (n: number) => demoId('usr', n);
const mid = (n: number) => demoId('mch', n);
const sid = (n: number) => demoId('str', n);

/** The tables the seed writes, in the order the status reports them. */
export const DEMO_TABLES = [
  'users',
  'community_merchants',
  'merchant_stores',
  'merchant_printers',
  'merchant_request_prefs',
  'community_posts',
  'community_comments',
  'community_likes',
  'community_saves',
  'user_follows',
  'follows',
  'community_requests',
  'community_offers',
] as const;
export type DemoTable = (typeof DEMO_TABLES)[number];
export type DemoCounts = Record<DemoTable, number>;

/** How many rows of each table one seed writes. */
export function expectedDemoCounts(): DemoCounts {
  return {
    users: USERS.length,
    community_merchants: SHOPS.length,
    merchant_stores: SHOPS.length,
    merchant_printers: SHOPS.reduce((n, s) => n + s.printers.length, 0),
    merchant_request_prefs: SHOPS.length,
    community_posts: POSTS.length,
    community_comments: COMMENTS.length,
    community_likes: POSTS.reduce((n, p) => n + likesFor(p).length, 0),
    community_saves: POSTS.reduce((n, p) => n + savesFor(p).length, 0),
    user_follows: USER_FOLLOWS.length,
    follows: STORE_FOLLOWS.length,
    community_requests: REQUESTS.length,
    community_offers: OFFERS.length,
  };
}

/** The demo rows each table holds now. One statement, one sub-count per table. */
export async function demoCounts(db: D1Database): Promise<DemoCounts> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE ${demoIdSql('id')}) AS users,
        (SELECT COUNT(*) FROM community_merchants WHERE ${demoIdSql('id')}) AS community_merchants,
        (SELECT COUNT(*) FROM merchant_stores WHERE ${demoIdSql('id')}) AS merchant_stores,
        (SELECT COUNT(*) FROM merchant_printers WHERE ${demoIdSql('id')}) AS merchant_printers,
        (SELECT COUNT(*) FROM merchant_request_prefs WHERE ${demoIdSql('merchant_id')}) AS merchant_request_prefs,
        (SELECT COUNT(*) FROM community_posts WHERE ${demoIdSql('id')}) AS community_posts,
        (SELECT COUNT(*) FROM community_comments WHERE ${demoIdSql('id')}) AS community_comments,
        (SELECT COUNT(*) FROM community_likes WHERE ${demoIdSql('user_id')} OR ${demoIdSql('post_id')}) AS community_likes,
        (SELECT COUNT(*) FROM community_saves WHERE ${demoIdSql('user_id')} OR ${demoIdSql('post_id')}) AS community_saves,
        (SELECT COUNT(*) FROM user_follows WHERE ${demoIdSql('follower_id')} OR ${demoIdSql('user_id')}) AS user_follows,
        (SELECT COUNT(*) FROM follows WHERE ${demoIdSql('user_id')} OR ${demoIdSql('merchant_id')}) AS follows,
        (SELECT COUNT(*) FROM community_requests WHERE ${demoIdSql('id')}) AS community_requests,
        (SELECT COUNT(*) FROM community_offers WHERE ${demoIdSql('id')}) AS community_offers`
    )
    .first<Record<string, number>>();
  const out = {} as DemoCounts;
  for (const t of DEMO_TABLES) out[t] = Number(row?.[t] ?? 0);
  return out;
}

export const demoTotal = (c: DemoCounts) => DEMO_TABLES.reduce((n, t) => n + c[t], 0);

/** Is any demo row present — an account, a shop, a post, a request or an offer? */
export const DEMO_PRESENT_SQL = `(EXISTS (SELECT 1 FROM users WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM community_merchants WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM merchant_stores WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM community_posts WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM community_requests WHERE ${demoIdSql('id')})
    OR EXISTS (SELECT 1 FROM community_offers WHERE ${demoIdSql('id')}))`;

export async function demoPresent(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT ${DEMO_PRESENT_SQL} AS x`).first<{ x: number }>();
  return Number(row?.x ?? 0) === 1;
}

/** The chats a demo shop, store or account is in. */
export const demoChatsSql = () =>
  `SELECT id FROM chats WHERE ${demoIdSql('merchant_id')} OR ${demoIdSql('store_id')}
   UNION SELECT chat_id FROM chat_participants WHERE ${demoIdSql('user_id')}`;

/**
 * The gate is open to the public, as SQL: `{"open": true}` in the one row.
 * Read the strict way the server reads it, but leaning closed-for-demo: any
 * truthy `open` counts as open here, so the seed refuses rather than writes.
 */
export const GATE_OPEN_SQL = `EXISTS (SELECT 1 FROM admin_settings WHERE key = 'communityGate'
    AND json_valid(value) AND json_extract(value, '$.open') = 1)`;

/**
 * The seed's first statement: a guard that fails the whole batch (users.email
 * is NOT NULL) when the gate is open at the moment the batch runs, so a seed
 * racing an «open» writes nothing.
 */
export const DEMO_SEED_GUARD_SQL = `INSERT INTO users (id, email, name) SELECT 'demo_gate_guard', NULL, '' WHERE ${GATE_OPEN_SQL}`;

// ------------------------------------------------------------------ seeding

/**
 * Every INSERT of the set, in dependency order, for ONE `db.batch` (one
 * transaction: all of it or none). The like/save/comment/follow triggers of
 * 0154 keep the counters as the rows land. `now` is the seed's instant;
 * publication dates and expiries are spread around it.
 */
export function demoSeedStatements(db: D1Database, nowMs: number = Date.now()): D1PreparedStatement[] {
  const at = (hoursAgo: number) => new Date(nowMs - hoursAgo * 3_600_000).toISOString();
  const ahead = (days: number) => new Date(nowMs + days * 86_400_000).toISOString();
  const now = at(0);
  const out: D1PreparedStatement[] = [db.prepare(DEMO_SEED_GUARD_SQL)];

  for (const u of USERS) {
    const profile = u.maker ? { printers: u.printers ?? [], materials: u.materials ?? [] } : {};
    out.push(
      db
        .prepare(
          `INSERT INTO users (id, email, username, name, password_hash, google_sub, role, locale, bio, profile_json,
                              country, onboarding_state, notify_whatsapp, creator_public, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, 'customer', ?, ?, ?, 'IQ', 'done', 0, ?, ?, ?)`
        )
        .bind(uid(u.n), `demo+${u.n}@${DEMO_EMAIL_DOMAIN}`, u.username, u.name, u.locale, u.bio, JSON.stringify(profile), u.maker ? 1 : 0, at(24 * 40 + u.n), now)
    );
  }

  for (const s of SHOPS) {
    const owner = USERS.find((u) => u.n === s.owner)!;
    out.push(
      db
        .prepare(
          `INSERT INTO community_merchants (id, user_id, name, bio, governorate, status, badge, approved_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', 'new', ?, ?)`
        )
        .bind(mid(s.n), uid(s.owner), s.name, owner.bio, s.gov, at(24 * 30), at(24 * 35))
    );
    out.push(
      db
        .prepare(
          `INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name, tagline, description, governorate,
                                        categories, service_areas, accepts_custom_requests, sells_direct_products, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["3d_printing"]', ?, 1, 0, 'active', ?, ?)`
        )
        .bind(sid(s.n), mid(s.n), uid(s.owner), s.slug, s.name, s.tagline, s.description, s.gov, JSON.stringify(s.areas), at(24 * 35), now)
    );
    for (const p of s.printers) {
      out.push(
        db
          .prepare(
            `INSERT INTO merchant_printers (id, merchant_id, store_id, name, technology, brand, model, build_x_mm, build_y_mm, build_z_mm,
                                             materials, enclosed, availability, active, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 1, ?)`
          )
          .bind(demoId('prn', p.n), mid(s.n), sid(s.n), p.name, p.tech, p.brand, p.model, p.x, p.y, p.z, JSON.stringify(p.materials), p.enclosed ? 1 : 0, p.n)
      );
    }
    const techs = [...new Set(s.printers.map((p) => p.tech))];
    const big = s.printers.reduce((m, p) => (p.x * p.y * p.z > m.x * m.y * m.z ? { x: p.x, y: p.y, z: p.z } : m), { x: 0, y: 0, z: 0 });
    out.push(
      db
        .prepare(
          `INSERT INTO merchant_request_prefs (merchant_id, processes, governorates, delivery, turnaround_days, technologies, max_build_mm, workshop_intro)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(mid(s.n), JSON.stringify(techs), JSON.stringify(s.areas), JSON.stringify(s.delivery), s.turnaround, JSON.stringify(techs), JSON.stringify(big), s.intro)
    );
  }

  for (const p of POSTS) {
    const published = at(p.n * 7);
    out.push(
      db
        .prepare(
          `INSERT INTO community_posts (id, author_id, kind, title, body, state, visibility, printer_name, material, color,
                                        print_time_minutes, dimensions, tags, store_id, published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'published', 'public', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          demoId('prj', p.n), uid(p.author), p.kind, p.title, p.body, p.printer, p.material, p.color, p.minutes,
          JSON.stringify(p.dims ?? {}), JSON.stringify(p.tags), p.shop ? sid(p.shop) : null, published, published, published
        )
    );
  }

  for (const c of COMMENTS) {
    const post = POSTS.find((p) => p.n === c.post)!;
    out.push(
      db
        .prepare(
          `INSERT INTO community_comments (id, post_id, author_id, parent_id, body, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'visible', ?, ?)`
        )
        .bind(demoId('cmt', c.n), demoId('prj', c.post), uid(c.author), c.parent ? demoId('cmt', c.parent) : null, c.body, at(post.n * 7 - 1 - c.n / 10), at(post.n * 7 - 1 - c.n / 10))
    );
  }
  for (const p of POSTS) {
    for (const u of likesFor(p)) {
      out.push(db.prepare('INSERT INTO community_likes (user_id, post_id, created_at) VALUES (?, ?, ?)').bind(uid(u), demoId('prj', p.n), at(p.n * 7 - 2)));
    }
    for (const u of savesFor(p)) {
      out.push(db.prepare("INSERT INTO community_saves (user_id, post_id, collection, created_at) VALUES (?, ?, '', ?)").bind(uid(u), demoId('prj', p.n), at(p.n * 7 - 3)));
    }
  }
  for (const [a, b] of USER_FOLLOWS) {
    out.push(db.prepare('INSERT INTO user_follows (follower_id, user_id, created_at) VALUES (?, ?, ?)').bind(uid(a), uid(b), at(24 * 10)));
  }
  for (const [u, s] of STORE_FOLLOWS) {
    out.push(db.prepare('INSERT INTO follows (user_id, merchant_id, created_at) VALUES (?, ?, ?)').bind(uid(u), mid(s), at(24 * 9)));
  }

  for (const r of REQUESTS) {
    const created = at(r.n * 11);
    const hasOffers = OFFERS.some((o) => o.request === r.n);
    out.push(
      db
        .prepare(
          `INSERT INTO community_requests (id, customer_id, title, description, status, state, category, quantity, material, color,
                                           dimensions, budget_iqd, governorate, delivery_pref, visibility, offer_count, expires_at,
                                           published_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', 0, ?, ?, ?, ?)`
        )
        .bind(
          demoId('req', r.n), uid(r.customer), r.title, r.description, hasOffers ? 'receiving_offers' : 'open', r.category, r.quantity,
          r.material, r.color, r.dimensions, r.budget, r.gov, r.delivery, ahead(r.days), created, created, created
        )
    );
  }
  for (const o of OFFERS) {
    const created = at(o.request * 11 - 3 - o.n);
    out.push(
      db
        .prepare(
          `INSERT INTO community_offers (id, request_id, merchant_id, store_id, price_iqd, completion_days, delivery_method, message,
                                         state, expires_at, delivery_fee_iqd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
        )
        .bind(demoId('off', o.n), demoId('req', o.request), mid(o.shop), sid(o.shop), o.price, o.days, o.method, o.message, ahead(14), o.fee, created, created)
    );
  }
  // The board's advertised count, the same COUNT offerCountStatement writes.
  for (const r of REQUESTS) {
    out.push(
      db
        .prepare(
          `UPDATE community_requests SET offer_count = (SELECT COUNT(*) FROM community_offers o
                                                         WHERE o.request_id = ?1 AND o.state IN ('pending','accepted'))
            WHERE id = ?1`
        )
        .bind(demoId('req', r.n))
    );
  }
  return out;
}

// ------------------------------------------------------------------ removal

/**
 * Rows OUTSIDE the demo set that name a demo row and are money or trade: an
 * order, an escrow, a complaint, a ledger line, a payout, a wallet line. The
 * seed creates none and a demo account cannot sign in to create one, so this
 * is expected to be all zeros; if it is not, the removal stops and says what
 * it found rather than deleting a trade record.
 */
export async function demoRemovalBlockers(db: D1Database): Promise<Record<string, number>> {
  const d = demoIdSql;
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM community_orders WHERE ${d('id')} OR ${d('merchant_id')} OR ${d('store_id')} OR ${d('customer_id')} OR ${d('request_id')} OR ${d('offer_id')}) AS community_orders,
        (SELECT COUNT(*) FROM community_escrows WHERE ${d('merchant_id')} OR ${d('customer_id')}) AS community_escrows,
        (SELECT COUNT(*) FROM community_complaints WHERE ${d('merchant_id')} OR ${d('store_id')} OR ${d('offer_id')} OR ${d('reporter_id')} OR ${d('reported_user_id')}) AS community_complaints,
        (SELECT COUNT(*) FROM merchant_ledger_entries WHERE ${d('merchant_id')} OR ${d('store_id')}) AS merchant_ledger_entries,
        (SELECT COUNT(*) FROM merchant_payouts WHERE ${d('merchant_id')}) AS merchant_payouts,
        (SELECT COUNT(*) FROM orders WHERE ${d('user_id')} OR ${d('merchant_id')} OR ${d('store_id')} OR origin_chat_id IN (${demoChatsSql()})) AS orders,
        (SELECT COUNT(*) FROM community_orders WHERE chat_id IN (${demoChatsSql()})) AS community_orders_in_demo_chats,
        (SELECT COUNT(*) FROM wallet_transactions WHERE ${d('user_id')}) AS wallet_transactions`
    )
    .first<Record<string, number>>();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row ?? {})) if (Number(v) > 0) out[k] = Number(v);
  return out;
}

/**
 * The deletes, in dependency order, each labelled with what its count
 * reports. The interactions of REAL accounts with demo content are deleted
 * with it (a like on a demo project, a follow of a demo shop, an offer on a
 * demo request, a report of a demo post, a chat opened with a demo shop and
 * a direct request addressed to one); each is its own labelled line so the
 * owner sees exactly what went. The triggers of 0154 fire on every like,
 * save, comment and follow deleted, so the counters they keep stay exact.
 */
export function demoRemovalStatements(db: D1Database, realRequestsToRecount: string[]): Array<{ label: string; stmt: D1PreparedStatement }> {
  const d = demoIdSql;
  const del = (label: string, sql: string) => ({ label, stmt: db.prepare(sql) });
  const demoChats = demoChatsSql();
  const steps = [
    // A demo account's bell (user_notifications, the notifications service's
    // table) goes with the account: its user_id foreign key cascades.
    del('community_likes', `DELETE FROM community_likes WHERE ${d('user_id')} OR ${d('post_id')}`),
    del('community_saves', `DELETE FROM community_saves WHERE ${d('user_id')} OR ${d('post_id')}`),
    // Leaves first, so a reply is counted rather than swept away uncounted by
    // its parent's cascade: three passes cover a thread three replies deep,
    // the last pass takes whatever is left (and its cascade anything deeper).
    ...[1, 2, 3].map(() =>
      del(
        'community_comments',
        `DELETE FROM community_comments WHERE (${d('id')} OR ${d('author_id')} OR ${d('post_id')})
            AND NOT EXISTS (SELECT 1 FROM community_comments ch WHERE ch.parent_id = community_comments.id)`
      )
    ),
    del('community_comments', `DELETE FROM community_comments WHERE ${d('id')} OR ${d('author_id')} OR ${d('post_id')}`),
    del('community_report_targets', `DELETE FROM community_report_targets WHERE ${d('target_id')}`),
    del('community_reports', `DELETE FROM community_reports WHERE ${d('reporter_id')} OR ${d('target_id')}`),
    del('community_post_media', `DELETE FROM community_post_media WHERE ${d('post_id')}`),
    del('community_post_files', `DELETE FROM community_post_files WHERE ${d('post_id')}`),
    del('community_posts', `DELETE FROM community_posts WHERE ${d('id')} OR ${d('author_id')}`),
    del('user_follows', `DELETE FROM user_follows WHERE ${d('follower_id')} OR ${d('user_id')}`),
    del('user_blocks', `DELETE FROM user_blocks WHERE ${d('user_id')} OR ${d('blocked_id')}`),
    del('user_mutes', `DELETE FROM user_mutes WHERE ${d('user_id')} OR ${d('muted_id')}`),
    del('follows', `DELETE FROM follows WHERE ${d('user_id')} OR ${d('merchant_id')}`),
    del('community_offer_drafts', `DELETE FROM community_offer_drafts WHERE ${d('request_id')} OR ${d('merchant_id')}`),
    del('community_offers', `DELETE FROM community_offers WHERE ${d('id')} OR ${d('request_id')} OR ${d('merchant_id')}`),
    del('community_request_matches', `DELETE FROM community_request_matches WHERE ${d('request_id')} OR ${d('merchant_id')}`),
    del(
      'community_requests_to_demo_shops',
      `DELETE FROM community_requests WHERE NOT (${d('id')}) AND (${d('target_merchant_id')} OR origin_chat_id IN (${demoChats}))`
    ),
    // Every conversation a demo shop or a demo account is in — a store thread,
    // or a direct message a real tester opened with a demo maker — goes whole:
    // its messages, its members, the chat.
    // Messages first (counted), then the chats — while their members are still
    // there to name them; the members go with each chat (ON DELETE CASCADE).
    del('chat_messages', `DELETE FROM chat_messages WHERE chat_id IN (${demoChats})`),
    del('chats', `DELETE FROM chats WHERE id IN (${demoChats})`),
    del('community_requests', `DELETE FROM community_requests WHERE ${d('id')} OR ${d('customer_id')}`),
    del('merchant_printers', `DELETE FROM merchant_printers WHERE ${d('id')} OR ${d('merchant_id')}`),
    del('merchant_request_prefs', `DELETE FROM merchant_request_prefs WHERE ${d('merchant_id')}`),
    del('merchant_stores', `DELETE FROM merchant_stores WHERE ${d('id')} OR ${d('merchant_id')}`),
    del('community_merchants', `DELETE FROM community_merchants WHERE ${d('id')} OR ${d('user_id')}`),
    del('sessions', `DELETE FROM sessions WHERE ${d('user_id')}`),
    del('users', `DELETE FROM users WHERE ${d('id')}`),
  ];
  // A real request a demo workshop offered on (the seed never does it): its
  // advertised count is recomputed once the demo offer is gone.
  for (const id of realRequestsToRecount) {
    steps.push({
      label: 'recount',
      stmt: db
        .prepare(
          `UPDATE community_requests SET offer_count = (SELECT COUNT(*) FROM community_offers o
                                                         WHERE o.request_id = ?1 AND o.state IN ('pending','accepted'))
            WHERE id = ?1`
        )
        .bind(id),
    });
  }
  return steps;
}

/** Real requests a demo merchant's offer sits on — read before the removal deletes the offer. */
export async function realRequestsWithDemoOffers(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT request_id FROM community_offers WHERE ${demoIdSql('merchant_id')} AND ${notDemoSql('request_id')} LIMIT 90`)
    .all<{ request_id: string }>();
  return (results ?? []).map((r) => String(r.request_id));
}
