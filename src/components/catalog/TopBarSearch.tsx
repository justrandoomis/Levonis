import React, { Suspense, useState } from 'react';
import { Search } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { TopBarButton } from './PageTopBar';

const load = () => import('./SearchOverlay');
const SearchOverlay = React.lazy(load);

/** The top bar's search icon; the overlay's chunk is fetched on press, before the tap lands. */
export default function TopBarSearch() {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  return (
    <>
      <TopBarButton
        // OWNER: Sorani to be written by hand.
        label={loc('بحث في المتجر', 'Search the shop')}
        onPointerDown={() => void load()}
        onClick={() => {
          setArmed(true);
          setOpen(true);
        }}
      >
        <Search aria-hidden="true" className="size-[18px]" />
      </TopBarButton>
      {armed ? (
        <Suspense fallback={null}>
          <SearchOverlay open={open} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
