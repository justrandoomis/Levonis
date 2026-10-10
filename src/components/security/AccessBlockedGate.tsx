/**
 * THE ACCESS-BLOCKED NOTICE, ON DEMAND (DECISIONS row 206).
 *
 * When the deception layer blocks a browser, every API answer is
 * `403 ACCESS_BLOCKED` with a reference; src/lib/api.ts announces the first
 * one as `levonis:access-blocked`. This gate renders nothing and downloads
 * nothing until then — the screen itself (./AccessBlockedScreen.tsx) is its own
 * chunk, so the entry bundle does not grow. A failed chunk renders nothing.
 */
import React, { Suspense, useEffect, useState } from 'react';
import { ACCESS_BLOCKED_EVENT } from '../../lib/api';
import { useAuth } from '../../AuthContext';

type ScreenProps = { reference: string; signedIn: boolean };
const Nothing: React.ComponentType<ScreenProps> = () => null;
const Screen = React.lazy<React.ComponentType<ScreenProps>>(() => import('./AccessBlockedScreen').catch(() => ({ default: Nothing })));

export default function AccessBlockedGate() {
  const { user } = useAuth();
  const [reference, setReference] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const ref = (e as CustomEvent<{ reference?: string }>).detail?.reference;
      setReference(typeof ref === 'string' ? ref : '');
    };
    window.addEventListener(ACCESS_BLOCKED_EVENT, on);
    return () => window.removeEventListener(ACCESS_BLOCKED_EVENT, on);
  }, []);
  if (reference === null) return null;
  return (
    <Suspense fallback={null}>
      <Screen reference={reference} signedIn={!!user} />
    </Suspense>
  );
}
