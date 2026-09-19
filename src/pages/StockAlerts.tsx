/**
 * «تنبيهاتي» — THE ONE PLACE A CUSTOMER SEES EVERY STANDING RESTOCK REQUEST.
 *
 * The product page can arm an alert and cancel that product's alert. Nothing
 * until now could answer the question a customer actually asks a week later:
 * «شنو اللي أنا منتظره؟» — and the absence of that screen is not a missing
 * convenience, it is the feature's only failure mode made permanent.
 *
 * ---------------------------------------------------------------------------
 * THE ROW THIS PAGE EXISTS FOR IS THE DEAD ONE.
 *
 * `GET /api/stock-alerts` deliberately returns `state IN ('armed','firing',
 * 'notified','dead')` and carries `dead_reason` with every row. The sweep
 * (worker/lib/stockAlerts.ts, `deadStatement`) reconciles an alert to `dead`
 * WITH a reason the moment its target stops being something that can ever come
 * back — the colour was deleted, the model was hidden, the product became
 * pre-order-only, the shelf turned out to be untracked. Migration 0092 chose
 * reconciliation over a silent DELETE for exactly one reason: so the customer
 * can READ why the thing they were waiting for is never coming.
 *
 * A screen that draws a dead row the same as an armed one throws that entire
 * argument away and is WORSE than no screen: the customer is now looking at a
 * list that says, in writing, that they are still in a queue they were removed
 * from months ago. So `dead` gets its own surface, its own icon, its own
 * sentence per reason, and no cancel button — and `DEAD_REASON_TEXT` below
 * covers every value `AlertDeadReason` (worker/lib/stockAlertResolve.ts) can
 * hold, with an honest fallback for a reason a future worker invents.
 *
 * ---------------------------------------------------------------------------
 * CANCELLING WAITS FOR THE SERVER. THIS IS NOT A PERFORMANCE OVERSIGHT.
 *
 * The optimistic version of this list is one line shorter and tells a lie under
 * load: `DELETE /api/stock-alerts/:id` is rate-limited (60 per ten minutes),
 * answers 404 for a row that is no longer live, and is one network away. Remove
 * the row before the answer arrives and a failed cancel leaves the customer
 * looking at a list with nothing in it — while the row is still `armed`, still
 * in the sweep's queue, and still going to send them a message about a product
 * they told us to stop watching. A stale row that disappears half a second late
 * costs nothing; a cancelled row that was never cancelled costs the one unit of
 * trust this whole feature has. So the row shows a busy state, the list changes
 * only after `success`, and a refusal is said out loud next to the row.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PAGE DELIBERATELY DOES NOT SAY.
 *
 *   - THE CHANNEL. Every row carries `armed_channel`, which is the channel the
 *     server picked WHEN THE ALERT WAS ARMED. The sweep re-decides delivery at
 *     send time, so a Telegram binding revoked last week would make «راح نخبرك
 *     على تيليغرام» false at the only moment it matters. The in-app inbox is
 *     the floor (`channelReadiness().recommended` is never null), so there is
 *     nothing here that needs the stored value to be truthful.
 *
 *   - THE EXPIRY. `expires_at` is written by the arm endpoint (ninety days) but
 *     NOTHING in the worker reads it back — no sweep prunes on it, and the
 *     queue still contains rows whose date has passed. Printing «ينتهي في…»
 *     would promise a lapse the system does not perform, and printing «منتهي»
 *     for a row the sweep is still watching would tell a customer they are out
 *     of a queue they are in. Both are worse than silence.
 *
 *   - «نبّهني مرة ثانية» ON A DEAD ROW. The arm door (`armRefusal`) is stricter
 *     than the sweep, so re-arming the exact wish that was just reconciled dead
 *     is a request the server is guaranteed to refuse with the same reason
 *     already printed on the row. A button that can only fail is not an offer.
 *     The row links to the product instead, where the panel decides honestly.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BellOff, BellRing, CircleSlash, Hourglass, SendHorizontal, Trash2 } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, type StockAlertListEntry, type StockAlertListResponse } from '../lib/api';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import SafeImage from '../components/ui/SafeImage';

type Lang = 'ar' | 'en' | 'ckb';
type Trio = { ar: string; en: string; ckb: string };

/**
 * THE STATES THE SERVER WILL STILL CANCEL.
 *
 * `DELETE /api/stock-alerts/:id` guards with `state IN ('armed','firing')` and
 * answers 404 for everything else, so offering the bin on a `notified` or
 * `dead` row is offering a button whose only possible outcome is an error the
 * customer did nothing to deserve. The same set decides what counts against
 * the account's cap, which is why the header can say «3 من 40» honestly.
 */
