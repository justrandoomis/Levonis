/** Cash-on-delivery tax policy. Pure, integer-only, and shared by checkout tests. */

export const COD_TAX_BLOCK_IQD = 500_000;
export const COD_TAX_PER_BLOCK_IQD = 6_000;

/** 6,000 IQD for every complete 500,000 IQD payable at the door. */
export function calculateCodTaxIqd(codPayableBeforeTaxIqd: number): number {
  const base = Math.max(0, Math.trunc(codPayableBeforeTaxIqd));
  return Math.floor(base / COD_TAX_BLOCK_IQD) * COD_TAX_PER_BLOCK_IQD;
}

/** Tax applies only to COD delivered to an address, never store pickup. */
export function codDeliveryTaxIqd(input: {
  paymentMethodId: string;
  deliveryMethodId: string;
  payableBeforeTaxIqd: number;
}): number {
  const payment = input.paymentMethodId.trim().toLowerCase();
  const delivery = input.deliveryMethodId.trim().toLowerCase();
  const isCod = payment === 'cash' || payment === 'cod' || payment === 'cash_on_delivery';
  const isDelivery = delivery === 'standard' || delivery === 'personal';
  return isCod && isDelivery ? calculateCodTaxIqd(input.payableBeforeTaxIqd) : 0;
}
