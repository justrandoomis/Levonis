import React from 'react';
import { Link } from 'react-router-dom';

/**
 * AuthBrand — the compact LEVONIS mark for /auth: tracked wordmark in gold,
 * an olive seam, a mono eyebrow. There is no separate logo asset in this
 * repository by design; the wordmark IS the identity. Small on purpose —
 * on a phone the form owns the screen.
 */
export default function AuthBrand() {
  return (
    <Link to="/" aria-label="LEVONIS" className="lv-brand__link">
      <span dir="ltr" className="lv-brand__mark">
        LEVONIS
      </span>
      <span aria-hidden className="lv-brand__seam" />
      <span dir="ltr" className="lv-brand__eyebrow lv-mono">
        PRECISION 3D PRINTING
      </span>
    </Link>
  );
}
