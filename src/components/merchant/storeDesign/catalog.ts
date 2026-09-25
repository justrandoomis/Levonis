/**
 * THE BUILDER'S WORDS FOR THE SCHEMA — what each block, variant, setting,
 * enum value and token is called, and how the block picker groups them.
 *
 * Presentation metadata only. What a block IS (its variants, settings, types
 * and bounds) lives in packages/storeLayout/src/blocks.ts, and the inspector
 * builds its forms from that registry; this file only names what the registry
 * declares. A setting or value with no entry here is still editable — it is
 * shown under its schema name — so a block added to the registry is never
 * uneditable because nobody wrote its label yet.
 *
 * OWNER: Sorani to be written by hand — every string here is Arabic and
 * English only; `loc` falls back to Arabic for ckb (docs/DECISIONS.md row 11).
 */
import type { BlockType } from '../../../../packages/storeLayout/src/blocks';
import type { LinkRoute, SocialProviderName } from '../../../../packages/storeLayout/src/refs';
import type { ThemeName, ThemeTokens } from '../../../../packages/storeLayout/src/tokens';
import type { FooterVariant, HeaderVariant } from '../../../../packages/storeLayout/src/schema';

export type Pair = readonly [ar: string, en: string];
export type Loc = (ar: string, en: string, ckb?: string) => string;

export const say = (loc: Loc, p: Pair | undefined, fallback = ''): string => (p ? loc(p[0], p[1]) : fallback);

// ------------------------------------------------------------ categories

export type BlockCategory = 'identity' | 'products' | 'promotion' | 'content' | 'workshop';

export const CATEGORIES: ReadonlyArray<{ id: BlockCategory; label: Pair; types: readonly BlockType[] }> = [
  { id: 'identity', label: ['هوية المتجر', 'Store identity'], types: ['hero', 'about', 'stats', 'info_cards', 'social_links', 'contact'] },
  { id: 'products', label: ['المنتجات', 'Products'], types: ['products_grid', 'products_carousel', 'featured_products', 'collections', 'deals', 'tabs'] },
  { id: 'promotion', label: ['العروض والدعوات', 'Offers and calls'], types: ['banner', 'cta', 'coupon_banner', 'countdown', 'custom_request_cta'] },
  { id: 'content', label: ['محتوى', 'Content'], types: ['text', 'image_text', 'faq', 'gallery', 'video'] },
  { id: 'workshop', label: ['الورشة والثقة', 'Workshop and trust'], types: ['services', 'showcase', 'printers', 'reviews', 'delivery_info'] },
];

// ---------------------------------------------------------------- blocks

