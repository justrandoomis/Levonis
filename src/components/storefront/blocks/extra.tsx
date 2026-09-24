/**
 * The blocks the classic page does not use (and the hero's other variants),
 * in ONE lazy chunk: a store whose layout holds none of them never downloads
 * any of them, and one that does fetches them together, once.
 */
import type { ComponentType } from 'react';
import type { BlockType } from '../../../../packages/storeLayout/src/blocks';
import type { BlockProps } from '../types';
import BannerBlock from './Banner';
import ImageTextBlock from './ImageText';
import ProductsCarouselBlock from './ProductsCarousel';
import FeaturedProductsBlock from './FeaturedProducts';
import CouponBannerBlock from './CouponBanner';
import CountdownBlock from './Countdown';
import FaqBlock from './Faq';
import TextBlock from './Text';
import GalleryBlock from './Gallery';
import VideoBlock from './Video';
import SocialLinksBlock from './SocialLinks';
import CtaBlock from './Cta';
import ContactBlock from './Contact';
import DeliveryInfoBlock from './DeliveryInfo';
import PrintersBlock from './Printers';
import CustomRequestCtaBlock from './CustomRequestCta';
import StatsBlock from './Stats';
import InfoCardsBlock from './InfoCards';

/** The hero's non-classic variants, for ./Hero.tsx to load lazily. */
export { default as HeroVariant } from './HeroVariants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EXTRA_BLOCKS: Partial<Record<BlockType, ComponentType<BlockProps<any>>>> = {
  banner: BannerBlock,
  image_text: ImageTextBlock,
  products_carousel: ProductsCarouselBlock,
  featured_products: FeaturedProductsBlock,
  coupon_banner: CouponBannerBlock,
  countdown: CountdownBlock,
  faq: FaqBlock,
  text: TextBlock,
  gallery: GalleryBlock,
  video: VideoBlock,
  social_links: SocialLinksBlock,
  cta: CtaBlock,
  contact: ContactBlock,
  delivery_info: DeliveryInfoBlock,
  printers: PrintersBlock,
  custom_request_cta: CustomRequestCtaBlock,
  stats: StatsBlock,
  info_cards: InfoCardsBlock,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function ExtraBlock(props: BlockProps<any>) {
  const Component = EXTRA_BLOCKS[props.block.type as BlockType];
  return Component ? <Component {...props} /> : null;
}
