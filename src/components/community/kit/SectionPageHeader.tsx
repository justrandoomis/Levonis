/**
 * THE HEADER OF A COMMUNITY SECTION PAGE (community UI plan B2, §3; IMG_8476,
 * IMG_8469, IMG_8483 headers): «› المتاجر … الأقسام ⊞».
 *
 *   back       a chevron at the inline start, pointing outward (› in Arabic,
 *              ‹ in English), 24px drawn in a 44px hit, named «رجوع». It is
 *              useGoBack: a visitor who came from another page goes back to
 *              it, one who opened the section by its link goes up to the
 *              community home (`backTo`), never out of the app
 *   title      the page h1, 26/800
 *   kicker     optional, «مجتمع ليفو» at 13px over the title
 *   trailing   the inline-end slot: «الأقسام» (SectionsButton below, the door
 *              to the sections and account menu), «المحفوظات», «حفظ مسودة»,
 *              or a «⋯» menu
 *
 * 56px tall. On a phone it scrolls with the page, as the references draw it;
 * from `lg` it sticks to the top on the canvas so the door stays in reach. A
 * title too long for one row with its door (Sorani at 320px) keeps its words
 * whole and the door wraps under it, at the inline end.
 *
 * MenuDoor is the one way to open the sections menu (hub/CommunityMenu.tsx):
 * it holds the open state, downloads the menu on the first press (a lazy
 * chunk: a page that never opens it never pays for it), anchors it to the
 * trigger from `lg`, and gives focus back to the trigger when it closes. The
 * home avatar (C1) and the «الأقسام» button here both use it.
 */
import React, { Suspense, useCallback, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useGoBack } from '../../../lib/useGoBack';
import { useKitStrings } from './strings';

const CommunityMenu = React.lazy(() => import('../hub/CommunityMenu'));

export interface SectionPageHeaderProps {
  title: React.ReactNode;
  /** The kicker over the title: `true` for «مجتمع ليفو», or words of its own. */
  kicker?: boolean | React.ReactNode;
  /** Where Back goes when there is no page of this app behind this one. */
  backTo?: string;
  /** A back of its own (a flow that asks before leaving); replaces useGoBack. */
  onBack?: () => void;
  /** The inline-end slot. */
  trailing?: React.ReactNode;
  /** The id of the h1, for a section that names itself by it. */
  titleId?: string;
  className?: string;
}

export default function SectionPageHeader({ title, kicker, backTo = '/community', onBack, trailing, titleId, className = '' }: SectionPageHeaderProps) {
  const s = useKitStrings();
  const { dir } = useLanguage();
  const goBack = useGoBack(backTo);
  // Outward: toward the inline start, the side the page came from.
  const Back = dir === 'rtl' ? ChevronRight : ChevronLeft;
  return (
    <header data-section-header className={`top-0 z-30 flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 bg-canvas py-1.5 lg:sticky ${className}`}>
      <button
        type="button"
        onClick={onBack ?? goBack}
        aria-label={s.back}
        data-section-back
        className="relative -ms-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Back aria-hidden="true" className="h-6 w-6" strokeWidth={2} />
      </button>
      {/* The title keeps its words whole: on a narrow phone the trailing slot
          wraps under it at the inline end (plan R7) rather than breaking a word. */}
      <div className="flex-auto">
        {kicker && <p className="text-[13px] font-semibold text-text-secondary">{kicker === true ? s.communityName : kicker}</p>}
        <h1 id={titleId} className="text-[26px] font-extrabold leading-tight text-text-primary">
          {title}
        </h1>
      </div>
      {trailing && <div className="ms-auto flex shrink-0 items-center gap-1">{trailing}</div>}
    </header>
  );
}

/** What MenuDoor hands its trigger. */
export interface MenuDoorTriggerProps {
  ref: React.RefCallback<HTMLElement>;
  onClick: () => void;
  'aria-haspopup': 'dialog';
  'aria-expanded': boolean;
}

/**
 * The door to the sections and account menu: render the trigger with the
 * props it is given. The menu downloads on the first press and stays mounted
 * after it, so it can play its exit and hand focus back.
 */
export function MenuDoor({ children }: { children: (props: MenuDoorTriggerProps) => React.ReactNode }) {
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [ever, setEver] = useState(false);
  const ref = useCallback((el: HTMLElement | null) => {
    anchor.current = el;
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      {children({
        ref,
        onClick: () => {
          setEver(true);
          setOpen((o) => !o);
        },
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
      })}
      {ever && (
        <Suspense fallback={null}>
          <CommunityMenu open={open} onClose={close} anchor={anchor} />
        </Suspense>
      )}
    </>
  );
}

/** «الأقسام ⊞»: the trailing door of a section header (IMG_8469). */
export function SectionsButton({ className = '' }: { className?: string }) {
  const s = useKitStrings();
  return (
    <MenuDoor>
      {(p) => (
        <button
          {...p}
          type="button"
          data-sections-door
          className={`relative inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-[15px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
        >
          {s.sections}
          <LayoutGrid aria-hidden="true" className="h-6 w-6 text-text-primary" strokeWidth={1.75} />
        </button>
      )}
    </MenuDoor>
  );
}
