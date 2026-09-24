/**
 * THE CLASSIC PAGE'S OTHER TABS, IN ONE LAZY CHUNK.
 *
 * A visitor lands on the Products tab (./ProductsGrid.tsx, which ships with
 * the storefront). Collections, Deals, Services, Showcase and About (with the
 * reviews) are drawn only when picked, so their views — and the blocks a
 * custom layout builds from the same views — arrive here, together, once. The
 * renderer fetches this chunk as soon as the browser is idle
 * (StoreRenderer.tsx), so the first tab switch does not wait for it.
 */
import type { ComponentType } from 'react';
import { useLanguage } from '../../../LanguageContext';
import type { BlockType } from '../../../../packages/storeLayout/src/blocks';
import type { BlockData, CollectionData, ServiceData, ShowcaseData } from '../../../../packages/storeLayout/src/data';
import { useStorefrontRuntime } from '../runtime';
import type { BlockProps, StorefrontStore } from '../types';
import AboutBlock, { AboutView } from './About';
import CollectionsBlock, { CollectionsList } from './Collections';
import DealsBlock, { DealsView } from './Deals';
import ReviewsBlock, { ReviewsView } from './Reviews';
import ServicesBlock, { ServicesView } from './Services';
import ShowcaseBlock, { ShowcaseView } from './Showcase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TAB_BLOCKS: Partial<Record<BlockType, ComponentType<BlockProps<any>>>> = {
  collections: CollectionsBlock,
  deals: DealsBlock,
  services: ServicesBlock,
  showcase: ShowcaseBlock,
  reviews: ReviewsBlock,
  about: AboutBlock,
};

export type OtherTab = 'collections' | 'deals' | 'services' | 'showcase' | 'about';

export interface TabViewProps {
  kind: OtherTab;
  store: StorefrontStore;
  data: BlockData;
  sections: CollectionData[];
  services: ServiceData[];
  showcase: ShowcaseData[];
  /** The About tab shows the store's reviews under it. */
  aboutReviews: boolean;
  onPickSection: (id: string) => void;
}

/** The body of one tab other than Products — what the Tabs block shows when it is picked. */
export function TabView({ kind, store, data, sections, services, showcase, aboutReviews, onPickSection }: TabViewProps) {
  const { loc } = useLanguage();
  const rt = useStorefrontRuntime();
  switch (kind) {
    case 'collections':
      return <CollectionsList sections={sections} onPick={onPickSection} />;
    case 'deals':
      return <DealsView initial={data.products.deals} storeOpen={!!store.open} />;
    case 'services':
      return <ServicesView services={services} accepts={!!store.accepts_custom_requests} />;
    case 'showcase':
      return <ShowcaseView items={showcase} />;
    case 'about':
      return (
        <div className="space-y-4">
          <AboutView store={store} />
          {/* Store reviews are store-scoped; a profile-only merchant has no
              review history to show, and an empty promise helps nobody. */}
          {!rt.profileOnly && aboutReviews && (
            <div>
              <h2 className="sf-subtitle text-white mb-3">{loc('التقييمات', 'Reviews', 'هەڵسەنگاندنەکان')}</h2>
              <ReviewsView initial={data.reviews} />
            </div>
          )}
        </div>
      );
    default:
      return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function TabViewBlock(props: BlockProps<any>) {
  const Component = TAB_BLOCKS[props.block.type as BlockType];
  return Component ? <Component {...props} /> : null;
}
