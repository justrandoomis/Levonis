/**
 * THE MONTHLY LEVO CARE DRAW — «سحب ليفو كير الشهري» (owner, 2026-11-18/19; migration 0244;
 * docs/DECISIONS.md row 359).
 *
 *   «monthly competitions of free filaments to random customer who have active levo care is included
 *    with levo care» · «Random, I confirm each month» · «I set the prize each month»
 *
 * It is NOT a competition (worker/lib/rewards/competitions.ts stays as it is: its winners are chosen by
 * the team, never drawn). It is its own, separately described thing (rewards policy, chapter 16).
 *
 * WHO IS IN IT. One ticket per customer, however many devices: every account that is not a staff account
 * and holds at least one device whose Levo Care is in force NOW — the whole Care window (12, 24 or 36
 * months from delivery), not only the coupon year. «In force» is the claims desk's own answer
 * (`careEntitlements`, worker/lib/careClaims.ts): delivered, not closed by a return, not past its end; a
 * device traded in to the shop is the shop's. A device given to someone else carries its Care with it, so
 * the ticket is its holder's. A customer who won one of the last three monthly draws rests while anyone
 * else is in the draw (`REST_DRAWS`).
 *
 * FAIR AND CHECKABLE. Nothing about the winner or the candidates ever comes from a client. The server
 * reads the candidates, sorts their ids, stores sha-256 of that list (`candidate_hash`) and 32 random
 * bytes from `crypto.getRandomValues` (`seed`); the winner is `sorted[pickIndex(seed, n)]`, where
 * `pickIndex` turns the seed into an index by rejection sampling over sha-256(seed:counter), so every
 * index is exactly as likely as any other (no modulo bias) and anyone holding the list and the seed can
 * compute the same winner again. Every step (proposed, redrawn, skipped, confirmed) writes an audit row
 * in the same batch as the change.
 *
 * ONE PRIZE A MONTH. `care_draws.month` is UNIQUE: the job and «اسحب الآن» can both run and the month
 * still has one row. Confirming is one batch — the row flips proposed → confirmed behind a fence
 * (`changedExactlyOne`), the gift is granted through the gifts' own writer (`planGrant`,
 * worker/lib/gifts/grant.ts: its row, its audit), the winner is told — so a second press, a retry or a
 * concurrent confirm grants nothing more and answers with the gift already granted.
 *
 * A PRIZE THE SHELF CAN GIVE. Confirming asks the gifts' own rule with today's facts (`requireSellable`):
 * the chosen product, model and colour must be sellable now in the chosen quantity, or the confirmation is
 * refused with what is available. A confirmation made by mistake can be undone while the gift is still
 * unredeemed («إلغاء الجائزة», `voidCareDraw`: the gift cancelled by the gifts' own cancel writer, the draw
 * 'void', the winner told) — never after the customer redeemed it.
 *
 * ONLY THE CURRENT MONTH IS LIVE. A proposal not confirmed inside its own Baghdad month is closed
 * ('skipped', reason `not_confirmed_in_time`) in the batch that writes the next month's row, and
 * confirming or redrawing any month but the current one is refused: two months can never be confirmed
 * side by side from one stale screen.
 *
 * WHO READS WHAT. Only the owner reads a proposed name, the seed and the candidate hash; another admin
 * reads the months, their states, the candidate counts and a confirmed winner's display name.
 *
 * DEPLOY-AHEAD. A database without 0244 (or without 0236, the Care tables): the job writes nothing, the
 * admin read answers `installed: false`, the customer's perks answer `draw: null`, a write answers 503.
 */
import type { Env } from './types';
import { safeParse } from './types';
import { HttpError, badRequest, notFound } from './http';
import { auditStatements } from './audit';
import { newId, sha256Hex } from './crypto';
import { BAGHDAD_OFFSET_MS, baghdadDay } from './baghdadTime';
import { isSchemaMissing } from './membershipBenefits';
import { notifyStatement } from './notifications';
import { notifyCustomer, reachFor, type CustomerMessage } from './customerNotify';
import { verifiedOwnerId } from './verifiedOwner';
import { careClaimsInstalled, careEntitlements, type CareEntitlement } from './careClaims';
import { tradedInSql } from './deviceCustody';
import { changedExactlyOne, isLostRace } from './gifts/fence';
import { planGrant } from './gifts/grant';
import { planGiftCancel } from './gifts/cancel';
import { loadGiftRow } from './gifts/model';
import { checkGiftSelection, loadGiftProduct, type GiftSelectionResult } from './gifts/selection';
import { itemSelectionInput, parseItemInput, validateItem, type ItemInput } from './gifts/levels';
import { lineHasCareSql } from './rewards/earning';
import { customerPrinters } from './rewards/printers';

/** A winner rests for this many monthly draws while anyone else is in the draw. */
export const REST_DRAWS = 3;
/** The most units of the prize product one draw gives. */
export const PRIZE_QTY_MAX = 10;
/** The draw of a month is made on its 1st at this Baghdad hour, or at the first tick after it. */
export const DRAW_HOUR_BAGHDAD = 10;
/** The fewest letters of a reason for drawing another name or skipping a month. */
export const DRAW_REASON_MIN = 5;
/** Units read per `careEntitlements` call. */
const UNIT_CHUNK = 300;
/** The most Care devices one draw reads. Far above what the shop holds; past it the newest deliveries are read. */
const UNIT_LIMIT = 20_000;

export type CareDrawState = 'proposed' | 'confirmed' | 'skipped' | 'void';
type Tri = { ar: string; en: string; ckb: string };

// ------------------------------------------------------------------ refusals

