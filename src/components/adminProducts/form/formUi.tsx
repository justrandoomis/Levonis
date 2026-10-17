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
import { uploadFile, failureText } from '../../../lib/api';
import { toAsciiDigits } from '../../../lib/localeNumber';
import SafeImage from '../../ui/SafeImage';
import { MissingNote, useMissing, useMissingId } from '../completeness';
import type { CompletenessItemCode } from '../../../../packages/contracts/src/productCompleteness';

/**
 * 40px control (the §12 floor), 13px text, never wider than its track.
 *
 * A FIELD IS A WELL (clay, docs/DECISIONS.md row 207): the `lv-input` of the app —
 * sunk into its section behind the 3:1 field line, the focus ring that keeps
 * the well, a danger line on `aria-invalid` — at the density of the admin. The
 * geometry is kept apart so each control below names `lv-input` itself.
 */
const fieldSize = 'w-full min-w-0 h-10 min-h-10 px-2.5 text-[13px] disabled:opacity-50';
export const field = `lv-input ${fieldSize}`;

/** Same, for a multi-line value that must not grow without bound. */
const areaSize =
  'w-full min-w-0 min-h-[88px] max-h-[240px] overflow-y-auto px-2.5 py-2 text-[13px] leading-relaxed resize-y';
export const area = `lv-input ${areaSize}`;

/**
 * The clay buttons of the app (`lv-button`: resting clay, a dent while pressed,
 * the focus ring, the disabled and busy states) at the 36px admin height.
 * The primary keeps the violet admin fill (`iris` from the theme) on the rim and
 * base of a primary — only while it can be pressed: a utility outranks the
 * components layer, so an unconditional fill would leave a disabled button
 * looking live under the flat disabled rule (src/index.css, DISABLED IS FLAT).
 */
export const btn = 'lv-button min-h-0 h-9 gap-1.5 px-3 text-[13px] shrink-0';
export const btnPrimary = `${btn} lv-button-primary enabled:bg-iris enabled:hover:bg-iris-deep enabled:text-snow`;
export const btnGhost = `${btn} lv-button-secondary`;
export const btnDanger = `${btn} lv-button-danger`;
/** A small round icon button, matched to the 36px button row: flat, dimpled while pressed. */
export const iconBtn =
  'inline-flex items-center justify-center w-9 h-9 rounded-full text-text-secondary hover:text-text-primary ' +
  'hover:bg-white/[0.06] active:bg-[var(--clay-well-bg)] active:shadow-press transition-colors shrink-0';

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
  need,
  needOption,
}: {
  ar: string;
  en: string;
  hint?: string;
  tip?: string;
  required?: boolean;
  error?: string | null;
  children: ReactNode;
  /**
   * The central required-field code this field fills (owner brief
   * 2026-10-10). When the SAVED product misses it (the server's verdict, read
   * through CompletenessProvider), the field is outlined in red and a red line
   * under it says so — announced to a screen reader through aria-describedby.
   */
  need?: CompletenessItemCode;
  /** The model the code is missing on ('' = the product itself). */
  needOption?: string;
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
  const missing = useMissing(need, need ? (needOption ?? '') : undefined);
  const missingId = useMissingId();
  return (
    <div
      className={`min-w-0 ${span ? 'md:col-span-2 xl:col-span-3' : ''} ${missing ? 'rounded-lg border border-red-400/60 p-1 -m-1' : ''}`}
      data-missing-field={missing ? need : undefined}
    >
      <div className="flex items-center gap-1.5 mb-1 min-w-0">
        <label htmlFor={id} className="text-[12px] font-bold text-text-secondary truncate">
          {ar} <span className="hidden xl:inline text-[11px] font-medium text-text-muted">{en}</span>
          {required && <span className="text-red-400 ms-1">*</span>}
        </label>
        {tip && (
          <span className="group relative shrink-0">
            <Info className="w-3.5 h-3.5 text-text-muted" aria-hidden="true" />
            <span className="sr-only">{tip}</span>
            <span
              role="tooltip"
              className="pointer-events-none absolute z-20 start-0 top-5 hidden group-hover:block group-focus-within:block
                         w-56 max-w-[70vw] rounded-lg bg-surface-raised border border-border-subtle p-2 text-[11px] leading-snug text-text-secondary shadow-lg"
            >
              {tip}
            </span>
          </span>
        )}
      </div>
      {React.isValidElement(children) && !htmlFor
        ? React.cloneElement(
            children as React.ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>,
            missing ? { id, 'aria-invalid': true, 'aria-describedby': missingId } : { id }
          )
        : children}
      {hint && !error && !missing && <p className="mt-1 text-[12px] text-text-muted truncate">{hint}</p>}
      {error && <p className="mt-1 text-[12px] text-red-400">{error}</p>}
      {need && <MissingNote id={missingId} code={need} optionId={needOption ?? ''} />}
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
      className="mt-1 flex items-start gap-1 text-[12px] leading-snug text-text-muted"
      data-mirror={kind}
    >
      <Link2 className="w-3 h-3 mt-[3px] shrink-0 text-text-muted" aria-hidden="true" />
      <span className="min-w-0">
        {lead}
        {detail ? <span className="text-text-muted">{` · ${detail}`}</span> : null}
      </span>
    </p>
  );
}

