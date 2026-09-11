import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorityDeliveryVerdict } from '../worker/lib/priorityDelivery';
import type { TierStatus } from '../worker/lib/entitlements';
import type { ProPriorityDeliveryConfig } from '../worker/lib/settings';

const NOW = '2026-09-11T12:00:00.000Z';
const address = { governorate: 'Baghdad', city: 'Baghdad' };
const config: ProPriorityDeliveryConfig = {
  enabled: true,
  max_hours: 12,
  delivery_method_ids: ['personal'],
  shipping_types: ['direct'],
  governorates: ['Baghdad'],
};
const status = (tier: TierStatus['tier'], active = true, gated_benefits: string[] = []): TierStatus => ({
  tier,
  active,
  expires_at: active ? '2099-01-01T00:00:00.000Z' : null,
  pending_launch: null,
  gated_benefits,
});

const verdict = (over: Partial<Parameters<typeof priorityDeliveryVerdict>[0]> = {}) =>
  priorityDeliveryVerdict({
    status: status('pro'),
    atApprovedDefault: true,
    config,
    deliveryMethodId: 'personal',
    shippingType: 'direct',
    address,
    nowIso: NOW,
    ...over,
  });

test('eligible PRO orders receive a real 12-hour deadline', () => {
  assert.deepEqual(verdict(), {
    eligible: true,
    max_hours: 12,
    due_at: '2026-09-12T00:00:00.000Z',
    reason: null,
  });
});

test('PLUS, PREMIUM, expired PRO and restricted PRO never receive the 12-hour service', () => {
  assert.equal(verdict({ status: status('plus') }).reason, 'PRO_REQUIRED');
  assert.equal(verdict({ status: status('prime') }).reason, 'PRO_REQUIRED');
  assert.equal(verdict({ status: status('pro', false) }).reason, 'PRO_REQUIRED');
  assert.equal(verdict({ status: status('pro', true, ['priorityDelivery12h']) }).reason, 'PRO_REQUIRED');
});

test('address, method, shipping type, area and service switch are enforced server-side', () => {
  assert.equal(verdict({ atApprovedDefault: false }).reason, 'APPROVED_ADDRESS_REQUIRED');
  assert.equal(verdict({ deliveryMethodId: 'standard' }).reason, 'DELIVERY_METHOD_UNAVAILABLE');
  assert.equal(verdict({ shippingType: 'preorder_air' }).reason, 'SHIPPING_TYPE_UNAVAILABLE');
  assert.equal(verdict({ address: { governorate: 'Basra' } }).reason, 'AREA_UNAVAILABLE');
  assert.equal(verdict({ config: { ...config, enabled: false } }).reason, 'SERVICE_DISABLED');
});
