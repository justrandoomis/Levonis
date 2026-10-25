/** CSS minifiers may serialize 250ms as .25s; Web Animations only accepts ms. */
export function cssTimeMs(value: string, fallback: number): number {
  const match = /^\s*(\d*\.?\d+)\s*(ms|s)\s*$/.exec(value);
  return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : fallback;
}
