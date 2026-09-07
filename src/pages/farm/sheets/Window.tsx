/**
 * Sheet on a phone, anchored Overlay from 640px — the PurchaseConfirm rule,
 * shared by every farm window. Escape and the scrim stay disabled while a
 * request is in flight so a window is never closed under a pending intent.
 */
import React from 'react';
import { Overlay, Sheet } from '../../../components/ui/Overlay';
import { usePhone } from '../hooks/usePhone';

export interface WindowProps {
  open: boolean;
  onClose: () => void;
  label: string;
  labelledBy?: string;
  busy?: boolean;
  anchor?: React.RefObject<HTMLElement | null>;
  testId?: string;
  z?: number;
  children: React.ReactNode;
}

export function Window({ open, onClose, label, labelledBy, busy = false, anchor, testId, z, children }: WindowProps) {
  const phone = usePhone();
  return phone ? (
    <Sheet
      open={open}
      onClose={onClose}
      label={label}
      labelledBy={labelledBy}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      testId={testId}
      z={z}
      panelClassName="w-full sm:max-w-md max-h-[88dvh] overflow-y-auto"
    >
      {children}
    </Sheet>
  ) : (
    <Overlay
      open={open}
      onClose={onClose}
      label={label}
      labelledBy={labelledBy}
      anchor={anchor}
      dismissOnEscape={!busy}
      dismissOnScrim={!busy}
      testId={testId}
      z={z}
      panelClassName="w-full max-w-md max-h-[88dvh] overflow-y-auto"
    >
      {children}
    </Overlay>
  );
}

/** The window body padding every farm sheet uses. */
export const WINDOW_BODY = 'p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] space-y-4';
