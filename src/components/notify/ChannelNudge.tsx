/**
 * «فعّل قناة لتصلك الإشعارات» — the one quiet offer that follows a success.
 *
 * WHAT THE OWNER ASKED FOR. «عندما يطلب المستخدم طلب أو ينشئ تذكرة … إذا لم
 * يفعل أي قناة لتصل الإشعارات مثل واتساب أو تليجرام يظهر نافذة بسيطة … ملاحظة
 * إذا يريد أن يفعل إحدى القنوات أو لا». Four constraints live in that
 * sentence and every one of them is a rule below: AFTER the action, only when
 * NO channel is on, SMALL, and DECLINABLE.
 *
 * WHY IT EXISTS AT ALL. An order, a community request and a support ticket are
 * all promises of a LATER message: the workshop answers, a merchant offers,
 * support replies. `worker/lib/customerNotify.ts` fans that message out to
 * every channel the account can carry — and for an account that carries none,
 * the only place it lands is the in-app inbox, which is a page the customer
 * has to remember to open. Nothing is lost, but nothing arrives either, and
 * the customer experiences it as «ما وصلني شي». The cheapest moment to fix
 * that is the moment they have just proved they care about an answer.
 *
 * THE PREDICATE IS THE SERVER'S, NOT OURS. `any_outbound_ready` comes from
 * worker/lib/channelReadiness.ts, which computes it as the AND of what the
 * DEPLOYMENT can carry and what the ACCOUNT has. 'inapp' is excluded from it
 * by that module's own rule — it is the floor, never an outbound win — so
 * `any_outbound_ready === false` is exactly "there is no way to reach this
 * person once they close the tab". A client-side guess (does the profile have
 * a phone?) would offer Telegram on a deployment whose bot is not answering,
 * and the tap would 503.
 *
 * IT NEVER BLOCKS, AND IT ARRIVES SECOND. The order is placed, the ticket is
 * open; this window is about what happens NEXT. So it is `mode="parallel"` —
 * the Overlay mode with no scrim and no scroll lock, "a parallel, non-blocking
 * panel must NOT break the flow" — and it waits `REVEAL_MS` so the
 * confirmation the customer came for is read first. A prompt that lands on top
 * of a success screen reads as a failure report, which is worse than no prompt.
 *
 * IT OFFERS ONLY WHAT CAN ACTUALLY BE TURNED ON. The buttons are built from
 * the `action` the server published per channel — `can_activate` is the
 * activation route's OWN predicate — and when no channel is activatable the
 * window does not appear at all. Telling somebody to switch on a channel this
 * deployment cannot carry is the same lie in a friendlier voice.
 *
 * IT IS THE APP'S OWN SHEET. `Sheet` (src/components/ui/Overlay.tsx) owns the
 * material, the spring, the grabber, the drag-to-dismiss and Escape. Twenty-
 * four screens once hand-rolled `fixed inset-0 bg-black/80`; that file exists
 * so number twenty-five is not written here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useAuth } from '../../AuthContext';
import { Sheet } from '../ui/Overlay';
import { fetchNotifyChannels, type NotifyChannelReadiness } from '../../lib/api';
import type { StorageLike } from '../../lib/pwa';

/** What the customer just finished. It decides the SENTENCE, nothing else. */
export type NudgeContext = 'order' | 'request' | 'ticket';

/** ar, en, ckb — fed to `loc()`, never to `dir === 'rtl' ? … : …`, because
 *  Sorani is right-to-left too and that idiom serves Arabic to Kurdish
 *  customers. */
type Trio = readonly [ar: string, en: string, ckb: string];

/**
 * THREE CONTEXTS, THREE SENTENCES — the owner asked for this explicitly
 * («لكي يحصل على إشعارات الطلب أو … طلب داخل المجتمع أو … بخصوص تذكرته»).
 * One generic «فعّل الإشعارات» would be a settings prompt that happened to
 * appear after a purchase; naming the thing they just did is what makes it an
 * answer to a question they are already asking — "how will I hear back?".
 *
 * THE TITLE CONFIRMS FIRST. «تم استلام طلبك» leads, the offer follows, so the
 * window can never be misread as "your order did not go through".
 *
 * THE BODY NAMES NO CHANNEL. The buttons do, and they are built from what the
 * server says can actually be activated — a body that promised WhatsApp on a
 * deployment with no WhatsApp session would be a sentence that rots the first
 * time an operator changes a secret.
 */
