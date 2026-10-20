/**
 * THE SIGNED-IN VIEWER'S OWN PRINTERS — a SESSION tool.
 *
 * Moved here from worker/routes/support.ts unchanged, so the support card and
 * the triage read one list. The user id is the session's; nothing a request
 * body carries can change whose devices these are.
 */
import { serialAssignmentsInstalled } from '../../serialPolicy';
import { tradedInSql } from '../../deviceCustody';
import { maskSerial } from '../../deviceOps';
import type { Locale, ModelToken } from '../types';
import { latinModels } from '../understand/models';

export interface DeviceLite extends Record<string, unknown> {
  id: string;
  delivered_at: string | null;
  warranty_end_at: string | null;
  policy_version: string | null;
  serial_raw: string | null;
  name_snapshot: string | null;
  p_name: string | null;
  p_name_ar: string | null;
  p_name_ku: string | null;
}

/**
 * The devices the support card may talk about: the caller's live links, minus
 * a device that came back to Levonis — traded in (owner decision 3, derived)
 * or returned (its unit closed, 0178) — even where its link outlived that.
 */
export async function ownDevices(db: D1Database, userId: string): Promise<DeviceLite[]> {
  const notClosed = (await serialAssignmentsInstalled(db)) ? 'AND u.warranty_closed_at IS NULL' : '';
  const { results } = await db
    .prepare(
      `SELECT u.id, u.delivered_at, u.warranty_end_at, u.policy_version, s.serial_raw, oi.name_snapshot,
              p.name AS p_name, p.name_ar AS p_name_ar, p.name_ku AS p_name_ku
         FROM device_registrations r
         JOIN order_item_units u ON u.id = r.unit_id
         LEFT JOIN device_serials s ON s.unit_id = u.id
         LEFT JOIN order_items oi ON oi.id = u.order_item_id
         LEFT JOIN products p ON p.id = u.product_id
        WHERE r.user_id = ? AND r.revoked_at IS NULL ${notClosed}
          AND ${tradedInSql('u')} IS NULL
        ORDER BY r.registered_at DESC
        LIMIT 10`
    )
    .bind(userId)
    .all<DeviceLite>();
  return results;
}

export function deviceName(loc: Locale, d: Pick<DeviceLite, 'p_name' | 'p_name_ar' | 'p_name_ku' | 'name_snapshot'>): string {
  const ar = d.p_name_ar || '';
  const en = d.p_name || '';
  const ckb = d.p_name_ku || '';
  const fallback = d.name_snapshot || en || ar || ckb || '—';
  if (loc === 'en') return en || fallback;
  if (loc === 'ckb') return ckb || ar || fallback;
  return ar || fallback;
}

export interface MyPrinter {
  unit_id: string;
  model: ModelToken;
  /** The product name in the viewer's language, and the serial's masked tail. */
  label: string;
}

/**
 * The viewer's devices that are printers the registry can name, newest first.
 * A registered AMS or an accessory is not a printer chip.
 */
export function printersOf(devices: readonly DeviceLite[], loc: Locale): MyPrinter[] {
  const out: MyPrinter[] = [];
  for (const d of devices) {
    const model = latinModels(`${d.p_name ?? ''} ${d.name_snapshot ?? ''}`)[0];
    if (!model) continue;
    const name = deviceName(loc, d);
    out.push({ unit_id: String(d.id), model, label: d.serial_raw ? `${name} · ${maskSerial(d.serial_raw)}` : name });
  }
  return out;
}
