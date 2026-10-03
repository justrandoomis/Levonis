import { badRequest } from './http';
/** RFC 4180 fields, including commas, escaped quotes and embedded newlines. */
export function parsePurchaseCsv(input: string): Record<string, string>[] {
  if (input.length > 200000) throw badRequest('ملف الشراء أكبر من الحد المسموح');
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  const source = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) throw badRequest('علامة اقتباس غير مكتملة في CSV');
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  const headers = rows.shift()?.map((s) => s.trim().toLowerCase()) ?? [];
  if (!headers.includes('sku') || !headers.includes('qty') || !headers.includes('unit_amount'))
    throw badRequest('أعمدة CSV المطلوبة: sku,qty,unit_amount');
  if (new Set(headers).size !== headers.length || rows.length > 30)
    throw badRequest('أسماء أعمدة مكررة أو أكثر من 30 بندًا');
  return rows.map((r, i) => {
    if (r.length !== headers.length) throw badRequest(`عدد أعمدة السطر ${i + 2} غير صحيح`);
    return Object.fromEntries(headers.map((h, j) => [h, r[j].trim()]));
  });
}
