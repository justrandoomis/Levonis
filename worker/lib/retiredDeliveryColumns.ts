/**
 * THE RETIRED PER-PRODUCT DELIVERY COLUMNS (standard_/personal_delivery_*).
 *
 * Delivery is priced centrally by «إدارة التوصيل» (owner, 2026-10-18). A data
 * file (CSV sheet or TXT template) that still carries these cells imports;
 * the cells are ignored with ONE warning per file.
 */
export const RETIRED_DELIVERY_KEY = /^(standard|personal)_delivery_(enabled|quantity_step|fee_iqd)$/;

export const RETIRED_DELIVERY_WARNING =
  'standard_/personal_delivery_*: أُلغيت؛ التوصيل من إدارة التوصيل / retired — delivery is set in Delivery management / لابراون؛ گەیاندن لە بەڕێوەبردنی گەیاندنەوە دیاری دەکرێت';
