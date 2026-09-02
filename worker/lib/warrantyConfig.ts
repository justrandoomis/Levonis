/**
 * The warranty receipt's CONFIGURATION: the shop's own details and the
 * wording the document prints.
 *
 * NOT THE SAME THING AS THE WARRANTY POLICY. `policy_documents` (key
 * `warranty`) holds the long-form, versioned policy a customer accepts and
 * the thermal slip quotes; it is legal prose. What a receipt PRINTS is the
 * short list of conditions that fits on the paper next to the device, plus
 * the shop's own contact block and the default period. Those are here, and
 * each issued receipt keeps the copy it was printed with, so re-wording this
 * never rewrites a document already in a customer's hands.
 *
 * Its own module, and a leaf one: worker/lib/settings.ts stores this shape
 * under the `warrantyConfig` key, and settings is imported by half the
 * worker. Keeping the defaults in warranty.ts (which reads device coverage)
 * closed a cycle — settings -> warranty -> membershipOps -> settings — that
 * left the constant uninitialised at import time. Nothing here imports
 * anything but the JSON reader.
 */

import { safeParse } from './types';

/** One line of the printed terms, in both languages the shop serves. */
export interface WarrantyTermLine {
  ar: string;
  en: string;
}

export interface WarrantyRetailer {
  name: string;
  address_ar: string;
  address_en: string;
  phone: string;
  website: string;
  instagram: string;
}

export interface WarrantyConfig {
  /** Default coverage length in months when a unit carries no configured one. */
  default_months: number;
  type_ar: string;
  type_en: string;
  coverage_ar: string;
  coverage_en: string;
  terms: WarrantyTermLine[];
  retailer: WarrantyRetailer;
  /** Bumped by the admin when the wording changes; snapshotted per receipt. */
  version: number;
}

/**
 * The shop's own details and the default wording. Editable from the admin
 * (admin_settings key `warrantyConfig`) — every sentence here is a DEFAULT,
 * not a constant, because the owner asked for terms they can change without
 * a deploy. What a receipt prints is the copy taken at issue time.
 */
export const DEFAULT_WARRANTY_CONFIG: WarrantyConfig = {
  default_months: 12,
  type_ar: 'ضمان ليفونيس',
  type_en: 'Levonis Warranty',
  coverage_ar:
    'يغطي عيوب التصنيع وأعطال الأجزاء تحت الاستعمال الطبيعي. لا يشمل الضرر الفيزيائي وسوء الاستعمال والسوائل والحروق والأضرار الكهربائية الناتجة عن مصدر طاقة غير مناسب والإصلاح أو التعديل غير المُصرَّح به والعبث بالرقم التسلسلي والضرر الناتج عن تركيب خاطئ أو استعمال خارج مواصفات المُصنِّع والمشاكل البرمجية وحدها ما لم يُنص على تغطيتها.',
  coverage_en:
    'Covers manufacturing defects and hardware failures under normal use. It does not cover physical damage, misuse, liquid damage, burns, electrical damage from an improper power source, unauthorized repair or modification, serial-number tampering, damage from incorrect installation or use outside the manufacturer’s specifications, or software-only problems unless explicitly covered.',
  terms: [
    {
      ar: 'يجب إبراز هذا الوصل عند طلب خدمة الضمان.',
      en: 'Present this receipt when requesting warranty service.',
    },
    {
      ar: 'يجب أن يطابق الرقم التسلسلي على الجهاز الرقم المذكور في هذا الوصل.',
      en: 'The serial number on the device must match the one on this receipt.',
    },
    {
      ar: 'لليفونيس أن تفحص الجهاز وتُشخّصه قبل الموافقة على الإصلاح أو الاستبدال.',
      en: 'Levonis may inspect and diagnose the product before approving repair or replacement.',
    },
    {
      ar: 'الضمان لا يعني الاستبدال تلقائيًا؛ قرار الإصلاح أو الاستبدال يتبع نتيجة الفحص والسياسة المعتمدة.',
      en: 'Warranty does not automatically mean replacement; the repair or replacement decision follows the inspection and the applicable policy.',
    },
    {
      ar: 'الجهاز البديل يكمل المدة المتبقية من الضمان الأصلي ما لم تُمدَّد صراحةً من الإدارة.',
      en: 'A replacement unit continues the remaining original warranty unless the administration explicitly extends it.',
    },
    {
      ar: 'يسقط الضمان إذا أُزيل الرقم التسلسلي أو عُبث به.',
      en: 'The warranty is void if the serial number has been removed or altered.',
    },
    {
      ar: 'قد تُطبَّق سياسة الشركة المصنّعة حيثما كانت ذات صلة.',
      en: 'The manufacturer’s applicable policy may also apply where relevant.',
    },
  ],
  retailer: {
    name: 'LEVONIS',
    address_ar: 'بابل — الحلة',
    address_en: 'Babil - Al Hilla',
    phone: '07838455220',
    website: 'LEVONIS-IQ.COM',
    instagram: '@LEVONIS_IQ',
  },
  version: 1,
};

/** Parses a stored config, filling anything missing from the default. */
export function parseWarrantyConfig(raw: unknown): WarrantyConfig {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : safeParse<Record<string, unknown>>(raw, {});
  const d = DEFAULT_WARRANTY_CONFIG;
  const months = obj.default_months;
  const retailer = (typeof obj.retailer === 'object' && obj.retailer !== null ? obj.retailer : {}) as Record<string, unknown>;
  const s = (v: unknown, fallback: string, max = 2000): string =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback;
  const terms = Array.isArray(obj.terms)
    ? (obj.terms as unknown[])
        .map((t) => {
          const o = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>;
          return { ar: s(o.ar, '', 500), en: s(o.en, '', 500) };
        })
        .filter((t) => t.ar || t.en)
        .slice(0, 30)
    : d.terms;
  return {
    default_months:
      typeof months === 'number' && Number.isInteger(months) && months >= 1 && months <= 240 ? months : d.default_months,
    type_ar: s(obj.type_ar, d.type_ar, 120),
    type_en: s(obj.type_en, d.type_en, 120),
    coverage_ar: s(obj.coverage_ar, d.coverage_ar),
    coverage_en: s(obj.coverage_en, d.coverage_en),
    terms: terms.length ? terms : d.terms,
    retailer: {
      name: s(retailer.name, d.retailer.name, 120),
      address_ar: s(retailer.address_ar, d.retailer.address_ar, 200),
      address_en: s(retailer.address_en, d.retailer.address_en, 200),
      phone: s(retailer.phone, d.retailer.phone, 40),
      website: s(retailer.website, d.retailer.website, 120),
      instagram: s(retailer.instagram, d.retailer.instagram, 120),
    },
    version: typeof obj.version === 'number' && Number.isFinite(obj.version) ? obj.version : d.version,
  };
}