export const BLOCK_COPY: Record<BlockType, { name: Pair; line: Pair }> = {
  hero: { name: ['واجهة المتجر', 'Store header'], line: ['الاسم والشعار والغلاف في أعلى الصفحة', 'Name, logo and cover at the top'] },
  banner: { name: ['لافتة', 'Banner'], line: ['صورة عريضة بعنوان ورابط', 'A wide picture with a title and a link'] },
  image_text: { name: ['صورة ونص', 'Image and text'], line: ['صورة بجانبها فقرة', 'A picture beside a paragraph'] },
  products_grid: { name: ['شبكة منتجات', 'Product grid'], line: ['أحدث منتجاتك أو المميزة أو من مجموعة', 'Latest, featured or from a collection'] },
  products_carousel: { name: ['شريط منتجات', 'Product carousel'], line: ['منتجات تمرّ أفقيًا', 'Products that scroll sideways'] },
  featured_products: { name: ['منتجات تختارها', 'Hand-picked products'], line: ['حتى 12 منتجًا بالترتيب الذي تريده', 'Up to 12 products in your order'] },
  collections: { name: ['المجموعات', 'Collections'], line: ['روابط إلى مجموعات متجرك', 'Links to your collections'] },
  deals: { name: ['التخفيضات', 'Deals'], line: ['المنتجات المخفّضة الآن', 'Products on sale now'] },
  coupon_banner: { name: ['كوبون', 'Coupon'], line: ['كوبون فعّال من كوبوناتك', 'One of your live coupons'] },
  countdown: { name: ['عدّ تنازلي', 'Countdown'], line: ['حتى موعد تحدده، ثم يختفي', 'To a moment you set, then it hides'] },
  services: { name: ['الخدمات', 'Services'], line: ['خدماتك وأزرار طلب عرض سعر', 'Your services and quote buttons'] },
  showcase: { name: ['معرض الأعمال', 'Showcase'], line: ['أعمالك وطابعاتك وخاماتك', 'Your work, printers and materials'] },
  reviews: { name: ['التقييمات', 'Reviews'], line: ['ما يقوله زبائنك', 'What customers say'] },
  faq: { name: ['أسئلة شائعة', 'FAQ'], line: ['سؤال وجواب قابلان للطي', 'Collapsible questions and answers'] },
  text: { name: ['نص', 'Text'], line: ['عنوان وفقرات', 'A heading and paragraphs'] },
  gallery: { name: ['معرض صور', 'Gallery'], line: ['صور من رفعك', 'Pictures you uploaded'] },
  video: { name: ['فيديو', 'Video'], line: ['فيديو رفعته أنت، لا تضمين خارجي', 'A video you uploaded — never an embed'] },
  social_links: { name: ['حسابات التواصل', 'Social links'], line: ['روابط حساباتك', 'Links to your accounts'] },
  cta: { name: ['دعوة لإجراء', 'Call to action'], line: ['عنوان وزر واحد', 'A heading and one button'] },
  contact: { name: ['التواصل', 'Contact'], line: ['الهاتف والساعات والموقع والمراسلة', 'Phone, hours, location, chat'] },
  delivery_info: { name: ['التوصيل', 'Delivery'], line: ['أين توصل وبكم', 'Where you deliver and for how much'] },
  printers: { name: ['الطابعات', 'Printers'], line: ['أجهزتك وقدراتها', 'Your machines and what they do'] },
  custom_request_cta: { name: ['طلب مخصص', 'Custom request'], line: ['دعوة لطلب قطعة حسب الطلب', 'An invitation to order a custom piece'] },
  stats: { name: ['أرقام', 'Figures'], line: ['أرقام حقيقية من متجرك', 'Real figures from your store'] },
  info_cards: { name: ['بطاقات معلومات', 'Info cards'], line: ['حقائق قصيرة بأيقونات', 'Short facts with icons'] },
  tabs: { name: ['تبويبات المتجر', 'Store tabs'], line: ['المنتجات والمجموعات والخدمات في تبويبات', 'Products, collections, services in tabs'] },
  about: { name: ['عن المتجر', 'About'], line: ['قصتك وسياساتك وساعات العمل', 'Your story, policies and hours'] },
};

export const VARIANT_COPY: Record<string, Pair> = {
  profile: ['الملف الكلاسيكي', 'Classic profile'],
  cover: ['غلاف', 'Cover'],
  split: ['مقسوم', 'Split'],
  minimal: ['بسيط', 'Minimal'],
  wide: ['عريض', 'Wide'],
  inset: ['داخل الإطار', 'Inset'],
  image_start: ['الصورة أولًا', 'Image first'],
  image_end: ['النص أولًا', 'Text first'],
  grid: ['شبكة', 'Grid'],
  carousel: ['شريط', 'Carousel'],
  chips: ['أزرار', 'Chips'],
  list: ['قائمة', 'List'],
  cards: ['بطاقات', 'Cards'],
  ticket: ['تذكرة', 'Ticket'],
  bar: ['شريط', 'Bar'],
  card: ['بطاقة', 'Card'],
  grouped: ['مجمّع', 'Grouped'],
  accordion: ['قابل للطي', 'Accordion'],
  plain: ['عادي', 'Plain'],
  callout: ['مؤطّر', 'Callout'],
  inline: ['في الصفحة', 'Inline'],
  pills: ['أزرار', 'Pills'],
  icons: ['أيقونات', 'Icons'],
  accent: ['باللون المميز', 'Accent'],
  subtle: ['هادئ', 'Subtle'],
  row: ['صف', 'Row'],
  underline: ['خط سفلي', 'Underline'],
};

