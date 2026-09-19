/**
 * «خبرني لما يرجع» — THE BUTTON, AND THE SHEET BEHIND IT (migration 0092).
 *
 * The server half has been live since 0092: /api/stock-alerts arms a standing
 * request, the sweep in worker/lib/stockAlerts.ts answers it every fifteen
 * minutes. Nothing on the storefront ever asked for one. A customer who found
 * the shelf empty had exactly one way to be told when it filled: come back and
 * look again.
 *
 * ---------------------------------------------------------------------------
 * THE SENTENCE THIS SCREEN MUST NEVER SAY IS «هذا المنتج غير متوفر».
 *
 * The situation this panel appears in is not unavailability. Direct sale is
 * sold out AND pre-order is open — the page already says so, in
 * `directSoldOutPreorderOpen` — which means the product CAN be bought right
 * now, by the other route, at a higher price. A customer arming an alert here
 * is not waiting for the product. They are choosing to WAIT FOR THE CHEAPER
 * ROUTE, having seen and declined the expensive one.
 *
 * So every line of copy below is written against that truth. The panel never
 * implies the thing is gone, it never competes with the pre-order card
 * standing beside it, and it says out loud what the wait buys — «تنتظر سعر
 * البيع المباشر» — because a customer who does not know that is being nudged
 * away from a purchase they could make today for no reason they can see.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PICKER IS PER MODEL, AND WHERE IT STOPS BEING ONE.
 *
 * The owner chose the precise version — «قم بالتدقيق» — so the message can say
 * «رجع A1 كومبو» rather than «رجع المنتج». `buildAlertTargets`
 * (./stockAlertTargets.ts) owns the rule and its long note owns the reason: a
 * stored alert has exactly ONE `option_value_id`, so per-model rows are honest
 * for a product with one option group and a lie for a product with two. This
 * file draws whatever that function returns and adds nothing to it.
 *
 * THE COLOUR IS THE PAGE'S, NOT THE SHEET'S. When the customer has picked a
 * colour on the product page the wishes carry it (kind 'combination' /
 * 'color'); when they have not, the wish is colour-blind and the sheet says
 * «أي لون». There is deliberately no colour selector in here: Save REPLACES
 * this product's whole alert set in one batch, and a second scope inside the
 * sheet is how a customer ends up silently cancelling a standing alert they
 * could not see on screen. Anything armed that the current rows cannot
 * represent is listed under «تنبيهات ثانية على هذا المنتج» and carried through
 * Save untouched unless they remove it themselves.
 *
 * ---------------------------------------------------------------------------
 * THE THREE ANSWERS THAT ARE NOT FAILURES.
 *
 *   401  the routes are behind requireAuth. A signed-out visitor still gets
 *        the sheet and still picks their model; Save takes them to /auth with
 *        `?next=` carrying BOTH the product and the choice (see
 *        `productPathWithIntent`), so they come back to a pre-ticked sheet
 *        rather than to an empty one they have to fill in again.
 *
 *   503 ALERT_TEMPORARILY_UNAVAILABLE
 *        «حاول بعد لحظات», NOT «فشل». The resolver's context was degraded — a
 *        relational read did not come back — so the door refused to promise
 *        something it could not verify. The request was fine. The sheet keeps
 *        every tick, says so, and offers Retry; calling this a failure would
 *        be telling the customer something untrue about their own account.
 *
 *   400 ALERT_<reason>
 *        permanent, and the ONLY moment it can be said honestly. The door is
 *        stricter than the sweep on purpose (worker/routes/stockAlerts.ts): a
 *        pre-order-only model, an untracked shelf, a combination the shop does
 *        not model. Each is a promise that could never be kept, and the
 *        alternative to refusing it here is a row that sits armed for ninety
 *        days and fires never.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { StockAlertRow, StockAlertReadiness, StockAlertSaveResponse, StockAlertsForProductResponse } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Overlay';
import Spinner from '../ui/Spinner';
import { asLang, type Lang } from '../orders/format';
import {
  alertRefusalText,
  buildAlertTargets,
  channelName,
  isPerTargetRefusal,
  productPathWithIntent,
  wishKey,
  wishOfRow,
  type AlertColorOption,
  type AlertModel,
  type AlertTarget,
  type StockAlertWish,
} from './stockAlertTargets';

const STRINGS = {
  ar: {
    /* The trigger. «خبرني لما يرجع» is the owner's own wording. */
    cta: 'خبرني لما يرجع',
    ctaSub: 'نفد البيع المباشر — نخبرك أول ما يرجع بسعره',
    armedCta: 'راح نخبرك لما يرجع',
    armedChange: 'تغيير أو إلغاء',
    /* The sheet. */
    title: 'خبرني لما يرجع',
    introPreorder:
      'الطلب المسبق مفتوح وتكدر تطلبه هسه. وإذا تفضّل تنتظر سعر البيع المباشر الأرخص، اختر شنو تنتظر ونخبرك أول ما يرجع للمخزون.',
    introPlain: 'اختر شنو تنتظر بالضبط، ونخبرك أول ما يرجع للمخزون.',
    pickTitle: 'شنو تنتظر؟',
    anyModel: 'أي موديل',
    forColor: (color: string) => `اللون المختار: ${color}`,
    anyColor: 'أي لون — اختر لونًا من الصفحة إذا تنتظر لون محدد',
    others: 'تنبيهات ثانية على هذا المنتج',
    othersHint: 'محفوظة كما هي. اضغط الإزالة إذا ما عدت تنتظرها.',
    remove: 'إزالة',
    gone: 'خيار ما عاد معروض',
    signInNeeded: 'تحتاج تسجّل دخول حتى نكدر نوصّلك الخبر. اختيارك راح يبقى محفوظ.',
    signIn: 'سجّل الدخول واحفظ',
    save: 'احفظ',
    saving: 'جارٍ الحفظ…',
    cancelAll: 'إلغاء التنبيه',
    close: 'إغلاق',
    retry: 'حاول مرة ثانية',
    loading: 'جارٍ قراءة تنبيهاتك…',
    pickOne: 'اختر واحد على الأقل، أو اضغط «إلغاء التنبيه».',
    /* The confirmation names the channel the SERVER picked, never one we guessed. */
    doneOn: (channel: string) => `تم. راح نخبرك ${channel} أول ما يرجع.`,
    doneCancelled: 'تم إلغاء التنبيه على هذا المنتج.',
    activate: 'فعّل قناة أسرع',
    perTarget: 'واحد من اختياراتك ما نكدر ننبّه عليه، وما انحفظ ولا واحد. شيل الاختيار المذكور وجرّب مرة ثانية.',
    failed: 'تعذّر حفظ التنبيه. حاول مرة ثانية.',
    loadFailed: 'تعذّر قراءة تنبيهاتك الحالية.',
  },
  en: {
    cta: 'Tell me when it is back',
    ctaSub: 'Direct sale is sold out — we will tell you when it returns',
    armedCta: 'We will tell you when it is back',
    armedChange: 'Change or cancel',
    title: 'Tell me when it is back',
    introPreorder:
      'Pre-order is open and you can order it now. If you would rather wait for the cheaper direct-sale price, pick what you are waiting for and we will tell you the moment it is back in stock.',
    introPlain: 'Pick exactly what you are waiting for and we will tell you the moment it is back in stock.',
    pickTitle: 'What are you waiting for?',
    anyModel: 'Any model',
    forColor: (color: string) => `Chosen colour: ${color}`,
    anyColor: 'Any colour — choose one on the page if you are waiting for a specific colour',
    others: 'Your other alerts on this product',
    othersHint: 'Kept as they are. Remove one if you are no longer waiting for it.',
    remove: 'Remove',
    gone: 'This option is no longer offered',
    signInNeeded: 'You need to sign in so we have somewhere to send the message. Your choice will be kept.',
    signIn: 'Sign in and save',
    save: 'Save',
    saving: 'Saving…',
    cancelAll: 'Cancel the alert',
    close: 'Close',
    retry: 'Try again',
    loading: 'Reading your alerts…',
    pickOne: 'Pick at least one, or press “Cancel the alert”.',
    doneOn: (channel: string) => `Done. We will tell you ${channel} as soon as it is back.`,
    doneCancelled: 'The alert on this product has been cancelled.',
    activate: 'Turn on a faster channel',
    perTarget: 'One of your choices cannot be watched, so nothing was saved. Remove it and try again.',
    failed: 'We could not save the alert. Please try again.',
    loadFailed: 'We could not read your current alerts.',
  },
  ckb: {
    cta: 'ئاگادارم بکەوە کە گەڕایەوە',
    ctaSub: 'فرۆشتنی ڕاستەوخۆ تەواو بووە — کاتێک گەڕایەوە پێت دەڵێین',
    armedCta: 'کاتێک گەڕایەوە ئاگادارت دەکەینەوە',
    armedChange: 'گۆڕین یان هەڵوەشاندنەوە',
    title: 'ئاگادارم بکەوە کە گەڕایەوە',
    introPreorder:
      'پێش‌داواکاری کراوەیە و ئێستا دەتوانیت داوای بکەیت. ئەگەر پێت باشترە چاوەڕێی نرخی هەرزانتری فرۆشتنی ڕاستەوخۆ بکەیت، هەڵبژێرە چاوەڕێی چی دەکەیت و هەرکە گەڕایەوە بۆ کۆگا پێت دەڵێین.',
    introPlain: 'بە وردی هەڵبژێرە چاوەڕێی چی دەکەیت، هەرکە گەڕایەوە بۆ کۆگا پێت دەڵێین.',
    pickTitle: 'چاوەڕێی چی دەکەیت؟',
    anyModel: 'هەر مۆدێلێک',
    forColor: (color: string) => `ڕەنگی هەڵبژێردراو: ${color}`,
    anyColor: 'هەر ڕەنگێک — ئەگەر چاوەڕێی ڕەنگێکی دیاریکراویت، لە پەڕەکەدا هەڵیبژێرە',
    others: 'ئاگادارکردنەوەکانی تری تۆ لەسەر ئەم بەرهەمە',
    othersHint: 'وەک خۆیان پارێزراون. ئەگەر چیتر چاوەڕێیان ناکەیت، بیانسڕەوە.',
    remove: 'سڕینەوە',
    gone: 'ئەم هەڵبژاردەیە چیتر پێشکەش ناکرێت',
    signInNeeded: 'پێویستە بچیتە ژوورەوە تا شوێنێکمان هەبێت پەیامەکەی بۆ بنێرین. هەڵبژاردنەکەت دەپارێزرێت.',
    signIn: 'بچۆ ژوورەوە و پاشەکەوتی بکە',
    save: 'پاشەکەوت',
    saving: 'پاشەکەوت دەکرێت…',
    cancelAll: 'هەڵوەشاندنەوەی ئاگادارکردنەوە',
    close: 'داخستن',
    retry: 'دووبارە هەوڵ بدە',
    loading: 'ئاگادارکردنەوەکانت دەخوێنرێنەوە…',
    pickOne: 'لانیکەم یەکێک هەڵبژێرە، یان «هەڵوەشاندنەوەی ئاگادارکردنەوە» دابگرە.',
    doneOn: (channel: string) => `تەواو بوو. هەرکە گەڕایەوە ${channel} پێت دەڵێین.`,
    doneCancelled: 'ئاگادارکردنەوەی ئەم بەرهەمە هەڵوەشێنرایەوە.',
    activate: 'کەناڵێکی خێراتر چالاک بکە',
    perTarget: 'یەکێک لە هەڵبژاردنەکانت ناتوانرێت چاودێری بکرێت، بۆیە هیچ پاشەکەوت نەکرا. لایبە و دووبارە هەوڵ بدە.',
    failed: 'نەمانتوانی ئاگادارکردنەوەکە پاشەکەوت بکەین. دووبارە هەوڵ بدە.',
    loadFailed: 'نەمانتوانی ئاگادارکردنەوە ئێستاکانت بخوێنینەوە.',
  },
} as const;

