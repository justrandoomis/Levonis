/**
 * Primitives for the rebuilt product form — mandate §1.
 *
 * The sizing rules are not decoration, they are the acceptance criteria:
 *   - a control is 40px tall (h-10) and its text is 13–14px. 40px is the
 *     floor the §12 suite enforces (every input/select >= 40px at five
 *     widths); the owner reviewed the 44px version on an iPad and asked for
 *     smaller controls and smaller text everywhere, so the panel sits at the
 *     floor, not above it. Buttons are not inputs and may go to 36px;
 *   - a textarea starts at a usable height and STOPS growing (max-h + scroll),
 *     so one long description cannot push the save bar off the page;
 *   - every grid track is minmax(0,1fr) and every flex child that holds text
 *     carries min-w-0. Without those two, a long SKU or URL widens the track
 *     and the whole admin page scrolls sideways — which §12 tests for at 360,
 *     390, 768, 1024 and 1440px;
 *   - labels are Arabic-first with a small English secondary (the admin panel
 *     is RTL), but every INPUT is dir="ltr" because §3 makes the entered text
 *     English only.
 */

import React, { useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ImagePlus, Info, Link2, RefreshCw, X } from 'lucide-react';
import { uploadFile, failureText, formatIqd } from '../../../lib/api';
import SafeImage from '../../ui/SafeImage';

/** 40px control (the §12 floor), 13px text, never wider than its track. */
export const field =
  'w-full min-w-0 h-10 bg-zinc-800/40 border border-zinc-700 rounded-lg px-2.5 text-[13px] text-white ' +
  'placeholder:text-zinc-600 focus:border-[#6B46FF] focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none ' +
  'transition-colors disabled:opacity-50';

/** Same, for a multi-line value that must not grow without bound. */
export const area =
  'w-full min-w-0 min-h-[88px] max-h-[240px] overflow-y-auto bg-zinc-800/40 border border-zinc-700 rounded-lg ' +
  'px-2.5 py-2 text-[13px] leading-relaxed text-white placeholder:text-zinc-600 focus:border-[#6B46FF] ' +
  'focus:ring-1 focus:ring-[#6B46FF]/50 focus:outline-none transition-colors resize-y';

export const btn =
  'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-bold transition-colors ' +
  'disabled:opacity-50 disabled:cursor-not-allowed shrink-0';
export const btnPrimary = `${btn} bg-[#6B46FF] hover:bg-[#5a3ae0] text-white`;
export const btnGhost = `${btn} bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700`;
export const btnDanger = `${btn} bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/30`;
/** A small square icon button, matched to the 36px button row. */
export const iconBtn =
  'inline-flex items-center justify-center w-9 h-9 rounded-lg text-zinc-400 hover:text-white ' +
  'hover:bg-zinc-800 transition-colors shrink-0';

/**
 * Responsive field grid. One column on a phone, two on a tablet, and — only
 * for short controls — three on a wide screen (§1). `minmax(0,1fr)` rather
 * than `1fr` is what stops a long value from widening the page.
 */
export function Grid({ cols = 2, children }: { cols?: 1 | 2 | 3; children: ReactNode }) {
  const cls =
    cols === 1
      ? 'grid gap-3 [grid-template-columns:minmax(0,1fr)]'
      : cols === 2
        ? 'grid gap-3 [grid-template-columns:minmax(0,1fr)] md:[grid-template-columns:repeat(2,minmax(0,1fr))]'
        : 'grid gap-3 [grid-template-columns:minmax(0,1fr)] md:[grid-template-columns:repeat(2,minmax(0,1fr))] xl:[grid-template-columns:repeat(3,minmax(0,1fr))]';
  return <div className={cls}>{children}</div>;
}

/**
 * One labelled field. `hint` is a SHORT helper line; anything longer belongs
 * in the tooltip, because §1 forbids long technical prose inside the form.
 */
