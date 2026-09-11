/** Server verdict for the PRO 12-hour fulfilment service. */
import { benefits, type TierStatus } from './entitlements';
import type { ProPriorityDeliveryConfig } from './settings';
import type { ShippingType } from './shippingType';

export interface PriorityDeliveryVerdict {
  eligible: boolean;
  max_hours: 12;
  due_at: string | null;
  reason:
    | null
    | 'PRO_REQUIRED'
    | 'APPROVED_ADDRESS_REQUIRED'
    | 'SERVICE_DISABLED'
    | 'DELIVERY_METHOD_UNAVAILABLE'
    | 'SHIPPING_TYPE_UNAVAILABLE'
    | 'AREA_UNAVAILABLE';
}

const normalized = (value: unknown) => String(value ?? '').trim().toLowerCase();

export function priorityDeliveryVerdict(input: {
  status: TierStatus;
  atApprovedDefault: boolean;
  config: ProPriorityDeliveryConfig;
  deliveryMethodId: string;
  shippingType: ShippingType;
  address: Record<string, unknown>;
  nowIso: string;
}): PriorityDeliveryVerdict {
  const base = { max_hours: 12 as const, due_at: null };
  if (!benefits.priorityDelivery12h(input.status)) return { ...base, eligible: false, reason: 'PRO_REQUIRED' };
  if (!input.atApprovedDefault) return { ...base, eligible: false, reason: 'APPROVED_ADDRESS_REQUIRED' };
  if (!input.config.enabled) return { ...base, eligible: false, reason: 'SERVICE_DISABLED' };
  if (!input.config.delivery_method_ids.includes(input.deliveryMethodId)) {
    return { ...base, eligible: false, reason: 'DELIVERY_METHOD_UNAVAILABLE' };
  }
  if (!input.config.shipping_types.includes(input.shippingType)) {
    return { ...base, eligible: false, reason: 'SHIPPING_TYPE_UNAVAILABLE' };
  }
  const areas = input.config.governorates.map(normalized).filter(Boolean);
  const governorate = normalized(input.address.governorate ?? input.address.city);
  if (areas.length > 0 && !areas.includes(governorate)) return { ...base, eligible: false, reason: 'AREA_UNAVAILABLE' };
  return {
    eligible: true,
    max_hours: 12,
    due_at: new Date(Date.parse(input.nowIso) + 12 * 3_600_000).toISOString(),
    reason: null,
  };
}