export const CARE_DRAW_REFUSALS = {
  CARE_DRAW_NOT_INSTALLED: {
    ar: 'سحب ليفو كير غير مفعّل بعد على قاعدة البيانات.',
    en: 'The Levo Care draw is not set up on the database yet.',
    ckb: 'تیروپشکی لیڤۆ کێر هێشتا لە بنکەدراوەکەدا ئامادە نەکراوە.',
  },
  CARE_DRAW_EXISTS: {
    ar: 'لهذا الشهر سحب مسجَّل بالفعل — حدّث الصفحة.',
    en: 'This month already has a draw — reload the page.',
    ckb: 'ئەم مانگە پێشتر تیروپشکێکی تۆمارکراوی هەیە — لاپەڕەکە نوێ بکەرەوە.',
  },
  CARE_DRAW_NOT_PROPOSED: {
    ar: 'هذا السحب لم يعد بانتظار التأكيد (أُكِّد أو تُخطّي) — حدّث الصفحة.',
    en: 'This draw is no longer waiting for confirmation (it was confirmed or skipped) — reload the page.',
    ckb: 'ئەم تیروپشکە چیتر چاوەڕێی پشتڕاستکردنەوە نییە (پشتڕاستکراوەتەوە یان تێپەڕێنراوە) — لاپەڕەکە نوێ بکەرەوە.',
  },
  CARE_DRAW_CHANGED: {
    ar: 'تغيّر الاسم المقترح منذ فتحت الصفحة — حدّثها وراجع الاسم الجديد قبل التأكيد.',
    en: 'The proposed name changed since you opened the page — reload and review the new name before confirming.',
    ckb: 'ناوە پێشنیارکراوەکە لەو کاتەوەی لاپەڕەکەت کردەوە گۆڕاوە — نوێی بکەرەوە و پێش پشتڕاستکردنەوە سەیری ناوە نوێیەکە بکە.',
  },
  CARE_DRAW_WINNER_INELIGIBLE: {
    ar: 'الاسم المقترح لم يعد لديه ليفو كير سارٍ (انتهى أو أُرجع الجهاز أو انتقل) — اسحب اسماً آخر.',
    en: 'The proposed winner no longer holds an active Levo Care (it ended, the device was returned or it changed hands) — draw another name.',
    ckb: 'ناوە پێشنیارکراوەکە چیتر لیڤۆ کێری کارای نییە (کۆتایی هاتووە، ئامێرەکە گەڕێنراوەتەوە یان گواستراوەتەوە) — ناوێکی تر ڕابکێشە.',
  },
  CARE_DRAW_NO_OTHER_CANDIDATE: {
    ar: 'لا يوجد مشترك آخر مؤهل لهذا الشهر — أكّد الاسم الحالي أو تخطَّ الشهر.',
    en: 'No other eligible holder this month — confirm the current name or skip the month.',
    ckb: 'هیچ بەشداربوویەکی تری شیاو بۆ ئەم مانگە نییە — ناوی ئێستا پشتڕاست بکەرەوە یان مانگەکە تێپەڕێنە.',
  },
  CARE_DRAW_REASON_REQUIRED: {
    ar: 'اكتب السبب (5 أحرف على الأقل) — يُحفظ في سجل التدقيق.',
    en: 'Write the reason (at least 5 characters) — it is kept in the audit log.',
    ckb: 'هۆکارەکە بنووسە (لانیکەم 5 پیت) — لە تۆماری وردبینیدا هەڵدەگیرێت.',
  },
  CARE_DRAW_PRIZE_INVALID: {
    ar: 'هذه الجائزة لا تُمنح كهدية: اختر منتجاً منشوراً مع موديله ولونه، والكمية من 1 إلى 10.',
    en: 'This prize cannot be granted as a gift: pick a product on sale with its model and colour, and a quantity from 1 to 10.',
    ckb: 'ئەم خەڵاتە وەک دیاری نادرێت: بەرهەمێکی بڵاوکراوە لەگەڵ مۆدێل و ڕەنگەکەی هەڵبژێرە، و ژمارە لە 1 تا 10.',
  },
  CARE_DRAW_PRIZE_OUT_OF_STOCK: {
    ar: 'الكمية المتوفرة الآن من هذه الجائزة أقل من الكمية المختارة — قلّل الكمية أو اختر منتجاً آخر. لم يُمنح شيء.',
    en: 'Fewer units of this prize are available now than the quantity chosen — lower the quantity or pick another product. Nothing was granted.',
    ckb: 'ئەو ژمارەیەی ئێستا لەم خەڵاتە بەردەستە کەمترە لەو ژمارەیەی هەڵبژێردراوە — ژمارەکە کەم بکەرەوە یان بەرهەمێکی تر هەڵبژێرە. هیچ شتێک نەدرا.',
  },
  CARE_DRAW_MONTH_PASSED: {
    ar: 'انتهى شهر هذا السحب دون تأكيد، فلا يُؤكَّد ولا يُعاد سحبه الآن. سحب الشهر الحالي هو المعروض.',
    en: 'This draw’s month ended without a confirmation, so it can no longer be confirmed or redrawn. The current month’s draw is the one on screen.',
    ckb: 'مانگی ئەم تیروپشکە بەبێ پشتڕاستکردنەوە کۆتایی هات، بۆیە ئێستا نە پشتڕاست دەکرێتەوە و نە دووبارە ڕادەکێشرێت. تیروپشکی مانگی ئێستا ئەوەیە کە پیشان دراوە.',
  },
  CARE_DRAW_NOT_CONFIRMED: {
    ar: 'تُلغى جائزة سحب مؤكَّد فقط — حدّث الصفحة.',
    en: 'Only a confirmed draw’s prize can be cancelled — reload the page.',
    ckb: 'تەنها خەڵاتی تیروپشکێکی پشتڕاستکراو هەڵدەوەشێنرێتەوە — لاپەڕەکە نوێ بکەرەوە.',
  },
  CARE_DRAW_PRIZE_REDEEMED: {
    ar: 'استرد الفائز جائزته أو طلبها، فلا تُلغى من هنا.',
    en: 'The winner already redeemed or ordered the prize, so it cannot be cancelled from here.',
    ckb: 'براوەکە خەڵاتەکەی وەرگرتووەتەوە یان داوای کردووە، بۆیە لێرەوە هەڵناوەشێنرێتەوە.',
  },
} as const satisfies Record<string, Tri>;
export type CareDrawRefusalCode = keyof typeof CARE_DRAW_REFUSALS;

export function careDrawRefusal(code: CareDrawRefusalCode, status = 409, details?: Record<string, unknown>): HttpError {
  const t = CARE_DRAW_REFUSALS[code];
  return new HttpError(status, `${t.ar} / ${t.en} / ${t.ckb}`, code, details);
}

const notInstalled = (e: unknown): never => {
  if (isSchemaMissing(e)) throw careDrawRefusal('CARE_DRAW_NOT_INSTALLED', 503);
  throw e;
};

// ------------------------------------------------------------------ the month

/** The Baghdad month an instant is in, 'YYYY-MM'. */
export const baghdadMonth = (nowMs: number): string => baghdadDay(nowMs).slice(0, 7);

/** When a month's draw is due: its 1st, 10:00 in Baghdad, as epoch ms. */
export const drawDueMs = (month: string): number => Date.parse(`${month}-01T${String(DRAW_HOUR_BAGHDAD).padStart(2, '0')}:00:00.000Z`) - BAGHDAD_OFFSET_MS;