// -------------------------------------------------------------- settings

export const FIELD_COPY: Record<string, { label: Pair; hint?: Pair }> = {
  image: { label: ['الصورة', 'Picture'], hint: ['اتركها فارغة لاستخدام غلاف متجرك', 'Leave empty to use your store cover'] },
  headline: { label: ['العنوان', 'Headline'], hint: ['فارغ = اسم متجرك', 'Empty = your store name'] },
  subheadline: { label: ['السطر الثاني', 'Subheadline'], hint: ['فارغ = الوصف القصير من الإعدادات', 'Empty = the tagline from settings'] },
  show_cover: { label: ['إظهار الغلاف', 'Show the cover'] },
  show_stats: { label: ['إظهار الأرقام', 'Show the figures'] },
  show_bio: { label: ['إظهار النبذة', 'Show the bio'] },
  show_links: { label: ['إظهار الروابط', 'Show the links'] },
  show_info_cards: { label: ['إظهار بطاقات المعلومات', 'Show the info cards'] },
  show_actions: { label: ['إظهار أزرار التواصل والمتابعة', 'Show contact and follow'] },
  cta_label: { label: ['نص الزر', 'Button text'] },
  cta_link: { label: ['رابط الزر', 'Button link'] },
  align: { label: ['المحاذاة', 'Alignment'] },
  title: { label: ['العنوان', 'Title'] },
  subtitle: { label: ['العنوان الفرعي', 'Subtitle'] },
  link: { label: ['الرابط', 'Link'] },
  overlay: { label: ['تعتيم الصورة تحت النص', 'Dim the picture under text'] },
  height: { label: ['الارتفاع', 'Height'] },
  body: { label: ['النص', 'Text'] },
  source: { label: ['المصدر', 'Source'] },
  collection_id: { label: ['المجموعة', 'Collection'] },
  limit: { label: ['العدد', 'How many'] },
  show_more: { label: ['زر «عرض الكل»', '«Show all» button'] },
  product_ids: { label: ['المنتجات', 'Products'] },
  collection_ids: { label: ['المجموعات', 'Collections'], hint: ['فارغ = كل المجموعات التي فيها منتجات', 'Empty = every collection with products'] },
  coupon_id: { label: ['الكوبون', 'Coupon'] },
  note: { label: ['ملاحظة', 'Note'] },
  ends_at: { label: ['ينتهي في', 'Ends at'], hint: ['يختفي القسم بعد هذا الموعد', 'The section hides after this moment'] },
  show_doors: { label: ['أزرار طلب عرض سعر والمراسلة', 'Quote and message buttons'] },
  kinds: { label: ['ما يُعرض', 'What to show'] },
  show_summary: { label: ['ملخص التقييم', 'Rating summary'] },
  items: { label: ['العناصر', 'Items'] },
  q: { label: ['السؤال', 'Question'] },
  a: { label: ['الجواب', 'Answer'] },
  images: { label: ['الصور', 'Pictures'] },
  caption: { label: ['وصف', 'Caption'] },
  video: { label: ['الفيديو', 'Video'] },
  poster: { label: ['صورة الغلاف', 'Poster'] },
  autoplay: { label: ['تشغيل تلقائي بلا صوت', 'Autoplay, muted'] },
  label: { label: ['نص الزر', 'Button text'] },
  show_phone: { label: ['الهاتف', 'Phone'] },
  show_hours: { label: ['ساعات العمل', 'Hours'] },
  show_location: { label: ['الموقع', 'Location'] },
  show_chat: { label: ['زر المراسلة', 'Message button'] },
  show_areas: { label: ['مناطق التوصيل', 'Delivery areas'] },
  show_note: { label: ['ملاحظة التوصيل', 'Delivery note'] },
  show_materials: { label: ['الخامات', 'Materials'] },
  metrics: { label: ['الأرقام', 'Figures'] },
  icon: { label: ['الأيقونة', 'Icon'] },
  about_reviews: { label: ['التقييمات داخل «عن المتجر»', 'Reviews inside «About»'] },
  products_preview: { label: ['منتجات قبل «عرض الكل»', 'Products before «Show all»'] },
  show_policies: { label: ['السياسات', 'Policies'] },
};

