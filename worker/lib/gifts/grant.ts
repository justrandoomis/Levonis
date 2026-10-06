/**
 * GRANTING A GIFT — the one writer of a new `gift_entitlements` row
 * (docs/GIFTS_QUICK_BUY.md §1.2): the admin's «منح هدية» and the review reward
 * approval both build their statements here, so a gift can never be granted
 * without its audit row and its in-app notice in the same batch.
 *
 *   mode 'level'    the customer chooses one of the level's items  → granted
 *   mode 'product'  one product pinned by the admin (a level item
 *                   or any store product)                          → ready_to_redeem
 *
 * Nothing is reserved here (D6): stock moves only through the order the gift
 * ends up in.
 */
import type { Env } from '../types';
import { newId } from '../crypto';
import { auditStatements } from '../audit';
import { notifyStatement } from '../notifications';
import { notifyCustomer, reachFor, type CustomerMessage } from '../customerNotify';
import type { GiftSelection, GiftSnapshot } from './selection';
import { snapshotJson, type GrantReason } from './model';

export interface GrantPlanInput {
  id?: string;
  userId: string;
  level: number;
  reason: GrantReason;
  /** Internal — never shown to the customer. */
  note: string;
  /** Who granted: an admin id, or 'system'. */
  actorId: string;
  /** Set for a product-pinned grant (mode 'product'); absent for a level grant. */
  pinned?: { selection: GiftSelection; snapshot: GiftSnapshot; itemId: string | null } | null;
  rewardId?: string | null;
  requestId?: string | null;
  requestHash?: string | null;
  now: string;
  /** Extra facts for the audit row (the review a reward came from, …). */
  auditExtra?: Record<string, unknown>;
}

export const GIFT_COPY = {
  ar: {
    title: 'وصلتك هدية من Levonis 🎁',
    body: (level: string) => `حصلت على هدية من ${level}. افتح «هداياي» لاختيارها واستردادها ثم اطلبها مجاناً.`,
    subject: 'وصلتك هدية من Levonis',
    cta: 'افتح هداياي',
  },
  en: {
    title: 'You received a gift from Levonis 🎁',
    body: (level: string) => `You were granted a gift from ${level}. Open "My gifts" to choose it, redeem it and order it for free.`,
    subject: 'You received a gift from Levonis',
    cta: 'Open my gifts',
  },
  ckb: {
    title: 'دیارییەکت لە Levonis ـەوە پێگەیشت 🎁',
    body: (level: string) => `دیارییەکت لە ${level} وەرگرت. «دیارییەکانم» بکەرەوە بۆ هەڵبژاردن و وەرگرتنەوەی، پاشان بەخۆڕایی داوای بکە.`,
    subject: 'دیارییەکت لە Levonis ـەوە پێگەیشت',
    cta: 'دیارییەکانم بکەرەوە',
  },
} as const;

const levelWords = (n: number) => ({ ar: `المستوى ${n}`, en: `level ${n}`, ckb: `ئاستی ${n}` });

/**
 * The INSERT, the audit row and the in-app notice for one grant — one batch.
 * The caller adds any precondition of its own (the reward's approval).
 */
export async function planGrant(db: D1Database, input: GrantPlanInput): Promise<{ id: string; statements: D1PreparedStatement[] }> {
  const id = input.id ?? newId('gift');
  const pinned = input.pinned ?? null;
  const sel = pinned?.selection ?? null;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO gift_entitlements
           (id, reward_id, user_id, max_level, chosen_level, state, grant_mode, reason, level, admin_note,
            granted_by, granted_at, updated_at, version, grant_request_id, grant_request_hash,
            gift_item_id, gift_product_id, gift_option_value_ids, gift_color_id, gift_qty, gift_sale_type,
            gift_transport_method, gift_snapshot, chosen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.rewardId ?? null,
        input.userId,
        input.level,
        input.level,
        sel ? 'ready_to_redeem' : 'granted',
        sel ? 'product' : 'level',
        input.reason,
        input.level,
        input.note,
        input.actorId,
        input.now,
        input.now,
        input.requestId ?? null,
        input.requestHash ?? null,
        pinned?.itemId ?? null,
        sel?.productId ?? null,
        JSON.stringify(sel?.optionValueIds ?? []),
        sel?.colorId ?? '',
        sel?.qty ?? 1,
        sel?.saleType ?? '',
        sel?.transportMethod ?? '',
        snapshotJson(pinned?.snapshot ?? null),
        sel ? input.now : null,
        input.now
      ),
  ];
  const audit = await auditStatements(db, input.actorId === 'system' ? null : input.actorId, 'gift.grant', id, {
    user_id: input.userId,
    level: input.level,
    mode: sel ? 'product' : 'level',
    reason: input.reason,
    note: input.note,
    item_id: pinned?.itemId ?? null,
    product_id: sel?.productId ?? null,
    option_value_ids: sel?.optionValueIds ?? [],
    color_id: sel?.colorId ?? '',
    qty: sel?.qty ?? null,
    sale_type: sel?.saleType ?? null,
    transport_method: sel?.transportMethod ?? null,
    granted_by: input.actorId,
    ...(input.auditExtra ?? {}),
  });
  statements.push(...audit.statements);
  const words = levelWords(input.level);
  statements.push(
    notifyStatement(db, {
      userId: input.userId,
      kind: 'gift_granted',
      title_ar: GIFT_COPY.ar.title,
      title_en: GIFT_COPY.en.title,
      body_ar: GIFT_COPY.ar.body(words.ar),
      body_en: GIFT_COPY.en.body(words.en),
      link: '/gifts',
      entity_type: 'gift',
      entity_id: id,
      meta: { level: input.level, title_ckb: GIFT_COPY.ckb.title, body_ckb: GIFT_COPY.ckb.body(words.ckb) },
      eventKey: `gift.granted:${id}`,
    }).stmt
  );
  return { id, statements };
}

/**
 * «وصلتك هدية» on the channels that reach the customer (email, WhatsApp,
 * Telegram) — after the grant committed, through the existing fan-out. Never
 * throws: a notice that cannot be queued must not undo a grant.
 */
export async function notifyGiftGranted(env: Env, giftId: string): Promise<void> {
  try {
    const g = await env.DB.prepare('SELECT id, user_id, level FROM gift_entitlements WHERE id = ?')
      .bind(giftId)
      .first<{ id: string; user_id: string; level: number }>();
    if (!g) return;
    // The language this customer actually reads notifications in — the same
    // rule every other customer notice uses (customerNotify.ts).
    const lang = (await reachFor(env, g.user_id)).lang;
    const t = GIFT_COPY[lang];
    const origin = String(env.APP_ORIGIN ?? '').trim().replace(/\/+$/, '');
    const msg: CustomerMessage = {
      subject: t.subject,
      body: t.body(levelWords(Number(g.level) || 1)[lang]),
      ...(origin.startsWith('https://') ? { cta: { label: t.cta, url: `${origin}/gifts` } } : {}),
    };
    await notifyCustomer(env, g.user_id, `gift.granted:${g.id}`, msg);
  } catch (e) {
    console.error('gift granted notice not queued', giftId, e instanceof Error ? e.message : String(e));
  }
}