/** English text input — always LTR, per §1/§3. */
export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input dir="ltr" {...props} className={`lv-input ${fieldSize} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea dir="ltr" rows={4} {...props} className={`lv-input ${areaSize} ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative min-w-0">
      <select {...props} className={`lv-input ${fieldSize} appearance-none pe-9 ${props.className ?? ''}`} />
      <ChevronDown className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
    </div>
  );
}

/**
 * Whole dinars AS TYPED: Arabic-Indic and Extended digits are digits (owner
 * report 2026-10-10 — «١٥٠٠٠» in «تكاليف إضافية» was dropped key by key),
 * every separator is dropped.
 */
export const wholeDigits = (raw: string): string => toAsciiDigits(raw).replace(/[^\d]/g, '');

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
      className={`lv-input ${fieldSize}`}
      placeholder={placeholder ?? (required ? '0' : 'يرث / inherit')}
      value={text}
      onChange={(e) => {
        const raw = wholeDigits(e.target.value);
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
 * is not snapped to 7 under the finger of the admin, and the model receives only
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
        className={`lv-input ${fieldSize} pe-8`}
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
      <span aria-hidden="true" className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-[12px] text-text-muted">
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
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sub?: string;
  /** Shown and readable, not switchable (a setting another role owns). */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      // A row that holds a switch is flush clay (the rim alone, on the fill of its
      // parent): the switch is
      // the state, so the row does not tint or outline itself a second time.
      // `lv-hit`: the 40 px row still takes a 44 px tap (docs/ux/PRODUCT-DISCOUNT.md §6.7).
      className="lv-hit relative flex items-center justify-between gap-3 w-full min-w-0 h-10 px-2.5 rounded-md border border-border-subtle shadow-xs text-[13px] text-text-primary text-start transition-colors disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="min-w-0 truncate">
        {label}
        {sub && <span className="text-[12px] text-text-muted ms-1.5">{sub}</span>}
      </span>
      {/* The platform switch: a well track with a lifted knob when off, the
          violet admin track when on. */}
      <span
        className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${checked ? 'bg-iris' : 'lv-well'}`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full shadow-1 transition-all ${checked ? 'start-[18px] bg-snow' : 'start-0.5 bg-text-secondary'}`}
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
      // An option: flush clay at rest; checked is the press with the gold
      // start bar (lv-choice, aria-checked), and the box below keeps
      // its tick — no violet fill or outline on top.
      className={`lv-choice min-w-0 text-start p-2.5 ${disabled ? 'opacity-70 cursor-default' : ''}`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span
          className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
            checked ? 'bg-text-primary border-text-primary' : 'border-[var(--clay-field)]'
          }`}
        >
          {checked && (
            <svg viewBox="0 0 12 12" className="w-3 h-3 text-canvas" aria-hidden="true">
              <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span className="text-[13px] font-bold text-text-primary truncate">{title}</span>
      </span>
      {sub && <span className="block mt-0.5 text-[11px] text-text-muted truncate">{sub}</span>}
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
  missing,
  missingLabel,
  chip,
}: {
  n: number;
  ar: string;
  en: string;
  /** The one status chip of the section (the Pricing V2 «● محدّثة» …), beside the title — never a control. */
  chip?: ReactNode;
  summary?: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  error?: boolean;
  children: ReactNode;
  /** Required fields the saved product misses in this section (a red count on the header). */
  missing?: number;
  /** The count's words, in the viewer's language («2 ناقص»). */
  missingLabel?: string;
}) {
  return (
    <section
      // §1 numbers the sections 1..8 and the order is part of the spec, so the
      // ordinal is the stable handle for a test that needs one section in
      // particular. The accordion opens one heavy section at a time, so
      // "click every header" cannot reach a specific panel.
      data-section={n}
      // One clay card per section (resting, level 1); a section the saved
      // product leaves incomplete keeps its red edge on top of the clay.
      className={`lv-surface min-w-0 overflow-hidden mb-2.5 ${
        error || (missing ?? 0) > 0 ? 'border-red-500/50 bg-red-500/[0.03]' : ''
      }`}
    >
      <button
        type="button"
        data-section-toggle={n}
        aria-expanded={open}
        onClick={onToggle}
        className="w-full min-w-0 flex items-center gap-2 px-2.5 h-10 text-start hover:bg-white/[0.04] transition-colors"
      >
        <span
          className={`shrink-0 w-5 h-5 rounded-md grid place-items-center text-[10px] font-black ${
            open ? 'lv-well text-text-primary' : 'bg-surface-selected text-text-secondary'
          }`}
        >
          {n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-bold text-text-primary truncate">
            {ar}
            {/* The English secondary is dropped on a phone: at 360-390px it
                pushed the Arabic title into an ellipsis, and the number plus
                the Arabic title already identify the section. */}
            <span className="hidden sm:inline text-[10px] font-medium text-text-muted"> {en}</span>
          </span>
          {!open && summary && <span className="block text-[11px] text-text-muted truncate">{summary}</span>}
        </span>
        {chip ? <span className="min-w-0 max-w-[45%] shrink truncate" data-section-chip={n}>{chip}</span> : null}
        {(missing ?? 0) > 0 && (
          <span
            className="shrink-0 h-5 px-1.5 rounded-full border border-red-500/60 bg-red-500/15 text-[11px] font-bold text-red-200 grid place-items-center"
            data-section-missing={missing}
          >
            {missingLabel ?? missing}
          </span>
        )}
        {count !== undefined && count > 0 && (
          <span className="shrink-0 min-w-6 h-5 px-1.5 rounded-full bg-surface-selected text-[11px] font-bold text-text-secondary grid place-items-center">
            {count}
          </span>
        )}
        <ChevronDown
          className={`shrink-0 w-4 h-4 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && <div className="p-3 border-t border-border-subtle min-w-0">{children}</div>}
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
        <h4 className="text-[12px] font-bold text-text-secondary truncate">{title}</h4>
        <button type="button" onClick={onAdd} className={`${btnGhost} h-8 px-2.5 text-[12px]`}>
          + {addLabel}
        </button>
      </div>
      {React.Children.count(children) === 0 && empty ? (
        <p className="text-[12px] text-text-muted py-2">{empty}</p>
      ) : (
        <div className="space-y-2 min-w-0">{children}</div>
      )}
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'error' | 'warn' | 'ok'; children: ReactNode }) {
  // A note is information, so it is flat: the alert of the app (a 3px start
  // bar over a 10% tint), at the density of the form.
  const cls =
    kind === 'error'
      ? 'lv-alert-danger text-red-200'
      : kind === 'warn'
        ? 'lv-alert-warning text-amber-100'
        : 'lv-alert-success text-emerald-100';
  return (
    <div className={`lv-alert min-w-0 px-3 py-2 text-[12px] leading-snug mb-2.5 ${cls}`}>{children}</div>
  );
}

