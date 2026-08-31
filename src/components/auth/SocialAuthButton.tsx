import React from 'react';

/**
 * SocialAuthButton — a full-width secondary provider action (Telegram; the
 * Google slot is Google's own iframe, staged in GoogleAuthButton). Visually
 * quieter than the gold primary CTA on purpose: providers are alternatives,
 * never the headline.
 */
export interface SocialAuthButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export default function SocialAuthButton({ icon, label, onClick, disabled }: SocialAuthButtonProps) {
  return (
    <button type="button" className="lv-social" onClick={onClick} disabled={disabled}>
      <span aria-hidden className="lv-social__icon">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

/** The recognizable Telegram roundel (official mark, inlined). */
export function TelegramIcon() {
  const gid = React.useId();
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#2AABEE" />
          <stop offset="1" stopColor="#229ED9" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="12" fill={`url(#${gid})`} />
      <path
        fill="#fff"
        d="M5.43 11.87c3.28-1.43 5.47-2.37 6.57-2.83 3.13-1.3 3.78-1.53 4.2-1.54.1 0 .3.02.44.13.11.09.14.21.16.3.02.09.04.28.02.43-.17 1.79-.9 6.12-1.28 8.12-.16.85-.47 1.13-.77 1.16-.66.06-1.16-.43-1.79-.85-1-.65-1.56-1.06-2.53-1.7-1.12-.73-.39-1.14.24-1.8.17-.17 3.06-2.8 3.11-3.04.01-.03.01-.14-.05-.2s-.16-.04-.23-.02c-.1.02-1.69 1.07-4.76 3.14-.45.31-.86.46-1.23.45-.4-.01-1.18-.23-1.76-.42-.71-.23-1.27-.35-1.22-.75.02-.2.3-.41.88-.63Z"
      />
    </svg>
  );
}
