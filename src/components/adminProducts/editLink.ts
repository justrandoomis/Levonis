/**
 * THE EDITOR'S DEEP LINK: `/admin?tab=products&edit=<id>&section=<1–8>` opens that product's editor with
 * that form section open and scrolled to (the import dashboard's «أبعاد الشحن» list links section ٤, the
 * offers' links section ٣). An unsafe id opens nothing; a section outside 1–8 opens the form as usual.
 */
export interface EditLink {
  id: string;
  section: number | null;
}

export function readEditLink(search: string): EditLink | null {
  const q = new URLSearchParams(search);
  const id = q.get('edit') ?? '';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  const section = q.get('section') ?? '';
  return { id, section: /^[1-8]$/.test(section) ? Number(section) : null };
}
