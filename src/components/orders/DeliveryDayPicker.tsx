/**
 * «يستطيع اختيار وتغيير يوم التوصيل في أي وقت يريد ولكن بحد أقصى أسبوع» — the
 * customer's day, as a row of buttons carrying text the SERVER already wrote.
 *
 * THIS COMPONENT OWNS NO CALENDAR AND NO CLOCK. It is handed `days[]` —
 * `{ day, label, is_today, is_tomorrow }` straight out of `deliveryDateVerb`
 * — and it renders `label`. There is no date library here, no
 * `<input type="date">`, and no `new Date()`. Two failures, both of which have
 * already happened to Iraqi users, are what that buys:
 *
 *  1. A NATIVE DATE INPUT OPENS IN THE DEVICE'S LOCALE, and on Iraqi Androids
 *     it opens on the HIJRI calendar often enough to matter. A customer who
 *     wants «الأربعاء» is shown ١١ ربيع الأول and has to convert in their head
 *     — for a shop whose every other date is Gregorian.
 *  2. `new Date('2026-09-23')` PARSES AS UTC MIDNIGHT. Rendered by a browser
 *     on a negative offset that is the TWENTY-SECOND: the customer picks
 *     Wednesday and the confirmation says Tuesday. `worker/lib/deliveryDay.ts`
 *     records this as the reason the label is computed on the server at all.
 *
 * Eight buttons of server-rendered text have neither problem, and they are the
 * whole control.
 *
 * WHEN THE DAY CANNOT BE CHANGED THERE ARE NO CHIPS AT ALL — one read-only
 * line and one sentence naming WHY. A greyed-out control that never explains
 * itself is how a customer concludes the site is broken and opens a ticket;
 * the server sends `reason` precisely so this screen can print a sentence
 * instead, and all five are written out below in all three languages.
 *
 * THE ONE THING THIS FILE DOES COMPUTE is the absolute label of an already
 * chosen day when the window has SHUT — «الأربعاء ٢٣ أيلول». The labels only
 * ride along inside `days[]`, which is empty exactly then, so the read-only
 * line would otherwise have a bare '2026-09-23' to print. It calls the same
 * `dayLabel` the server calls, with an EMPTY `todayDay`, which is what makes
 * it clock-free: with no today there are no relative words, so the browser
 * cannot say «غدًا» over a day that is not tomorrow, and the answer is a pure
 * function of the day string. Importing it rather than copying the month names
 * follows `src/lib/policyReader.ts`: both modules are pure string functions
 * with no imports of their own, so nothing of the Worker runtime enters the
 * bundle, and one table cannot drift from the other.
 */
import { Check } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useRail } from '../../lib/useRail';
import { dayLabel } from '../../../worker/lib/deliveryDay';
import type { DeliveryDateReason, DeliveryDayOption } from '../../lib/api';
import { asLang } from './format';

export interface DeliveryDayPickerProps {
  /** The days on offer, in order, exactly as the server sent them. */
  days: DeliveryDayOption[];
  /** The chosen day, or null for «في أقرب وقت» — which is most orders. */
  selected: string | null;
  canChange: boolean;
  /** Why not, when `canChange` is false. */
  reason: DeliveryDateReason | null;
  /** `null` clears the day back to "as soon as possible". */
  onPick: (day: string | null) => void;
}

/**
 * THE RAIL HOLDS EIGHT DAYS, and that is the whole shipped offer rather than a
 * truncation of it: `DEFAULT_DELIVERY_DAY_POLICY` is «بحد أقصى أسبوع» with
 * same-day on, so the widest window an order ever has is today plus seven —
 * eight days. The bound exists for the owner who raises `max_days` towards its
 * 30-day ceiling, where thirty-one chips stop being a choice and become a
 * scroll. The «في أقرب وقت» chip sits outside the count because it is not a
 * day; it is the absence of one.
 */
const MAX_DAY_CHIPS = 8;