/** Per-key overrides for a key whose meaning differs by block. */
export const FIELD_COPY_BY_BLOCK: Partial<Record<BlockType, Record<string, { label: Pair; hint?: Pair }>>> = {
  social_links: {
    items: { label: ['حساباتك', 'Your accounts'] },
    source: { label: ['الحسابات', 'Accounts'] },
  },
  info_cards: { source: { label: ['البطاقات', 'Cards'] }, items: { label: ['بطاقاتك', 'Your cards'] } },
  tabs: { items: { label: ['التبويبات وترتيبها', 'Tabs and their order'] } },
  gallery: { images: { label: ['الصور', 'Pictures'] } },
  faq: { items: { label: ['الأسئلة', 'Questions'] } },
  banner: { image: { label: ['الصورة', 'Picture'] } },
  image_text: { image: { label: ['الصورة', 'Picture'] } },
};

export function fieldCopy(type: BlockType, key: string): { label: Pair; hint?: Pair } | undefined {
  return FIELD_COPY_BY_BLOCK[type]?.[key] ?? FIELD_COPY[key];
}

export const VALUE_COPY: Record<string, Pair> = {
  center: ['وسط', 'Center'],
  start: ['بداية السطر', 'Start'],
  dim: ['نعم', 'Yes'],
  none: ['لا', 'No'],
  short: ['قصير', 'Short'],
  medium: ['متوسط', 'Medium'],
  tall: ['طويل', 'Tall'],
  latest: ['الأحدث', 'Latest'],
  featured: ['المميزة', 'Featured'],
  deals: ['المخفّضة', 'On sale'],
  collection: ['من مجموعة', 'A collection'],
  store: ['من إعدادات المتجر', 'From store settings'],
  custom: ['أكتبها هنا', 'Written here'],
  work: ['أعمال', 'Work'],
  printer: ['طابعات', 'Printers'],
  material: ['خامات', 'Materials'],
  rating: ['التقييم', 'Rating'],
  positive: ['رضا الزبائن', 'Satisfaction'],
  products: ['المنتجات', 'Products'],
  followers: ['المتابعون', 'Followers'],
  completed_orders: ['طلبات منجزة', 'Completed orders'],
  years: ['سنوات على Levonis', 'Years on Levonis'],
  collections: ['المجموعات', 'Collections'],
  services: ['الخدمات', 'Services'],
  showcase: ['المعرض', 'Showcase'],
  about: ['عن المتجر', 'About'],
};

// ------------------------------------------------------------------ links

export const ROUTE_COPY: Record<LinkRoute, Pair> = {
  home: ['أعلى صفحة المتجر', 'Top of the store page'],
  products: ['كل المنتجات', 'All products'],
  deals: ['التخفيضات', 'Deals'],
  collections: ['المجموعات', 'Collections'],
  services: ['الخدمات', 'Services'],
  showcase: ['المعرض', 'Showcase'],
  about: ['عن المتجر', 'About'],
  reviews: ['التقييمات', 'Reviews'],
  cart: ['السلة', 'Cart'],
};

export const SOCIAL_COPY: Record<SocialProviderName, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  youtube: 'YouTube',
  x: 'X',
  snapchat: 'Snapchat',
};