export interface StockAlertPanelProps {
  productId: string;
  productSlug: string;
  productLabel: string;
  /** Values of the product's option group, already labelled by the page. */
  models: AlertModel[];
  /** How many option groups the product publishes — the per-model rule. */
  optionGroupCount: number;
  /** Every colour the product offers, for naming a stored wish's colour. */
  colors: AlertColorOption[];
  /** The colour chosen ON THE PAGE, '' when none. The sheet follows it. */
  selectedColorId: string;
  /** True when pre-order is genuinely open, which decides the intro copy. */
  preorderOpen: boolean;
  isAuthenticated: boolean;
  /** Pre-ticked rows recovered from `?alert=` after the sign-in bounce. */
  intent: readonly StockAlertWish[];
  /** Called once the intent has been taken up, so a refresh does not reopen. */
  onIntentConsumed: () => void;
}

export default function StockAlertPanel({
  productId,
  productSlug,
  productLabel,
  models,
  optionGroupCount,
  colors,
  selectedColorId,
  preorderOpen,
  isAuthenticated,
  intent,
  onIntentConsumed,
}: StockAlertPanelProps) {
  const { lang } = useLanguage();
  const L = asLang(lang) as Lang;
  const s = STRINGS[L];
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<StockAlertRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The refusal code behind `error`, so a 503 can keep the ticks and a
   *  per-target 400 can add the sentence that says which way out exists. */
  const [errorCode, setErrorCode] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /** Armed wishes the current rows cannot represent. Carried through Save so
   *  a replace-the-whole-set write never cancels something off screen. */
  const [carried, setCarried] = useState<StockAlertWish[]>([]);
  const [done, setDone] = useState<{ channel: string; readiness: StockAlertReadiness | null } | null>(null);

  const colorLabel = useMemo(
    () => colors.find((c) => c.id === selectedColorId)?.label ?? '',
    [colors, selectedColorId]
  );

  const targets: AlertTarget[] = useMemo(
    () =>
      buildAlertTargets({
        models,
        optionGroupCount,
        colorId: selectedColorId,
        productLabel: models.length > 1 ? s.anyModel : productLabel,
        colorLabel: colorLabel || productLabel,
      }),
    [models, optionGroupCount, selectedColorId, productLabel, colorLabel, s.anyModel]
  );

  /** The row a wish belongs to, or undefined when no row can represent it. */
  const keyOfWish = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of targets) map.set(wishKey(t.wish), t.key);
    return map;
  }, [targets]);

  /**
   * Split a set of wishes into "ticks the sheet can show" and "everything
   * else, kept". Both the stored rows and the URL intent go through it, but
   * only STORED wishes may be carried: an intent token the rows cannot express
   * came from a URL anyone can type, and carrying it would save a target
   * nobody on this screen chose.
   */
  const applyWishes = useCallback(
    (stored: readonly StockAlertWish[], wanted: readonly StockAlertWish[]) => {
      const tick = new Set<string>();
      const keep: StockAlertWish[] = [];
      const seen = new Set<string>();
      for (const w of [...stored, ...wanted]) {
        const key = wishKey(w);
        if (seen.has(key)) continue;
        seen.add(key);
        const rowKey = keyOfWish.get(key);
        if (rowKey) tick.add(rowKey);
        else if (stored.some((x) => wishKey(x) === key)) keep.push(w);
      }
      setTicked(tick);
      setCarried(keep);
    },
    [keyOfWish]
  );

  /**
   * THE CURRENT SET IS READ, NOT REMEMBERED.
   *
   * The sheet must open with the boxes that are actually armed, and the only
   * thing that knows them is the database — a customer who armed this alert on
   * their phone and opened the product on a laptop would otherwise be shown an
   * empty sheet and, on Save, silently cancel the alert they came to check.
   * Live rows only ('armed'/'firing'): a cancelled or dead wish is history,
   * and pre-ticking from one would re-arm something they removed.
   *
   * AND THAT LIVE-ONLY FILTER IS ALSO WHAT PUTS THIS BUTTON BACK TO «نبّهني»
   * AFTER THE ALERT HAS FIRED — the owner's rule, and it is satisfied here by
   * the server's SELECT rather than by anything on this screen.
   *
   * «التنبيه ينتهي عندما يتوفر في المخزون ويرجع الزر لكي يفعله مرة ثانية».
   * A fired alert is FINISHED: the sweep moves the row to `notified`, and
   * `GET /api/stock-alerts/product/:id` (`armedForProduct`, which guards
   * `state IN ('armed','firing')`) then stops returning it. `armed` comes back
   * empty, `hasArmed` is false, the tick disappears and the trigger reads
   * «خبرني لما يرجع» again — an honest offer, because the arm upsert really
   * does re-arm a notified row (state back to 'armed', arm_seq + 1) and
   * `armRefusal` judges the target, never the row's history.
   *
   * SO DO NOT WIDEN THIS READ TO INCLUDE 'notified'. It looks like showing the
   * customer more of their own data; what it actually does is pre-tick a spent
   * alert and light the armed tick on a product nobody is waiting for — the
   * screen would say «راح نخبرك» about a message that was already sent and will
   * never be sent again. A `dead` row must stay out for a different reason
   * (see src/pages/StockAlerts.tsx: re-arming an invalidated wish is a button
   * the server is guaranteed to refuse). Notified is not invalidated — it is
   * satisfied — which is exactly why it gets the button back and `dead` does
   * not.
   */
  const load = useCallback(async () => {
    if (!isAuthenticated) {
      setArmed([]);
      return;
    }
    setLoading(true);
    setError('');
    setErrorCode('');
    try {
      const res = await api.get<StockAlertsForProductResponse>(`/api/stock-alerts/product/${productId}`);
      setArmed(res.alerts ?? []);
    } catch (e) {
      // A 401 here is the ordinary signed-out answer, not a failure worth a
      // red line: the sheet still works and Save does the bounce.
      if (e instanceof ApiError && e.status === 401) setArmed([]);
      else {
        setArmed([]);
        setError(alertRefusalText(e, L, s.loadFailed));
        setErrorCode(e instanceof ApiError ? e.code ?? '' : '');
      }
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, productId, L, s.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * THE TICKS ARE SEEDED ONCE THE READ LANDS, AND NEVER AGAIN BY AN EFFECT.
   *
   * `targets` is rebuilt whenever this component re-renders with fresh props,
   * and the product page re-renders for reasons that have nothing to do with
   * this sheet — a quote arriving, the three-second notice timer. An effect
   * that re-derived the ticks from the stored rows on every such render would
   * quietly undo whatever the customer had just ticked, in front of them, with
   * no event to blame it on. So the seeding happens exactly twice: when the
   * first read lands (this effect, which the ref makes a one-shot) and when
   * the sheet is opened (`openSheet`). Between those two moments the ticks
   * belong to the customer.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (armed === null || seeded.current) return;
    seeded.current = true;
    applyWishes(armed.map(wishOfRow), []);
  }, [armed, applyWishes]);

  /**
   * THE CHOICE THAT CAME BACK FROM /auth OPENS THE SHEET, AND NOTHING MORE.
   *
   * It is pre-ticked and waiting for the customer's own Save. Arming straight
   * from a URL parameter would mean a link, pasted anywhere, quietly creates a
   * standing request on whoever opens it — and the first they would know of it
   * is the message.
   */
  const intentTaken = useRef(false);
  useEffect(() => {
    if (intentTaken.current || intent.length === 0 || armed === null) return;
    intentTaken.current = true;
    applyWishes(armed.map(wishOfRow), intent);
    setOpen(true);
    onIntentConsumed();
  }, [intent, armed, applyWishes, onIntentConsumed]);

  const armedLabels = useMemo(() => {
    const rows = armed ?? [];
    if (rows.length === 0) return [];
    return rows.map((r) => labelOfWish(wishOfRow(r), targets, models, colors, s.gone));
  }, [armed, targets, models, colors, s.gone]);

  const selectedWishes = useMemo(
    () => [...carried, ...targets.filter((t) => ticked.has(t.key)).map((t) => t.wish)],
    [carried, targets, ticked]
  );

  const toSignIn = useCallback(() => {
    const dest = productPathWithIntent(productSlug, selectedWishes);
    navigate(`/auth?next=${encodeURIComponent(dest)}`);
  }, [navigate, productSlug, selectedWishes]);

  /** Opening always shows what is ACTUALLY armed right now — a sheet that
   *  opened on a stale tick set would, on Save, cancel an alert the customer
   *  armed on another device and came here to check. */
  const openSheet = useCallback(() => {
    setDone(null);
    setError('');
    setErrorCode('');
    if (armed !== null) applyWishes(armed.map(wishOfRow), []);
    setOpen(true);
  }, [armed, applyWishes]);

  const closeSheet = useCallback(() => {
    if (busy) return;
    setOpen(false);
    setError('');
    setErrorCode('');
    setDone(null);
  }, [busy]);

  /**
   * SAVE IS ONE REQUEST, AND IT IS THE SERVER'S OWN BATCH.
   *
   * PUT /product/:id cancels what left and re-arms what stayed inside a single
   * D1 batch. Deleting then posting from here would, on any failure between
   * the two, leave the customer with their alerts gone and the sheet showing
   * the set they had just saved.
   */
  const save = useCallback(
    async (wishes: readonly StockAlertWish[]) => {
      if (busy) return;
      if (!isAuthenticated) {
        toSignIn();
        return;
      }
      setBusy(true);
      setError('');
      setErrorCode('');
      try {
        const res = await api.put<StockAlertSaveResponse>(`/api/stock-alerts/product/${productId}`, {
          alerts: wishes.map((w) => ({
            kind: w.kind,
            // The route refuses an id on a kind that may not carry one, so the
            // '' sentinel is sent only where the kind asks for an id at all.
            ...(w.optionValueId ? { optionValueId: w.optionValueId } : {}),
            ...(w.colorId ? { colorId: w.colorId } : {}),
          })),
        });
        setArmed(res.alerts ?? []);
        setDone({ channel: res.channel, readiness: res.readiness ?? null });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          toSignIn();
          return;
        }
        setError(alertRefusalText(e, L, s.failed));
        setErrorCode(e instanceof ApiError ? e.code ?? '' : '');
      } finally {
        setBusy(false);
      }
    },
    [busy, isAuthenticated, toSignIn, productId, L, s.failed]
  );

  const onSave = () => {
    if (selectedWishes.length === 0) {
      setError(s.pickOne);
      setErrorCode('');
      return;
    }
    void save(selectedWishes);
  };

  const hasArmed = (armed?.length ?? 0) > 0;
  /** An activation the server says would actually succeed — never an invented
   *  one. `can_activate` is the server's own answer to "would this work if
   *  tapped right now?". */
  const activation = done?.readiness?.channels.find((c) => c.can_activate && c.action) ?? null;

  return (
    <div className="lv-section" data-stock-alert>
      <button
        type="button"
        onClick={openSheet}
        data-stock-alert-trigger
        aria-haspopup="dialog"
        /*
         * `.lv-choice-mark` is `opacity: 0` in src/index.css and is only ever
         * lifted by `.lv-choice[aria-pressed='true']` (or aria-checked, or
         * data-selected). Without one of those the armed tick rendered at zero
         * opacity for every armed customer — dead markup, and the suite's
         * `includes('data-stock-alert-armed')` probe passed on an element
         * nobody could see. `aria-pressed` is also the correct semantics here:
         * this is a toggle whose state a screen reader should announce.
         */
        aria-pressed={hasArmed}
        className="lv-choice flex min-h-[52px] w-full items-center gap-3 px-3 py-2.5 text-sm text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Bell aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block font-bold leading-snug">{hasArmed ? s.armedCta : s.cta}</span>
          <span className="block truncate text-[11px] font-medium leading-snug text-zinc-400">
            {hasArmed ? `${armedLabels.join('، ')} · ${s.armedChange}` : s.ctaSub}
          </span>
        </span>
        {hasArmed ? (
          <span className="lv-choice-mark" data-stock-alert-armed>
            <Check aria-hidden="true" className="h-3 w-3" />
          </span>
        ) : null}
      </button>

      <Sheet
        open={open}
        onClose={closeSheet}
        label={s.title}
        dismissOnEscape={!busy}
        dismissOnScrim={!busy}
        panelClassName="w-full sm:max-w-md"
        testId="stock-alert-sheet"
      >
        <div className="max-h-[min(82dvh,44rem)] overflow-y-auto overscroll-contain px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
          <h2 className="text-[16px] font-bold leading-snug text-white">{s.title}</h2>

          {done ? (
            <>
              <p className="mt-2 text-[13px] leading-relaxed text-zinc-300" data-stock-alert-done>
                {(armed?.length ?? 0) > 0 ? s.doneOn(channelName(done.channel, L)) : s.doneCancelled}
              </p>
              {activation?.action ? (
                <a
                  href={activation.action.href}
                  className="lv-button lv-button-secondary press-scale mt-4 w-full"
                >
                  {s.activate}
                </a>
              ) : null}
              <button type="button" onClick={closeSheet} className="lv-button lv-button-primary press-scale mt-2 w-full">
                {s.close}
              </button>
            </>
          ) : (
            <>
              <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
                {preorderOpen ? s.introPreorder : s.introPlain}
              </p>

              {loading ? (
                <p className="mt-4 flex items-center gap-2 text-[13px] leading-snug text-zinc-400">
                  <Spinner size="sm" delayMs={0} decorative />
                  {s.loading}
                </p>
              ) : null}

              <fieldset className="mt-4">
                <legend className="px-0.5 text-[13px] font-bold leading-snug text-white">{s.pickTitle}</legend>
                {colors.length > 0 ? (
                  <p className="mt-1 px-0.5 text-[11px] leading-snug text-zinc-500" data-stock-alert-colour>
                    {selectedColorId && colorLabel ? s.forColor(colorLabel) : s.anyColor}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-col gap-2">
                  {targets.map((t) => {
                    const on = ticked.has(t.key);
                    return (
                      <button
                        key={t.key}
                        type="button"
                        aria-pressed={on}
                        data-stock-alert-target={t.key}
                        disabled={busy}
                        onClick={() =>
                          setTicked((current) => {
                            const next = new Set(current);
                            if (next.has(t.key)) next.delete(t.key);
                            else next.add(t.key);
                            return next;
                          })
                        }
                        className="lv-choice flex min-h-[48px] items-center gap-3 px-3 py-2 text-sm text-start disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        <span className="min-w-0 flex-1 truncate">{t.label}</span>
                        <span className="lv-choice-mark ms-auto">
                          <Check aria-hidden="true" className="h-3 w-3" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {carried.length > 0 ? (
                <div className="mt-4" data-stock-alert-carried>
                  <h3 className="px-0.5 text-[13px] font-bold leading-snug text-white">{s.others}</h3>
                  <p className="mt-1 px-0.5 text-[11px] leading-snug text-zinc-500">{s.othersHint}</p>
                  <ul className="mt-2 flex flex-col gap-2">
                    {carried.map((w) => (
                      <li
                        key={wishKey(w)}
                        className="flex min-h-[44px] items-center gap-3 rounded-md border border-border-subtle px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-zinc-300">
                          {labelOfWish(w, targets, models, colors, s.gone)}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={s.remove}
                          onClick={() => setCarried((cur) => cur.filter((x) => wishKey(x) !== wishKey(w)))}
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          <X aria-hidden="true" className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {!isAuthenticated ? (
                <p className="lv-alert lv-alert-info mt-4 text-[12.5px] leading-relaxed text-zinc-200" data-stock-alert-signin>
                  {s.signInNeeded}
                </p>
              ) : null}

              {/* Reserved height, so a refusal never shoves the two buttons
                  down under the thumb already reaching for them. */}
              <p
                role="alert"
                aria-live="assertive"
                className="mt-3 min-h-[1.25em] text-[12.5px] leading-relaxed text-red-400"
                data-stock-alert-error
              >
                {error}
                {isPerTargetRefusal(errorCode) ? ` ${s.perTarget}` : ''}
              </p>

              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={closeSheet}
                  disabled={busy}
                  className="lv-button lv-button-secondary press-scale flex-1"
                >
                  {s.close}
                </button>
                <button
                  type="button"
                  onClick={onSave}
                  disabled={busy}
                  data-stock-alert-save
                  className="lv-button lv-button-primary press-scale flex-1"
                >
                  {busy && <Spinner size="sm" delayMs={0} decorative />}
                  {busy ? s.saving : !isAuthenticated ? s.signIn : errorCode === 'ALERT_TEMPORARILY_UNAVAILABLE' ? s.retry : s.save}
                </button>
              </div>

              {/* Cancelling everything is a SAVE OF AN EMPTY SET — the same
                  atomic batch, so the customer is never left half-cancelled.
                  Offered only when there is something to cancel. */}
              {hasArmed ? (
                <button
                  type="button"
                  onClick={() => void save([])}
                  disabled={busy}
                  data-stock-alert-cancel-all
                  className="lv-button lv-button-ghost press-scale mt-2 w-full text-[13px] leading-snug"
                >
                  {s.cancelAll}
                </button>
              ) : null}
            </>
          )}
        </div>
      </Sheet>
    </div>
  );
}

/**
 * WHAT A STORED WISH IS CALLED ON SCREEN.
 *
 * Resolved from the page's own catalogue rather than from the row, because the
 * row holds ids and nothing else. An id the page cannot name is the «the
 * option disappeared» case — a value deactivated or merged away (0073) since
 * the alert was armed — and it is SAID rather than rendered as a bare id or
 * quietly dropped: the customer has a standing request against something the
 * shop no longer offers, and the only way they can act on that is to see it.
 */
function labelOfWish(
  wish: StockAlertWish,
  targets: readonly AlertTarget[],
  models: readonly AlertModel[],
  colors: readonly AlertColorOption[],
  goneText: string
): string {
  const exact = targets.find((t) => wishKey(t.wish) === wishKey(wish));
  if (exact) return exact.label;
  const parts: string[] = [];
  if (wish.optionValueId) {
    const model = models.find((m) => m.id === wish.optionValueId);
    parts.push(model ? model.label : goneText);
  }
  if (wish.colorId) {
    const color = colors.find((c) => c.id === wish.colorId);
    parts.push(color ? color.label : goneText);
  }
  return parts.length ? parts.join(' · ') : goneText;
}
