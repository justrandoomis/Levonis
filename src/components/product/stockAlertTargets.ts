/**
 * «خبرني لما يرجع» — WHAT THE CUSTOMER IS ALLOWED TO POINT AT.
 *
 * The browser half of migration 0092. Everything in this file is pure: which
 * targets a product can honestly offer, how one survives a trip through
 * /auth?next=, and what each of the server's refusal codes says in the three
 * languages. No React, no fetch — so tests/stockAlertUi.test.ts can run the
 * real rules instead of a paraphrase of them.
 *
 * ---------------------------------------------------------------------------
 * THE PICKER MAY ONLY OFFER WHAT ONE `product_stock_alerts` ROW CAN NAME.
 *
 * The schema's four kinds are the whole vocabulary:
 *
 *   'product'      the product, whatever its models and colours do
 *   'option_value' ONE model            — one `option_value_id`, no colour
 *   'color'        ONE colour           — one `color_id`, every model
 *   'combination'  ONE model in ONE colour
 *
 * Note what is missing: there is exactly ONE `option_value_id` column. A
 * product with two option groups (model AND nozzle, say) therefore has no row
 * that can say «A1 كومبو بفوهة 0.4». A picker that listed the model values of
 * such a product would arm `option_value = A1` and the sweep would fire the
 * moment ANY completion containing A1 became buyable — a different nozzle from
 * the one the customer was standing in front of. The customer would be told
 * «رجع A1 كومبو», arrive, and find the thing they wanted still gone. That is
 * the promise this module refuses to let the UI make: with more than one
 * option group the only honest targets are the product as a whole and, when
 * the product has colours, a colour — both of which one row names exactly.
 *
 * So `buildAlertTargets` is not a formatting helper. It is the rule that keeps
 * the picker's choices and the server's storage in step, and the reason the
 * A1 / A1 Combo product (one group, two values) gets the per-model list the
 * owner asked for while a multi-group product quietly gets fewer rows rather
 * than a lie.
 */

import type { Lang } from '../orders/format';

/** The four `kind` values migration 0092's CHECK constraint allows. */
export type StockAlertKind = 'product' | 'option_value' | 'color' | 'combination';

/**
 * A wish AS THE REQUEST BODY SPELLS IT (camelCase — worker/routes/stockAlerts
 * `readWish`). `''` and never null or undefined for an id the wish does not
 * name: the route refuses `optionValueId` on a kind that may not carry one, so
 * an accidental `undefined` here is a 400 rather than a silently narrower
 * alert.
 */
export interface StockAlertWish {
  kind: StockAlertKind;
  optionValueId: string;
  colorId: string;
}

/** A stored alert as GET/PUT answer it (snake_case — the D1 columns). */
export interface StockAlertRow {
  id: string;
  product_id: string;
  kind: string;
  option_value_id: string;
  color_id: string;
  state: string;
  arm_seq: number;
  armed_channel: string;
  armed_at: string;
  notified_at: string;
  expires_at: string;
  dead_reason: string;
}

/**
 * The identity `idx_stock_alerts_target` uses, as a comparable string — the
 * same `JSON.stringify` of the same three fields the route uses, and for the
 * same reason: a joined string would merge two different wishes the day an id
 * contains the separator, and the row that then went missing from a save would
 * look like a lost write rather than a collision.
 */
export const wishKey = (w: StockAlertWish): string =>
  JSON.stringify([w.kind, w.optionValueId, w.colorId]);

/** A stored row read back as the wish that created it, so a ticked box and a
 *  saved row compare by ONE rule. The cast is safe for the same reason the
 *  route's is: SQLite's CHECK constraint cannot hold a fifth value. */
export const wishOfRow = (r: StockAlertRow): StockAlertWish => ({
  kind: r.kind as StockAlertKind,
  optionValueId: r.option_value_id,
  colorId: r.color_id,
});

// ------------------------------------------------------------------ targets

/** One value of the product's single option group — a "model" on this page. */
export interface AlertModel {
  id: string;
  label: string;
}

/** A colour the customer may narrow the wish to. */
export interface AlertColorOption {
  id: string;
  label: string;
}