// ------------------------------------------------------------------ theme

export const THEME_COPY: Record<ThemeName, { name: Pair; line: Pair }> = {
  classic: { name: ['الكلاسيكي', 'Classic'], line: ['صفحة متجرك كما عرفها زبائنك', 'Your store page as customers know it'] },
  minimal: { name: ['البسيط', 'Minimal'], line: ['هدوء ومساحات واسعة وصور طولية', 'Quiet, roomy, tall pictures'] },
  modern: { name: ['العصري', 'Modern'], line: ['بطاقات بارزة وزوايا دائرية', 'Raised cards, round corners'] },
  premium_dark: { name: ['الداكن الفاخر', 'Premium dark'], line: ['أسود عميق وأسماء فوق الصور', 'Deep black, names over pictures'] },
  workshop: { name: ['الورشة', 'Workshop'], line: ['كثيف وعملي لمن يعرض قدراته', 'Dense and practical, for capabilities'] },
  portfolio: { name: ['معرض الأعمال', 'Portfolio'], line: ['الصور أولًا لأعمالك', 'Pictures first, for your work'] },
  product_focused: { name: ['المنتجات أولًا', 'Product focused'], line: ['شبكة منتجات أوسع', 'A wider product grid'] },
};

export const TOKEN_COPY: Record<keyof ThemeTokens, Pair> = {
  accent: ['اللون المميز', 'Accent'],
  surface: ['الخلفية', 'Background'],
  radius: ['الزوايا', 'Corners'],
  density: ['الكثافة', 'Density'],
  typography: ['الخط', 'Type'],
  card: ['البطاقات', 'Cards'],
  product_card: ['بطاقة المنتج', 'Product card'],
  image_ratio: ['نسبة الصور', 'Picture shape'],
  section_spacing: ['المسافة بين الأقسام', 'Space between sections'],
  grid_columns: ['منتجات في الصف على الهاتف', 'Products per row on a phone'],
  width: ['عرض الصفحة', 'Page width'],
};

export const TOKEN_VALUE_COPY: Record<string, Pair> = {
  store: ['لون المتجر', 'Store colour'],
  default: ['ذهبي Levonis', 'Levonis gold'],
  olive: ['زيتوني', 'Olive'],
  gold: ['ذهبي', 'Gold'],
  slate: ['رمادي', 'Slate'],
  plum: ['برقوقي', 'Plum'],
  teal: ['فيروزي', 'Teal'],
  blue: ['أزرق', 'Blue'],
  glow: ['توهج', 'Glow'],
  ink: ['حبر', 'Ink'],
  graphite: ['غرافيت', 'Graphite'],
  carbon: ['كربون', 'Carbon'],
  midnight: ['منتصف الليل', 'Midnight'],
  sharp: ['حادة', 'Sharp'],
  soft: ['ناعمة', 'Soft'],
  round: ['دائرية', 'Round'],
  compact: ['مضغوط', 'Compact'],
  comfortable: ['مريح', 'Comfortable'],
  airy: ['واسع', 'Airy'],
  standard: ['قياسي', 'Standard'],
  bold: ['عريض', 'Bold'],
  refined: ['رشيق', 'Refined'],
  outline: ['بإطار', 'Outline'],
  flat: ['مسطّحة', 'Flat'],
  raised: ['بارزة', 'Raised'],
  tile: ['بلاطة', 'Tile'],
  bordered: ['بإطار', 'Bordered'],
  overlay: ['الاسم فوق الصورة', 'Name over picture'],
  minimal: ['بسيطة', 'Minimal'],
  square: ['مربعة', 'Square'],
  portrait: ['طولية', 'Portrait'],
  landscape: ['عرضية', 'Landscape'],
  tight: ['قليلة', 'Tight'],
  normal: ['عادية', 'Normal'],
  loose: ['واسعة', 'Loose'],
  '2': ['2', '2'],
  '3': ['3', '3'],
  wide: ['عريضة', 'Wide'],
};

