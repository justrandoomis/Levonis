import React from 'react';

/** AuthDivider — the "أو" seam between the primary form and provider buttons. */
export default function AuthDivider({ label }: { label: string }) {
  return (
    <div className="lv-divider" role="separator" aria-label={label}>
      <span className="lv-divider__label">{label}</span>
    </div>
  );
}