const STRINGS = {
  ar: {
    title: 'يوم التوصيل',
    asap: 'في أقرب وقت',
    hint: 'اختر اليوم الذي يناسبك، أو اتركه في أقرب وقت.',
    fixed: (day: string) => `يوم التوصيل: ${day}`,
    reasons: {
      PICKUP: 'هذا الطلب استلام من المخزن، فلا يوجد توصيل إلى عنوانك حتى نحدّد له يومًا.',
      PREORDER_NOT_ARRIVED:
        'الطلب المسبق ما زال في الطريق. يُفتح اختيار يوم التوصيل عند وصول البضاعة إلى مخزن ليفو.',
      // HONEST, NOT A REFUSAL. `DeliveryDriver` has listStatuses, createShipment
      // and getShipment — and no updateShipment — so once the waybill exists a
      // day changed here would live on our screen and nowhere else.
      WITH_COURIER:
        'الطلب صار عند شركة التوصيل. نظامها لا يقبل تعديل موعد شحنة بعد إنشائها، فلا نستطيع تحريك اليوم من هنا — المندوب أو فريق الدعم ينسّق معك مباشرة.',
      FINISHED: 'انتهى هذا الطلب، فلم يبقَ يوم توصيل يتغيّر.',
      WINDOW_CLOSED:
        'لم يعد اختيار يوم التوصيل متاحًا لهذا الطلب — انتهت مدة الأسبوع المحسوبة من تاريخ الطلب، أو أن الطلب أقدم من هذه الميزة.',
    } as Record<DeliveryDateReason, string>,
  },
  en: {
    title: 'Delivery day',
    asap: 'As soon as possible',
    hint: 'Pick the day that suits you, or leave it as soon as possible.',
    fixed: (day: string) => `Delivery day: ${day}`,
    reasons: {
      PICKUP: 'This order is collected from the store, so there is no delivery to your address to schedule.',
      PREORDER_NOT_ARRIVED:
        'This pre-order is still in transit. Choosing a delivery day opens once the goods reach the LEVO warehouse.',
      WITH_COURIER:
        'The parcel is already with the courier. Their system accepts no change to a shipment once it has been created, so we cannot move the day from here — the driver or our support team will arrange it with you directly.',
      FINISHED: 'This order is finished, so there is no delivery day left to change.',
      WINDOW_CLOSED:
        'Choosing a delivery day is no longer available for this order — the week counted from the order date has passed, or the order predates this feature.',
    } as Record<DeliveryDateReason, string>,
  },
  ckb: {
    title: 'ڕۆژی گەیاندن',
    asap: 'زووترین کات',
    hint: 'ئەو ڕۆژە هەڵبژێرە کە بۆت باشە، یان بیهێڵەرەوە بۆ زووترین کات.',
    fixed: (day: string) => `ڕۆژی گەیاندن: ${day}`,
    reasons: {
      PICKUP: 'ئەم داواکارییە لە کۆگاوە وەردەگیرێت، بۆیە گەیاندنێک بۆ ناونیشانەکەت نییە کە ڕۆژی بۆ دابنرێت.',
      PREORDER_NOT_ARRIVED:
        'ئەم پێشـداواکارییە هێشتا لە ڕێگادایە. هەڵبژاردنی ڕۆژی گەیاندن کاتێک دەکرێتەوە کە کاڵاکە دەگاتە کۆگای LEVO.',
      WITH_COURIER:
        'پاکەتەکە لەلای کۆمپانیای گەیاندنە. سیستەمی ئەوان دوای دروستکردنی بارکردنێک هیچ گۆڕانکارییەک قبوڵ ناکات، بۆیە ناتوانین ڕۆژەکە لێرەوە بگۆڕین — گەیێنەر یان تیمی پشتگیری ڕاستەوخۆ لەگەڵت ڕێک دەکەون.',
      FINISHED: 'ئەم داواکارییە تەواو بووە، بۆیە هیچ ڕۆژێکی گەیاندن نەماوە بۆ گۆڕین.',
      WINDOW_CLOSED:
        'هەڵبژاردنی ڕۆژی گەیاندن چیتر بۆ ئەم داواکارییە بەردەست نییە — ماوەی هەفتەیەک لە بەرواری داواکارییەوە تەواو بووە، یان داواکارییەکە پێش ئەم تایبەتمەندییە بووە.',
    } as Record<DeliveryDateReason, string>,
  },
} as const;

