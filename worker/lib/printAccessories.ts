/**
 * «أضف خاصية جديدة وهي إضافة مواد من إكسسوارات ميكر وورد مثل المغناطيس ومحرك
 *  وميدالية … إذا كانت الطبعة تحتاج إلى عدد من المغناطيس أو مصباح أو محرك أو
 *  أسلاك وغيرها» — THE HARDWARE A PRINT NEEDS, PRICED WITH IT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A MATERIAL.
 *
 * `printMaterials` answers "what is this printed FROM", and every number in it
 * is per kilogram and multiplied by a weight the geometry produced. A magnet is
 * none of that: it is priced per piece, its count comes from the MODEL's
 * instructions and not from its volume, and no amount of measuring an STL will
 * ever tell you that the design wants six 6×3 mm magnets and a 9 V motor.
 *
 * So it is its own catalogue with its own unit, and the count is ASKED FOR
 * rather than derived. A MakerWorld listing says "6× magnet 6×3mm, 1× LED, 20cm
 * wire" on the page; this is where that list becomes money.
 *
 * ---------------------------------------------------------------------------
 * HARDWARE IS NOT CONSUMED BY A FAILED PRINT, AND THAT IS A PRICING DECISION.
 *
 * Every other cost in a quote carries a share of the failure provision: if one
 * run in twenty fails, the plastic, the electricity and the machine hours of
 * that run are really spent and the price has to carry them. The magnets are
 * not. They are pressed into the part AFTER it comes off the plate, so a failed
 * print leaves them in the drawer, and charging a failure provision on them
 * would be charging the customer for a loss nobody takes.
 *
 * Both engines therefore add hardware AFTER the risk provision is computed —
 * worker/lib/printPricing.ts keeps it out of `attemptIqd`, and
 * worker/lib/printQuote/model.ts keeps `HARDWARE` out of `VARIABLE_COMPONENTS`.
 * It still goes through the margin like every other cost: the shop buys the
 * magnet, stocks it and fits it, and a part sold at exactly what its hardware
 * cost is a part sold at a loss on the labour of fitting it.
 *
 * ---------------------------------------------------------------------------
 * THE SEEDED PRICES ARE A STARTING POINT AND SAY SO.
 *
 * Every row here is admin-editable, for exactly the reason `DEFAULT_MATERIALS`
 * is: these are Iraqi market reference points in 2026 dinars and they will
 * drift. What is NOT a guess is the shape — the unit each one is counted in —
 * because a magnet sold per piece and wire sold per metre cannot share a
 * column without one of them being wrong every time.
 */

/** How a row is counted. The unit is shown beside the quantity box, so a
 *  customer typing "20" into wire knows whether that is 20 cm or 20 pieces. */
export type AccessoryUnit = 'piece' | 'pair' | 'set' | 'cm' | 'gram';

export interface PrintAccessory {
  id: string;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  unit: AccessoryUnit;
  /** What ONE unit costs the shop. Dinars, never fractions of one. */
  cost_iqd: number;
  /** Grouping for the picker, so a list of thirty rows is still readable. */
  category: 'magnet' | 'motion' | 'electronics' | 'fastener' | 'finishing';
  active: boolean;
}

const acc = (
  id: string,
  name_ar: string,
  name_en: string,
  name_ckb: string,
  unit: AccessoryUnit,
  cost_iqd: number,
  category: PrintAccessory['category']
): PrintAccessory => ({ id, name_ar, name_en, name_ckb, unit, cost_iqd, category, active: true });

/**
 * The seed catalogue: what the owner named, plus the rest of the short list a
 * MakerWorld bill of materials actually draws from.
 *
 * THREE MAGNET SIZES AND NOT ONE «مغناطيس». The whole point of this feature is
 * an accurate number, and a 6×3 mm disc and a 10×3 mm disc are not the same
 * money — folding them into one row would put the arithmetic back where it was,
 * which is the shop guessing.
 */
