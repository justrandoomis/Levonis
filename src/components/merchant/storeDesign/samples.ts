/**
 * THE PICKER'S EXAMPLES — what a block of each type looks like before the
 * merchant fills it in, for the live preview in the block picker only.
 *
 * These words are the builder's own, labelled «مثال» on screen, and they are
 * NEVER inserted into a layout: «أضف» adds the block with every setting at its
 * default (editorModel.addBlock). Pictures are the store's own cover, and only
 * when it is a key the schema accepts. The sample goes through
 * `normalizeLayout` like anything else rendered.
 */
import type { BlockType } from '../../../../packages/storeLayout/src/blocks';
import { normalizeLayout } from '../../../../packages/storeLayout/src/normalize';
import { mediaKey } from '../../../../packages/storeLayout/src/refs';
import type { StoreBlock, StoreLayout } from '../../../../packages/storeLayout/src/schema';
import type { Loc } from './catalog';

const T = (loc: Loc, ar: string, en: string) => {
  const v = loc(ar, en);
  return { ar: v, en: v, ckb: v };
};

function coverKey(bannerUrl: string | null | undefined): string {
  const v = bannerUrl ? mediaKey(bannerUrl, 'image', null) : null;
  return v && v.ok ? v.key : '';
}

export function sampleSettings(type: BlockType, loc: Loc, bannerUrl: string | null | undefined): Record<string, unknown> {
  const cover = coverKey(bannerUrl);
  const title = T(loc, 'عنوان القسم', 'Section title');
  const body = T(loc, 'فقرة قصيرة تشرح لزبائنك ما يجدونه هنا، بكلماتك أنت.', 'A short paragraph telling customers what they find here, in your own words.');
  const cta = T(loc, 'تسوّق الآن', 'Shop now');
  const toProducts = { kind: 'route', route: 'products' };
  switch (type) {
    case 'banner':
      return { image: cover, title: T(loc, 'تشكيلة الموسم', 'This season'), subtitle: T(loc, 'قطع جديدة كل أسبوع', 'New pieces every week'), cta_label: cta, link: toProducts };
    case 'image_text':
      return { image: cover, title, body, cta_label: cta, link: toProducts };
    case 'text':
      return { title, body };
    case 'faq':
      return {
        title: T(loc, 'أسئلة شائعة', 'Questions'),
        items: [
          { q: T(loc, 'كم يستغرق التوصيل؟', 'How long is delivery?'), a: T(loc, 'يومان إلى ثلاثة أيام لكل المحافظات.', 'Two to three days to every governorate.') },
          { q: T(loc, 'هل تصنعون حسب الطلب؟', 'Do you make to order?'), a: T(loc, 'نعم — أرسل طلبك وسنرد بعرض سعر.', 'Yes — send a request and we reply with a quote.') },
        ],
      };
    case 'cta':
      return { title: T(loc, 'تحتاج قطعة خاصة؟', 'Need something special?'), body, label: T(loc, 'تواصل معنا', 'Get in touch'), link: { kind: 'route', route: 'about' } };
    case 'countdown':
      return { title: T(loc, 'ينتهي العرض بعد', 'The offer ends in'), ends_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), cta_label: cta, link: toProducts };
    case 'gallery':
      return cover ? { title, images: [{ image: cover }, { image: cover }, { image: cover }] } : { title };
    case 'custom_request_cta':
      return { title: T(loc, 'اطلب قطعة حسب الطلب', 'Order a custom piece'), body, label: T(loc, 'أرسل طلبك', 'Send a request') };
    case 'info_cards':
      return {
        source: 'custom',
        items: [
          { icon: 'truck', title: T(loc, 'توصيل سريع', 'Fast delivery'), subtitle: T(loc, 'كل المحافظات', 'Every governorate') },
          { icon: 'shield', title: T(loc, 'ضمان', 'Warranty'), subtitle: T(loc, 'على كل قطعة', 'On every piece') },
          { icon: 'printer', title: T(loc, 'طباعة دقيقة', 'Precise printing'), subtitle: T(loc, 'FDM ورزن', 'FDM and resin') },
        ],
      };
    case 'social_links':
      return { title: T(loc, 'تابعنا', 'Follow us') };
    case 'coupon_banner':
    case 'video':
    case 'featured_products':
      return { title };
    default:
      return {};
  }
}

/** A one-block page, in the current look, for the picker's preview. */
export function samplePage(layout: StoreLayout, type: BlockType, variant: string, loc: Loc, bannerUrl: string | null | undefined): StoreLayout {
  const { layout: page } = normalizeLayout(
    {
      schema_version: 1,
      theme: layout.theme,
      tokens: layout.tokens,
      header: { variant: 'none' },
      footer: { variant: 'none' },
      blocks: [{ id: 'sample', type, variant, settings: sampleSettings(type, loc, bannerUrl) }],
    },
    { ownerUserId: null }
  );
  return page;
}

export type { StoreBlock };