export const CHANNEL_NUDGE_COPY: Record<NudgeContext, { title: Trio; body: Trio }> = {
  order: {
    title: ['تم استلام طلبك', 'Your order is placed', 'داواکاریەکەت وەرگیرا'],
    body: [
      'فعّل قناة لتصلك تحديثات طلبك أولًا بأول — التأكيد، التجهيز، والتسليم.',
      'Turn on a channel so your order updates reach you — confirmation, production and delivery.',
      'کەناڵێک چالاک بکە تا نوێکارییەکانی داواکاریەکەت پێت بگات — پشتڕاستکردنەوە، ئامادەکردن و گەیاندن.',
    ],
  },
  request: {
    title: ['تم نشر طلبك في المجتمع', 'Your community request is live', 'داواکاریەکەت لە کۆمەڵگە بڵاوکرایەوە'],
    body: [
      'فعّل قناة لتصلك عروض التجار على طلبك فور وصولها.',
      'Turn on a channel so merchants’ offers on your request reach you as they arrive.',
      'کەناڵێک چالاک بکە تا ئۆفەری بازرگانەکان بۆ داواکاریەکەت دەستبەجێ پێت بگات.',
    ],
  },
  ticket: {
    title: ['تم فتح تذكرتك', 'Your ticket is open', 'تیکتەکەت کرایەوە'],
    body: [
      'فعّل قناة لتصلك ردود الدعم على تذكرتك دون أن تعود للتحقق.',
      'Turn on a channel so support replies on your ticket reach you without checking back.',
      'کەناڵێک چالاک بکە تا وەڵامی پشتگیری بۆ تیکتەکەت پێت بگات بەبێ گەڕانەوە.',
    ],
  },
};

/** The two labels the server's `action.kind` can ask for, plus the one case
 *  where Telegram linking switches on WhatsApp as well (see `nudgeActions`). */
export const CHANNEL_NUDGE_ACTION_LABEL: Record<
  'link_telegram' | 'link_telegram_whatsapp' | 'verify_email',
  Trio
> = {
  link_telegram: ['تفعيل تيليجرام', 'Turn on Telegram', 'تێلێگرام چالاک بکە'],
  link_telegram_whatsapp: [
    'تفعيل تيليجرام وواتساب',
    'Turn on Telegram & WhatsApp',
    'تێلێگرام و واتساپ چالاک بکە',
  ],
  verify_email: ['تأكيد البريد الإلكتروني', 'Verify your email', 'ئیمەیڵەکەت پشتڕاست بکەرەوە'],
};

// ------------------------------------------------------- the "not now" memory

/** `lv.` + a version suffix, following `lv.pwa.install.dismissed.v1` and
 *  `lv.verify-email.snooze.<email>`. The `v1` is what lets a later change of
 *  shape retire the old value instead of misreading it. */
export const CHANNEL_NUDGE_DISMISS_KEY = 'lv.notify.channel-nudge.dismissed.v1';

/**
 * THIRTY DAYS, and the argument for the number.
 *
 * «إذا يريد أن يفعل إحدى القنوات أو لا» — declining is a real answer, so
 * asking again on the next order turns an offer into a nag. But "never again"
 * is wrong too: the person who declined once is a different person after three
 * orders, and a channel that is off costs them every future update.
 *
 * Thirty days is chosen against the LIFETIME OF WHAT THEY JUST DID, not
 * against a habit: an order, a community request and a support ticket all
 * finish well inside a month, so nobody is ever re-asked about the thing they
 * already declined for. It is also the period `INSTALL_DISMISS_MS` argues for
 * in src/lib/pwa.ts, and two "not now" memories that expire on different
 * clocks would be two behaviours for one idea.
 *
 * Stored as an ABSOLUTE expiry timestamp, not as "dismissed at", so reading it
 * is a comparison rather than arithmetic on a value a corrupted storage could
 * have supplied.
 */
export const CHANNEL_NUDGE_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * ONE MEMORY FOR ALL THREE CONTEXTS, deliberately not one per context.
 *
 * The question is the same question — "may we reach you off the site?" — and
 * the customer already answered it. Asking it again two hours later because
 * the second success was a ticket rather than an order is exactly the nagging
 * the owner's «أو لا» rules out. The SENTENCE differs per context because the
 * news differs; the ANSWER does not.
 */
export function readChannelNudgeDismissedUntil(storage: StorageLike | null | undefined): number {
  if (!storage) return 0;
  try {
    const raw = storage.getItem(CHANNEL_NUDGE_DISMISS_KEY);
    const until = raw ? Number(raw) : 0;
    return Number.isFinite(until) && until > 0 ? until : 0;
  } catch {
    // localStorage THROWS — not returns null — in a Safari private window and
    // in an iframe with third-party storage blocked. The rule this codebase
    // already wrote down (src/lib/recentlyViewed.ts, src/lib/pwa.ts) is that a
    // surface which cannot read a preference must still draw. The worst
    // outcome of returning 0 is one extra offer; the worst outcome of letting
    // the throw escape is a blank screen where a paid order should be.
    return 0;
  }
}

/** Dismissed AND still inside the quiet period. The boundary is exclusive: at
 *  exactly `until` the quiet period is over. */