/** The month `n` calendar months before `month`. */
function monthsBefore(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ the randomness

/** 32 bytes from the platform's CSPRNG, hex. */
export function newSeed(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha-256 of the sorted candidate ids, one per line: what the draw was made over. */
export const candidateHash = (sortedIds: readonly string[]): Promise<string> => sha256Hex(sortedIds.join('\n'));

const SPACE = 2 ** 48;

/**
 * AN INDEX IN [0, n) FROM A SEED, UNBIASED AND REPEATABLE. Each round reads 48 bits of
 * sha-256(`seed:round`) and keeps them only when they fall under the largest multiple of n (rejection
 * sampling), so no index is favoured by the remainder. 48 bits are exact in a double. A round is
 * rejected with probability below n / 2^48, so the loop ends at once in practice; it is bounded anyway.
 */
export async function pickIndex(seed: string, n: number): Promise<number> {
  if (!Number.isSafeInteger(n) || n < 1 || n >= SPACE) throw new Error('pickIndex: n out of range');
  const limit = Math.floor(SPACE / n) * n;
  for (let round = 0; round < 1000; round++) {
    const x = Number.parseInt((await sha256Hex(`${seed}:${round}`)).slice(0, 12), 16);
    if (x < limit) return x % n;
  }
  throw new Error('pickIndex: no index after 1000 rounds');
}

// ------------------------------------------------------------------ who is in the draw

export interface CareHolder {
  user_id: string;
  /** The device that carries the ticket: the one whose Care ends last. */
  unit_id: string;
  care_end_at: string | null;
}

/** Care in force for the draw and the perks: the claims desk's «active», and a Care whose terms the shop has not published yet (its paperwork, not the customer's). */
export const careInForce = (e: CareEntitlement | null | undefined): boolean => !!e && (e.state === 'active' || e.state === 'terms_missing');

/**
 * EVERY CUSTOMER HOLDING A LEVO CARE IN FORCE at `nowMs`, one entry each. Read by the server only.
 * `onlyUser` narrows it to one account (the confirmation's re-check, the winner's device).
 */
export async function careHolders(db: D1Database, nowMs: number, onlyUser?: string): Promise<Map<string, CareHolder>> {
  const out = new Map<string, CareHolder>();
  if (!(await careClaimsInstalled(db))) return out;
  // The live unit of each device (a warranty replacement sits on the same line), not closed, not traded in,
  // held by an account that still exists and is not staff, on a line sold with Levo Care. Whether the Care
  // is in force (delivered, inside its window) is `careEntitlements`' answer below, from the device's root unit.
  const { results } = await db
    .prepare(
      `SELECT u.id, u.owner_user_id
         FROM order_item_units u
         JOIN users cu ON cu.id = u.owner_user_id
        WHERE u.replaced_by_unit_id IS NULL
          AND u.warranty_closed_at IS NULL
          AND cu.role <> 'admin'
          AND (?1 = '' OR u.owner_user_id = ?1)
          AND ${lineHasCareSql('u.order_item_id')}
          AND ${tradedInSql('u')} IS NULL
        ORDER BY u.rowid DESC
        LIMIT ?2`
    )
    .bind(onlyUser ?? '', UNIT_LIMIT)
    .all<{ id: string; owner_user_id: string }>();
  const units = results ?? [];
  for (let i = 0; i < units.length; i += UNIT_CHUNK) {
    const part = units.slice(i, i + UNIT_CHUNK);
    const care = await careEntitlements(db, part.map((u) => u.id), nowMs);
    for (const u of part) {
      const e = care.get(u.id);
      if (!careInForce(e)) continue;
      const end = e!.end_at;
      const prior = out.get(u.owner_user_id);
      if (!prior || String(end ?? '') > String(prior.care_end_at ?? '')) out.set(u.owner_user_id, { user_id: u.owner_user_id, unit_id: u.id, care_end_at: end });
    }
  }
  return out;
}

interface DrawRow {
  id: string;
  month: string;
  state: CareDrawState;
  candidates: number;
  candidate_hash: string;
  seed: string;
  winner_user_id: string | null;
  winner_unit_id: string | null;
  redraws: number;
  passed_user_ids: string;
  prize_product_id: string | null;
  prize_qty: number | null;
  prize_note: string;
  gift_id: string | null;
  proposed_at: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  skip_reason: string;
  created_at: string;
}

const passedOf = (row: Pick<DrawRow, 'passed_user_ids'> | null): string[] => {
  const v = safeParse<unknown>(row?.passed_user_ids ?? '[]', []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

interface Picked {
  holders: number;
  /** The sorted ids the name was drawn from. */
  pool: string[];
  hash: string;
  seed: string;
  winner: CareHolder | null;
  rested: number;
}

/**
 * One pick for `month`: the holders, minus the names already passed over this month (never drawn
 * again for it), minus the winners of the last REST_DRAWS months while anyone else is left.
 */
async function pick(db: D1Database, month: string, nowMs: number, passed: readonly string[]): Promise<Picked> {
  const holders = await careHolders(db, nowMs);
  const all = [...holders.keys()].sort();
  const gone = new Set(passed);
  const open = all.filter((id) => !gone.has(id));
  const { results } = await db
    .prepare("SELECT winner_user_id FROM care_draws WHERE state = 'confirmed' AND month >= ?1 AND month < ?2 AND winner_user_id IS NOT NULL")
    .bind(monthsBefore(month, REST_DRAWS), month)
    .all<{ winner_user_id: string }>();
  const resting = new Set((results ?? []).map((r) => r.winner_user_id));
  const fresh = open.filter((id) => !resting.has(id));
  const pool = fresh.length ? fresh : open;
  const seed = newSeed();
  const hash = await candidateHash(pool);
  const winner = pool.length ? holders.get(pool[await pickIndex(seed, pool.length)]) ?? null : null;
  return { holders: all.length, pool, hash, seed, winner, rested: open.length - pool.length };
}

// ------------------------------------------------------------------ words

export const CARE_DRAW_NOTICES = {
  proposed: (month: string, n: number) => ({
    title: {
      ar: `سحب ليفو كير لشهر ${month}: اسم بانتظار تأكيدك`,
      en: `Levo Care draw for ${month}: a name is waiting for your confirmation`,
      ckb: `تیروپشکی لیڤۆ کێر بۆ مانگی ${month}: ناوێک چاوەڕێی پشتڕاستکردنەوەی تۆیە`,
    },
    body: {
      ar: `اختار النظام اسماً عشوائياً من بين ${n} من أصحاب ليفو كير الساري. لم يُمنح شيء ولم يُبلَّغ الزبون بعد — اختر الجائزة وأكّد من «الإدارة ← المكافآت ← سحب ليفو كير».`,
      en: `The system picked one name at random among ${n} holders of an active Levo Care. Nothing was granted and the customer was not told yet — choose the prize and confirm in Admin → Rewards → Levo Care draw.`,
      ckb: `سیستەمەکە بە هەڕەمەکی ناوێکی لەنێو ${n} خاوەنی لیڤۆ کێری کارادا هەڵبژارد. هێشتا هیچ شتێک نەدراوە و کڕیار ئاگادار نەکراوەتەوە — خەڵاتەکە هەڵبژێرە و لە «بەڕێوەبردن ← خەڵاتەکان ← تیروپشکی لیڤۆ کێر» پشتڕاستی بکەرەوە.`,
    },
  }),
  won: (month: string, prize: Tri, qty: number) => ({
    title: {
      ar: 'فزت بسحب ليفو كير الشهري 🎁',
      en: 'You won the monthly Levo Care draw 🎁',
      ckb: 'لە تیروپشکی مانگانەی لیڤۆ کێردا براوە بوویت 🎁',
    },
    body: {
      ar: `وقع عليك سحب شهر ${month} بين أصحاب ليفو كير الساري. جائزتك: ${prize.ar} × ${qty}. افتح «هداياي» واطلبها مجاناً.`,
      en: `The ${month} draw among holders of an active Levo Care picked you. Your prize: ${prize.en} × ${qty}. Open "My gifts" and order it for free.`,
      ckb: `تیروپشکی مانگی ${month} لەنێو خاوەنانی لیڤۆ کێری کارادا تۆی هەڵبژارد. خەڵاتەکەت: ${prize.ckb} × ${qty}. «دیارییەکانم» بکەرەوە و بەخۆڕایی داوای بکە.`,
    },
    cta: { ar: 'افتح هداياي', en: 'Open my gifts', ckb: 'دیارییەکانم بکەرەوە' },
  }),
  voided: (month: string) => ({
    title: {
      ar: 'أُلغيت جائزة سحب ليفو كير',
      en: 'The Levo Care draw prize was cancelled',
      ckb: 'خەڵاتی تیروپشکی لیڤۆ کێر هەڵوەشێنرایەوە',
    },
    body: {
      ar: `ألغى المتجر جائزة سحب شهر ${month} التي أُعلنت لك، ولم تعد في «هداياي». نعتذر عن ذلك؛ راسلنا إن كان لديك سؤال.`,
      en: `The Store cancelled the ${month} draw prize that was announced to you; it is no longer in "My gifts". We are sorry; write to us if you have a question.`,
      ckb: `فرۆشگا خەڵاتی تیروپشکی مانگی ${month}ی هەڵوەشاندەوە کە بۆت ڕاگەیەنرابوو، و چیتر لە «دیارییەکانم»دا نییە. داوای لێبوردن دەکەین؛ ئەگەر پرسیارت هەیە بۆمان بنووسە.`,
    },
    cta: { ar: 'افتح هداياي', en: 'Open my gifts', ckb: 'دیارییەکانم بکەرەوە' },
  }),
} as const;

// ------------------------------------------------------------------ proposing

export interface CareDrawJobReport {
  installed: boolean;
  /** The Baghdad month the tick is in. */
  month: string;
  /** What this run did: nothing was due or the month already has its row, or the row it wrote. */
  outcome: 'not_due' | 'exists' | 'proposed' | 'skipped';
  candidates: number;
}

/** Why a proposal nobody confirmed inside its own month was closed. */
export const STALE_REASON = 'not_confirmed_in_time';

const isUnique = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(e instanceof Error ? e.message : String(e));

/**
 * Writes the month's row: 'proposed' with a winner, or 'skipped' when nobody is eligible. The owner is
 * rung once for a proposal (his bell, never a staff channel). Nothing is granted; the customer hears nothing.
 * `reopen` turns a SKIPPED row of the same month back into a proposal («اسحب الآن» after an empty month).
 */
async function writeProposal(
  env: Env,
  month: string,
  nowIso: string,
  actorId: string | null,
  reopen: DrawRow | null
): Promise<{ outcome: 'proposed' | 'skipped' | 'exists'; candidates: number; id: string }> {
  const db = env.DB;
  const p = await pick(db, month, Date.parse(nowIso), passedOf(reopen));
  const id = reopen?.id ?? newId('cdr');
  const state: CareDrawState = p.winner ? 'proposed' : 'skipped';
  const audit = await auditStatements(db, actorId, p.winner ? 'care_draw.proposed' : 'care_draw.skipped', id, {
    month,
    holders: p.holders,
    candidates: p.pool.length,
    rested: p.rested,
    candidate_hash: p.hash,
    seed: p.seed,
    winner_user_id: p.winner?.user_id ?? null,
    winner_unit_id: p.winner?.unit_id ?? null,
    by: actorId ? 'owner' : 'job',
    reason: p.winner ? undefined : 'no_candidates',
  });
  const statements: D1PreparedStatement[] = reopen
    ? [
        db
          .prepare(
            `UPDATE care_draws SET state = ?1, candidates = ?2, candidate_hash = ?3, seed = ?4, winner_user_id = ?5, winner_unit_id = ?6,
                    proposed_at = ?7, skip_reason = ?8, updated_at = ?7
              WHERE id = ?9 AND state = 'skipped'`
          )
          .bind(state, p.pool.length, p.hash, p.seed, p.winner?.user_id ?? null, p.winner?.unit_id ?? null, nowIso, p.winner ? '' : 'no_candidates', id),
        ...changedExactlyOne(db),
      ]
    : [
        db
          .prepare(
            `INSERT INTO care_draws (id, month, state, candidates, candidate_hash, seed, winner_user_id, winner_unit_id, proposed_at, skip_reason, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?9)`
          )
          .bind(id, month, state, p.pool.length, p.hash, p.seed, p.winner?.user_id ?? null, p.winner?.unit_id ?? null, nowIso, p.winner ? '' : 'no_candidates'),
      ];
  statements.push(...audit.statements);
  // A proposal of an EARLIER month nobody confirmed ends here, in the batch that opens this month: one live
  // proposal at a time, and its name is never confirmed from a stale screen.
  const { results: stale } = await db
    .prepare("SELECT id, month, winner_user_id, seed FROM care_draws WHERE state = 'proposed' AND month < ?")
    .bind(month)
    .all<{ id: string; month: string; winner_user_id: string | null; seed: string }>();
  for (const old of stale ?? []) {
    const closed = await auditStatements(db, actorId, 'care_draw.skipped', old.id, {
      month: old.month,
      reason: STALE_REASON,
      winner_user_id: old.winner_user_id,
      seed: old.seed,
      closed_by_month: month,
      by: actorId ? 'owner' : 'job',
    });
    statements.push(...closed.statements);
  }
  if ((stale ?? []).length) {
    statements.push(
      db.prepare("UPDATE care_draws SET state = 'skipped', skip_reason = ?1, updated_at = ?2 WHERE state = 'proposed' AND month < ?3").bind(STALE_REASON, nowIso, month)
    );
  }
  if (p.winner) {
    const ownerId = await verifiedOwnerId(env);
    if (ownerId) {
      const t = CARE_DRAW_NOTICES.proposed(month, p.pool.length);
      statements.push(
        notifyStatement(db, {
          userId: ownerId,
          kind: 'reward',
          title_ar: t.title.ar,
          title_en: t.title.en,
          body_ar: t.body.ar,
          body_en: t.body.en,
          link: '/admin?tab=rewards',
          meta: { title_ckb: t.title.ckb, body_ckb: t.body.ckb, care_draw_id: id, month },
          eventKey: `care_draw:proposed:${month}:${p.seed.slice(0, 12)}`,
        }).stmt
      );
    }
  }
  try {
    await db.batch(statements);
  } catch (e) {
    // The other caller (the job or the owner's press) wrote this month first: nothing of this batch stands.
    if (isUnique(e) || isLostRace(e)) return { outcome: 'exists', candidates: 0, id: '' };
    throw e;
  }
  return { outcome: state === 'proposed' ? 'proposed' : 'skipped', candidates: p.pool.length, id };
}

const rowOfMonth = (db: D1Database, month: string) => db.prepare('SELECT * FROM care_draws WHERE month = ?').bind(month).first<DrawRow>();
const rowById = (db: D1Database, id: string) => db.prepare('SELECT * FROM care_draws WHERE id = ?').bind(id).first<DrawRow>();

/**
 * THE JOB (worker/lib/jobs.ts step `care_draw`, every quarter hour): once per Baghdad month, at the first
 * tick on or after the 1st 10:00 Baghdad. A month that already has its row costs one read.
 */
export async function runCareDrawJob(env: Env, nowIso = new Date().toISOString()): Promise<CareDrawJobReport> {
  const nowMs = Date.parse(nowIso);
  const month = baghdadMonth(nowMs);
  const report: CareDrawJobReport = { installed: true, month, outcome: 'not_due', candidates: 0 };
  if (nowMs < drawDueMs(month)) return report;
  try {
    if (await rowOfMonth(env.DB, month)) return { ...report, outcome: 'exists' };
    if (!(await careClaimsInstalled(env.DB))) return { ...report, installed: false };
    const out = await writeProposal(env, month, nowIso, null, null);
    return { ...report, outcome: out.outcome, candidates: out.candidates };
  } catch (e) {
    if (isSchemaMissing(e)) return { ...report, installed: false };
    throw e;
  }
}

/** «اسحب الآن»: the owner makes this month's draw himself — when it has no row yet, or its row is a skipped month. */
export async function drawNow(env: Env, actorId: string, nowIso = new Date().toISOString()): Promise<{ id: string; outcome: 'proposed' | 'skipped' }> {
  const month = baghdadMonth(Date.parse(nowIso));
  const row = await rowOfMonth(env.DB, month).catch(notInstalled);
  if (row && row.state !== 'skipped') throw careDrawRefusal('CARE_DRAW_EXISTS');
  if (!(await careClaimsInstalled(env.DB))) throw careDrawRefusal('CARE_DRAW_NOT_INSTALLED', 503);
  const out = await writeProposal(env, month, nowIso, actorId, row ?? null).catch(notInstalled);
  if (out.outcome === 'exists') throw careDrawRefusal('CARE_DRAW_EXISTS');
  return { id: out.id, outcome: out.outcome };
}

const reasonOf = (raw: unknown): string => {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < DRAW_REASON_MIN || reason.length > 300) throw careDrawRefusal('CARE_DRAW_REASON_REQUIRED', 400);
  return reason;
};

async function proposedRow(db: D1Database, id: string): Promise<DrawRow> {
  const row = await rowById(db, id).catch(notInstalled);
  if (!row) throw notFound('Draw not found');
  if (row.state !== 'proposed' || !row.winner_user_id) throw careDrawRefusal('CARE_DRAW_NOT_PROPOSED');
  return row;
}

/** A proposal is confirmed or redrawn only inside its own Baghdad month. */
function currentMonthOnly(row: Pick<DrawRow, 'month'>, nowIso: string): void {
  const now = baghdadMonth(Date.parse(nowIso));
  if (row.month !== now) throw careDrawRefusal('CARE_DRAW_MONTH_PASSED', 409, { month: row.month, current_month: now });
}

/**
 * «سحب اسم آخر»: the proposed name is passed over for this month (never drawn again for it) and another
 * is picked the same way, with a fresh seed. Fenced on the seed read, so two presses draw once.
 */
export async function redrawCareDraw(env: Env, id: string, actorId: string, rawReason: unknown, nowIso = new Date().toISOString()): Promise<void> {
  const db = env.DB;
  const reason = reasonOf(rawReason);
  const row = await proposedRow(db, id);
  currentMonthOnly(row, nowIso);
  const passed = [...new Set([...passedOf(row), row.winner_user_id!])];
  const p = await pick(db, row.month, Date.parse(nowIso), passed);
  if (!p.winner) throw careDrawRefusal('CARE_DRAW_NO_OTHER_CANDIDATE');
  const audit = await auditStatements(db, actorId, 'care_draw.redraw', id, {
    month: row.month,
    reason,
    from: { winner_user_id: row.winner_user_id, seed: row.seed, candidate_hash: row.candidate_hash, candidates: row.candidates },
    to: { winner_user_id: p.winner.user_id, winner_unit_id: p.winner.unit_id, seed: p.seed, candidate_hash: p.hash, candidates: p.pool.length, rested: p.rested },
    redraws: Number(row.redraws) + 1,
  });
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE care_draws SET candidates = ?1, candidate_hash = ?2, seed = ?3, winner_user_id = ?4, winner_unit_id = ?5,
                  redraws = redraws + 1, passed_user_ids = ?6, proposed_at = ?7, updated_at = ?7
            WHERE id = ?8 AND state = 'proposed' AND seed = ?9`
        )
        .bind(p.pool.length, p.hash, p.seed, p.winner.user_id, p.winner.unit_id, JSON.stringify(passed), nowIso, id, row.seed),
      ...changedExactlyOne(db),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isLostRace(e)) throw careDrawRefusal('CARE_DRAW_CHANGED');
    throw e;
  }
}

/** «تخطّي هذا الشهر»: no prize this month, with the owner's reason. Nothing was granted, so nothing is taken back. */
export async function skipCareDraw(env: Env, id: string, actorId: string, rawReason: unknown, nowIso = new Date().toISOString()): Promise<void> {
  const db = env.DB;
  const reason = reasonOf(rawReason);
  const row = await proposedRow(db, id);
  const audit = await auditStatements(db, actorId, 'care_draw.skipped', id, { month: row.month, reason, winner_user_id: row.winner_user_id, seed: row.seed, by: 'owner' });
  try {
    await db.batch([
      db.prepare("UPDATE care_draws SET state = 'skipped', skip_reason = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'proposed' AND seed = ?4").bind(reason, nowIso, id, row.seed),
      ...changedExactlyOne(db),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isLostRace(e)) throw careDrawRefusal('CARE_DRAW_CHANGED');
    throw e;
  }
}

// ------------------------------------------------------------------ the prize and the shelf

type CheckedOk = Extract<GiftSelectionResult, { ok: true }>;

/** Units of the selection sellable now: the shelf for a direct sale, the route's room for a pre-order. null = not counted (unlimited). */
function availableOf(checked: CheckedOk, saleType: string): number | null {
  const a = checked.availability;
  const n = saleType === 'pre_order' ? a.preorder.capacity.available : a.stock.available;
  return n === null || n === undefined ? null : Math.max(0, Math.trunc(Number(n) || 0));
}

export interface PrizeCheck {
  /** The selection is a complete, giftable one. */
  valid: boolean;
  /** It is sellable now in the asked quantity: what «تأكيد» will require. */
  ok: boolean;
  /** Units sellable now; null = not counted. */
  available: number | null;
  code: string | null;
}

/**
 * THE ADMIN PICKER'S READ: is this prize giftable, and how many units are sellable now? The same two
 * checks the confirmation runs, so the screen can say why «تأكيد» is not pressable before it is pressed.
 */
export async function prizeCheck(env: Env, raw: Record<string, unknown>): Promise<PrizeCheck> {
  let item: ItemInput;
  try {
    item = parseItemInput(raw);
  } catch {
    return { valid: false, ok: false, available: null, code: 'CARE_DRAW_PRIZE_INVALID' };
  }
  if (item.qty > PRIZE_QTY_MAX) return { valid: false, ok: false, available: null, code: 'CARE_DRAW_PRIZE_INVALID' };
  const product = await loadGiftProduct(env, item.productId);
  const checked = validateItem(product, item);
  if (!checked.ok) return { valid: false, ok: false, available: null, code: checked.code };
  const sellable = checkGiftSelection(product, itemSelectionInput(item), { requireSellable: true });
  return { valid: true, ok: sellable.ok, available: availableOf(checked, item.saleType), code: sellable.ok ? null : 'CARE_DRAW_PRIZE_OUT_OF_STOCK' };
}

// ------------------------------------------------------------------ confirming

export interface ConfirmInput {
  /** The winner the owner saw on his screen; a different name now is refused (CARE_DRAW_CHANGED). */
  winnerSeen: unknown;
  /** The prize as the gifts' own editor sends an item: productId, optionValueIds, colorId, qty, saleType, transportMethod. */
  prize: unknown;
  note: unknown;
}

/**
 * «تأكيد الفائز ومنح الجائزة» — the owner's. One batch: the row flips to confirmed (fenced), the gift is
 * granted by the gifts' writer (a product pinned by the owner, reason 'reward', its own audit row), the draw's
 * audit row, and the winner's in-app notice. A draw already confirmed answers with what it granted.
 */
export async function confirmCareDraw(
  env: Env,
  id: string,
  actorId: string,
  input: ConfirmInput,
  nowIso = new Date().toISOString()
): Promise<{ already: boolean; gift_id: string; winner_user_id: string }> {
  const db = env.DB;
  const row = await rowById(db, id).catch(notInstalled);
  if (!row) throw notFound('Draw not found');
  const done = (r: DrawRow) => ({ already: true, gift_id: String(r.gift_id), winner_user_id: String(r.winner_user_id) });
  if (row.state === 'confirmed' && row.gift_id) return done(row);
  if (row.state !== 'proposed' || !row.winner_user_id) throw careDrawRefusal('CARE_DRAW_NOT_PROPOSED');
  currentMonthOnly(row, nowIso);
  const winnerId = row.winner_user_id;
  if (typeof input.winnerSeen === 'string' && input.winnerSeen && input.winnerSeen !== winnerId) throw careDrawRefusal('CARE_DRAW_CHANGED');
  // A staff account is never in the draw; this also keeps the owner from confirming a prize to himself.
  if (winnerId === actorId) throw careDrawRefusal('CARE_DRAW_WINNER_INELIGIBLE');

  const body = input.prize && typeof input.prize === 'object' ? (input.prize as Record<string, unknown>) : null;
  if (!body) throw careDrawRefusal('CARE_DRAW_PRIZE_INVALID', 400);
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > PRIZE_QTY_MAX) throw careDrawRefusal('CARE_DRAW_PRIZE_INVALID', 400, { reason: 'QTY' });
  let item;
  try {
    item = parseItemInput(body);
  } catch {
    throw careDrawRefusal('CARE_DRAW_PRIZE_INVALID', 400, { reason: 'INPUT' });
  }
  const product = await loadGiftProduct(env, item.productId);
  const checked = validateItem(product, item);
  if (!checked.ok) throw careDrawRefusal('CARE_DRAW_PRIZE_INVALID', 400, { reason: checked.code, errors: checked.errors });
  // TODAY'S FACTS: the winner is told at once and a confirmation is hard to take back, so the shelf (or the
  // pre-order room) must hold the whole quantity now — the rule «اختر» itself applies to a customer.
  const sellable = checkGiftSelection(product, itemSelectionInput(item), { requireSellable: true });
  if (!sellable.ok) {
    throw careDrawRefusal('CARE_DRAW_PRIZE_OUT_OF_STOCK', 409, { available: availableOf(checked, item.saleType), requested: qty, reason: sellable.code, errors: sellable.errors });
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 300) throw badRequest('note is too long (300 characters at most)');

  // The winner still holds a Care in force NOW (it may have ended, come back or changed hands since the pick).
  const holder = (await careHolders(db, Date.parse(nowIso), winnerId)).get(winnerId);
  if (!holder) throw careDrawRefusal('CARE_DRAW_WINNER_INELIGIBLE');

  const giftId = newId('gift');
  const plan = await planGrant(db, {
    id: giftId,
    userId: winnerId,
    level: 1,
    reason: 'reward',
    note: `Levo Care draw ${row.month}${note ? ` — ${note}` : ''}`,
    actorId,
    pinned: { selection: checked.selection, snapshot: checked.snapshot, itemId: null },
    now: nowIso,
    auditExtra: { care_draw_id: id, care_draw_month: row.month },
    // The draw's own notice says what was won; the gifts' generic «وصلتك هدية» would say it twice.
    silent: true,
  });
  const names: Tri = { ar: checked.snapshot.name_ar || checked.snapshot.name_en, en: checked.snapshot.name_en || checked.snapshot.name_ar, ckb: checked.snapshot.name_ckb || checked.snapshot.name_ar };
  const words = CARE_DRAW_NOTICES.won(row.month, names, qty);
  const audit = await auditStatements(db, actorId, 'care_draw.confirmed', id, {
    month: row.month,
    winner_user_id: winnerId,
    winner_unit_id: holder.unit_id,
    seed: row.seed,
    candidate_hash: row.candidate_hash,
    candidates: row.candidates,
    redraws: row.redraws,
    gift_id: giftId,
    prize: { product_id: checked.selection.productId, option_value_ids: checked.selection.optionValueIds, color_id: checked.selection.colorId, qty },
    note,
  });
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE care_draws SET state = 'confirmed', prize_product_id = ?1, prize_qty = ?2, prize_note = ?3, gift_id = ?4,
                  confirmed_by = ?5, confirmed_at = ?6, winner_unit_id = ?7, updated_at = ?6
            WHERE id = ?8 AND state = 'proposed' AND winner_user_id = ?9 AND seed = ?10 AND gift_id IS NULL`
        )
        .bind(checked.selection.productId, qty, note, giftId, actorId, nowIso, holder.unit_id, id, winnerId, row.seed),
      // Nothing after this stands unless THIS call confirmed the draw: no second gift, ever.
      ...changedExactlyOne(db),
      ...plan.statements,
      ...audit.statements,
      notifyStatement(db, {
        userId: winnerId,
        kind: 'gift_granted',
        title_ar: words.title.ar,
        title_en: words.title.en,
        body_ar: words.body.ar,
        body_en: words.body.en,
        link: '/gifts',
        entity_type: 'gift',
        entity_id: giftId,
        meta: { title_ckb: words.title.ckb, body_ckb: words.body.ckb, care_draw_month: row.month },
        eventKey: `care_draw:won:${row.month}`,
      }).stmt,
    ]);
  } catch (e) {
    if (!isLostRace(e)) throw e;
    const now = await rowById(db, id);
    if (now && now.state === 'confirmed' && now.gift_id) return done(now);
    throw careDrawRefusal('CARE_DRAW_CHANGED');
  }
  await tellWinner(env, winnerId, row.month, words);
  return { already: false, gift_id: giftId, winner_user_id: winnerId };
}

