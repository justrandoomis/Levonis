/** Match the image's rendered box, including the studio-photo crop in index.css. */
type Screen = { min: number; height: number; padding: number; gap: number; large: number };
const SCREENS: Screen[] = [
  { min: 0, height: 200, padding: 16, gap: 8, large: 0.42 },
  { min: 400, height: 216, padding: 16, gap: 8, large: 0.42 },
  { min: 640, height: 240, padding: 24, gap: 8, large: 0.44 },
  { min: 1024, height: 380, padding: 32, gap: 12, large: 5 / 12 },
  { min: 1280, height: 420, padding: 32, gap: 12, large: 5 / 12 },
  { min: 1536, height: 480, padding: 32, gap: 12, large: 5 / 12 },
];
const number = (n: number) => Number(n.toFixed(3));

function widthLength(fraction: number, subtract: number, min: number): string {
  // Home's surface is capped at 1920px; below that it fills the viewport.
  return min >= 1536
    ? `calc(min(${number(fraction * 100)}vw, ${number(fraction * 1920)}px) - ${number(subtract)}px)`
    : `calc(${number(fraction * 100)}vw - ${number(subtract)}px)`;
}

export function bentoImageSizes({ position, crop, hasLarge, topCount, bottomCount }: {
  position: 'large' | 'top-1' | 'top-2' | 'bottom-1' | 'bottom-2' | 'bottom-3';
  crop: boolean;
  hasLarge: boolean;
  topCount: number;
  bottomCount: number;
}): string {
  return [...SCREENS].reverse().map((s) => {
    const large = position === 'large';
    const bothColumns = hasLarge && topCount + bottomCount > 0;
    const top = position.startsWith('top');
    const count = large ? 1 : Math.max(1, top ? topCount : bottomCount);
    const fraction = (bothColumns ? (large ? s.large : 1 - s.large) : 1) / count;
    const subtract = fraction * (s.padding * 2 + (bothColumns ? s.gap : 0)) + s.gap * (count - 1) / count;
    const height = !large && topCount > 0 && bottomCount > 0
      ? (s.height - s.gap) * (top ? 1 : 1.08) / 2.08
      : s.height;
    const width = widthLength(fraction / (crop ? 0.86 : 1), subtract / (crop ? 0.86 : 1), s.min);
    // A cropped square is wider than its tile: shrinking to just the tile's
    // width would blur the machine at the center of the photograph.
    const length = crop ? `max(${number(height / 0.53)}px, ${width})` : width;
    return `${s.min ? `(min-width: ${s.min}px) ` : ''}${length}`;
  }).join(', ');
}

export function editorialImageSizes(crop: boolean, columns: number): string {
  const count = Math.max(1, columns);
  return [
    { min: 1536, padding: 32, gap: 16, ratio: 12 / 5 },
    { min: 1024, padding: 32, gap: 16, ratio: 12 / 5 },
    { min: 640, padding: 24, gap: 10, ratio: 16 / 9 },
    { min: 0, padding: 16, gap: 8, ratio: 16 / 10 },
  ].map((s) => {
    const scale = crop ? Math.max(1 / 0.86, 1 / (s.ratio * 0.53)) : 1;
    const length = widthLength(scale / count, (s.padding * 2 + (count - 1) * s.gap) * scale / count, s.min);
    return `${s.min ? `(min-width: ${s.min}px) ` : ''}${length}`;
  }).join(', ');
}