export function isChannelNudgeDismissed(storage: StorageLike | null | undefined, now: number): boolean {
  return now < readChannelNudgeDismissedUntil(storage);
}

/** Records the answer. A write that throws is not an error worth showing
 *  anyone — the window closes either way, and all that is lost is the memory
 *  of it on this one device. */
export function recordChannelNudgeDismissal(
  storage: StorageLike | null | undefined,
  now: number
): number {
  const until = now + CHANNEL_NUDGE_DISMISS_MS;
  if (!storage) return until;
  try {
    storage.setItem(CHANNEL_NUDGE_DISMISS_KEY, String(until));
  } catch {
    // Private mode, or storage the browser has blocked. Memory-only is a
    // working fallback for a preference, not a failure worth reporting.
  }
  return until;
}

/** `localStorage` can throw on ACCESS, not only on read, so even reaching for
 *  it is wrapped. Null means "this browser gives us no memory", which every
 *  function above already treats as "not dismissed". */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- what to offer

export interface NudgeAction {
  /** Which sentence goes on the button. */
  label: 'link_telegram' | 'link_telegram_whatsapp' | 'verify_email';
  /** The href the SERVER published for this blocker. Never invented here. */
  href: string;
  /** Which channels this one tap switches on. Drives the label, and is the
   *  reason WhatsApp does not get a button of its own. */
  channels: string[];
}

/**
 * THE BUTTONS, BUILT FROM THE SERVER'S OWN ACTIONS.
 *
 * WhatsApp has NO activation path of its own — `users.phone_e164` is only ever
 * written after Telegram contact verification (migration 0013: "a phone typed
 * into a form is never stored here") — so `channelReadiness` gives the
 * WhatsApp row the SAME `link_telegram` action as Telegram's. Rendering both
 * would be two buttons that go to one place and do one thing. They are merged,
 * and the merge is what earns the label «تفعيل تيليجرام وواتساب»: one tap, two
 * channels, said honestly.
 *
 * A channel with `can_activate === false` produces nothing. That covers the
 * deployment with no bot token, the WhatsApp session that is logged out and
 * the staging allowlist that refuses this address — cases where the customer
 * can do nothing at all, so a button would be a dead end wearing a call to
 * action.
 */
export function nudgeActions(readiness: NotifyChannelReadiness | null | undefined): NudgeAction[] {
  if (!readiness) return [];
  const out: NudgeAction[] = [];
  for (const state of readiness.channels) {
    // 'inapp' is the floor; it is always on and has nothing to activate.
    if (state.channel === 'inapp' || state.ready) continue;
    const action = state.action;
    if (!state.can_activate || !action) continue;
    const existing = out.find((a) => a.href === action.href && a.label.startsWith(action.kind));
    if (existing) {
      existing.channels.push(state.channel);
      // Telegram + WhatsApp behind one tap: say both, because a customer who
      // wanted WhatsApp would otherwise read "Telegram" and close the window.
      if (existing.label === 'link_telegram' && existing.channels.includes('whatsapp')) {
        existing.label = 'link_telegram_whatsapp';
      }
      continue;
    }
    out.push({ label: action.kind, href: action.href, channels: [state.channel] });
  }
  return out;
}

/**
 * THE WHOLE DECISION, in one pure function so it can be tested without a DOM.
 *
 * Every clause is a way the window would otherwise be wrong:
 *   - no readiness answer  → we do not know, so we do not ask (a failed or
 *                            aborted read must never produce a prompt).
 *   - any_outbound_ready   → a customer with Telegram linked is ALREADY
 *                            reachable. Asking them is pure noise.
 *   - nothing activatable  → nothing to offer; see `nudgeActions`.
 *   - dismissed            → they answered «لا» and the answer still stands.
 */
export function shouldOfferChannelNudge(
  readiness: NotifyChannelReadiness | null | undefined,
  storage: StorageLike | null | undefined,
  now: number
): boolean {
  if (!readiness) return false;
  if (readiness.any_outbound_ready) return false;
  if (nudgeActions(readiness).length === 0) return false;
  return !isChannelNudgeDismissed(storage, now);
}

/**
 * The beat between the news and the offer. The success screens animate in over
 * roughly 700ms and the character's celebration runs 1.5s; arriving inside
 * that reads as part of the confirmation — or worse, as a correction to it.
 * Arriving after it reads as a second, separate thought, which is what it is.
 */
export const CHANNEL_NUDGE_REVEAL_MS = 1600;

// ------------------------------------------------------------- the component

export interface ChannelNudgeProps {
  /** Which sentence. */
  context: NudgeContext;
  /** Flipped true ONLY once the thing has actually succeeded — the order is
   *  placed, the ticket exists. Never before, or the window would be asking
   *  about something that has not happened. */
  active: boolean;
}