export interface AlertTargetInput {
  /** Values of the product's option group, in catalogue order. */
  models: AlertModel[];
  /**
   * How many option groups the product publishes. More than one and no single
   * `option_value_id` names a model — see the module note.
   */
  optionGroupCount: number;
  /** The colour the sheet is scoped to, `''` for «any colour». */
  colorId: string;
  /** Shown on the «any model» row. */
  productLabel: string;
  /** Shown instead of `productLabel` when a colour narrows the wish. */
  colorLabel?: string;
}

export interface AlertTarget {
  /** Stable across renders and equal to nothing else on the sheet. */
  key: string;
  label: string;
  wish: StockAlertWish;
}

/**
 * The route refuses a save carrying more than twenty wishes
 * (MAX_WISHES_PER_PRODUCT). Capping the LIST here means a catalogue with a
 * pathological number of values shows fewer rows rather than letting the
 * customer tick a set that is refused wholesale at Save with a message about a
 * limit they were never shown.
 */
export const MAX_ALERT_TARGETS = 20;

/**
 * The rows the sheet may draw, given what this product actually models.
 *
 * ONE GROUP → one row per model, plus an «any model» row when there is more
 * than one to choose between (a customer who just wants the shelf back should
 * not have to tick every model, and the product-level row is the one the sweep
 * can satisfy from any of them).
 *
 * MORE THAN ONE GROUP, OR NO MODELS AT ALL → the single row that one stored
 * row can name honestly.
 *
 * A colour scope changes the KIND rather than the list: with a colour chosen
 * a model row becomes 'combination' and the wide row becomes 'color'. Both are
 * exact; neither is a narrowing the server would discard.
 */
export function buildAlertTargets(input: AlertTargetInput): AlertTarget[] {
  const colorId = input.colorId || '';
  const wideLabel = colorId ? input.colorLabel || input.productLabel : input.productLabel;
  const wide: AlertTarget = {
    key: 'all',
    label: wideLabel,
    wish: {
      kind: colorId ? 'color' : 'product',
      optionValueId: '',
      colorId,
    },
  };

  const perModel = input.optionGroupCount === 1 && input.models.length > 0;
  if (!perModel) return [wide];

  const rows: AlertTarget[] = input.models.slice(0, MAX_ALERT_TARGETS).map((m) => ({
    key: `o:${m.id}`,
    label: m.label,
    wish: {
      kind: colorId ? 'combination' : 'option_value',
      optionValueId: m.id,
      colorId,
    },
  }));

  // With a single model there is nothing for «any model» to mean that the one
  // row does not already say, and two rows that arm the same thing are two
  // chances to be told twice about one restock.
  if (rows.length < 2) return rows;
  return [wide, ...rows].slice(0, MAX_ALERT_TARGETS);
}

// -------------------------------------------------- the choice survives auth

/**
 * WHY THE CHOICE TRAVELS IN THE URL AND NOT IN STORAGE.
 *
 * Every stock-alert route is behind `requireAuth`, so a signed-out visitor who
 * taps «خبرني لما يرجع» has to go to /auth and come back. Coming back to the
 * product with an empty sheet asks them to find the model again — and on a
 * phone, after a Telegram round trip, that is where people give up.
 *
 * `?alert=` on the RETURN path is the smallest thing that survives: it rides
 * inside the existing `?next=` machinery (src/components/auth/nextPath.ts
 * keeps a relative path's query string intact, tests/authNextPath.test.ts pins
 * it), it costs no storage that a private window or a cleared cache can lose,
 * and it cannot outlive the trip it was written for.
 *
 * It is READ BACK AS UNTRUSTED INPUT. Anyone can type it, so `decodeAlertIntent`
 * accepts only the exact grammar below and drops the whole token otherwise; a
 * dropped token costs one tap, while a trusted one would pre-tick a target
 * nobody chose. Nothing is ever ARMED from the URL either — the sheet opens
 * with the boxes ticked and the customer presses Save, because a link that
 * silently creates a standing request on someone's account is a link worth
 * sending to someone else.
 */
const INTENT_ID = /^[A-Za-z0-9_-]{1,60}$/;

/** Eight is far more than a picker can offer (a product has a handful of
 *  models) and small enough that a hand-written URL cannot make the sheet
 *  render a hundred rows. */
const MAX_INTENT_TOKENS = 8;

