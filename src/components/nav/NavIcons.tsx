import React from 'react';

/**
 * THE BOTTOM BAR'S FOUR ICONS, drawn for the bar.
 *
 * The bar used four stock glyphs from four different drawings — a 2px cart
 * with wheels and a handle, a round speech bubble, a two-person group whose
 * second figure sat higher than the first — so at 20px they had four
 * different weights and four different optical sizes. These are drawn on one
 * 24-unit grid with one live area (3.5–20.5), one stroke, round caps and
 * joins, and the same visual mass, so the four read as one family and line up
 * on the bar's baseline. The active state is a slightly heavier stroke, never
 * a fill: the gold tick above the icon is the bar's one selection cue.
 */
type IconProps = { className?: string; strokeWidth?: number };

function Svg({ className, strokeWidth = 1.6, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

/** حسابي — a head and shoulders. */
export function AccountIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.75 20c1.1-3.55 3.9-5.5 7.25-5.5s6.15 1.95 7.25 5.5" />
    </Svg>
  );
}

/** السلة — a shopping bag: the store's own metaphor for "what I am buying". */
export function BagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.25 8.25h13.5l-.95 10.6a1.75 1.75 0 0 1-1.74 1.6H7.94a1.75 1.75 0 0 1-1.74-1.6z" />
      <path d="M9 10.5V7a3 3 0 0 1 6 0v3.5" />
    </Svg>
  );
}

/** المحادثات — a speech bubble with a short tail. */
export function ChatsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.25 11.4c0 4.03-3.7 7.1-8.25 7.1-1.02 0-2-.15-2.9-.44L4.5 19.5l1.12-3.3A6.6 6.6 0 0 1 3.75 11.4c0-4.03 3.7-7.15 8.25-7.15s8.25 3.12 8.25 7.15z" />
      <path d="M8.75 11.5h.01M12 11.5h.01M15.25 11.5h.01" strokeWidth={(props.strokeWidth ?? 1.6) + 0.6} />
    </Svg>
  );
}

/** المجتمع — two people, the second a step behind the first. */
export function CommunityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9.25" cy="8.5" r="3.25" />
      <path d="M3.5 19.5c.85-3.1 3.05-4.85 5.75-4.85S14.15 16.4 15 19.5" />
      <path d="M15.25 5.6a3.1 3.1 0 0 1 0 5.8" />
      <path d="M17 14.9c1.75.5 2.95 2.05 3.5 4.6" />
    </Svg>
  );
}
