/**
 * THE PURCHASE DOCUMENT, BACK IN THE PANEL'S OWN NAMES (DECISIONS row 219).
 *
 * `GET /api/admin/procurement/documents[/:id]` answers every private figure
 * under a name the server's cost net knows (worker/routes/adminProcurement.ts
 * `documentWire`) — `payments[].supplier_payment_iqd`, `supplier_paid_iqd`,
 * `supplier_balance_iqd`, `charge_amount_iqd`, `charge_unit_amount_iqd`,
 * `invoice_attachment_url` — because the column names (`amount_iqd`,
 * `paid_iqd`, `attachment_url`) are wallet, store and chat words too and can
 * never be stripped by name. The owner's screen is unchanged: this maps the
 * answer back to the shape the panel has always read, in one place.
 */
type Row = Record<string, unknown>;
const rowOf = (v: unknown): Row => (v && typeof v === 'object' ? (v as Row) : {});

/** One list row: the paid total and the invoice link under the panel's names. */
export function purchaseRowFromWire<T>(raw: unknown): T {
  const { supplier_paid_iqd, invoice_attachment_url, ...rest } = rowOf(raw);
  return { ...rest, paid_iqd: Number(supplier_paid_iqd ?? 0), attachment_url: String(invoice_attachment_url ?? '') } as T;
}

/** The whole document: payments, totals, charges and the invoice link under the panel's names. */
export function purchaseDocumentFromWire<T>(raw: unknown): T {
  const d = rowOf(raw);
  const { invoice_attachment_url, ...purchase } = rowOf(d.purchase);
  const charges = Array.isArray(d.charges)
    ? d.charges.map((c) => {
        const { charge_amount_iqd, charge_unit_amount_iqd, allocations, ...rest } = rowOf(c);
        return {
          ...rest,
          amount_iqd: charge_amount_iqd,
          unit_amount_iqd: charge_unit_amount_iqd ?? null,
          allocations: Array.isArray(allocations)
            ? allocations.map((a) => ({ line_id: String(rowOf(a).line_id ?? ''), amount_iqd: Number(rowOf(a).charge_amount_iqd ?? 0) }))
            : null,
        };
      })
    : [];
  const { payments, supplier_paid_iqd, supplier_balance_iqd, ...rest } = d;
  return {
    ...rest,
    purchase: { ...purchase, attachment_url: String(invoice_attachment_url ?? '') },
    charges,
    payments: Array.isArray(payments)
      ? payments.map((pay) => {
          const { supplier_payment_iqd, ...p } = rowOf(pay);
          return { ...p, amount_iqd: Number(supplier_payment_iqd ?? 0) };
        })
      : [],
    paid_iqd: Number(supplier_paid_iqd ?? 0),
    balance_iqd: Number(supplier_balance_iqd ?? 0),
  } as T;
}