export const DEFAULT_ACCESSORIES: PrintAccessory[] = [
  // ——— magnets: the single most common insert in printed models
  acc('magnet-6x3', 'مغناطيس 6×3 ملم', 'Magnet 6×3 mm', 'ماگنێت ٦×٣ مم', 'piece', 250, 'magnet'),
  acc('magnet-8x3', 'مغناطيس 8×3 ملم', 'Magnet 8×3 mm', 'ماگنێت ٨×٣ مم', 'piece', 350, 'magnet'),
  acc('magnet-10x3', 'مغناطيس 10×3 ملم', 'Magnet 10×3 mm', 'ماگنێت ١٠×٣ مم', 'piece', 500, 'magnet'),
  acc('magnet-20x3', 'مغناطيس 20×3 ملم', 'Magnet 20×3 mm', 'ماگنێت ٢٠×٣ مم', 'piece', 1_000, 'magnet'),

  // ——— things that move
  acc('motor-n20', 'محرك N20 مع صندوق تروس', 'N20 gearmotor', 'مۆتۆری N20', 'piece', 6_000, 'motion'),
  acc('motor-sg90', 'سيرفو SG90', 'SG90 servo', 'سێرڤۆی SG90', 'piece', 5_000, 'motion'),
  acc('motor-28byj48', 'محرك خطوي 28BYJ-48 مع مشغّل', 'Stepper 28BYJ-48 + driver', 'مۆتۆری هەنگاوی 28BYJ-48', 'piece', 8_000, 'motion'),
  acc('bearing-608', 'بلي 608', '608 bearing', 'بلی ٦٠٨', 'piece', 1_000, 'motion'),
  acc('bearing-mr105', 'بلي MR105', 'MR105 bearing', 'بلی MR105', 'piece', 1_250, 'motion'),
  acc('spring-small', 'نابض صغير', 'Small spring', 'سپرینگی بچووک', 'piece', 500, 'motion'),

  // ——— things that light up or switch
  acc('led-5mm', 'ليد 5 ملم', 'LED 5 mm', 'LED ٥ مم', 'piece', 250, 'electronics'),
  acc('led-strip-ws2812', 'شريط ليد WS2812', 'WS2812 LED strip', 'شریتی LED WS2812', 'cm', 400, 'electronics'),
  acc('lamp-cob', 'مصباح COB صغير', 'Small COB lamp', 'لامپەی COB بچووک', 'piece', 2_500, 'electronics'),
  acc('switch-toggle', 'مفتاح صغير', 'Small switch', 'کلیلەی بچووک', 'piece', 1_000, 'electronics'),
  acc('battery-holder-aa', 'حامل بطارية AA', 'AA battery holder', 'هەڵگری باتری AA', 'piece', 1_500, 'electronics'),
  acc('usb-c-board', 'منفذ USB-C', 'USB-C breakout', 'پۆرتی USB-C', 'piece', 2_500, 'electronics'),
  acc('wire-22awg', 'سلك 22AWG', 'Wire 22AWG', 'وایەری 22AWG', 'cm', 50, 'electronics'),

  // ——— fasteners
  acc('screw-m3', 'برغي M3', 'M3 screw', 'برغی M3', 'piece', 250, 'fastener'),
  acc('nut-m3', 'صامولة M3', 'M3 nut', 'مۆرەی M3', 'piece', 150, 'fastener'),
  acc('insert-m3', 'إدخال حراري M3', 'M3 heat-set insert', 'ئینسێرتی گەرمی M3', 'piece', 400, 'fastener'),
  acc('rod-3mm', 'محور 3 ملم', '3 mm rod', 'تیرەی ٣ مم', 'cm', 200, 'fastener'),

  // ——— what turns a print into a thing you carry
  acc('keyring', 'حلقة ميدالية', 'Keyring', 'خڵخاڵی کلیل', 'piece', 500, 'finishing'),
  acc('lanyard', 'شريط تعليق', 'Lanyard', 'بەندی هەڵواسین', 'piece', 1_500, 'finishing'),
  acc('felt-pad', 'لبادة لاصقة', 'Felt pad', 'پەدی لکێنراو', 'piece', 150, 'finishing'),
  acc('glue-cyano', 'غراء سريع (استهلاك للقطعة)', 'Superglue (per part)', 'چەسپی خێرا', 'gram', 300, 'finishing'),
];