const LIVE_STATES = new Set(['armed', 'firing']);

/**
 * EVERY REASON THE SERVER CAN KILL AN ALERT WITH, SAID IN THE THREE LANGUAGES.
 *
 * The keys are `AlertDeadReason` from worker/lib/stockAlertResolve.ts verbatim
 * — all eight, including `VARIANT_NOT_MODELLED`, which only the ARM door
 * produces today but which is a stored column value the sweep would render the
 * moment anybody widened it, and a row whose reason this table does not know
 * falls through to a sentence that is true of all of them.
 *
 * These are NOT the route's `REFUSAL_TEXT`. That table is one string carrying
 * Arabic, a slash and English at once (HttpError has room for one sentence),
 * which shows a Kurdish reader two languages neither of which is theirs. These
 * are the same facts, one language at a time — and phrased in the past, because
 * on this screen the thing has already happened: the customer is not being
 * refused, they are being told why they stopped waiting.
 */
export const DEAD_REASON_TEXT: Record<string, Trio> = {
  NOT_A_STOCK_TARGET: {
    ar: 'هذا الخيار ما عاد ينباع من المخزون، فما بقى شي ننتظره — ألغينا التنبيه.',
    en: 'This option is no longer sold from stock, so there is nothing left to wait for — the alert was cancelled.',
    ckb: 'ئەم هەڵبژاردەیە چیتر لە کۆگاوە نافرۆشرێت، بۆیە هیچ نەماوە چاوەڕێی بکەین — ئاگادارکردنەوەکە هەڵوەشێنرایەوە.',
  },
  VARIANT_NOT_MODELLED: {
    ar: 'هذا الموديل بهذا اللون ما عاد معروض بالمتجر، فلغينا التنبيه.',
    en: 'This exact model-and-colour combination is no longer offered, so the alert was cancelled.',
    ckb: 'ئەم تێکەڵەیە (مۆدێل لەگەڵ ڕەنگ) چیتر پێشکەش ناکرێت، بۆیە ئاگادارکردنەوەکە هەڵوەشێنرایەوە.',
  },
  TARGET_REMOVED: {
    ar: 'الخيار اللي كنت تنتظره انحذف من المتجر، فما راح يوصلك تنبيه عنه أبداً.',
    en: 'The option you were waiting for was removed from the shop, so no alert about it can ever arrive.',
    ckb: 'ئەو هەڵبژاردەیەی چاوەڕێت دەکرد لە فرۆشگا لابرا، بۆیە هەرگیز ئاگادارکردنەوەیەکی بۆ ناگات.',
  },
  TARGET_INACTIVE: {
    ar: 'الخيار اللي كنت تنتظره ما عاد معروض، فبطّلنا ننتظره.',
    en: 'The option you were waiting for is no longer on display, so we stopped watching it.',
    ckb: 'ئەو هەڵبژاردەیەی چاوەڕێت دەکرد چیتر پیشان نادرێت، بۆیە وازمان لە چاودێریکردنی هێنا.',
  },
  PRODUCT_UNAVAILABLE: {
    ar: 'هذا المنتج ما عاد معروض بالمتجر، فألغينا التنبيه.',
    en: 'This product is no longer on display, so the alert was cancelled.',
    ckb: 'ئەم بەرهەمە چیتر لە فرۆشگا پیشان نادرێت، بۆیە ئاگادارکردنەوەکە هەڵوەشێنرایەوە.',
  },
  UNTRACKED: {
    ar: 'مخزون هذا المنتج ما ينحسب بالنظام، فما نكدر نعرف شوكت يرجع — لغينا التنبيه.',
    en: 'This product has no stock counter, so we cannot tell when it returns — the alert was cancelled.',
    ckb: 'ئەم بەرهەمە ژمێرەری کۆگای نییە، بۆیە ناتوانین بزانین کەی دەگەڕێتەوە — ئاگادارکردنەوەکە هەڵوەشێنرایەوە.',
  },
  PREORDER_ONLY: {
    ar: 'هذا الخيار صار بالطلب المسبق فقط — ما عنده مخزون ننتظره، وتكدر تطلبه هسه.',
    en: 'This option is pre-order only now — there is no shelf to wait for, and you can order it today.',
    ckb: 'ئەم هەڵبژاردەیە ئێستا تەنها داواکاری پێشوەختە — کۆگایەک نییە چاوەڕێی بکەین، ئەمڕۆ دەتوانیت داوای بکەیت.',
  },
  COMPOSITION: {
    ar: 'هذا منتج مركّب (بكج أو صندوق)، وما إله مخزون خاص بيه نراقبه — لغينا التنبيه.',
    en: 'This is a composed product (a bundle or mystery box); it has no shelf of its own to watch.',
    ckb: 'ئەمە بەرهەمێکی پێکهاتەییە (پاکێج یان سندوقی نهێنی)؛ کۆگای تایبەت بە خۆی نییە چاودێری بکەین.',
  },
};