export function Field({
  ar,
  en,
  hint,
  tip,
  required,
  error,
  children,
  span,
  htmlFor,
}: {
  ar: string;
  en: string;
  hint?: string;
  tip?: string;
  required?: boolean;
  error?: string | null;
  children: ReactNode;
  /** Make the field take the full row in a multi-column grid. */
  span?: boolean;
  /**
   * The id of the control this labels, for a field whose child is a WRAPPER
   * (a select beside a quick-add button, an input above its chips) rather
   * than the control itself. Without it the clone below would put the id on
   * the wrapper div and the label would point at nothing — a required select
   * with no accessible name.
   */
  htmlFor?: string;
}) {
  const auto = useId();
  const id = htmlFor ?? auto;
  return (
    <div className={`min-w-0 ${span ? 'md:col-span-2 xl:col-span-3' : ''}`}>
      <div className="flex items-center gap-1.5 mb-1 min-w-0">
        <label htmlFor={id} className="text-[12px] font-bold text-zinc-300 truncate">
          {ar} <span className="text-[10px] font-medium text-zinc-500">{en}</span>
          {required && <span className="text-red-400 ms-1">*</span>}
        </label>
        {tip && (
          <span className="group relative shrink-0">
            <Info className="w-3.5 h-3.5 text-zinc-600" aria-hidden="true" />
            <span className="sr-only">{tip}</span>
            <span
              role="tooltip"
              className="pointer-events-none absolute z-20 start-0 top-5 hidden group-hover:block group-focus-within:block
                         w-56 max-w-[70vw] rounded-lg bg-zinc-950 border border-zinc-700 p-2 text-[11px] leading-snug text-zinc-300 shadow-xl"
            >
              {tip}
            </span>
          </span>
        )}
      </div>
      {React.isValidElement(children) && !htmlFor
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
      {hint && !error && <p className="mt-1 text-[11px] text-zinc-500 truncate">{hint}</p>}
      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

/**
 * ONE VALUE, SHOWN TWICE — AND THE FORM SAYS SO.
 *
 * The owner's report, in their words: «نفس الحقل مكرر بأكثر من قسم مما يسبب
 * بإرباك الأدمن … ليس خيارا إضافيا لكن هو نفس الخيار وعند تغييره يتغير الباقي».
 * They are right, and the links they hit are real and deliberate: the
 * direct-sale stock in «نوع الطلب لكل موديل» IS the model's stock in
 * «الخيارات» (one row, one column, edited through one piece of state); an
 * option's own price REPLACES the product price rather than adding to it; a
 * route's surcharge REPLACES the product's direct premium.
 *
 * None of that was wrong — it was just unsaid. A second box that moves when
 * you type in the first, with nothing on screen admitting they are the same
 * box, reads as a bug every single time. So each mirrored control now carries
 * ONE quiet line naming what it really is and which section owns it.
 *
 * Three relationships, because they behave differently and the admin must not
 * have to guess which one they are looking at:
 *
 *   same       literally one value. Typing here types there.
 *   replaces   setting this one makes the other stop applying HERE. It is not
 *              added on top, which is the misreading that costs money.
 *   derived    computed from elsewhere; this is a read-out, not an input.
 *
 * Deliberately not a tooltip: the admin panel is used on a tablet, where a
 * hover tooltip does not exist. It is quiet (11px, muted) so it never competes
 * with the control it explains — §4 of the design rules — but it is on screen.
 */
export function MirrorNote({
  kind,
  where,
  detail,
}: {
  kind: 'same' | 'replaces' | 'derived';
  /** The section that OWNS this value, in the admin's own words, e.g. «٥ الخيارات والألوان». */
  where: string;
  /** One extra clause when the consequence is not obvious from the kind. */
  detail?: string;
}) {
  const lead =
    kind === 'same'
      ? `نفس الحقل في «${where}» — تعديله هنا يعدّله هناك`
      : kind === 'replaces'
        ? `يستبدل قيمة «${where}» ولا يُضاف إليها`
        : `محسوب من «${where}» — للقراءة فقط هنا`;
  return (
    <p
      className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-zinc-500"
      data-mirror={kind}
    >
      <Link2 className="w-3 h-3 mt-[3px] shrink-0 text-zinc-600" aria-hidden="true" />
      <span className="min-w-0">
        {lead}
        {detail ? <span className="text-zinc-600">{` · ${detail}`}</span> : null}
      </span>
    </p>
  );
}

/**
 * THE TWO MEMBER PRICES, FOLDED BEHIND ONE LINE THAT NAMES WHAT IS FOLDED.
 *
 * The owner's instruction, in their words: «لا تحذف الخيارات أو الميزة …
 * اجعل هنالك زر وسيط صغير سطر بكتابة وليس زرا عند النقر عليه يفتح خانتين سعر
 * البرو لهذا الخيار او اللون وسعر البريميوم … التصميم يكون بزر خفيف صغير وناعم
 * قابل للضغط عند النقر عليه يفتح الخانتين بشكل ناعم».
 *
 * The feature it hides is not cosmetic. A member price typed on ONE option or
 * ONE colour is how that row steps out of the product's membership discount
 * while every other row keeps it: `memberPrice` in packages/pricing takes an
 * explicit number FIRST and never consults the rule (`rule_id: null`), and
 * `pickMember` walks base → option → fulfilment → transport → colour, so the
 * number typed on the row wins for that row alone. A 10% discount capped at
 * 100,000 still applies to the other nine options and the other ninety-nine
 * colours. Nothing here changes that; this only decides when the two boxes are
 * on screen.
 *
 * WHAT MAKES FOLDING SAFE, AND IT IS NOT OPTIONAL. With a hundred colours
 * collapsed into a hundred identical lines, the ONE row quietly taking itself
 * out of the discount would be invisible, and the only way to find it would be
 * to open all hundred. Two rules answer that and the control is dishonest
 * without either:
 *
 *   1. a row that already carries a member price OPENS BY ITSELF — and keeps
 *      opening by itself until the admin decides otherwise FOR THAT ROW;
 *   2. wherever it IS collapsed, the line names the amount — «سعر خاص لهذا
 *      اللون · PRO 855,000 د.ع» — which is the shape section 3's own collapsed
 *      summary already uses for the product's PRIME/PRO, through the same
 *      `formatIqd`.
 *
 * `marks` is therefore what the CALLER resolved as typed, never what it read
 * out of a column. An option's PRO may be stored as `pro_adjust_iqd` instead of
 * `pro_price_iqd` — the base+adjustment shape `normalizeCheapestBase` writes —
 * and a caller reading only half of that pair would fold shut over a live
 * override, which is the exact defect the price cells were rebuilt to end. The
 * caller passes the resolver's own answer (`Cell.mode !== 'inherit'`), and a
 * typed 0 is a real price, so the test is never truthiness.
 *
 * OPENING SMOOTHLY. `grid-template-rows: 0fr → 1fr` over a `min-h-0
 * overflow-hidden` child is the only way to animate to an unknown height in CSS
 * alone — no measurement, no library, no second render — and it is already the
 * repo's one unfold recipe (`.lv-refbar__panel`). The folded panel is
 * `invisible`, as that panel's is, which takes the two money inputs out of the
 * tab order so a hidden price box cannot be typed into blind.
 * `motion-reduce:transition-none` is load-bearing, not garnish: src/index.css's
 * reduce block clamps ANIMATIONS and deliberately leaves transitions running,
 * and this form renders outside the `.ap` scope whose theme.css clamps both — so
 * without it a reduced-motion admin would still get the travel. Under reduce the
 * panel still changes state, instantly; the feedback is kept, the movement is
 * not.
 *
 * It is a real `<button type="button">` and not a `<span role="button">` so it
 * inherits the global `:active` dim in src/index.css — the admin panel runs on
 * an iPad, where Tailwind v4 gates `hover:` behind `@media (hover: hover)` and a
 * hover underline is decoration only. The always-present chevron is the resting
 * affordance.
 */
export interface TierPriceMark {
  /** The tier as this form labels it — 'PRIME' or 'PRO'. */
  label: string;
  /** What that tier is charged on this row: already resolved and clamped by the
   *  caller, so this never formats a raw stored scalar. */
  iqd: number | null;
}

/**
 * The folded line's tail, as one string — «· PRO 855,000 د.ع». Split out so the
 * shape a folded row prints can be asserted directly: the state that produces
 * it (an admin who folded a row that HAS a price) is reachable only by a click,
 * and a rule this load-bearing must not be testable only through one.
 */
export function tierPriceSummary(marks: readonly TierPriceMark[]): string {
  /**
   * A NULL AMOUNT IS NOT "UNKNOWN", IT IS "TYPED AND NOT CHARGED", and the tail
   * has to say so in words. The case is real and it is the one the resolver
   * creates, not a missing-data accident: `memberAtRung` carries a member price
   * through the colour rung and DROPS anything that lands at zero or below, so
   * an OPTION with a PRIME of 0 is charged the regular price while a COLOUR
   * with the same 0 is charged 0 (PriceCells documents this on `level`). The
   * caller hands us `null` for exactly that row — it states a price, the till
   * ignores it — and a bare «—» would read as "a special price is set, value
   * unknown", which is the one impression that must never be given about a
   * price. «لا يُحتسب» is the same verdict the cell underneath prints as
   * `data-price-mode="regular-fallback"», so the folded line and the open box
   * cannot disagree.
   */
  return marks.map((m) => `· ${m.label} ${m.iqd === null ? '(لا يُحتسب)' : formatIqd(m.iqd)}`).join(' ');
}

/**
 * IS THE PANEL OPEN? Pulled out as a pure function because it is the whole
 * feature and it is otherwise only reachable through a click, and this repo has
 * no DOM test environment — only `react-dom/server`, and adding jsdom would
 * mean a new dependency. Rendering can only ever observe `choice === null`, so
 * without this export the entire branch where the admin has chosen, and the
 * entire transition from "has a price" to "no longer has one", would ship
 * unverified. They did once: see the latch below.
 *
 * @param choice        what the admin decided, or null while they have not touched it
 * @param hasMarks      does the row state a member price RIGHT NOW
 * @param everHadMarks  has it stated one at any point since this row mounted
 */
export function tierPriceOpen(choice: boolean | null, hasMarks: boolean, everHadMarks: boolean): boolean {
  return choice ?? (hasMarks || everHadMarks);
}

export function TierPriceDisclosure({
  scope,
  marks,
  children,
}: {
  /** Which row this is, for the wording — «لهذا الخيار» / «لهذا اللون» /
   *  «لهذا المنتج». Presentation only; it decides no price. */
  scope: 'option' | 'color' | 'product';
  /** The tiers this row has TYPED, in field order. Empty = nothing is set, so
   *  the line is the plain invitation and the panel starts folded. */
  marks: readonly TierPriceMark[];
  children: ReactNode;
}) {
  const panelId = useId();
  /**
   * NULL until the admin touches it, and that is the whole trick.
   * `useState(marks.length > 0)` would read the data ONCE, at mount — and the
   * product document arrives from the server AFTER this control has mounted, so
   * a PRO price loaded a moment later would land inside a panel that had already
   * decided to stay shut. That is precisely the hidden override rule 1 exists to
   * prevent. Deriving `open` from `marks` on every render until the admin
   * overrules it means a price can never arrive into a closed panel; once they
   * choose, their choice stands and the line beside it still names the amount.
   *
   * IT IS LOCAL ON PURPOSE, not a `Record<rowId, boolean>` held by the parent.
   * The flag is per row and the rows are a list, so the only question is what
   * identifies a row — and React already answers it: the option and colour
   * repeaters render `key={v.id}` / `key={c.id}`, so this component's own state
   * is bound to that id and nothing else. A map keyed by list INDEX (or a
   * component keyed by index) would hand row 7's «open» to whatever slid into
   * slot 7 after a colour was deleted or dragged — which, on a control whose
   * entire job is to show that row 7 has a price of its own, means showing it
   * on the wrong row. There is no id to plumb through and no map to keep in
   * sync with deletions, because the key already is the identity.
   */
  const [choice, setChoice] = useState<boolean | null>(null);
  /**
   * THE LATCH, AND WHY `open` IS NOT A LIVE FUNCTION OF `marks`.
   *
   * It was, and it made the documented way to UNDO an override unusable. The
   * panel's own sentence tells the admin «واتركه فارغًا ليسري الخصم» — clear the
   * box to put this colour back on the discount. But `Money` fires
   * `onChange(null)` on the last backspace, `PriceCells.commit` writes both
   * columns null, the mode falls to 'inherit' and `marks` empties — mid
   * keystroke. On a row that auto-opened (i.e. every row that already had a
   * price, which is the whole population of rows this control matters on)
   * `choice` is still null, so `open` flipped to false under the admin's
   * finger: the panel folded, the wrapper took `visibility: hidden`, and
   * hiding an ancestor of the focused input drops focus to <body>. The «يرث»
   * button did the same thing to itself — it destroyed the container it was
   * standing in. The opposite of «يفتح الخانتين بشكل ناعم».
   *
   * Latching keeps the property that mattered (a price ARRIVING — from the
   * server, after mount — still forces the panel open, so an override can
   * never land inside a closed panel) and drops the one that did not (a price
   * LEAVING closing it). The admin's own click still overrules both.
   *
   * Written during render on purpose: the assignment is monotonic and
   * idempotent, so a double invocation under StrictMode reaches the same
   * value. An effect would run after paint and fold the panel for one frame.
   */
  const everSet = useRef(false);
  if (marks.length > 0) everSet.current = true;
  const open = tierPriceOpen(choice, marks.length > 0, everSet.current);

  const noun = scope === 'color' ? 'اللون' : scope === 'product' ? 'المنتج' : 'الخيار';
  const rest = scope === 'color' ? 'الألوان' : 'الخيارات';
  /**
   * ONE sentence, and it is scoped on purpose. MembershipDiscountSection's own
   * banner speaks about the PRODUCT («لن يُقرأ هذا التجاوز حتى يُفرَّغ ذلك
   * الحقل»); repeating that here without «وحده» would contradict it, because a
   * price typed on one option leaves every other option on the rule. The verb is
   * the house's «يسبق» / «يستبدل», not the owner's «يطغى», which appears nowhere
   * else in this codebase.
   */
  const rule =
    scope === 'product'
      ? 'السعر المكتوب هنا يسبق خصم العضوية لهذا المنتج كله — واتركه فارغًا ليسري الخصم.'
      : `السعر المكتوب هنا يسبق خصم العضوية لهذا ${noun} وحده، وتبقى بقية ${rest} على الخصم — واتركه فارغًا ليسري الخصم.`;
  /**
   * THE ENGLISH SECONDARY IS SCOPED BY THE SAME TERNARY, and it must be: an
   * unconditional «for this row only» sat beside the product sentence and said
   * the opposite of it in the same paragraph. At product scope the override is
   * not a per-row exception — MembershipDiscountSection's banner states that the
   * rule «لن يُقرأ» at all while that field holds a number — so an English
   * reader was being told the discount still applied to everything else when it
   * applied to nothing.
   */
  const ruleEn =
    scope === 'product'
      ? 'A price written here replaces the membership discount for this whole product.'
      : 'A price written here replaces the membership discount for this row only.';

  return (
    // A FULL-WIDTH BAND, because the parent is
    // `grid … [grid-template-columns:minmax(0,1fr)] md:repeat(2,…) xl:repeat(3,…)`
    // (see `Grid`) and every `PriceCell` is a DIRECT item of it. Dropped in as
    // one more ordinary item this would land beside «السعر» at md/xl and read as
    // a fourth price box; `col-span-full` puts it on its own row instead. The
    // caller nests a `Grid` of the same column count inside, so PRIME and PRO
    // still line up under «السعر» at every breakpoint rather than re-dividing
    // the row into halves.
    <div className="col-span-full min-w-0">
      <button
        type="button"
        onClick={() => setChoice(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        data-tier-price-toggle={scope}
        className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-h-9 max-w-full min-w-0 py-1 rounded
                   text-[11px] leading-snug font-medium text-zinc-400 text-start
                   underline-offset-4 hover:text-zinc-200 hover:underline transition-colors
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B46FF]"
      >
        {/* A ChevronDown that only ever rotates 180° — vertical, so it is
            direction-neutral and cannot point the wrong way in RTL the way a
            rotated ChevronRight does. */}
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-zinc-500 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
        <span className="min-w-0">
          سعر خاص لهذا {noun}{' '}
          <span className="text-[10px] leading-snug font-medium text-zinc-600">PRIME / PRO</span>
        </span>
        {/* THE HONEST COLLAPSED LINE. Only while folded, because open the two
            boxes state it better — but folded, this is the only thing standing
            between the admin and an override they cannot see. */}
        {!open && marks.length > 0 && (
          <span className="min-w-0 text-zinc-300 tabular-nums" data-tier-price-set>
            {tierPriceSummary(marks)}
          </span>
        )}
      </button>
      {/* The id sits on the wrapper that is ALWAYS rendered, so `aria-controls`
          resolves whether the panel is open or not. */}
      <div
        id={panelId}
        data-tier-price-panel={scope}
        className={`grid min-w-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div
          className={`min-h-0 min-w-0 overflow-hidden transition-[visibility] duration-200 motion-reduce:transition-none ${
            open ? 'visible' : 'invisible'
          }`}
        >
          <p className="mb-2 text-[11px] leading-snug text-zinc-500">
            {rule}
            <span className="text-zinc-600"> {ruleEn}</span>
          </p>
          {children}
        </div>
      </div>
    </div>
  );
}

/** English text input — always LTR, per §1/§3. */
export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input dir="ltr" {...props} className={`${field} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea dir="ltr" rows={4} {...props} className={`${area} ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative min-w-0">
      <select {...props} className={`${field} appearance-none pe-9 ${props.className ?? ''}`} />
      <ChevronDown className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
    </div>
  );
}

/**
 * Integer IQD money input. EMPTY means "inherit / not set" (null) and an
 * explicit 0 is a real price — never a truthiness check, because a genuinely
 * free item and an unset price are different facts.
 */
export function Money({
  value,
  onChange,
  placeholder,
  required,
  id,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  required?: boolean;
  id?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [touched, setTouched] = useState(false);
  // Follow the model when it changes from outside (load, reset, import).
  React.useEffect(() => {
    if (!touched) setText(value === null ? '' : String(value));
  }, [value, touched]);
  return (
    <input
      id={id}
      dir="ltr"
      inputMode="numeric"
      disabled={disabled}
      className={field}
      placeholder={placeholder ?? (required ? '0' : 'يرث / inherit')}
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d]/g, '');
        setTouched(true);
        setText(raw);
        onChange(raw === '' ? null : Number(raw));
      }}
      onBlur={() => setTouched(false)}
    />
  );
}

/**
 * A PERCENT input (7.5 → 7.5%) with two decimals at most — the extended
 * warranty's fee as a share of the printer price. EMPTY is null ("no
 * percent: the fixed fee applies"); the text is kept while typing so "7."
 * is not snapped to 7 under the admin's finger, and the model receives only
 * a finished number.
 */
export function Percent({
  value,
  onChange,
  placeholder,
  id,
  disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [touched, setTouched] = useState(false);
  React.useEffect(() => {
    if (!touched) setText(value === null ? '' : String(value));
  }, [value, touched]);
  return (
    <div className="relative min-w-0">
      <input
        id={id}
        dir="ltr"
        inputMode="decimal"
        disabled={disabled}
        className={`${field} pe-8`}
        placeholder={placeholder ?? '7.5'}
        value={text}
        onChange={(e) => {
          // digits, at most one dot, at most two decimals — anything else is
          // dropped as it is typed rather than refused after the fact.
          const raw = e.target.value.replace(/[^\d.]/g, '').replace(/^(\d*\.\d{0,2}).*$/, '$1').replace(/(\..*)\./g, '$1');
          setTouched(true);
          setText(raw);
          const n = raw === '' || raw === '.' || raw.endsWith('.') ? null : Number(raw);
          onChange(n === null || !Number.isFinite(n) ? (raw === '' ? null : value) : n);
        }}
        onBlur={() => {
          setTouched(false);
          if (text.endsWith('.')) setText(text.slice(0, -1));
        }}
      />
      <span aria-hidden="true" className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-[12px] text-zinc-500">
        %
      </span>
    </div>
  );
}

/** Integer quantity input with the same null-vs-zero contract. */
export function Qty({
  value,
  onChange,
  id,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  id?: string;
  placeholder?: string;
}) {
  return (
    <Money value={value} onChange={onChange} id={id} placeholder={placeholder ?? 'غير محدود / untracked'} />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  sub,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sub?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex items-center justify-between gap-3 w-full min-w-0 h-10 px-2.5 rounded-lg border text-[13px] text-start transition-colors ${
        checked ? 'bg-[#6B46FF]/10 border-[#6B46FF]/50 text-white' : 'bg-zinc-800/40 border-zinc-700 text-zinc-300'
      }`}
    >
      <span className="min-w-0 truncate">
        {label}
        {sub && <span className="text-[11px] text-zinc-500 ms-1.5">{sub}</span>}
      </span>
      <span
        className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${checked ? 'bg-[#6B46FF]' : 'bg-zinc-600'}`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'start-[18px]' : 'start-0.5'}`}
        />
      </span>
    </button>
  );
}

/** Multi-select card, used for sale types (§6) and facets. */
export function CheckCard({
  checked,
  onChange,
  title,
  sub,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  sub?: string;
  /** A card whose answer is decided elsewhere: shown, readable, not clickable. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`min-w-0 text-start rounded-lg border p-2.5 transition-colors ${
        disabled ? 'opacity-70 cursor-default' : ''
      } ${
        checked
          ? 'bg-[#6B46FF]/10 border-[#6B46FF]/60'
          : `bg-zinc-800/30 border-zinc-700 ${disabled ? '' : 'hover:border-zinc-600'}`
      }`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span
          className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
            checked ? 'bg-[#6B46FF] border-[#6B46FF]' : 'border-zinc-600'
          }`}
        >
          {checked && (
            <svg viewBox="0 0 12 12" className="w-3 h-3 text-white" aria-hidden="true">
              <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span className="text-[13px] font-bold text-white truncate">{title}</span>
      </span>
      {sub && <span className="block mt-0.5 text-[10px] text-zinc-500 truncate">{sub}</span>}
    </button>
  );
}

/**
 * A form section. Collapsed sections show a one-line summary and an item
 * count, so an admin can see what is inside without opening it (§1). Only ONE
 * heavy section is open at a time — the parent decides which.
 */
export function SectionCard({
  n,
  ar,
  en,
  summary,
  count,
  open,
  onToggle,
  error,
  children,
}: {
  n: number;
  ar: string;
  en: string;
  summary?: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  error?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      // §1 numbers the sections 1..8 and the order is part of the spec, so the
      // ordinal is the stable handle for a test that needs one section in
      // particular. The accordion opens one heavy section at a time, so
      // "click every header" cannot reach a specific panel.
      data-section={n}
      className={`min-w-0 rounded-xl border overflow-hidden mb-2.5 ${
        error ? 'border-red-500/50 bg-red-500/[0.03]' : 'border-zinc-800 bg-zinc-900/40'
      }`}
    >
      <button
        type="button"
        data-section-toggle={n}
        aria-expanded={open}
        onClick={onToggle}
        className="w-full min-w-0 flex items-center gap-2 px-2.5 h-10 text-start hover:bg-zinc-800/30 transition-colors"
      >
        <span
          className={`shrink-0 w-5 h-5 rounded-md grid place-items-center text-[10px] font-black ${
            open ? 'bg-[#6B46FF] text-white' : 'bg-zinc-800 text-zinc-400'
          }`}
        >
          {n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-bold text-white truncate">
            {ar}
            {/* The English secondary is dropped on a phone: at 360-390px it
                pushed the Arabic title into an ellipsis, and the number plus
                the Arabic title already identify the section. */}
            <span className="hidden sm:inline text-[10px] font-medium text-zinc-500"> {en}</span>
          </span>
          {!open && summary && <span className="block text-[10px] text-zinc-500 truncate">{summary}</span>}
        </span>
        {count !== undefined && count > 0 && (
          <span className="shrink-0 min-w-6 h-5 px-1.5 rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-300 grid place-items-center">
            {count}
          </span>
        )}
        <ChevronDown
          className={`shrink-0 w-4 h-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && <div className="p-3 border-t border-zinc-800/70 min-w-0">{children}</div>}
    </section>
  );
}

/** A small inline row of repeated items (options, colours) with a header. */
export function Repeater({
  title,
  onAdd,
  addLabel,
  children,
  empty,
}: {
  title: string;
  onAdd: () => void;
  addLabel: string;
  children: ReactNode;
  empty?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <h4 className="text-[12px] font-bold text-zinc-300 truncate">{title}</h4>
        <button type="button" onClick={onAdd} className={`${btnGhost} h-8 px-2.5 text-[12px]`}>
          + {addLabel}
        </button>
      </div>
      {React.Children.count(children) === 0 && empty ? (
        <p className="text-[12px] text-zinc-500 py-2">{empty}</p>
      ) : (
        <div className="space-y-2 min-w-0">{children}</div>
      )}
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'error' | 'warn' | 'ok'; children: ReactNode }) {
  const cls =
    kind === 'error'
      ? 'bg-red-500/10 border-red-500/40 text-red-200'
      : kind === 'warn'
        ? 'bg-amber-500/10 border-amber-500/40 text-amber-100'
        : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-100';
  return (
    <div className={`min-w-0 rounded-lg border px-3 py-2 text-[12px] leading-snug mb-2.5 ${cls}`}>{children}</div>
  );
}

/** Compact image slot: thumbnail when set, an upload button when not. Used
 *  for option/colour images and the usage-guide step photos. */
export function ImgSlot({
  url,
  label,
  onChange,
}: {
  url: string;
  label: string;
  onChange: (url: string | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  /** The REASON this slot is empty, not merely that it is. `catch {}` with a
   *  boolean left the admin with a red outline and nothing to act on. */
  const [err, setErr] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await uploadFile(file, 'product');
      onChange(res.url);
    } catch (e) {
      setErr(failureText(e, 'فشل الرفع / upload failed'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <span className="relative inline-flex items-center gap-1.5 shrink-0 min-w-0">
      <input
        ref={fileRef}
        type="file"
        dir="ltr"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => pick(e.target.files?.[0])}
      />
      {url ? (
        <span className="relative block w-10 h-10">
          {/* SafeImage, not a bare <img>: an option thumbnail whose host stops
              answering shows an explicit "failed" glyph with a retry, instead
              of the browser's broken-file icon that reads as "no image set". */}
          <SafeImage
            src={url}
            alt={label}
            aspect="auto"
            fit="cover"
            className="w-10 h-10 rounded-lg border border-zinc-700"
            bgClassName="bg-zinc-900"
            fallbackIconClassName="w-3.5 h-3.5"
          />
          <button
            type="button"
            aria-label={`\u0625\u0632\u0627\u0644\u0629 ${label}`}
            onClick={() => onChange(null)}
            className="absolute -top-1.5 -end-1.5 w-4 h-4 rounded-full bg-zinc-900 border border-zinc-600 text-zinc-300 hover:text-red-400 grid place-items-center"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          aria-label={label}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          title={err ?? label}
          className={`w-10 h-10 shrink-0 rounded-lg border grid place-items-center transition-colors disabled:opacity-60 ${
            err
              ? 'border-red-500/50 text-red-400'
              : 'border-dashed border-zinc-600 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500'
          }`}
        >
          {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
        </button>
      )}
      {/* A `title` tooltip does not exist on the tablet this form is used on,
          so the reason is TEXT. Truncated and width-capped so a long message
          cannot push the row it sits in. */}
      {err && (
        <span role="alert" className="text-[10px] leading-tight text-red-400 truncate max-w-[9rem]" title={err}>
          {err}
        </span>
      )}
    </span>
  );
}
