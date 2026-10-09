/**
 * A PURCHASE DOCUMENT'S LINES AND CHARGES, PARSED AND COMPUTED — the pure part
 * of `planDocument` (worker/routes/adminProcurement.ts), extracted so the
 * owner's procurement pricing preview reads a draft through the very parser the
 * purchase POST and PUT use (USD design §6.3 step 1, fit #20: the draft is
 * never key-allow-listed twice).
 *
 * Reads only: the route profiles, each line's selection (`requireSelection`)
 * and nothing else. It validates exactly as the save does and throws the same
 * refusals; the ids it mints for the incoming row and the line are used by the
 * save alone.
 */
import { procurementSelectionKey, type CostProfile } from '../../packages/contracts/src/procurementCost';
import { badRequest, conflict, str } from './http';
import { newId } from './crypto';
import { requireSelection, type Selection } from './inventorySelection';
import { decimal, whole } from './operations';
import { packedMeasure, procurementAmount, procurementProfiles, profileRates, purchaseChargeShares, purchaseCharges, type PurchaseCharge } from './procurementCosts';

const text = (v: unknown, max = 200) => str(v, 'text', { max, required: false }) ?? '';

export interface DraftLine {
  sel: Selection;
  qty: number;
  unit: number;
  total: number;
  costMode: 'unit' | 'total';
  source: number;
  sourceTotal: number | null;
  weight: number;
  volume: number;
  invoiceQty: number;
  selling: number | null;
  charges: number;
  autoShipping: number;
  key: string;
  incomingId: string;
  lineId: string;
}

export interface ParsedDraft {
  profile: CostProfile | undefined;
  profileVersion: number | null;
  shippingRate: number | null;
  currency: string;
  rate: number;
  lines: DraftLine[];
  charges: PurchaseCharge[];
  /** shares[charge][line]: the whole dinars each charge puts on each line. */
  shares: number[][];
}

/** Parse and compute a purchase body's lines and charges (see the file header). */
export async function parseProcurementDraft(db: D1Database, b: Record<string, unknown>): Promise<ParsedDraft> {
  const profileId = text(b.cost_profile_id, 30);
  const profile = profileId ? (await procurementProfiles(db)).find(row => row.id === profileId) : undefined;
  if (profileId && !profile) throw badRequest('مسار التوريد غير صحيح', 'INVALID_COST_PROFILE');
  if (profile && (b.currency !== profile.currency || (b.shipping_basis != null && b.shipping_basis !== profile.shipping_basis)))
    throw badRequest('عملة ومسار الشحن لا يتطابقان', 'COST_PROFILE_MISMATCH');
  const profileVersion = profile ? whole(b.cost_profile_version, 'إصدار أسعار المسار', 1) : null;
  if (profile && profile.version !== profileVersion)
    throw conflict('تغيرت أسعار مسار التوريد؛ حدّث البيانات وأعد المحاولة', 'COST_PROFILE_CHANGED');
  const shippingRate = profile ? profileRates(b).shipping_rate_iqd : null;
  if (!profile && b.shipping_rate_iqd != null && b.shipping_rate_iqd !== '')
    throw badRequest('اختر مسار التوريد لحساب الشحن تلقائياً', 'INVALID_COST_PROFILE');
  const currency = text(b.currency, 8) || 'IQD';
  if (!['IQD', 'USD', 'CNY', 'EUR'].includes(currency)) throw badRequest('Unsupported currency');
  const rate = currency === 'IQD' ? 1 : decimal(b.exchange_rate, 'سعر الصرف', 0.000001);
  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (raw.length < 1 || raw.length > 30) throw badRequest('أضف بين منتج واحد و30 منتجًا في الشحنة');
  const lines: DraftLine[] = [];
  for (const v of raw) {
    const r = v as Record<string, unknown>;
    const sel = await requireSelection(db, text(r.product_id, 60), text(r.scope, 20), text(r.scope_id, 60));
    if (profile && ((r.option_id != null && r.option_id !== '' && r.option_id !== sel.option_id) ||
        (r.color_id != null && r.color_id !== '' && r.color_id !== sel.color_id)))
      throw badRequest('اختر هوية المخزون المطابقة للخيار واللون؛ تكلفة الألوان المنفصلة تتطلب مخزون تركيبات', 'INVALID_SELECTION');
    const qty = whole(r.qty_ordered, 'الكمية', 1, 100000);
    const costMode=r.purchase_cost_mode==='total'?'total':'unit';
    const entered=decimal(costMode==='total' ? (profile ? r.source_total_amount : r.source_total_amount??r.purchase_total_iqd) : (profile ? r.source_unit_amount : r.source_unit_amount??r.purchase_unit_iqd),'تكلفة الشراء الخام');
    if(currency==='IQD')whole(entered,'تكلفة الشراء بالدينار');
    const total = profile
      ? procurementAmount(costMode === 'total' ? [entered, rate] : [entered, rate, qty])
      : whole(Math.round(costMode === 'total' ? entered * rate : Math.round(entered * rate) * qty), 'إجمالي شراء البند');
    const unit=Math.floor(total/qty),source=costMode==='total'?entered/qty:entered;
    const weight = packedMeasure(r.weight_g ?? (profile ? sel.packed_weight_g ?? 0 : sel.weight_g), 'الوزن'),
      volume = packedMeasure(r.volume_mm3 ?? (profile ? sel.packed_volume_mm3 ?? 0 : sel.volume_mm3), 'الحجم');
    if (profile && (profile.shipping_basis === 'weight' ? weight : volume) <= 0)
      throw badRequest('أدخل وزن الكرتون مع التغليف أو حجمه لجميع البنود', 'PACKED_MEASUREMENT_REQUIRED');
    const autoShipping = profile ? procurementAmount([qty, profile.shipping_basis === 'weight' ? weight : volume, shippingRate!], profile.shipping_basis === 'weight' ? 1000 : 1e9) : 0;
    lines.push({
      sel,
      qty,
      unit,
      total,
      costMode,
      source,
      sourceTotal: costMode === 'total' ? entered : null,
      weight,
      volume,
      invoiceQty: whole(r.invoiced_qty ?? qty, 'كمية الفاتورة', 0, 100000),
      selling:
        r.selling_price_iqd === null
          ? null
          : whole(r.selling_price_iqd ?? sel.selling_price_iqd, 'سعر البيع'),
      charges: autoShipping,
      autoShipping,
      key: procurementSelectionKey(sel),
      incomingId: newId('inc'),
      lineId: newId('pol'),
    });
  }
  // Extra costs are only what was typed for this document's own lines. Route
  // freight above is already in l.charges; nothing here repeats it.
  const charges = purchaseCharges(b.charges, lines.map((l) => l.key), !!profile);
  const shares = purchaseChargeShares(
    charges,
    lines.map((l) => ({ key: l.key, qty: l.qty, value: l.total, weight_g: l.weight, volume_mm3: l.volume })),
    profile ? 'BAD_ALLOCATION' : 'ALLOCATION_BASIS_MISSING',
  );
  shares.forEach((row) => row.forEach((share, i) => (lines[i].charges += share)));
  whole(
    lines.reduce((n, l) => n + l.total + l.charges, 0),
    'مجموع الشحنة',
  );
  return { profile, profileVersion, shippingRate, currency, rate, lines, charges, shares };
}