/**
 * «إلغاء الجائزة» — the owner undoes a CONFIRMED draw whose gift the winner has not redeemed yet. One batch:
 * the draw becomes 'void' (fenced), the gift is cancelled by the gifts' own cancel writer (its fence on the
 * state read: a redeem in the same instant fails the whole batch), the audit row, and the winner's notice.
 * A gift already redeemed, ordered or delivered is never taken back from here. The month keeps its row: it
 * has no prize, and is not drawn again.
 */
export async function voidCareDraw(env: Env, id: string, actorId: string, rawReason: unknown, nowIso = new Date().toISOString()): Promise<void> {
  const db = env.DB;
  const reason = reasonOf(rawReason);
  const row = await rowById(db, id).catch(notInstalled);
  if (!row) throw notFound('Draw not found');
  if (row.state !== 'confirmed' || !row.gift_id || !row.winner_user_id) throw careDrawRefusal('CARE_DRAW_NOT_CONFIRMED');
  const gift = await loadGiftRow(db, row.gift_id);
  const giftState = String(gift?.state ?? '');
  if (gift && giftState !== 'cancelled' && !UNREDEEMED.includes(giftState)) throw careDrawRefusal('CARE_DRAW_PRIZE_REDEEMED', 409, { gift_state: giftState });
  const cancel = gift && giftState !== 'cancelled'
    ? await planGiftCancel(db, gift, actorId, `Levo Care draw ${row.month} voided: ${reason}`, nowIso, { care_draw_id: id, care_draw_month: row.month })
    : [];
  const audit = await auditStatements(db, actorId, 'care_draw.voided', id, {
    month: row.month,
    reason,
    winner_user_id: row.winner_user_id,
    gift_id: row.gift_id,
    gift_state: giftState || null,
    prize: { product_id: row.prize_product_id, qty: row.prize_qty },
  });
  const words = CARE_DRAW_NOTICES.voided(row.month);
  try {
    await db.batch([
      db.prepare("UPDATE care_draws SET state = 'void', skip_reason = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'confirmed' AND gift_id = ?4").bind(reason, nowIso, id, row.gift_id),
      ...changedExactlyOne(db),
      ...cancel,
      ...audit.statements,
      notifyStatement(db, {
        userId: row.winner_user_id,
        kind: 'reward',
        title_ar: words.title.ar,
        title_en: words.title.en,
        body_ar: words.body.ar,
        body_en: words.body.en,
        link: '/gifts',
        entity_type: 'gift',
        entity_id: row.gift_id,
        meta: { title_ckb: words.title.ckb, body_ckb: words.body.ckb, care_draw_month: row.month },
        eventKey: `care_draw:voided:${row.month}`,
      }).stmt,
    ]);
  } catch (e) {
    if (isLostRace(e)) throw careDrawRefusal('CARE_DRAW_CHANGED');
    throw e;
  }
  await tellWinner(env, row.winner_user_id, `voided:${row.month}`, words);
}

