/**
 * «كذلك اضفها ايضا في طريقة الدفع عند checkout تحت خيار الدفع عند الاستلام
 *  كخيار إضافي لكن خيار ناعم وبسيط ليس ضخما»
 *
 * THE GINI ROW, and why it is not a fourth payment card.
 *
 * Checkout draws each payment method as an `lv-choice` card, and Gini is a
 * real selection among them — picking it re-quotes the cart and changes what
 * is collected at the door. But it is also the least common door of the four,
 * and a card of the same size would give an instalments service taken out in
 * somebody else's app the same standing as the two ways nearly every order is
 * actually paid. So it is a row of body text with an icon, one weight below
 * the cards it hangs under, and it still behaves exactly like the radios:
 * `onChoose` is what the page's own `onChange` handlers do.
 *
 * THE UNFOLD IS THE REPO'S ONE RECIPE. `grid-template-rows: 0fr → 1fr` over a
 * `min-h-0 overflow-hidden` child is the only way to animate to an unknown
 * height in CSS alone — no measurement, no library, no second render — and
 * src/components/adminProducts/form/formUi.tsx makes the same point from the
 * other side. `motion-reduce:*` is load-bearing rather than garnish:
 * src/index.css's reduce block clamps ANIMATIONS and deliberately leaves
 * transitions running, so without it a reduced-motion customer still gets the
 * travel. The folded panel is `invisible`, which takes the field out of the
 * tab order so a hidden input cannot be typed into blind.
 *
 * THE COPY IS THE PAGE'S. Every sentence arrives through `strings` from
 * Checkout's own trilingual table, because the same warning is repeated on the
 * screen after the order is placed and two copies of one promise are two
 * promises that can drift.
 */
import { AlertCircle, ChevronDown, Landmark } from 'lucide-react';

/**
 * ARABIC-INDIC AND PERSIAN DIGITS, AS THE SERVER SPELLS THEM.
 *
 * The Gini order number is checked against `/^[0-9]{6}$/` where the checkout
 * input is parsed and again by a GLOB on `orders.gini_order_no`, so «١٢٣٤٥٦»
 * typed on an Arabic keyboard is a refusal — and simply stripping non-ASCII
 * digits would erase the field under the finger of the customer most likely to
 * be typing into it. They are the same six digits; only the shapes differ, so
 * they are folded rather than rejected.
 */
export function asciiDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export interface GiniCheckoutStrings {
  /** The row's own line — «طلبتها أقساط من تطبيق جني؟» */
  row: string;
  /** One quiet line under it: the price is settled in the app, delivery is not. */
  hint: string;
  label: string;
  help: string;
  /** «لم يتم تاكيده الا بعد … مسح باركود الاستلام», already carrying the hours. */
  warning: string;
}

export default function GiniCheckoutOption({
  selected,
  orderNo,
  onOrderNoChange,
  onChoose,
  strings,
}: {
  selected: boolean;
  orderNo: string;
  onOrderNoChange: (value: string) => void;
  /** Select Gini as the payment method — the radios' `onChange`, by another name. */
  onChoose: () => void;
  strings: GiniCheckoutStrings;
}) {
  return (
    <div data-gini-option data-selected={selected} className="-mt-1">
      <button
        type="button"
        onClick={onChoose}
        aria-expanded={selected}
        aria-controls="checkout-gini-panel"
        data-gini-toggle
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Landmark
          aria-hidden="true"
          strokeWidth={1.5}
          className={`w-4 h-4 shrink-0 ${selected ? 'text-gold' : 'text-zinc-500'}`}
        />
        <span className="min-w-0 flex-1">
          <span className={`block text-[13px] ${selected ? 'text-white' : 'text-zinc-400'}`}>{strings.row}</span>
          <span className="block text-[11.5px] font-light leading-snug text-zinc-500">{strings.hint}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.5}
          className={`w-4 h-4 shrink-0 text-zinc-600 transition-transform duration-200 motion-reduce:transition-none ${
            selected ? 'rotate-180' : ''
          }`}
        />
      </button>

      <div
        id="checkout-gini-panel"
        className={`grid min-w-0 transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
          selected ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div
          className={`min-h-0 min-w-0 overflow-hidden transition-opacity duration-200 motion-reduce:transition-none ${
            selected ? 'visible opacity-100' : 'invisible opacity-0'
          }`}
        >
          <div className="px-3 pb-1 pt-2">
            <label className="mb-1.5 block text-[12px] font-medium text-zinc-300" htmlFor="checkout-gini-order-no">
              {strings.label}
            </label>
            {/*
              `dir="ltr"` on the VALUE only: six digits read left to right
              inside this right-to-left page, while the label above keeps the
              page's own direction. `text-[16px]` is the Mobile Safari floor —
              anything smaller zooms the viewport on focus and never zooms back
              out — and `inputMode="numeric"` raises the digit pad without
              `type="number"`'s spinner and scroll-to-change.
            */}
            <input
              id="checkout-gini-order-no"
              type="text"
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              placeholder="000000"
              value={orderNo}
              onChange={(e) => onOrderNoChange(asciiDigits(e.target.value).replace(/[^0-9]/g, '').slice(0, 6))}
              aria-describedby="checkout-gini-help"
              data-gini-order-no
              className="lv-input w-full text-center font-mono text-[16px] tracking-[0.3em]"
            />
            <p id="checkout-gini-help" className="mt-1.5 text-[11.5px] font-light text-zinc-500">
              {strings.help}
            </p>

            {/*
              «ملاحظه مهمه للمستخدم ان الطلب لم يتم تاكيده الا بعد طلب من تطبيق
              جني وتاكيد مسح باركود الاستلام» — said HERE, where the customer is
              choosing, and not only on the screen after the order is placed.
              Amber rather than red: a hold that has not expired yet is a
              caution, not an error — nothing has gone wrong, something is
              still required.
            */}
            <p data-gini-warning className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed text-warning">
              <AlertCircle aria-hidden="true" className="mt-px w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
              <span>{strings.warning}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
