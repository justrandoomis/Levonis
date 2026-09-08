/**
 * The message templates for the four events this slice consumes.
 *
 * Two rules carried over from the core and worth restating:
 *
 *  1. **In-app text is stored per language, not pre-rendered.** A notification
 *     read next month must be in the language the reader is using then, not the
 *     one that happened to be active when it was written
 *     (`worker/lib/notifications.ts`).
 *  2. **A link is a PATH, never an absolute URL.** A stored origin is a stored
 *     mistake waiting for the day the domain changes. `APP_ORIGIN` is used only
 *     to render an absolute link inside an EMAIL, where a path is useless.
 *
 * No template interpolates a contact, a token or an amount in a currency it was
 * not given. A verification mail carries a link the caller supplies; this
 * service never mints one, because minting it would make Notifications an
 * authentication surface.
 */
import type { NotificationInput, OutboxEmail, OutboxTelegram } from './types';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const absolute = (origin: string | undefined, path: string): string => {
  const base = (origin || '').replace(/\/+$/, '');
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path;
};

/** A minimal, dependency-free HTML body: one heading, one paragraph, one link. */
export function simpleEmail(to: string, subject: string, heading: string, body: string, link?: { href: string; label: string }): OutboxEmail {
  const linkHtml = link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : '';
  const linkText = link ? `\n\n${link.label}: ${link.href}` : '';
  return {
    kind: 'email',
    to,
    subject,
    html: `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p>${linkHtml}`,
    text: `${heading}\n\n${body}${linkText}`,
  };
}

export function adminTelegram(chatId: string, text: string): OutboxTelegram {
  return { kind: 'telegram', chat_id: chatId, text };
}

// ------------------------------------------------------------- templates

/** `UserCreated` — the verification mail. The link is supplied, never minted here. */
export function verifyEmail(to: string, verifyUrl: string, locale: 'ar' | 'en' | 'ckb'): OutboxEmail {
  const ar = locale === 'ar' || locale === 'ckb';
  return simpleEmail(
    to,
    ar ? 'تأكيد بريدك الإلكتروني' : 'Confirm your email address',
    ar ? 'مرحبًا بك في ليفونيس' : 'Welcome to Levonis',
    ar ? 'اضغط على الرابط لتأكيد بريدك الإلكتروني.' : 'Follow the link to confirm your email address.',
    { href: verifyUrl, label: ar ? 'تأكيد البريد' : 'Confirm email' }
  );
}

/** `OrderCreated` — the customer's in-app row. */
export function orderCreatedInApp(userId: string, orderId: string, eventKey: string): NotificationInput {
  return {
    userId,
    kind: 'order_update',
    title_ar: 'تم استلام طلبك',
    title_en: 'Your order was received',
    body_ar: `رقم الطلب ${orderId}`,
    body_en: `Order ${orderId}`,
    link: `/orders/${orderId}`,
    entity_type: 'order',
    entity_id: orderId,
    eventKey,
  };
}

/** `OrderCreated` — the admin group message. Totals only; no name, address or contact. */
export function orderCreatedAdmin(chatId: string, orderId: string, totalIqd: number, sellerType: string): OutboxTelegram {
  return adminTelegram(chatId, `New order ${orderId}\nseller: ${sellerType}\ntotal: ${totalIqd} IQD`);
}

/** `DepositDecided` — the customer's in-app row. Personal, so it never reaches Analytics or Ads. */
export function depositDecidedInApp(userId: string, requestId: string, decision: 'approved' | 'rejected', usdCents: number, eventKey: string): NotificationInput {
  const approved = decision === 'approved';
  const amount = (usdCents / 100).toFixed(2);
  return {
    userId,
    kind: 'order_update',
    title_ar: approved ? 'تمت الموافقة على إيداعك' : 'تم رفض طلب الإيداع',
    title_en: approved ? 'Your deposit was approved' : 'Your deposit was rejected',
    body_ar: `${amount} دولار`,
    body_en: `${amount} USD`,
    link: '/wallet',
    entity_type: '',
    entity_id: requestId,
    eventKey,
  };
}

/** `RequestPublished` — one inbox row per matched merchant, deduped on (user_id, event_key). */
export function requestPublishedInApp(merchantId: string, requestId: string, eventKey: string): NotificationInput {
  return {
    userId: merchantId,
    kind: 'print_request_match',
    title_ar: 'طلب طباعة يناسب متجرك',
    title_en: 'A print request suits your shop',
    body_ar: '',
    body_en: '',
    link: `/requests?request=${requestId}`,
    entity_type: 'request',
    entity_id: requestId,
    eventKey,
  };
}

/** The absolute-link helper, exported so a test can pin the "paths in app, URLs in mail" rule. */
export const emailLink = absolute;