/**
 * `p` | `o:<id>` | `c:<id>` | `o:<id>~c:<id>`, joined with `,`.
 *
 * `:` `~` and `,` are all outside `INTENT_ID`, so no id can ever contain a
 * separator and the grammar cannot be broken by catalogue data.
 */
export function encodeAlertIntent(wishes: readonly StockAlertWish[]): string {
  const tokens: string[] = [];
  for (const w of wishes.slice(0, MAX_INTENT_TOKENS)) {
    const o = w.optionValueId;
    const c = w.colorId;
    if (o && !INTENT_ID.test(o)) continue;
    if (c && !INTENT_ID.test(c)) continue;
    if (w.kind === 'product') tokens.push('p');
    else if (w.kind === 'option_value' && o) tokens.push(`o:${o}`);
    else if (w.kind === 'color' && c) tokens.push(`c:${c}`);
    else if (w.kind === 'combination' && o && c) tokens.push(`o:${o}~c:${c}`);
  }
  return tokens.join(',');
}

export function decodeAlertIntent(raw: string | null | undefined): StockAlertWish[] {
  if (typeof raw !== 'string' || !raw) return [];
  const out: StockAlertWish[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(',').slice(0, MAX_INTENT_TOKENS)) {
    const wish = decodeOne(token);
    if (!wish) continue;
    const key = wishKey(wish);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(wish);
  }
  return out;
}

function decodeOne(token: string): StockAlertWish | null {
  if (token === 'p') return { kind: 'product', optionValueId: '', colorId: '' };
  if (token.startsWith('c:')) {
    const id = token.slice(2);
    return INTENT_ID.test(id) ? { kind: 'color', optionValueId: '', colorId: id } : null;
  }
  if (!token.startsWith('o:')) return null;
  const rest = token.slice(2);
  const tilde = rest.indexOf('~c:');
  if (tilde === -1) {
    return INTENT_ID.test(rest) ? { kind: 'option_value', optionValueId: rest, colorId: '' } : null;
  }
  const optionValueId = rest.slice(0, tilde);
  const colorId = rest.slice(tilde + 3);
  if (!INTENT_ID.test(optionValueId) || !INTENT_ID.test(colorId)) return null;
  return { kind: 'combination', optionValueId, colorId };
}

/** The product path carrying a choice — what goes inside `?next=`. */
export function productPathWithIntent(slug: string, wishes: readonly StockAlertWish[]): string {
  const intent = encodeAlertIntent(wishes);
  const base = `/product/${slug}`;
  return intent ? `${base}?alert=${encodeURIComponent(intent)}` : base;
}

// ----------------------------------------------------------------- refusals

/**
 * THE SERVER'S REFUSAL CODES, SAID IN THE THREE LANGUAGES.
 *
 * `HttpError` carries ONE sentence and the route writes it Arabic-then-English
 * in a single string (worker/routes/stockAlerts.ts REFUSAL_TEXT). Printing
 * that verbatim shows a Kurdish reader Arabic followed by a slash followed by
 * English — and shows every reader both languages at once. These are the same
 * facts, one language at a time.
 *
 * They are HERE and not in src/lib/refusalStrings.ts on purpose: that table is
 * shared by the cart and the checkout and is walked by its own contract test,
 * and this feature's codes are not part of that contract. `alertRefusalText`
 * falls back to the server's own sentence for anything this table does not
 * know, so a code added to the route later is still readable — just bilingual
 * until somebody adds it here.
 */