/**
 * A REASON THIS BUILD HAS NEVER HEARD OF STILL GETS A TRUE SENTENCE.
 *
 * `dead_reason` is a plain TEXT column and the worker ships separately from the
 * app the customer has cached. A reason added server-side next month would
 * otherwise render as an empty line under a red icon — a row that says
 * «something happened» and nothing more, which is the exact silence the whole
 * feature was built to stop. This sentence is true of every dead row by
 * construction: the alert is not live and no message is coming.
 */
const DEAD_REASON_FALLBACK: Trio = {
  ar: 'ما عاد نكدر ننتظر هذا الخيار، فألغينا التنبيه.',
  en: 'We can no longer watch this option, so the alert was cancelled.',
  ckb: 'چیتر ناتوانین چاودێری ئەم هەڵبژاردەیە بکەین، بۆیە ئاگادارکردنەوەکە هەڵوەشێنرایەوە.',
};

const STATE_LABEL: Record<string, Trio> = {
  armed: { ar: 'بالانتظار', en: 'Waiting', ckb: 'چاوەڕوانی' },
  firing: { ar: 'قيد الإرسال', en: 'Sending now', ckb: 'لە ناردندایە' },
  notified: { ar: 'تم تنبيهك', en: 'You were told', ckb: 'ئاگادارکرایتەوە' },
  dead: { ar: 'ملغي', en: 'Cancelled', ckb: 'هەڵوەشێنراوە' },
};

/**
 * Latin numerals in every language, and the Gregorian calendar everywhere.
 * `ar-IQ` alone answers in Arabic-Indic digits on some devices and in the Hijri
 * calendar on others, so a customer comparing «armed on» with an order date
 * would be reading two different documents. `-u-nu-latn` is the same decision
 * src/components/orders/format.ts already made and states.
 *
 * AND THE LOCALE IS THREE-WAY, not `lang === 'en' ? en : ar`. That binary is
 * the `dir === 'rtl' ? ar : en` bug wearing a different mask: its non-English
 * arm serves ARABIC to every Kurdish reader, so a row that says
 * «ئاگادارکرایتەوە» in Sorani was dating itself «19 أيلول 2026» in Arabic. The
 * date was the one string on this page that was not three-way.
 *
 * The `try` below is what makes `ckb-IQ` safe to ask for: an older mobile
 * WebView without Sorani locale data throws RangeError here rather than
 * silently substituting, and the ISO fallback is language-neutral — which is
 * honest in a way that hard-coding Arabic is not.
 */
function formatDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const locale =
      lang === 'en' ? 'en-GB' : lang === 'ckb' ? 'ckb-IQ-u-nu-latn' : 'ar-IQ-u-nu-latn';
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The product name the server already resolved into three languages; `en` is
 *  its own fallback for the other two, so there is always something to draw. */
const pick = (text: { ar: string; en: string; ckb: string } | null, lang: Lang): string =>
  text ? text[lang] || text.en || text.ar : '';

