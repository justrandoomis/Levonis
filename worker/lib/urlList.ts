export function splitUrlList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\r\n]+/)
    .flatMap((line) => line.split(/\s+/))
    .map((s) => s.trim().replace(/^,+|,+$/g, ''))
    .filter(Boolean);
}
