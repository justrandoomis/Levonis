/**
 * WHAT EACH TIMELINE EVENT SAYS — pure, so the wording of every kind is
 * tested (tests/merchantOrderDetailUi.test.ts). The events are the server's
 * (worker/routes/merchantOrders.ts); this only puts them into words.
 * OWNER: Sorani to be written by hand (every sentence here passes ar/en).
 */
import type { TimelineActor, TimelineEvent } from './api';
import { orderStatusLabel } from './labels';

type Loc = (ar: string, en: string, ckb?: string) => string;

export function actorText(a: TimelineActor, loc: Loc): string {
  switch (a) {
    case 'store': return loc('أنت', 'You');
    case 'customer': return loc('الزبون', 'The customer');
    case 'levonis': return loc('فريق Levonis', 'The Levonis team');
    case 'courier': return loc('شركة التوصيل', 'The courier');
    default: return loc('تلقائيًا', 'Automatically');
  }
}

const LINE: Record<string, [string, string]> = {
  sale_gross: ['المبيع', 'Sale'],
  commission: ['عمولة المنصة', 'Platform commission'],
  delivery_fee: ['رسوم التوصيل', 'Delivery fee'],
  refund: ['استرجاع المبيع', 'Sale reversed'],
  commission_refund: ['إرجاع العمولة', 'Commission returned'],
  delivery_refund: ['استرجاع التوصيل', 'Delivery fee reversed'],
};

export function ledgerLineText(kind: string, loc: Loc): string {
  const l = LINE[kind];
  return l ? loc(l[0], l[1]) : kind;
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** The event's headline, an optional second line, and its tone (never colour alone: the words carry it). */
export function eventText(e: TimelineEvent, loc: Loc, money: (iqd: number) => string): { title: string; detail?: string; tone: Tone } {
  switch (e.kind) {
    case 'placed':
      return { title: loc('وصل الطلب', 'Order placed'), detail: loc(`الإجمالي ${money(e.total_iqd)}`, `Total ${money(e.total_iqd)}`), tone: 'info' };
    case 'status':
      return {
        title: loc(`صار الطلب: ${orderStatusLabel(e.status, loc)}`, `Order is now: ${orderStatusLabel(e.status, loc)}`),
        detail: actorText(e.actor, loc),
        tone: e.status === 'delivered' ? 'success' : 'neutral',
      };
    case 'cancelled':
      return { title: loc('أُلغي الطلب', 'Order cancelled'), detail: actorText(e.actor, loc), tone: 'danger' };
    case 'refunded':
      return { title: loc('أُعيد المبلغ إلى محفظة الزبون', 'The customer was refunded to their wallet'), tone: 'neutral' };
    case 'receipt_confirmed':
      return { title: loc('أكّد الزبون الاستلام', 'The customer confirmed receipt'), tone: 'success' };
    case 'credit_recorded': {
      const net = e.lines.reduce((s, l) => s + l.amount_iqd, 0);
      return {
        title: loc(`سُجّل لك ${money(net)} — معلّق`, `${money(net)} recorded for you — pending`),
        detail: e.lines.map((l) => `${ledgerLineText(l.kind, loc)} ${money(l.amount_iqd)}`).join(' · '),
        tone: 'neutral',
      };
    }
    case 'credit_reversed': {
      const net = e.lines.reduce((s, l) => s + l.amount_iqd, 0);
      return {
        title: loc(`عُكس ${money(Math.abs(net))} من رصيدك`, `${money(Math.abs(net))} reversed from your balance`),
        detail: e.lines.map((l) => `${ledgerLineText(l.kind, loc)} ${money(l.amount_iqd)}`).join(' · '),
        tone: 'warning',
      };
    }
    case 'credit_released':
      return {
        title: loc(`صار ${money(e.amount_iqd)} متاحًا في رصيدك`, `${money(e.amount_iqd)} became available`),
        detail: e.actor === 'customer'
          ? loc('بتأكيد الزبون', 'On the customer’s confirmation')
          : e.actor === 'system'
            ? loc('تلقائيًا بعد 3 أيام من التسليم', 'Automatically, 3 days after delivery')
            : actorText(e.actor, loc),
        tone: 'success',
      };
    case 'ledger_adjustment':
      return { title: loc(`تسوية إدارية ${money(e.amount_iqd)}`, `Admin adjustment ${money(e.amount_iqd)}`), tone: 'neutral' };
    case 'dispute_opened':
      return {
        title: e.source === 'complaint' ? loc('فُتحت شكوى على الطلب', 'A complaint was opened on this order') : loc('فُتحت تذكرة دعم على الطلب', 'A support ticket was opened on this order'),
        detail: loc('المال مجمّد حتى تُحلّ', 'The money is frozen until it is resolved'),
        tone: 'warning',
      };
    case 'dispute_closed':
      return { title: e.source === 'complaint' ? loc('أُغلقت الشكوى', 'The complaint was closed') : loc('أُغلقت تذكرة الدعم', 'The support ticket was closed'), tone: 'neutral' };
    case 'chat_started':
      return { title: loc('بدأت محادثة حول الطلب', 'A conversation about this order began'), tone: 'neutral' };
    case 'release_due':
      return e.frozen
        ? { title: loc('الإفراج التلقائي متوقف', 'The automatic release is on hold'), detail: loc('شكوى مفتوحة تجمّد المال حتى يقرّر فريق Levonis', 'An open complaint freezes the money until Levonis decides'), tone: 'warning' }
        : { title: loc('يصبح المال متاحًا تلقائيًا', 'The money becomes available automatically'), detail: loc('ما لم يؤكد الزبون قبلها أو تُفتح شكوى', 'Unless the customer confirms first or a complaint is opened'), tone: 'info' };
  }
}