export const HEADER_COPY: Record<HeaderVariant, { name: Pair; line: Pair }> = {
  overlay: { name: ['فوق الغلاف', 'Over the cover'], line: ['زر الرجوع والقائمة يطفوان فوق أعلى الصفحة', 'Back and the menu float over the top'] },
  bar: { name: ['شريط علوي', 'Top bar'], line: ['شريط بشعار متجرك واسمه', 'A bar with your logo and name'] },
  none: { name: ['بلا رأس', 'None'], line: ['لا شيء فوق الأقسام', 'Nothing above the sections'] },
};

export const FOOTER_COPY: Record<FooterVariant, { name: Pair; line: Pair }> = {
  minimal: { name: ['بسيطة', 'Minimal'], line: ['بطاقة «ثبّت التطبيق» على نطاق متجرك', '«Install the app» on your store address'] },
  standard: { name: ['قياسية', 'Standard'], line: ['البطاقة واسم متجرك وتاريخه على Levonis', 'The card, your name and since when'] },
  none: { name: ['بلا تذييل', 'None'], line: ['لا شيء تحت الأقسام', 'Nothing below the sections'] },
};

// ----------------------------------------------------------------- issues

/** What an issue from `normalizeLayout` means, next to the field it is about. */
export const ISSUE_COPY: Record<string, Pair> = {
  unsafe_link: ['هذا الرابط غير مسموح — يقبل المتجر روابط https:// فقط أو صفحات متجرك.', 'This link is not allowed — only https:// addresses or your own pages.'],
  invalid_media: ['هذا ليس ملفًا رفعته على Levonis.', 'This is not a file you uploaded to Levonis.'],
  foreign_media: ['هذا الملف ليس لك.', 'This file is not yours.'],
  media_not_found: ['الملف لم يعد موجودًا — اختر غيره.', 'The file is gone — choose another.'],
  unknown_ref: ['لم يعد موجودًا في متجرك.', 'No longer in your store.'],
  invalid_ref: ['اختيار غير صالح.', 'Not a valid choice.'],
  invalid_value: ['قيمة غير مقبولة — أُعيدت إلى الافتراضي.', 'Not an accepted value — reset to the default.'],
  clamped: ['خارج الحدود — ضُبط إلى أقرب قيمة مسموحة.', 'Out of range — set to the nearest allowed value.'],
  truncated: ['أطول من المسموح — سيُقصّ.', 'Longer than allowed — it will be cut.'],
  too_many: ['أكثر من المسموح — سيُحذف الزائد.', 'More than allowed — the extra will be dropped.'],
  dropped_item: ['عنصر ناقص — لن يظهر حتى يكتمل.', 'An incomplete item — it will not show until complete.'],
  unknown_key: ['إعداد غير معروف — سيُحذف.', 'An unknown setting — it will be removed.'],
  duplicate_id: ['معرّف مكرر — أُعطي معرّفًا جديدًا.', 'A repeated id — given a new one.'],
  payload_too_large: ['التصميم أكبر مما تسمح به صفحة المتجر — احذف بعض الأقسام أو النصوص.', 'The design is larger than a store page may be — remove some sections or text.'],
};

export const ADD_REFUSAL_COPY: Record<string, Pair> = {
  max_blocks: ['وصلت إلى 40 قسمًا — الحد الأقصى لصفحة واحدة.', 'You have 40 sections — the most one page can hold.'],
  type_max: ['وصلت إلى الحد الأقصى من هذا النوع.', 'You have the most of this kind a page can hold.'],
  product_lists: ['وصلت إلى 12 قائمة منتجات — الحد الأقصى لصفحة واحدة.', 'You have 12 product lists — the most one page can hold.'],
  not_found: ['هذا القسم لم يعد موجودًا.', 'That section no longer exists.'],
};