export default function ChannelNudge({ context, active }: ChannelNudgeProps) {
  const { loc } = useLanguage();
  const { isAuthenticated } = useAuth();
  const [readiness, setReadiness] = useState<NotifyChannelReadiness | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // A guest has no channels to offer and the route would 401. The dismissal
    // is checked BEFORE the request, so a customer who said no does not even
    // cost a round trip.
    if (!active || !isAuthenticated) return;
    if (isChannelNudgeDismissed(browserStorage(), Date.now())) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    fetchNotifyChannels({ signal: controller.signal, mascot: 'silent' })
      .then((answer) => {
        if (controller.signal.aborted) return;
        if (!shouldOfferChannelNudge(answer, browserStorage(), Date.now())) return;
        setReadiness(answer);
        timer = setTimeout(() => setOpen(true), CHANNEL_NUDGE_REVEAL_MS);
      })
      .catch(() => {
        // Offline, 401, a deadline — all of them mean "we do not know", and
        // not knowing is never a reason to interrupt somebody who has just
        // paid. Silence is the correct failure mode here.
      });
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // `mascot: 'silent'` because nobody asked for this read: the character
    // must not paint a loading face over a success screen.
  }, [active, isAuthenticated]);

  const actions = useMemo(() => nudgeActions(readiness), [readiness]);

  /**
   * TWO EXITS, AND THEY MEAN DIFFERENT THINGS — the distinction
   * `InstallAppSheet` draws. Throwing the sheet away, pressing Escape or
   * heading off to activate a channel means "not this window"; only «ليس الآن»
   * is the ANSWER the owner asked to be respected, and only it is remembered.
   */
  const close = useCallback(() => setOpen(false), []);
  const later = useCallback(() => {
    recordChannelNudgeDismissal(browserStorage(), Date.now());
    setOpen(false);
  }, []);

  if (!readiness || actions.length === 0) return null;

  const copy = CHANNEL_NUDGE_COPY[context];

  return (
    <Sheet
      open={open}
      onClose={close}
      // No scrim, no scroll lock, no push-back: the page behind stays live and
      // usable. This is an offer, not a task.
      mode="parallel"
      labelledBy="channel-nudge-title"
      testId="channel-nudge"
      /**
       * THE LAYER MUST NOT EAT THE PAGE'S TAPS.
       *
       * `Overlay` positions every window inside a `fixed inset-0` flex
       * container. In `modal` mode that is correct — the scrim below it is
       * SUPPOSED to catch the tap and close the window. In `parallel` mode
       * there is no scrim, and a full-viewport container with nothing drawn
       * in it would still swallow every click on the success screen behind:
       * an invisible pane over the whole page, which is the blocking this
       * window exists not to do. `pointer-events-none` on the container and
       * `auto` on the panel is the narrowest fix, and it uses the props the
       * primitive already publishes rather than changing it for everyone.
       */
      className="pointer-events-none"
      // Geometry only — the material, the rounding and the border belong to
      // the primitive and must stay there.
      panelClassName="pointer-events-auto w-full sm:max-w-md"
    >
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-5" data-channel-nudge={context}>
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gold/15 text-gold">
            <BellRing aria-hidden="true" className="h-5 w-5" strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <h2 id="channel-nudge-title" className="text-[15px] leading-snug font-bold text-text-primary">
              {loc(...copy.title)}
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">{loc(...copy.body)}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {actions.map((action) => (
            <Link
              key={action.href + action.label}
              to={action.href}
              onClick={close}
              className="inline-flex min-h-[48px] items-center justify-center rounded-xl bg-gold px-5 text-[14px] leading-snug font-bold text-black transition-opacity duration-200 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {loc(...CHANNEL_NUDGE_ACTION_LABEL[action.label])}
            </Link>
          ))}
          <button
            type="button"
            onClick={later}
            className="min-h-[44px] rounded-xl px-5 text-[13px] leading-snug font-medium text-text-muted transition-colors duration-200 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {loc('ليس الآن', 'Not now', 'ئێستا نا')}
          </button>
        </div>

        {/* The floor, stated rather than assumed. A customer who declines has
            NOT been cut off: `channelReadiness` keeps 'inapp' ready for every
            signed-in account, so the message is in their inbox to find. Saying
            so is what makes «ليس الآن» a safe answer instead of a gamble. */}
        <p className="mt-3 text-[11.5px] leading-relaxed text-text-muted">
          {loc(
            'في كل الأحوال ستجد التحديثات داخل التطبيق في صندوق الإشعارات.',
            'Either way, the updates are waiting in your in-app notifications.',
            'بە هەر حاڵ، نوێکارییەکان لە ناو ئەپەکە لە سندوقی ئاگادارکردنەوە دەبن.'
          )}
        </p>
      </div>
    </Sheet>
  );
}
