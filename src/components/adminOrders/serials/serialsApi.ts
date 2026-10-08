/**
 * The calls of the serial scan (worker/routes/adminOrderSerials.ts) and the
 * small rules the screen shares about them. Every decision is the server's:
 * these only carry what was read and say what came back.
 */
import { api, ApiError } from '../../../lib/api';
import { refusalText } from '../../../lib/refusalStrings';
import type { Language } from '../../../translations';
import { classifyCode, normalizeSerial } from '../../../../packages/catalog/src/deviceSerials';
import { dateLocale } from '../../orders/format';
import { serialStrings } from './strings';
import type { LinkResult, LinkSource, OrderSerials, OverrideKind, UnlinkResult } from './types';

const base = (orderId: string) => `/api/admin/orders/${encodeURIComponent(orderId)}/serials`;

/**
 * The scan doors speak for themselves: the slot and the sheet show the verdict
 * and sound it (a light tap and a chime, or the error tone), so the app's
 * character stays out of it — three units read by a USB reader would
 * otherwise be three celebrations over the work (mascotRequest.ts: «the screen
 * that asked knows the answer and says so itself»).
 */
const QUIET = { mascot: 'silent' as const };

/**
 * ONE OPERATION ID PER READ. A double tap, a wedge that sends Enter twice or a
 * retry after a dropped response replays the SAME id, and the server answers
 * `already` instead of linking twice (§24).
 */
export function newOpId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* an insecure context has no randomUUID */
  }
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `op-${Date.now().toString(36)}-${rnd()}${rnd()}`;
}

export interface ReadPayload {
  code: string;
  ean?: string | null;
  box_sn?: string | null;
  source: LinkSource;
}

const clean = (r: ReadPayload) => ({
  code: r.code,
  ...(r.ean ? { ean: r.ean } : {}),
  ...(r.box_sn && normalizeSerial(r.box_sn) !== normalizeSerial(r.code) ? { box_sn: r.box_sn } : {}),
  source: r.source,
});

export const serialsApi = {
  // A background re-read after a link the screen already shows: the mascot stays out of it.
  view: (orderId: string) => api.get<{ serials: OrderSerials }>(base(orderId), QUIET).then((r) => r.serials),
  scan: (orderId: string, slot: { order_item_id: string; unit_index: number; part: string }, read: ReadPayload, opId: string) =>
    api.post<LinkResult>(`${base(orderId)}/scan`, { order_item_id: slot.order_item_id, unit_index: slot.unit_index, part: slot.part, ...clean(read), op_id: opId }, QUIET),
  change: (orderId: string, assignmentId: string, read: ReadPayload, opId: string) =>
    api.post<LinkResult>(`${base(orderId)}/change`, { assignment_id: assignmentId, ...clean(read), op_id: opId }, QUIET),
  unlink: (orderId: string, assignmentId: string, reason?: string) =>
    api.post<UnlinkResult>(`${base(orderId)}/unlink`, { assignment_id: assignmentId, ...(reason ? { reason } : {}) }, QUIET),
  override: (
    orderId: string,
    target: { order_item_id: string; unit_index: number; part: string; assignment_id?: string },
    read: ReadPayload,
    o: { kind: OverrideKind; reason: string; warranty_mode?: 'carry' | 'restart' },
    opId: string
  ) =>
    api.post<LinkResult>(`${base(orderId)}/override`, {
      ...(target.assignment_id ? { assignment_id: target.assignment_id } : { order_item_id: target.order_item_id, unit_index: target.unit_index, part: target.part }),
      code: read.code,
      ...(read.ean ? { ean: read.ean } : {}),
      ...(read.box_sn ? { box_sn: read.box_sn } : {}),
      kind: o.kind,
      reason: o.reason,
      ...(o.warranty_mode ? { warranty_mode: o.warranty_mode } : {}),
      op_id: opId,
    }, QUIET),
};

/**
 * WHICH OWNER EXCEPTION ANSWERS WHICH REFUSAL (worker/lib/serialAssignments.ts
 * classifyLink). A refusal with no entry has no exception: a product mismatch
 * is corrected on the asset, a voided device is restored first.
 */
export function overrideFor(err: unknown): OverrideKind | null {
  if (!(err instanceof ApiError)) return null;
  const d = (err.details ?? {}) as Record<string, unknown>;
  switch (err.code) {
    case 'SERIAL_IN_USE':
      return 'take_from_order';
    case 'SERIAL_DELIVERED':
      return 'delivered_device';
    case 'SERIAL_NOT_AVAILABLE':
      return d.reason === 'void' ? null : 'unavailable';
    case 'ORDER_NOT_PREPARABLE':
      // A merchant order, a cancelled or delivered one: nothing to override.
      return d.status === 'cancelled' || d.status === 'delivered' ? null : 'outside_window';
    case 'SERIAL_BATCH_MISMATCH':
      return 'batch';
    case 'SERIAL_MODEL_MISMATCH':
      return 'model_family';
    default:
      return null;
  }
}

/** The refusal in the reader's language: the code's sentence, then its detail. */
export function serialRefusal(err: unknown, lang: Language | string): { text: string; detail: string | null } {
  const s = serialStrings(lang);
  const l = (lang === 'en' || lang === 'ckb' ? lang : 'ar') as 'ar' | 'en' | 'ckb';
  if (!(err instanceof ApiError)) return { text: s.failed, detail: null };
  const d = (err.details ?? {}) as Record<string, unknown>;
  if (err.code === 'SERIAL_DELIVERED' && d.active_warranty === true) return { text: s.deliveredActive, detail: null };
  const text = refusalText(err.code, l, err.message || s.failed);
  let detail: string | null = null;
  if (err.code === 'SERIAL_INVALID' && typeof d.problem === 'string') detail = s.problems[d.problem] ?? null;
  if (err.code === 'SERIAL_IN_USE_THIS_ORDER' && typeof d.unit_index === 'number') detail = s.inUseHere(d.unit_index);
  return { text, detail };
}

/**
 * H1: never move focus on after a value that is a BOX SN — the next read is
 * almost always the product SN of the same box, and it belongs to THIS unit.
 * The server resolves a known box to its device, so the link may well have
 * succeeded; only the auto-advance is withheld.
 */
export function looksLikeBoxSn(text: string): boolean {
  const stripped = String(text ?? '').replace(/^\s*(?:product\s*)?s\s*\/?\s*n(?:\s*[:：#]\s*|\s+)(?=\S)/i, '');
  return classifyCode({ text: stripped }).kind === 'box_sn';
}

/**
 * A short date in the reader's language, Latin digits (the orders screens'
 * `dateLocale`: Sorani reads the Iraqi calendar names, as everywhere else).
 */
export function shortDate(iso: string | null | undefined, lang: Language | string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  try {
    return d.toLocaleDateString(dateLocale(lang), { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

export function dateTime(iso: string | null | undefined, lang: Language | string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  try {
    return d.toLocaleString(dateLocale(lang), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}