export default function StockAlerts() {
  const navigate = useNavigate();
  const { lang, dir, loc } = useLanguage();
  const l = lang as Lang;

  const [alerts, setAlerts] = useState<StockAlertListEntry[]>([]);
  const [limit, setLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  /** The row whose DELETE is in flight — one at a time, because two bins
   *  pressed together on a phone is a double-tap, not two intentions. */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Per-row refusals: a cancel that failed says so beside the row it failed
   *  on, never as a page-level banner that leaves «which one?» unanswered. */
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<StockAlertListResponse>('/api/stock-alerts');
      setAlerts(res.alerts || []);
      setLimit(Number(res.limit) || 0);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A confirmation gets out of the way by itself; a refusal does not (it stays
  // beside its row until the customer acts on it).
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /**
   * CANCEL — AFTER THE ROUND TRIP, AND EVERY REFUSAL NAMED.
   *
   * 404 is the one answer that is NOT a failure: the server guards the update
   * with `state IN ('armed','firing')`, so «not found» means this alert is
   * already not live — cancelled from the product sheet in another tab, or
   * reconciled by the sweep a second ago. Dropping the row is then the honest
   * outcome, and saying so is what stops it reading as a bug.
   *
   * 401 is handed to `ErrorState`, which renders the sign-in prompt with
   * `?next=` rather than a red box: an expired cookie is not an error the
   * customer made.
   */
  const cancel = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      await api.delete<{ success: boolean; removed: string }>(`/api/stock-alerts/${encodeURIComponent(id)}`);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      setNotice(loc('تم إلغاء التنبيه.', 'The alert was cancelled.', 'ئاگادارکردنەوەکە هەڵوەشێنرایەوە.'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setAlerts((prev) => prev.filter((a) => a.id !== id));
        setNotice(
          loc(
            'هذا التنبيه أصلاً ما عاد فعّال — شلناه من القائمة.',
            'That alert was no longer live — we removed it from the list.',
            'ئەم ئاگادارکردنەوەیە چیتر چالاک نەبوو — لە لیستەکە لامانبرد.'
          )
        );
      } else if (e instanceof ApiError && e.status === 401) {
        setError(e);
      } else if (e instanceof ApiError && e.status === 429) {
        setRowError((prev) => ({
          ...prev,
          [id]: loc(
            'محاولات كثيرة بوقت قصير. انتظر دقيقة وجرّب مرة ثانية.',
            'Too many attempts in a short time. Wait a minute and try again.',
            'هەوڵی زۆر لە ماوەیەکی کورتدا. خولەکێک چاوەڕێ بکە و دووبارە هەوڵ بدەوە.'
          ),
        }));
      } else {
        setRowError((prev) => ({
          ...prev,
          [id]: loc(
            'ما انلغى التنبيه. التنبيه باقي فعّال — جرّب مرة ثانية.',
            'The alert was not cancelled. It is still live — please try again.',
            'ئاگادارکردنەوەکە هەڵنەوەشێنرایەوە. هێشتا چالاکە — دووبارە هەوڵ بدەوە.'
          ),
        }));
      }
    } finally {
      setBusyId(null);
    }
  };

  const goBack = () => {
    // navigate(-1) is a no-op on a deep link or a refresh — the account page is
    // where this screen is reached from, so that is the honest fallback.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/profile');
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const liveCount = alerts.filter((a) => LIVE_STATES.has(a.state)).length;

  return (
    <div className="w-full min-h-screen bg-canvas text-zinc-300 font-sans pb-24" data-stock-alerts-page>
      <header className="sticky top-0 z-40 material material-thin px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={goBack}
          aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-surface-raised text-white hover:bg-surface-selected active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus transition-colors"
        >
          <Back aria-hidden="true" className="w-5 h-5" />
        </button>
        <h1 className="text-white font-bold text-lg leading-6 flex-1 min-w-0 truncate">
          {loc('تنبيهاتي', 'My alerts', 'ئاگادارکردنەوەکانم')}
        </h1>
        {/* The cap is the server's (MAX_ARMED_PER_USER). Printing it here is
            what turns a future «وصلت للحد الأعلى» refusal on the product page
            into something the customer already understood. */}
        {!loading && !error && limit > 0 ? (
          <span
            className="shrink-0 text-[12px] leading-4 text-zinc-500 tabular-nums"
            dir="ltr"
            data-stock-alerts-count
          >
            {liveCount} / {limit}
          </span>
        ) : null}
      </header>

      <div className="p-4 max-w-2xl mx-auto">
        <p className="text-[12px] leading-5 text-zinc-500 mb-4">
          {loc(
            'هنا كل شي طلبت نخبرك لما يرجع للمخزون. التنبيه الملغي يبيّن سببه.',
            'Everything you asked us to tell you about when it returns to stock. A cancelled alert says why.',
            'هەرچی داوات کردووە ئاگادارت بکەینەوە کاتێک دەگەڕێتەوە کۆگا. ئاگادارکردنەوەی هەڵوەشاوە هۆکارەکەی دەڵێت.'
          )}
        </p>

        {notice ? (
          <p
            role="status"
            className="mb-3 rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[12px] leading-5 text-zinc-300"
          >
            {notice}
          </p>
        ) : null}

        {loading ? (
          <SkeletonGroup className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                aria-hidden="true"
                className="rounded-xl border border-border-subtle bg-surface p-3 flex items-center gap-3"
              >
                <Skeleton className="w-16 h-16 rounded-lg shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </SkeletonGroup>
        ) : error ? (
          /* One component owns loading / empty / error / 401 across the
             storefront (src/components/ui/AsyncStates.tsx). A 401 here renders
             the sign-in prompt carrying `?next=`, never «لا توجد تنبيهات» —
             telling a signed-out customer their list is empty is a lie they
             cannot tell from the truth. */
          <ErrorState error={error} onRetry={load} next="/stock-alerts" />
        ) : alerts.length === 0 ? (
          <EmptyState
            icon={<BellOff aria-hidden="true" className="w-6 h-6" />}
            title={loc('ما عندك أي تنبيه', 'You have no alerts', 'هیچ ئاگادارکردنەوەیەکت نییە')}
            description={loc(
              'لما يخلص مخزون شي تريده، اضغط «خبرني لما يرجع» بصفحة المنتج وراح يظهر هنا.',
              'When something you want is sold out, tap “Tell me when it is back” on its page and it will appear here.',
              'کاتێک شتێکی دەتەوێت لە کۆگا تەواو دەبێت، لە پەڕەی بەرهەمەکە «ئاگادارم بکەوە کە گەڕایەوە» دابگرە و لێرە دەردەکەوێت.'
            )}
            action={
              <Link
                to="/products"
                className="mt-1 min-h-[44px] px-5 rounded-xl bg-surface-raised text-white text-sm font-bold flex items-center justify-center gap-2 hover:bg-surface-selected active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus transition-colors"
              >
                {loc('تصفّح المنتجات', 'Browse the catalogue', 'بەرهەمەکان ببینە')}
              </Link>
            }
          />
        ) : (
          <ul className="space-y-3" data-stock-alerts-list>
            {alerts.map((a) => {
              const dead = a.state === 'dead';
              const live = LIVE_STATES.has(a.state);
              const reason = dead
                ? (a.dead_reason && DEAD_REASON_TEXT[a.dead_reason]) || DEAD_REASON_FALLBACK
                : null;
              const target = [pick(a.option_value, l), pick(a.color, l)].filter(Boolean).join(' · ');
              const state = STATE_LABEL[a.state] || STATE_LABEL.armed;
              const rowErr = rowError[a.id];
              const busy = busyId === a.id;

              return (
                <li
                  key={a.id}
                  data-alert-row
                  data-alert-state={a.state}
                  /* The dead row is a DIFFERENT surface, not the same card with
                     a grey word on it: at arm's length on a phone the tint and
                     the CircleSlash marker are what separate «still waiting»
                     from «this will never arrive». */
                  className={`rounded-xl border p-3 ${
                    dead
                      ? 'border-danger/35 bg-danger/[0.07]'
                      : 'border-border-subtle bg-surface'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* The picture goes to the same place as the title beside
                        it, so it is one destination with two hit areas — not
                        two links. It is taken out of the tab order and hidden
                        from the accessibility tree for exactly that reason:
                        a screen reader that announces the product name twice
                        per row makes a list of forty alerts eighty items long. */}
                    <Link
                      to={`/product/${a.slug}`}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="shrink-0 rounded-lg overflow-hidden"
                    >
                      <SafeImage
                        src={a.image}
                        alt={pick(a.name, l)}
                        aspect="auto"
                        className={`w-16 h-16 ${dead ? 'opacity-60' : ''}`}
                        bgClassName="bg-surface-raised"
                      />
                    </Link>

                    <div className="flex-1 min-w-0">
                      <Link
                        to={`/product/${a.slug}`}
                        dir="auto"
                        className="block font-bold text-[14px] leading-5 text-white truncate hover:underline underline-offset-2 active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm"
                      >
                        {pick(a.name, l)}
                      </Link>

                      {target ? (
                        <p dir="auto" className="mt-0.5 text-[12px] leading-5 text-zinc-400 truncate">
                          {target}
                        </p>
                      ) : (
                        /* `kind: 'product'` — the customer asked about the
                           shelf, not one model, and saying so beats an empty
                           line that reads like a missing label. */
                        <p className="mt-0.5 text-[12px] leading-5 text-zinc-500 truncate">
                          {loc('المنتج كامل', 'The whole product', 'هەموو بەرهەمەکە')}
                        </p>
                      )}

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-4 font-semibold ${
                            dead
                              ? 'bg-danger/15 text-danger'
                              : a.state === 'notified'
                                ? 'bg-success/15 text-success'
                                : 'bg-surface-raised text-zinc-300'
                          }`}
                        >
                          {dead ? (
                            <CircleSlash aria-hidden="true" className="w-3 h-3" />
                          ) : a.state === 'notified' ? (
                            <BellRing aria-hidden="true" className="w-3 h-3" />
                          ) : a.state === 'firing' ? (
                            <SendHorizontal aria-hidden="true" className="w-3 h-3" />
                          ) : (
                            <Hourglass aria-hidden="true" className="w-3 h-3" />
                          )}
                          {state[l]}
                        </span>
                        {a.state === 'notified' && a.notified_at ? (
                          <span className="text-[11px] leading-4 text-zinc-500">
                            {/* «خبرناك بتاريخ» and not «خبرناك بـ»: the tatweel
                                on «بـ» exists to show the bāʾ is a prefix still
                                waiting for its word, so a space after it reads
                                to an Arabic eye the way "un- believable" reads
                                to an English one. «من» below is a free-standing
                                preposition and takes its space correctly. */}
                            {loc('خبرناك بتاريخ', 'Told you on', 'ئاگادارمان کردیتەوە لە')}{' '}
                            <time dateTime={a.notified_at}>{formatDate(a.notified_at, l)}</time>
                          </span>
                        ) : a.armed_at ? (
                          <span className="text-[11px] leading-4 text-zinc-500">
                            {loc('من', 'Since', 'لە')}{' '}
                            <time dateTime={a.armed_at}>{formatDate(a.armed_at, l)}</time>
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* The bin exists only where the server will honour it. */}
                    {live ? (
                      <button
                        type="button"
                        onClick={() => cancel(a.id)}
                        /* EVERY bin greys out while ANY cancel is in flight,
                           not just the one that is waiting. `cancel` opens with
                           `if (busyId) return;` — one round trip at a time, for
                           the reasons in its own header — but a bin that is
                           only guarded and not disabled is a control that looks
                           live and is not: on a slow Iraqi mobile link the
                           customer taps the second bin, the guard returns
                           before `setBusyId`, before `setRowError`, before
                           `setNotice`, and NOTHING on the screen changes. The
                           reasonable reading of that is a broken button, and
                           the reasonable next move is to tap it again. So the
                           set goes flat for the one round trip, and the guard
                           goes back to being belt-and-braces. `aria-busy` stays
                           per-row, because only one row is actually working. */
                        disabled={!!busyId}
                        aria-busy={busy}
                        aria-label={loc('إلغاء التنبيه', 'Cancel this alert', 'هەڵوەشاندنەوەی ئاگادارکردنەوە')}
                        data-alert-cancel
                        className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-zinc-400 hover:bg-surface-raised hover:text-white active:opacity-70 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus transition-colors"
                      >
                        <Trash2 aria-hidden="true" className="w-4 h-4" />
                      </button>
                    ) : null}
                  </div>

                  {/* THE SENTENCE THIS PAGE WAS BUILT FOR. */}
                  {reason ? (
                    <p
                      data-alert-dead={a.dead_reason || 'UNKNOWN'}
                      className="mt-2.5 border-s-2 border-danger/55 ps-2.5 text-[12px] leading-5 text-zinc-200"
                    >
                      {reason[l]}
                    </p>
                  ) : null}

                  {rowErr ? (
                    <p role="alert" className="mt-2.5 text-[12px] leading-5 text-danger">
                      {rowErr}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