/** «الأربعاء ٢٣ أيلول» → the weekday above, the rest below. */
function twoLines(label: string): [string, string] {
  const at = label.indexOf(' ');
  return at === -1 ? [label, ''] : [label.slice(0, at), label.slice(at + 1)];
}

export default function DeliveryDayPicker({ days, selected, canChange, reason, onPick }: DeliveryDayPickerProps) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  // The rail owns the three incompatible RTL `scrollLeft` conventions this app
  // has already been bitten by, and detaches itself when the row is not
  // actually a scroller. Snapping is off: a chip is ~80px, and a rail that
  // clicks into place every 80px fights the finger rather than following it.
  const rail = useRail({ decelerationRate: 0.99, snap: false });

  if (!canChange) {
    return (
      <section data-delivery-day className="lv-surface min-w-0 p-3">
        <h3 className="text-[13px] font-bold leading-[1.5] text-text-primary">{s.title}</h3>
        <p className="mt-1 text-[13px] leading-[1.6] text-text-secondary">
          {/* An absolute label, built with no clock at all — see the file
              header. A day already chosen but no longer changeable still has
              to be READABLE; '2026-09-23' is not an answer to "when". */}
          {s.fixed(selected ? dayLabel(selected, '', lang).label || selected : s.asap)}
        </p>
        {reason && (
          <p className="lv-alert lv-alert-info mt-2 text-[12.5px] leading-[1.6] text-text-secondary">
            {s.reasons[reason]}
          </p>
        )}
      </section>
    );
  }

  // A day the server sent with no label is a row we cannot put words on, and a
  // blank chip is worse than one fewer chip.
  const chips = days.filter((d) => d.label).slice(0, MAX_DAY_CHIPS);

  return (
    <section data-delivery-day className="lv-surface min-w-0 p-3">
      <h3 className="text-[13px] font-bold leading-[1.5] text-text-primary">{s.title}</h3>
      <p className="mt-0.5 text-[12px] leading-[1.6] text-text-muted">{s.hint}</p>
      <div
        ref={rail.ref}
        role="group"
        aria-label={s.title}
        data-delivery-day-rail
        className="-mx-3 mt-2 flex gap-2 overflow-x-auto overscroll-x-contain px-3 pb-1 hide-scrollbar"
      >
        <Chip label={s.asap} sublabel="" pressed={selected === null} onPick={() => onPick(null)} wide />
        {chips.map((d) => {
          const [head, tail] = twoLines(d.label);
          return (
            <Chip
              key={d.day}
              label={head}
              sublabel={tail}
              pressed={selected === d.day}
              onPick={() => onPick(d.day)}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * One chip. `.lv-choice` + `aria-pressed` is the house selected-state
 * primitive and already carries THREE simultaneous non-colour cues — the
 * surface changes, an RTL-mirrored inset edge bar appears, and the checkmark
 * fades in — so nothing here re-states selection in colour alone.
 *
 * Press feedback needs no JavaScript: `:active` is global in the base layer
 * and `.press-scale` is the opt-in for chip-sized controls. `hover:` is gated
 * behind `@media (hover: hover)` in Tailwind v4 and therefore never fires on
 * the phone this screen is designed for, so the affordances that matter here
 * are press and focus-visible.
 */
function Chip({
  label,
  sublabel,
  pressed,
  onPick,
  wide,
}: {
  label: string;
  sublabel: string;
  pressed: boolean;
  onPick: () => void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      data-day-chip
      aria-pressed={pressed}
      // Re-picking what is already picked would spend a PATCH and increment
      // `delivery_day_changes` — the counter a support agent reads when a
      // customer says the courier keeps missing them — for no change at all.
      onClick={() => !pressed && onPick()}
      className={`lv-choice press-scale relative flex min-h-[56px] shrink-0 flex-col items-center justify-center gap-0.5 px-3 py-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        wide ? 'min-w-[104px]' : 'min-w-[78px]'
      }`}
    >
      <span className="text-[13px] font-bold leading-[1.35]">{label}</span>
      {sublabel && <span className="text-[12px] leading-[1.35] text-text-muted">{sublabel}</span>}
      <span className="lv-choice-mark absolute top-1 end-1">
        <Check className="h-3 w-3" aria-hidden="true" />
      </span>
    </button>
  );
}
