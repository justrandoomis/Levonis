/**
 * An order that spent several reward coupons together (0225; DECISIONS row 295)
 * says how many on its discount line, where one coupon says its code.
 */
export function couponPoolLabel(n: number, lang: string): string {
  if (lang === 'en') return `${n} coupons`;
  if (lang === 'ckb') return `داشکاندنی ${n} کۆپۆن`;
  if (n === 2) return 'خصم كوبونين';
  return n <= 10 ? `خصم ${n} كوبونات` : `خصم ${n} كوبونًا`;
}