/** One requested row: the customer's count of one catalogue entry. */
export interface AccessorySelection {
  id: string;
  qty: number;
}

export interface PricedAccessory {
  id: string;
  qty: number;
  unit_iqd: number;
  iqd: number;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  unit: AccessoryUnit;
}

/** The largest count of any one accessory a single part may carry. A model
 *  wanting more than this is a data-entry slip, and a quote built on a slip is
 *  worse than a refusal. */
export const MAX_ACCESSORY_QTY = 500;

/**
 * Turn what the customer asked for into priced rows, dropping anything the
 * catalogue does not recognise.
 *
 * AN UNKNOWN ID IS DROPPED, NOT PRICED AT ZERO AND NOT THROWN ON. It reaches
 * here from a client that may be a version behind after the owner retires a
 * row, and the honest outcome is a quote for the accessories that still exist
 * — the caller is told which ones were dropped so the screen can say so.
 * Pricing an unknown row at 0 would quietly under-quote; throwing would turn
 * one stale menu entry into a shop that cannot quote at all.
 *
 * `perPart` MULTIPLIES BY THE COPY COUNT because these are per part by
 * definition: ten keychains need ten rings. It is the caller's quantity, not a
 * second one entered here, so the two can never disagree.
 */
export function priceAccessories(
  catalogue: readonly PrintAccessory[],
  selections: readonly AccessorySelection[],
  perPart = 1
): { lines: PricedAccessory[]; total_iqd: number; unknown: string[] } {
  const byId = new Map(catalogue.filter((a) => a.active !== false).map((a) => [a.id, a]));
  const copies = Math.max(1, Math.floor(perPart));
  const lines: PricedAccessory[] = [];
  const unknown: string[] = [];
  // Merged by id: two rows naming the same magnet are one line of six, not two
  // lines of three that the reader has to add up themselves.
  const wanted = new Map<string, number>();
  for (const s of selections) {
    const id = String(s?.id ?? '');
    const qty = Math.floor(Number(s?.qty));
    if (!id || !Number.isFinite(qty) || qty <= 0) continue;
    if (!byId.has(id)) {
      if (!unknown.includes(id)) unknown.push(id);
      continue;
    }
    wanted.set(id, Math.min(MAX_ACCESSORY_QTY, (wanted.get(id) ?? 0) + qty));
  }

  let total = 0;
  // Catalogue order, not request order: the breakdown reads the same way twice
  // for the same basket, whatever order the boxes were filled in.
  for (const a of catalogue) {
    const qty = wanted.get(a.id);
    if (qty === undefined) continue;
    const iqd = Math.round(a.cost_iqd * qty * copies);
    total += iqd;
    lines.push({
      id: a.id,
      qty: qty * copies,
      unit_iqd: a.cost_iqd,
      iqd,
      name_ar: a.name_ar,
      name_en: a.name_en,
      name_ckb: a.name_ckb,
      unit: a.unit,
    });
  }
  return { lines, total_iqd: total, unknown };
}

/**
 * Validate a catalogue the admin just saved. Returns the reasons it is
 * unusable, empty when it is fine — the same contract PrintPricingAdmin
 * already uses for materials.
 */
export function accessoryProblems(rows: readonly PrintAccessory[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const who = r?.name_ar || r?.id || '—';
    if (!r?.id || !/^[a-z0-9-]{2,40}$/.test(r.id)) out.push(`${who}: المعرّف يجب أن يكون حروفًا صغيرة وأرقامًا وشرطات`);
    else if (seen.has(r.id)) out.push(`${r.id}: معرّف مكرر`);
    else seen.add(r.id);
    if (!r?.name_ar) out.push(`${who}: الاسم العربي مطلوب`);
    if (!Number.isFinite(r?.cost_iqd) || r.cost_iqd < 0) out.push(`${who}: التكلفة لا تكون سالبة`);
    if (!Number.isInteger(r?.cost_iqd)) out.push(`${who}: التكلفة بالدينار الصحيح`);
  }
  return out;
}