const ALERT_REFUSALS: Record<string, { ar: string; en: string; ckb: string }> = {
  /* 503 — «ask again later», NOT «failed». The context was degraded, which
     means a relational read did not come back, so the door refused to make a
     promise it could not check. Nothing is wrong with what the customer asked
     for and the next attempt usually succeeds, so the copy says exactly that
     and the sheet keeps their ticks and offers Retry. */
  ALERT_TEMPORARILY_UNAVAILABLE: {
    ar: 'ما كدرنا نتأكد من هذا المنتج هسه. اختيارك محفوظ — جرّب مرة ثانية بعد لحظات.',
    en: 'We could not check this product just now. Your choice is kept — try again in a moment.',
    ckb: 'لە ئێستادا نەمانتوانی ئەم بەرهەمە بپشکنین. هەڵبژاردنەکەت پارێزراوە — دوای چەند چرکەیەک دووبارە هەوڵ بدە.',
  },
  ALERT_PREORDER_ONLY: {
    ar: 'هذا الخيار بالطلب المسبق فقط — ما عنده مخزون ننتظره. تكدر تطلبه هسه.',
    en: 'This option is pre-order only — there is no shelf to wait for. You can order it now.',
    ckb: 'ئەم هەڵبژاردەیە تەنها پێش‌داواکارییە — کۆگایەک نییە چاوەڕێی بکەین. ئێستا دەتوانیت داوای بکەیت.',
  },
  ALERT_UNTRACKED: {
    ar: 'هذا الخيار ما عنده عدّاد مخزون، فما نكدر نعرف متى يرجع.',
    en: 'This option has no stock counter, so we cannot tell when it returns.',
    ckb: 'ئەم هەڵبژاردەیە ژمێرەری کۆگای نییە، بۆیە ناتوانین بزانین کەی دەگەڕێتەوە.',
  },
  ALERT_VARIANT_NOT_MODELLED: {
    ar: 'هذا التجميع (الموديل مع اللون) غير معروض بالمتجر. اختر تجميع ثاني.',
    en: 'This exact model-and-colour combination is not offered. Please choose another.',
    ckb: 'ئەم تێکەڵەیە (مۆدێل لەگەڵ ڕەنگ) پێشکەش ناکرێت. یەکێکی تر هەڵبژێرە.',
  },
  ALERT_TARGET_REMOVED: {
    ar: 'الخيار الذي اخترته ما عاد موجود.',
    en: 'The option you chose no longer exists.',
    ckb: 'ئەو هەڵبژاردەیەی هەڵتبژارد چیتر بوونی نییە.',
  },
  ALERT_TARGET_INACTIVE: {
    ar: 'الخيار الذي اخترته ما عاد معروض حالياً.',
    en: 'The option you chose is no longer on display.',
    ckb: 'ئەو هەڵبژاردەیەی هەڵتبژارد ئێستا پیشان نادرێت.',
  },
  ALERT_PRODUCT_UNAVAILABLE: {
    ar: 'هذا المنتج غير معروض حالياً.',
    en: 'This product is not on display right now.',
    ckb: 'ئەم بەرهەمە لە ئێستادا پیشان نادرێت.',
  },
  ALERT_COMPOSITION: {
    ar: 'هذا منتج مركّب (بكج أو صندوق)، وما إله مخزون خاص فيه ننتبه عليه.',
    en: 'This is a bundle or mystery box; it has no shelf of its own to watch.',
    ckb: 'ئەمە پاکێج یان سندوقێکی نهێنییە؛ کۆگای تایبەت بە خۆی نییە چاودێری بکەین.',
  },
  ALERT_NOT_A_STOCK_TARGET: {
    ar: 'هذا الخيار ما ينباع من المخزون، فما نكدر ننبهك عليه.',
    en: 'This option is not sold from stock, so we cannot alert you about it.',
    ckb: 'ئەم هەڵبژاردەیە لە کۆگاوە نافرۆشرێت، بۆیە ناتوانین ئاگادارت بکەینەوە.',
  },
  ALERT_LIMIT_REACHED: {
    ar: 'وصلت للحد الأعلى من التنبيهات. احذف واحد قبل ما تضيف غيره.',
    en: 'You have reached the maximum number of alerts. Remove one before adding another.',
    ckb: 'گەیشتوویتە زۆرترین ژمارەی ئاگادارکردنەوە. پێش زیادکردنی یەکێکی تر، یەکێک بسڕەوە.',
  },
  TOO_MANY_ALERTS: {
    ar: 'اخترت أكثر مما نكدر نحفظه دفعة وحدة. قلّل الاختيارات وجرّب مرة ثانية.',
    en: 'That is more than one save can hold. Choose fewer and try again.',
    ckb: 'لە توانای یەک پاشەکەوتکردن زیاترە. کەمتر هەڵبژێرە و دووبارە هەوڵ بدە.',
  },
  RATE_LIMITED: {
    ar: 'محاولات كثيرة بوقت قصير. استنّى شوية وجرّب مرة ثانية.',
    en: 'Too many attempts in a short time. Wait a little and try again.',
    ckb: 'هەوڵی زۆر لە ماوەیەکی کورتدا. کەمێک چاوەڕێ بکە و دووبارە هەوڵ بدە.',
  },
  NOT_FOUND: {
    ar: 'ما لكينا هذا التنبيه — يمكن انحذف من قبل.',
    en: 'We could not find that alert — it may already be removed.',
    ckb: 'ئەم ئاگادارکردنەوەیەمان نەدۆزییەوە — لەوانەیە پێشتر سڕابێتەوە.',
  },
};