/** Compact image slot: thumbnail when set, an upload button when not. Used
 *  for option/colour images and the usage-guide step photos. */
export function ImgSlot({
  url,
  label,
  onChange,
  onUploaded,
}: {
  url: string;
  label: string;
  onChange: (url: string | null) => void;
  /** Canonical product-image callers keep the upload metadata with the URL. */
  onUploaded?: (asset: {
    url: string;
    key: string;
    width: number | null;
    height: number | null;
    bytes: number | null;
    content_type: string;
  }) => void;
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
      if (onUploaded) {
        onUploaded({
          url: res.url,
          key: res.key,
          width: res.width ?? null,
          height: res.height ?? null,
          bytes: res.bytes ?? null,
          content_type: res.mime ?? '',
        });
      } else {
        onChange(res.url);
      }
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
          <SafeImage sizes="40px"
            src={url}
            alt={label}
            aspect="auto"
            fit="cover"
            className="w-10 h-10 rounded-sm border border-border-subtle"
            bgClassName="bg-surface"
            fallbackIconClassName="w-3.5 h-3.5"
          />
          <button
            type="button"
            aria-label={`\u0625\u0632\u0627\u0644\u0629 ${label}`}
            onClick={() => onChange(null)}
            className="absolute -top-1.5 -end-1.5 w-4 h-4 rounded-full bg-surface-raised border border-border-subtle text-text-secondary hover:text-danger grid place-items-center"
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
          className={`w-10 h-10 shrink-0 rounded-sm border grid place-items-center transition-colors disabled:opacity-60 ${
            err
              ? 'border-red-500/50 text-red-400'
              : 'border-dashed border-[var(--clay-field)] text-text-muted hover:text-text-secondary'
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
