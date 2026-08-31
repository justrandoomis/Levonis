import React from 'react';
import { Link } from 'react-router-dom';

/**
 * AuthBrand — the compact LEVONIS header for /auth.
 *
 * The wordmark is the platform's existing identity (tracked Cairo black in
 * brand gold — there is no separate logo asset in this repo, by design), cut
 * with a machined seam and a technical eyebrow. Deliberately small: on a
 * phone the form, not the logo, owns the screen.
 */
export default function AuthBrand() {
  return (
    <div className="mb-5 flex flex-col items-center">
      <Link to="/" aria-label="LEVONIS" className="flex min-h-[44px] flex-col items-center justify-center">
        <span dir="ltr" className="lv-brand__mark">
          LEVONIS
        </span>
      </Link>
      <span aria-hidden className="lv-brand__seam" />
      <span dir="ltr" className="lv-brand__eyebrow lv-mono">
        PRECISION&nbsp;3D&nbsp;PRINTING
      </span>
    </div>
  );
}
