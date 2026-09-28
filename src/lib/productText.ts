/**
 * A PRODUCT'S WORDS IN THE READER'S LANGUAGE. A merchant writes the name (and
 * description) once, and may add an Arabic one; an Arabic reader gets the
 * Arabic words when the merchant wrote them, everyone else the name as written
 * — the community's product tile did this already, the store's own product
 * page and cards printed `name` to everyone (review of Levo Community,
 * 2026-09-28). Sorani readers get the name as written: no Sorani field exists.
 */
export interface ProductWords {
  name: string;
  name_ar?: string | null;
  description?: string | null;
  description_ar?: string | null;
}

export function productName(p: ProductWords, lang: string): string {
  return (lang === 'ar' && p.name_ar ? p.name_ar : p.name || p.name_ar) || '';
}

export function productDescription(p: ProductWords, lang: string): string {
  return (lang === 'ar' && p.description_ar ? p.description_ar : p.description || p.description_ar) || '';
}
