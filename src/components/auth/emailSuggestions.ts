// Lucian UX/UI Prompt #264 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#264
export const EMAIL_DOMAINS = ['gmail.com', 'icloud.com', 'outlook.com', 'yahoo.com', 'hotmail.com'] as const;

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** Suggestions only: custom domains remain valid and never change without a click. */
export function emailSuggestions(value: string): { domains: string[]; correction: string | null } {
  const parts = value.trim().split('@');
  if (parts.length !== 2 || !parts[0] || /\s/.test(value) || parts[1].length > 40) return { domains: [], correction: null };
  const domain = parts[1].toLowerCase();
  const prefix = parts[0] + '@';
  if (EMAIL_DOMAINS.some((d) => d === domain)) return { domains: [], correction: null };
  const domains = EMAIL_DOMAINS.filter((d) => d.startsWith(domain)).slice(0, 4).map((d) => prefix + d);
  if (domains.length || !/\.[a-z]{2,}$/i.test(domain)) return { domains, correction: null };
  const candidates = EMAIL_DOMAINS.map((d) => ({ domain: d, distance: distance(domain, d) })).filter((d) => d.distance <= 2).sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  return { domains: [], correction: best && best.distance !== candidates[1]?.distance ? prefix + best.domain : null };
}
