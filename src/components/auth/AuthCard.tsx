import React from 'react';

/**
 * AuthCard — the thin, lighter panel every /auth screen lives in: solid
 * surface, hairline border, one light shadow, two olive registration ticks
 * on opposite corners (auth.css .lv-card).
 */
export default function AuthCard({ children }: { children: React.ReactNode }) {
  return <div className="lv-card">{children}</div>;
}
