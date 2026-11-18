/**
 * A product's catalogue name → the few words the animated placeholder types
 * (./AnimatedPlaceholder.tsx). «B7000 Clear Jewelry & Mobile Phone Repair
 * Adhesive — 110 mL with Built-in Needle Tip» is a name for a product page,
 * not for a 300 px field: the part before the first dash, comma, bracket or
 * bar, then at most `MAX` characters cut at a word. Pure; tests/searchUpgrade.test.ts.
 */
const MAX = 28;

export function popularLabel(name: string): string {
  let s = name.replace(/\s+/g, ' ').trim();
  const cut = s.search(/\s[—–-]\s|[,(|/·]/);
  if (cut > 3) s = s.slice(0, cut).trim();
  if (s.length <= MAX) return s;
  const words = s.split(' ');
  let out = '';
  for (const w of words) {
    if ((out ? out.length + 1 : 0) + w.length > MAX) break;
    out = out ? `${out} ${w}` : w;
  }
  return out || s.slice(0, MAX);
}
