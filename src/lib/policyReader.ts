/** A historical deep link must never silently fall back to today's policy. */
export function parsePolicyVersion(raw: string | null): { valid: boolean; version: number | null } {
  if (raw === null) return { valid: true, version: null };
  if (!/^\d+$/.test(raw)) return { valid: false, version: null };
  const version = Number(raw);
  return Number.isSafeInteger(version) && version >= 1 && version <= 1_000_000
    ? { valid: true, version }
    : { valid: false, version: null };
}

export function policyDocumentUrl(key: string, version: number | null, lang: string): string {
  const locale = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  return `/api/policies/${encodeURIComponent(key)}?lang=${locale}${version === null ? '' : `&version=${version}`}`;
}

export function policyHeadings(body: string): Array<{ id: string; title: string }> {
  return body.split('\n').flatMap((line, index) => {
    const text = line.trim();
    return text.startsWith('## ') ? [{ id: `policy-section-${index}`, title: text.slice(3) }] : [];
  });
}
