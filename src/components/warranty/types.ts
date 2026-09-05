import type { Language } from '../../translations';

/**
 * Response shapes for the customer warranty surface (`/api/devices/*`).
 * Defined here rather than in lib/api.ts so the warranty components own the
 * contract they render; nothing else in the app reads these rows.
 */

export type WarrantyState = 'active' | 'expired' | 'not_delivered' | 'needs_config' | (string & {});

export interface DeviceProduct {
  id: string | null;
  slug: string | null;
  name: string;
  name_ar: string;
  name_ckb: string;
  image: string;
}

export interface Device {
  unit_id: string;
  /** The BUYER's order. Null when the viewer holds a transferred device: the order is someone else's. */
  order_id: string | null;
  order_item_id: string | null;
  unit_index: number;
  product: DeviceProduct;
  /** MASKED by the server, e.g. `****ABCD`. */
  serial: string | null;
  delivered_at: string | null;
  registered_at: string | null;
  warranty: {
    start_at: string | null;
    end_at: string | null;
    base_months: number | null;
    ext_months: number;
    state: WarrantyState;
    remaining_days: number | null;
  };
  replaced_by_unit_id: string | null;
  replacement_of_unit_id: string | null;
  receipt: { receipt_no: string; status: string } | null;
  open_claims: number;
  /** True when the holder is not the original buyer. */
  transferred: boolean;
}

export interface EligibleUnit extends Device {
  linked_elsewhere: boolean;
}

export type MembershipTier = 'free' | 'plus' | 'prime' | 'pro';

export interface MineResponse {
  devices: Device[];
  priority_service: boolean;
  tier: { tier: MembershipTier; active: boolean };
}

export interface RegisterResponse {
  device: Device;
  already_registered: boolean;
}

export type ClaimStage = 'received' | 'diagnosing' | 'approved' | 'rejected' | 'repairing' | 'replaced' | 'resolved';

export interface Claim {
  id: string;
  unit_id: string | null;
  order_item_id: string | null;
  subject: string;
  product_name: string;
  description: string;
  stage: ClaimStage | (string & {});
  legacy_status: string | null;
  decision: string | null;
  decision_reason: string;
  admin_note: string;
  evidence: Array<{ key: string; url: string }>;
  created_at: string;
  priority: boolean;
  serial: string | null;
}

export interface ClaimMessage {
  id: string;
  is_staff: boolean;
  mine: boolean;
  body: string;
  file_url: string | null;
  created_at: string;
}

export interface ClaimDetail {
  claim: Claim;
  warranty_facts: {
    order_id: string | null;
    delivered_at: string | null;
    warranty_end_at: string | null;
    state: string;
    remaining_days: number | null;
  } | null;
  messages: ClaimMessage[];
}

export interface Attachment {
  key: string;
  url: string;
  name: string;
  video: boolean;
}

// ----------------------------------------------------------------- helpers

/** Product name in the UI language: name_ar for ar, name_ckb for ckb (falling back to ar), else name. */
export function productName(p: DeviceProduct, lang: Language): string {
  if (lang === 'ar') return p.name_ar || p.name;
  if (lang === 'ckb') return p.name_ckb || p.name_ar || p.name;
  return p.name || p.name_ar;
}

/** Intl locale list for the UI language. ckb falls back to ar-IQ where ICU has no Sorani data. */
export function intlLocale(lang: Language): string | string[] {
  if (lang === 'en') return 'en-GB';
  if (lang === 'ckb') return ['ckb-IQ', 'ar-IQ'];
  return 'ar-IQ';
}

export function fmtDate(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(intlLocale(lang), { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

export function fmtDateTime(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(intlLocale(lang), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function fmtInt(n: number, lang: Language): string {
  try {
    return new Intl.NumberFormat(intlLocale(lang), { maximumFractionDigits: 0 }).format(n);
  } catch {
    return String(Math.round(n));
  }
}

export function isVideoUrl(u: string): boolean {
  return /\.(mp4|webm|mov)(\?|#|$)/i.test(u);
}

/** Stages during which the server treats a claim as open (blocks unlinking). */
export const OPEN_STAGES: ReadonlySet<string> = new Set(['received', 'diagnosing', 'approved', 'repairing']);

/** Where a stage sits on the received → diagnosing → decision → repair → resolved line. */
export function stageStep(stage: string): number {
  switch (stage) {
    case 'received':
      return 0;
    case 'diagnosing':
      return 1;
    case 'approved':
    case 'rejected':
      return 2;
    case 'repairing':
    case 'replaced':
      return 3;
    case 'resolved':
      return 4;
    default:
      return 0;
  }
}
