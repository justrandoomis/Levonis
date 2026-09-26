import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Overlay } from '../ui/Overlay';
import LiveSearch from '../search/LiveSearch';
import { useLanguage } from '../../LanguageContext';

/**
 * THE SHOP'S SEARCH, OPENED FROM A DISCOVERY PAGE'S TOP BAR (§5 item 1).
 *
 * The same `LiveSearch` the home header uses — the field, the panel that grows
 * out of it with the products it found, the grey completion — in a window
 * that drops from the top, so a shopper browsing the map can jump straight to
 * a product without going home first. Enter (or the panel's footer) opens the
 * full results page. Lazy: nothing of the search is downloaded until the icon
 * is pressed.
 */
export default function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { loc } = useLanguage();
  // OWNER: Sorani to be written by hand (the window's name).
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const box = useRef<HTMLDivElement>(null);
  // The field is what the shopper came for: focus it as the window lands.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => box.current?.querySelector<HTMLInputElement>('input')?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <Overlay
      open={open}
      onClose={onClose}
      placement="top"
      label={loc('ابحث في المتجر', 'Search the shop')}
      panelClassName="w-full max-w-[640px] p-3"
    >
      <div ref={box}>
      <LiveSearch
        value={value}
        onChange={setValue}
        onSubmit={(q) => {
          onClose();
          if (q.trim()) navigate(`/products?search=${encodeURIComponent(q.trim())}`);
        }}
        onPick={onClose}
        size="compact"
        tone="bar"
        className="w-full"
      />
      </div>
    </Overlay>
  );
}
