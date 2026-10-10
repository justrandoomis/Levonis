/**
 * The share panel in a window — what the store's OWNER opens from the «…»
 * menu of their own storefront.
 *
 * AN `Overlay`, NOT A DRAGGABLE `Sheet`, for the profile QR window's reason
 * (src/components/profile/QrCodeModal.tsx): this is a thing held up to
 * ANOTHER phone's camera, and a panel a stray downward swipe can throw away
 * is wrong for it. Centred, where a camera pointed at the middle of the
 * screen finds the code; `solid`, because the code needs its own ground.
 * Escape, the scrim and the close button dismiss it; the window arrives and
 * leaves the way every other window does. Loaded lazily — none of this, the
 * QR encoder included, is in a customer's first load of the storefront.
 */
import { X } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Overlay } from '../../ui/Overlay';
import { IconButton } from '../../ui/Button';
import ShareStore from './ShareStore';
import type { StoreShareKit } from './shareStoreApi';
import { shareStrings } from './strings';

export default function ShareStoreSheet({
  open,
  onClose,
  kit,
}: {
  open: boolean;
  onClose: () => void;
  kit: StoreShareKit | null;
}) {
  const { loc } = useLanguage();
  const s = shareStrings(loc);
  return (
    <Overlay
      open={open}
      onClose={onClose}
      label={s.title}
      placement="center"
      solid
      z={210}
      testId="share-store"
      panelClassName="w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain bg-surface-raised text-text-primary border border-border-subtle"
    >
      <div className="p-4">
        <div className="flex items-center justify-between gap-2 mb-1">
          <h2 className="text-[15px] font-bold text-text-primary text-balance">{s.title}</h2>
          <IconButton onClick={onClose} label={s.close} className="-me-2" icon={<X className="w-5 h-5" aria-hidden />} />
        </div>
        <p className="text-text-secondary text-[12px] leading-relaxed mb-3.5">{s.intro}</p>
        <ShareStore initialKit={kit} variant="plain" qrOpen />
      </div>
    </Overlay>
  );
}
