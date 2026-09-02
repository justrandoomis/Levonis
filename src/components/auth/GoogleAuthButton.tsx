import React, { useLayoutEffect, useRef, useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';

/**
 * GoogleAuthButton — the official Google Identity button, staged for the
 * /auth design system.
 *
 * It stays Google's own iframe ON PURPOSE: the server contract is a GIS ID
 * credential (POST /api/auth/google { credential }), which only this button
 * produces — a hand-rolled lookalike would either break the flow or violate
 * Google's branding rules. What this wrapper adds is presentation only: the
 * container is measured so the iframe spans the card exactly (GIS accepts a
 * fixed pixel width, 200–400), and the row keeps a constant height so the
 * async iframe load never shifts the layout.
 */
export interface GoogleAuthButtonProps {
  onCredential: (credential: string | undefined) => void;
  onError: () => void;
  /** 'signup' switches the official label to its create-account variant. */
  view: 'signin' | 'signup';
  busy?: boolean;
  /** Icon-only (a 40px official Google mark) for short viewports. */
  compact?: boolean;
}

export default function GoogleAuthButton({ onCredential, onError, view, busy, compact }: GoogleAuthButtonProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const w = Math.round(host.getBoundingClientRect().width);
      // Inside the well's border+padding; GIS accepts 200–400px — clamp
      // instead of letting it reject the value.
      if (w) setWidth(Math.max(200, Math.min(400, w - 12)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={hostRef}
      className={`lv-google${compact ? ' lv-google--compact' : ''}${busy ? ' is-busy' : ''}`}
      aria-busy={busy || undefined}
    >
      {compact ? (
        <GoogleLogin
          onSuccess={(credentialResponse) => onCredential(credentialResponse.credential)}
          onError={onError}
          theme="filled_black"
          type="icon"
          shape="circle"
          size="large"
        />
      ) : (
        <GoogleLogin
          onSuccess={(credentialResponse) => onCredential(credentialResponse.credential)}
          onError={onError}
          theme="filled_black"
          shape="rectangular"
          text={view === 'signup' ? 'signup_with' : 'continue_with'}
          width={String(width)}
        />
      )}
    </div>
  );
}