/** A gift the winner has not acted on yet: the only one «إلغاء الجائزة» takes back. */
const UNREDEEMED = ['granted', 'ready_to_redeem'];

/** The same news on the channels that reach the customer (email, WhatsApp, Telegram). Never throws. */
async function tellWinner(env: Env, userId: string, month: string, words: { title: Tri; body: Tri; cta: Tri }): Promise<void> {
  try {
    const lang = (await reachFor(env, userId)).lang;
    const origin = String(env.APP_ORIGIN ?? '').trim().replace(/\/+$/, '');
    const msg: CustomerMessage = {
      subject: words.title[lang],
      body: words.body[lang],
      ...(origin.startsWith('https://') ? { cta: { label: words.cta[lang], url: `${origin}/gifts` } } : {}),
    };
    await notifyCustomer(env, userId, `care_draw:won:${month}`, msg);
  } catch (e) {
    console.error('care draw winner notice not queued', month, e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------ the admin's read

export interface CareDrawView {
  id: string;
  month: string;
  state: CareDrawState;
  candidates: number;
  candidate_hash: string;
  seed: string;
  redraws: number;
  winner: {
    user_id: string;
    name: string;
    username: string;
    /** The last four digits of the phone, or ''. */
    phone_tail: string;
    /** The winner still holds a Care in force now (only asked for a proposed draw). */
    eligible: boolean | null;
    device: { unit_id: string; name: Tri; care_end_at: string | null } | null;
  } | null;
  prize: { product_id: string; name: Tri; qty: number; note: string } | null;
  gift_id: string | null;
  /** «إلغاء الجائزة» is possible: confirmed, and the gift not redeemed yet. The owner's read only. */
  can_void: boolean;
  proposed_at: string | null;
  confirmed_at: string | null;
  confirmed_by: string;
  skip_reason: string;
}

export interface CareDrawsForAdmin {
  /** Who is reading: only the owner reads a proposed name, the seed and the hash, and only he may act. */
  viewer: 'owner' | 'staff';
  installed: boolean;
  /** The Baghdad month now, and when its draw is (or was) due. */
  month: string;
  due_at: string;
  /** How many customers hold a Care in force right now (one ticket each). */
  holders_now: number;
  current: CareDrawView | null;
  /** «اسحب الآن» is offered: this month has no row yet, or its row is a skipped month. */
  can_draw: boolean;
  history: CareDrawView[];
  rules: { prize_qty_max: number; rest_draws: number; reason_min: number };
}

const HISTORY_LIMIT = 24;
const tri = (r: { name?: string | null; name_ar?: string | null; name_ku?: string | null } | undefined): Tri => {
  const en = String(r?.name ?? '');
  return { ar: String(r?.name_ar || en), en: en || String(r?.name_ar ?? ''), ckb: String(r?.name_ku || r?.name_ar || en) };
};

export async function careDrawsForAdmin(db: D1Database, nowIso = new Date().toISOString(), opts: { owner?: boolean } = {}): Promise<CareDrawsForAdmin> {
  const nowMs = Date.parse(nowIso);
  const month = baghdadMonth(nowMs);
  const owner = opts.owner === true;
  const base: CareDrawsForAdmin = {
    viewer: owner ? 'owner' : 'staff',
    installed: true,
    month,
    due_at: new Date(drawDueMs(month)).toISOString(),
    holders_now: 0,
    current: null,
    can_draw: false,
    history: [],
    rules: { prize_qty_max: PRIZE_QTY_MAX, rest_draws: REST_DRAWS, reason_min: DRAW_REASON_MIN },
  };
  let rows: DrawRow[];
  try {
    rows = (await db.prepare('SELECT * FROM care_draws ORDER BY month DESC LIMIT ?').bind(HISTORY_LIMIT + 1).all<DrawRow>()).results ?? [];
  } catch (e) {
    if (isSchemaMissing(e)) return { ...base, installed: false };
    throw e;
  }
  if (!(await careClaimsInstalled(db))) return { ...base, installed: false };
  const holders = await careHolders(db, nowMs);

  const userIds = [...new Set(rows.map((r) => r.winner_user_id).filter((x): x is string => !!x))];
  const adminIds = [...new Set(rows.map((r) => r.confirmed_by).filter((x): x is string => !!x))];
  const unitIds = [...new Set(rows.map((r) => (r.state === 'proposed' ? holders.get(r.winner_user_id ?? '')?.unit_id ?? r.winner_unit_id : r.winner_unit_id)).filter((x): x is string => !!x))];
  const productIds = [...new Set(rows.map((r) => r.prize_product_id).filter((x): x is string => !!x))];
  const list = async <T>(sql: string, ids: string[]) => (ids.length ? (await db.prepare(sql).bind(JSON.stringify(ids)).all<T>()).results ?? [] : []);
  const [users, units, products] = await Promise.all([
    list<{ id: string; name: string | null; username: string | null; phone_e164: string | null }>(
      'SELECT id, name, username, phone_e164 FROM users WHERE id IN (SELECT value FROM json_each(?))',
      [...new Set([...userIds, ...adminIds])]
    ),
    list<{ id: string; name: string | null; name_ar: string | null; name_ku: string | null }>(
      `SELECT u.id, COALESCE(p.name, oi.name_snapshot) AS name, p.name_ar, p.name_ku
         FROM order_item_units u LEFT JOIN order_items oi ON oi.id = u.order_item_id LEFT JOIN products p ON p.id = u.product_id
        WHERE u.id IN (SELECT value FROM json_each(?))`,
      unitIds
    ),
    list<{ id: string; name: string | null; name_ar: string | null; name_ku: string | null }>(
      'SELECT id, name, name_ar, name_ku FROM products WHERE id IN (SELECT value FROM json_each(?))',
      productIds
    ),
  ]);
  const userOf = new Map(users.map((u) => [u.id, u]));
  const unitOf = new Map(units.map((u) => [u.id, u]));
  const productOf = new Map(products.map((p) => [p.id, p]));
  const care = unitIds.length ? await careEntitlements(db, unitIds, nowMs) : new Map<string, CareEntitlement>();
  const gifts = await list<{ id: string; state: string }>(
    'SELECT id, state FROM gift_entitlements WHERE id IN (SELECT value FROM json_each(?))',
    [...new Set(rows.map((r) => (r.state === 'confirmed' ? r.gift_id : null)).filter((x): x is string => !!x))]
  );
  const giftState = new Map(gifts.map((g) => [g.id, g.state]));

  const view = (r: DrawRow): CareDrawView => {
    const w = r.winner_user_id ? userOf.get(r.winner_user_id) : undefined;
    const live = r.state === 'proposed' ? holders.get(r.winner_user_id ?? '') : undefined;
    const unitId = live?.unit_id ?? r.winner_unit_id;
    const digits = String(w?.phone_e164 ?? '').replace(/\D/g, '');
    const prize = r.prize_product_id
      ? { product_id: r.prize_product_id, name: tri(productOf.get(r.prize_product_id)), qty: Number(r.prize_qty) || 1, note: owner ? r.prize_note : '' }
      : null;
    // Another admin reads what happened, never who is waiting: no proposed name, no seed, no hash, no phone.
    if (!owner) {
      return {
        id: r.id,
        month: r.month,
        state: r.state,
        candidates: Number(r.candidates) || 0,
        candidate_hash: '',
        seed: '',
        redraws: Number(r.redraws) || 0,
        winner: r.state === 'confirmed' && r.winner_user_id
          ? { user_id: '', name: String(w?.name || w?.username || ''), username: '', phone_tail: '', eligible: null, device: null }
          : null,
        prize,
        gift_id: null,
        can_void: false,
        proposed_at: r.proposed_at,
        confirmed_at: r.confirmed_at,
        confirmed_by: '',
        skip_reason: r.skip_reason === 'no_candidates' || r.skip_reason === STALE_REASON ? r.skip_reason : r.state === 'skipped' || r.state === 'void' ? 'owner' : '',
      };
    }
    return {
      id: r.id,
      month: r.month,
      state: r.state,
      candidates: Number(r.candidates) || 0,
      candidate_hash: r.candidate_hash,
      seed: r.seed,
      redraws: Number(r.redraws) || 0,
      winner: r.winner_user_id
        ? {
            user_id: r.winner_user_id,
            name: String(w?.name ?? ''),
            username: String(w?.username ?? ''),
            phone_tail: digits.length >= 4 ? digits.slice(-4) : '',
            eligible: r.state === 'proposed' ? !!live : null,
            device: unitId ? { unit_id: unitId, name: tri(unitOf.get(unitId)), care_end_at: care.get(unitId)?.end_at ?? null } : null,
          }
        : null,
      prize,
      gift_id: r.gift_id,
      can_void: r.state === 'confirmed' && !!r.gift_id && UNREDEEMED.includes(giftState.get(r.gift_id) ?? ''),
      proposed_at: r.proposed_at,
      confirmed_at: r.confirmed_at,
      confirmed_by: r.confirmed_by ? String(userOf.get(r.confirmed_by)?.name ?? '') : '',
      skip_reason: r.skip_reason,
    };
  };
  const current = rows.find((r) => r.month === month) ?? null;
  return {
    ...base,
    holders_now: holders.size,
    current: current ? view(current) : null,
    can_draw: owner && (!current || current.state === 'skipped'),
    history: rows.filter((r) => r.month !== month).slice(0, HISTORY_LIMIT).map(view),
  };
}

// ------------------------------------------------------------------ the customer's perks

export interface CarePerks {
  /** The day the weekly coupons this customer EARNS on his Care devices end (the latest of them); null when he earns none (the programme off, or the devices were bought by someone else). */
  weekly_coupons_until: string | null;
  /** The same day per device, by unit id. */
  weekly_coupons_by_unit: Record<string, string>;
  /** This month's draw as it concerns this customer; null on a database without the draw. */
  draw: { month: string; won: boolean; prize: { name: string; name_ar: string; name_ku: string; qty: number } | null; gift_id: string | null } | null;
}

/**
 * WHAT ELSE LEVO CARE INCLUDES, FOR ONE CUSTOMER (GET /api/devices/mine → `care_perks`): until when the
 * weekly coupons run on each Care device (delivery + the owner's months, the programme's own rule), and
 * this month's draw — whether he is its CONFIRMED winner, with the gift to claim. A proposed name is the
 * owner's business only: nothing here reveals it. Null when the customer holds no Care in force.
 */
export async function carePerksFor(db: D1Database, userId: string, held: ReadonlyMap<string, CareEntitlement>, nowMs = Date.now()): Promise<CarePerks | null> {
  const mine = [...held.values()].filter(careInForce);
  if (!mine.length) return null;
  // THE SAME TRUTH AS ISSUING. A date is said only for a device whose coupons THIS customer earns: the
  // programme's own «طابعاتك» read (`customerPrinters`: the order's buyer, the slot not stopped — returned,
  // traded in, sold without Care, the programme off). A device he was given carries its Care, and so the
  // draw, but its coupons are its buyer's: no date for it. A year that ran out is said with its end.
  const byUnit: Record<string, string> = {};
  try {
    const roots = [...new Set(mine.map((e) => e.root_unit_id))];
    const [{ results: units }, printers] = await Promise.all([
      db
        .prepare('SELECT id, order_item_id, unit_index FROM order_item_units WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(roots))
        .all<{ id: string; order_item_id: string; unit_index: number }>(),
      customerPrinters(db, userId, new Date(nowMs).toISOString()),
    ]);
    const slotOf = new Map((units ?? []).map((u) => [u.id, `${u.order_item_id}:${u.unit_index}`]));
    const earned = new Map(printers.map((p) => [`${p.order_item_id}:${p.unit_index}`, p]));
    for (const e of mine) {
      const p = earned.get(slotOf.get(e.root_unit_id) ?? '');
      if (p?.ends_at && (p.earning || p.stopped === 'warranty_over')) byUnit[e.unit_id] = p.ends_at;
    }
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  const ends = Object.values(byUnit).sort();
  const month = baghdadMonth(nowMs);
  let draw: CarePerks['draw'] = null;
  try {
    const row = await db
      .prepare(
        `SELECT d.state, d.winner_user_id, d.gift_id, d.prize_qty, p.name, p.name_ar, p.name_ku
           FROM care_draws d LEFT JOIN products p ON p.id = d.prize_product_id WHERE d.month = ?`
      )
      .bind(month)
      .first<{ state: string; winner_user_id: string | null; gift_id: string | null; prize_qty: number | null; name: string | null; name_ar: string | null; name_ku: string | null }>();
    const won = !!row && row.state === 'confirmed' && row.winner_user_id === userId;
    const names = tri(row ?? undefined);
    draw = {
      month,
      won,
      prize: won ? { name: names.en, name_ar: names.ar, name_ku: names.ckb, qty: Number(row!.prize_qty) || 1 } : null,
      gift_id: won ? row!.gift_id : null,
    };
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  return { weekly_coupons_until: ends.length ? ends[ends.length - 1] : null, weekly_coupons_by_unit: byUnit, draw };
}

