import React from 'react';

/**
 * AuthCard — the machined charcoal panel every /auth screen lives in.
 * Solid surface (no glass), hairline border, one gold seam on the top
 * chamfer; the styling itself is in auth.css (.lv-card).
 */
export default function AuthCard({ children }: { children: React.ReactNode }) {
  return <div className="lv-card p-5 sm:p-6">{children}</div>;
}