/**
 * The refusal in ONE language, falling back to the server's own sentence — the
 * same discipline `apiRefusal` uses, and for the same reason: the alternative
 * is a customer reading the literal string `ALERT_UNTRACKED`.
 */
export function alertRefusalText(err: unknown, lang: Lang, fallback: string): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = e && typeof e.code === 'string' ? e.code : '';
  const known = code ? ALERT_REFUSALS[code] : undefined;
  if (known) return known[lang];
  const message = e && typeof e.message === 'string' ? e.message.trim() : '';
  return message || fallback;
}

/**
 * A refusal that names ONE target rather than the request as a whole.
 *
 * The save is atomic on purpose (an unarmable wish refuses the WHOLE save, so
 * the customer never leaves with a partial set they cannot read off the
 * screen), and the route answers with the reason but not with which of the
 * ticked rows caused it. When the reason is one of these, the sheet says so
 * plainly — «واحد من اختياراتك ما ينراد» — instead of leaving the customer to
 * re-tap Save on the same set for ever.
 */
export function isPerTargetRefusal(code: string | undefined | null): boolean {
  return (
    code === 'ALERT_PREORDER_ONLY' ||
    code === 'ALERT_UNTRACKED' ||
    code === 'ALERT_VARIANT_NOT_MODELLED' ||
    code === 'ALERT_TARGET_REMOVED' ||
    code === 'ALERT_TARGET_INACTIVE' ||
    code === 'ALERT_NOT_A_STOCK_TARGET'
  );
}

// ------------------------------------------------------------------ channel

/**
 * WHERE THE MESSAGE WILL LAND, NAMED BY THE SERVER AND NOT BY THE PAGE.
 *
 * The route answers every arm with the ONE `channel` it picked
 * (`channelReadiness().recommended`, never null — the in-app inbox is the
 * floor). A page that composed «راح نخبرك على تيليغرام» from its own idea of
 * what is linked would eventually promise a channel the server did not pick —
 * a revoked bot binding, an unverified mailbox — and the customer would be
 * told in writing to watch somewhere nothing arrives. This table only turns
 * the server's answer into a word.
 */
/**
 * THE PREPOSITION BELONGS IN THE TABLE, NOT IN THE SENTENCE.
 *
 * The one sentence whose whole job is telling the customer WHERE the restock
 * message will arrive reads `«تم. راح نخبرك {channel} أول ما يرجع.»`, and with
 * bare nouns in here it came out «راح نخبرك تيليغرام» — no preposition, not
 * Iraqi, not Arabic. English was worse: "We will tell you Telegram as soon as
 * it is back." Only `inapp` happened to read correctly, because «داخل التطبيق»
 * carries its own preposition — and Telegram is the channel most Iraqi
 * customers have linked, so the broken one was the common one.
 *
 * Each language governs it differently — Arabic «على», Sorani «لە» but «بە» for
 * email, English "on"/"by"/"in the" — so it cannot be prefixed by the template.
 * It is recorded per language per channel, which is what this project does
 * with every other phrase it cannot derive.
 */
export const CHANNEL_NAMES: Record<string, { ar: string; en: string; ckb: string }> = {
  inapp: { ar: 'داخل التطبيق', en: 'in the app', ckb: 'لەناو ئەپەکەدا' },
  telegram: { ar: 'على تيليغرام', en: 'on Telegram', ckb: 'لە تێلێگرام' },
  whatsapp: { ar: 'على واتساب', en: 'on WhatsApp', ckb: 'لە واتسئاپ' },
  email: { ar: 'على الإيميل', en: 'by email', ckb: 'بە ئیمەیڵ' },
};

export function channelName(channel: string, lang: Lang): string {
  return (CHANNEL_NAMES[channel] ?? CHANNEL_NAMES.inapp)[lang];
}
