/**
 * «كم تستهلك الطابعة من كهرباء في العراق على 220 فولت … بالأمبيرية وكم تحتاج
 * من الـ UPS الأونلاين وما فرقه عن الأوفلاين» — THE MAINS QUESTION, ANSWERED
 * AS ARITHMETIC (worker/lib/powerAdvice.ts).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A PARAGRAPH ON A PAGE.
 *
 * Iraq runs 220–230 V at 50 Hz and the mains fail daily. A customer here is
 * not asking a curiosity question: a ten-hour print dies with the grid, and
 * the machine he is about to buy has to be matched to a UPS he can afford.
 * The answer is three multiplications and one division, and every surface that
 * wants it — the comparison, the product page, the support assistant — must
 * produce the SAME three multiplications. A second copy of them in a template
 * string is how one surface starts telling a customer 1.6 A and another 1.8 A.
 *
 * PURE, ON PURPOSE. No D1, no clock, no fetch, no locale state: numbers in,
 * numbers and trilingual sentences out. That is what makes
 * tests/powerAdvice.test.ts able to assert the arithmetic against values a
 * human worked out on paper, which is the only way a sizing table earns trust.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS MODULE EXISTS TO PREVENT — A ZERO PRETENDING TO BE A FACT.
 *
 * A printer whose wattage nobody typed in must read as UNKNOWN, never as 0 W.
 * Zero watts sizes a UPS at zero VA and hands a customer a confident "1 kVA is
 * plenty" derived from nothing. So every reading carries `known`, every
 * derived figure is `null` when its input is missing, and `advise()` returns
 * `known: false` with NO points at all rather than a sentence built out of
 * absences. The same rule compareSpecs.ts calls D1: a gap in our own data
 * entry is never dressed up as a statement about a machine.
 *
 * ---------------------------------------------------------------------------
 * AND THE SECOND DEFECT — A RUNTIME NOBODY CAN STAND BEHIND.
 *
 * How long a UPS holds depends on the battery's amp-hours, its AGE, how deeply
 * the inverter is willing to discharge it and how efficient that inverter is.
 * A product page knows none of the four. So runtime is emitted as a RANGE with
 * its assumptions attached to the returned object — not buried in a comment —
 * and the assumptions ship to the UI so the customer reads the arithmetic and
 * not an oracle. A customer who buys a UPS on a number we invented and then
 * loses a ten-hour print does not come back.
 *
 * EVERY NUMBER HERE IS TRACEABLE. It came from a field the owner typed, or
 * from one of the constants below, each of which appears in `assumptions`.
 */

import { readNumber, readRange } from './compareSpecs';

/** Labels are trilingual because the whole shop is (ar / en / ckb). Declared
 *  here rather than imported so this module stays standalone and pure. */
export interface Trilingual {
  ar: string;
  en: string;
  ckb: string;
}

// --------------------------------------------------------------- constants
//
// EVERY ONE OF THESE IS AN ASSUMPTION, AND EVERY ONE OF THEM IS EXPORTED so a
// test can assert the arithmetic against it and the UI can print it. A magic
// number inside a formula is a number nobody can argue with.

/**
 * THE VOLTAGE THE CURRENT IS COMPUTED AT, and the lower end of the Iraqi band
 * on purpose. The grid here sits between 220 V and 230 V; for the same wattage
 * the LOWER voltage yields the HIGHER current, so 220 V is the conservative
 * choice — a cable and a UPS sized from it are not undersized when the voltage
 * sags, which in Baghdad it does. Quoting 230 V would shave 4% off every amp
 * figure in the customer's favour and in nobody's interest.
 */
export const IRAQ_MAINS_VOLTS = 220;

/** Iraq is 50 Hz. A unit that accepts only 60 Hz is a real problem, which is
 *  why `supply.accepts_50hz` is reported rather than assumed. */
export const IRAQ_MAINS_HZ = 50;

/**
 * THE PRINTER'S INPUT POWER FACTOR, assumed when the field is empty.
 *
 * Watts are what the machine turns into heat and motion; volt-amps are what it
 * pulls off the wire. P = V × I × PF, so I = P / (V × PF). A switching supply
 * with active PFC sits at 0.95–0.99 and a cheap one without it at 0.6–0.7;
 * 0.9 is a middle that neither flatters a good supply nor lets a bad one look
 * efficient. It is an ASSUMPTION and it is labelled as one in `assumptions` —
 * a printer whose datasheet states its power factor overrides it through the
 * `power_factor` spec field.
 */
export const ASSUMED_INPUT_POWER_FACTOR = 0.9;

/**
 * THE UPS'S OUTPUT POWER FACTOR — THE ENTIRE POINT OF THIS FEATURE.
 *
 * «واحد كي في» DOES NOT MEAN 1000 watts. A UPS is sold in VA and delivers
 * watts equal to VA × its output power factor; the tower units actually on
 * sale in Baghdad are overwhelmingly rated 0.6 (a 1000 VA box printed
 * "600 W"). Sizing with 0.6 is therefore both the honest figure and the
 * conservative one: a customer who sizes at 1.0 buys a UPS that trips the
 * moment the bed and the hotend heat together.
 */
export const UPS_OUTPUT_POWER_FACTOR = 0.6;

/** The sizes a shop in Iraq can actually sell, and the ones the owner named:
 *  «واحد كي في اثنين كي في ثلاثة كي في». Rounding is always UP to one of
 *  these — a computed 1.2 kVA buys a 2 kVA box, never a 1 kVA one. */
export const STANDARD_UPS_KVA = [1, 2, 3] as const;
export type StandardKva = (typeof STANDARD_UPS_KVA)[number];

/**
 * THE SHARE OF A UPS'S WATT RATING WE ARE WILLING TO PUT A PRINTER ON.
 *
 * ROUNDING UP TO A STANDARD SIZE IS NOT HEADROOM. A 600 W printer divides out
 * at exactly 1000 VA, so the old rule «round up to 1, 2 or 3» landed it on a
 * 1 kVA box and then reported that box as `fits: true` — at 100% of its
 * continuous rating, with nothing left over. A tower UPS held at 100% alarms
 * and drops the load within seconds, and the moment it would be asked to do it
 * is precisely the moment this module says matters most: the bed and the
 * hotend heating together at the start of a print. The customer loses the
 * ten-hour print the header is written about, on a recommendation we gave him.
 *
 * So the load is checked against 80% of what the box delivers, not 100%. The
 * 20% covers the surge when the heaters strike together, the pack that has
 * aged out of its nameplate, and the fact that our own rated figure came off a
 * datasheet rather than off a clamp meter. It is applied in ONE place — the
 * `carries()` predicate below — so the size we RECOMMEND and the sizes we mark
 * `fits` can never disagree, and it is echoed into `assumptions` like every
 * other constant here so the customer reads the rule rather than the result.
 */
export const UPS_LOAD_HEADROOM = 0.8;

/**
 * THE BATTERY ENERGY A TOWER UPS OF THIS SIZE TYPICALLY SHIPS WITH, per kVA,
 * as a range. A 1 kVA line-interactive unit carries two or three 12 V 7–9 Ah
 * sealed cells, which is roughly 150–250 Wh; the bigger sizes scale with it.
 *
 * THIS IS THE WEAKEST LINK IN THE RUNTIME NUMBER and it is stated as such: a
 * model built for external battery banks holds for hours and shares nothing
 * with this figure, so the runtime is published as a range and the range is
 * published with this assumption beside it.
 */
export const UPS_BATTERY_WH_PER_KVA_MIN = 150;
export const UPS_BATTERY_WH_PER_KVA_MAX = 250;

/**
 * DEPTH OF DISCHARGE. A sealed lead-acid pack is not emptied to zero — the
 * inverter cuts out early to keep the cells alive, and an old pack cuts out
 * earlier still. 0.5 is the pessimistic end (a pack two or three years into
 * Baghdad summers), 0.8 the optimistic one (a new pack on a single deep
 * discharge). The spread between them is most of the width of the range, and
 * that width is the honest part of the answer.
 */
export const BATTERY_DEPTH_OF_DISCHARGE_MIN = 0.5;
export const BATTERY_DEPTH_OF_DISCHARGE_MAX = 0.8;

/** Inverter efficiency: DC out of the battery becomes AC at a loss, and the
 *  loss is real enough that leaving it out overstates every runtime by a
 *  sixth. 0.85 is typical for the units sold at these sizes. */
export const INVERTER_EFFICIENCY = 0.85;

/** Breaker sizes an Iraqi consumer unit is actually populated with. The
 *  suggestion rounds UP to one of these after the derating below. */
const STANDARD_BREAKERS_A = [6, 10, 16, 20, 25, 32, 40];

/** Continuous-load derating. A printer heats for hours, and a breaker sized at
 *  exactly the running current nuisance-trips; 1.25 is the usual allowance.
 *  This is a STARTING POINT for an electrician, not an installation design. */
export const BREAKER_DERATING = 1.25;

// ------------------------------------------------------------- field ids
//
// The spec ids this module reads. They are declared in
// worker/lib/templateFamilies.ts — that file is the ONE definition of what a
// spec is — and repeated here only as the bridge from a stored sheet to this
// arithmetic. tests/powerAdvice.test.ts asserts every id below is still
// declared by the printer template, so a field renamed there fails a test
// instead of silently turning every printer's power advice into "unknown".

export const POWER_FIELD_IDS = {
  rated: 'rated_power',
  printing: 'typical_print_power',
  bed: 'heated_bed_power',
  standby: 'standby_power',
  voltage: 'input_voltage',
  frequency: 'input_frequency',
  powerFactor: 'power_factor',
  /** The pre-existing free-text «الطاقة» column. Read only as a FALLBACK for
   *  the rated wattage: hundreds of products already carry a value in it and
   *  refusing to read them would ship a feature that works on nothing. */
  legacyPower: 'power',
} as const;

// ------------------------------------------------------------------ shapes

/** One wattage, and what it is in amps on the Iraqi mains. `known: false`
 *  means the owner has not entered it — never that the printer draws zero. */
export interface PowerReading {
  known: boolean;
  watts: number | null;
  amps: number | null;
  label: Trilingual;
}

/** An assumption, in the RETURNED OBJECT rather than only in a comment, so a
 *  surface can print the arithmetic beside the answer. */
export interface Assumption {
  id: string;
  /** The value as the reader should see it — "220 V", "0.6", "50–80%". */
  value: string;
  text: Trilingual;
}

/** What one standard UPS size does for THIS printer. */
export interface UpsRuntime {
  kva: StandardKva;
  /** false when this size cannot carry the load at all — then the minutes are
   *  null rather than a number the customer would read as a promise. */
  fits: boolean;
  minutes_min: number | null;
  minutes_max: number | null;
}

export interface UpsSizing {
  known: boolean;
  /** The volt-amps the printer needs — watts ÷ the UPS output power factor. */
  va: number | null;
  /** The same figure in kVA, unrounded, so nothing is hidden by the rounding. */
  kva: number | null;
  /** Rounded UP to 1, 2 or 3 kVA. null when unknown or off the top of the scale. */
  recommended_kva: StandardKva | null;
  /** true when even 3 kVA cannot carry it: an honest "ask us" rather than a 3. */
  above_range: boolean;
  runtimes: UpsRuntime[];
}

/** One ordered point of the answer. Points, not a table: «لا يتم وضعها بشكل
 *  جداول وهوسه وخربطه». */
export interface PowerPoint {
  id: string;
  text: Trilingual;
}

export interface PowerAdvice {
  /** false when no wattage at all was entered. The caller renders nothing. */
  known: boolean;
  mains: { volts: number; hz: number };
  supply: {
    /** Does the unit accept the Iraqi 220–230 V band? 'unknown' when unstated. */
    accepts_iraq_mains: 'yes' | 'no' | 'unknown';
    accepts_50hz: 'yes' | 'no' | 'unknown';
    voltage_text: string;
    frequency_text: string;
  };
  draw: {
    rated: PowerReading;
    printing: PowerReading;
    bed: PowerReading;
    standby: PowerReading;
  };
  /** Which reading the UPS was sized on, and which the runtime was taken at. */
  sizing_basis: 'rated' | 'printing' | null;
  runtime_basis: 'rated' | 'printing' | null;
  circuit: { amps: number | null; suggested_breaker_a: number | null };
  ups: UpsSizing;
  topology: { recommended: 'online'; points: PowerPoint[] };
  assumptions: Assumption[];
  /** The whole answer as ordered sentences, ready to render. */
  points: PowerPoint[];
}

/** What `advise` needs. Every field optional: the honest state of a product
 *  nobody has finished entering. */
export interface PowerInput {
  rated_w?: number | null;
  printing_w?: number | null;
  bed_w?: number | null;
  standby_w?: number | null;
  /** The unit's own power factor when its datasheet states one. */
  power_factor?: number | null;
  /** The raw `input_voltage` / `input_frequency` strings, as typed. */
  voltage_text?: string;
  frequency_text?: string;
}

// ------------------------------------------------------------------ helpers

/** A positive, finite wattage or null. A 0 or a negative in the sheet is a
 *  typo, not a measurement, and reading it as a fact is the defect this
 *  module's header names. */
function positive(n: unknown): number | null {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * THE WATTAGES A 3D PRINTER CAN ACTUALLY HAVE, as a fence rather than as a
 * hope. Nothing in this shop draws 0.35 W and nothing draws 20 kW; a figure
 * outside the fence is a unit that was mis-read or a digit that slipped, and
 * the module's own rule is that unknown is said out loud rather than sized on.
 *
 * The standby floor is separate and much lower on purpose: a machine asleep
 * really can sit at 2 W, and holding it to the 5 W the heaters are held to
 * would throw away a true reading.
 */
export const PLAUSIBLE_WATTS_MIN = 5;
export const PLAUSIBLE_STANDBY_WATTS_MIN = 0.5;
export const PLAUSIBLE_WATTS_MAX = 5000;

/** A kilowatt spelling, which is ordinary on a datasheet: "0.35kW", "1.2 kW".
 *
 *  THE SI PREFIX MUST NOT BE THROWN AWAY. `readNumber(raw, 'W')` hands the
 *  string to compareSpecs' `stripUnit`, and 'kw' is one of its recognised unit
 *  tokens — so "0.35kW" comes back as the number 0.35 with the "k" silently
 *  gone. That is a 350 W printer reported as drawing 0.35 W, 0 A, needing a
 *  1 VA UPS, and holding a print for 7 to 20 DAYS. It is reachable on every
 *  product carrying the legacy free-text `power` column, which is hundreds of
 *  them, so the prefix is read here before the unit stripper ever sees it. */
const KILOWATT = /^(.*[0-9])\s*k\s*w\b\.?$/i;

/**
 * One wattage out of whatever an admin typed, with the prefix honoured and the
 * fence applied — or null, which everywhere downstream means UNKNOWN.
 */
function wattsFrom(text: string, floor: number): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const kilo = KILOWATT.exec(trimmed);
  const read = kilo ? readNumber(kilo[1]) : readNumber(trimmed, 'W');
  const watts = read === null ? null : kilo ? read * 1000 : read;
  const value = positive(watts);
  if (value === null) return null;
  return value >= floor && value <= PLAUSIBLE_WATTS_MAX ? value : null;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Digits stay ASCII: the storefront prints ASCII digits in every language,
 *  and a locale-formatted number here would disagree with the spec table
 *  rendered two rows above it. */
const num = (n: number): string => String(n);

const READING_LABELS: Record<'rated' | 'printing' | 'bed' | 'standby', Trilingual> = {
  rated: { ar: 'القدرة القصوى', en: 'Rated power', ckb: 'وزەی ناوزەد' },
  printing: { ar: 'القدرة أثناء الطباعة', en: 'Typical printing power', ckb: 'وزە لە کاتی چاپدا' },
  bed: { ar: 'قدرة السرير الساخن', en: 'Heated bed power', ckb: 'وزەی بێدی گەرم' },
  standby: { ar: 'قدرة وضع الانتظار', en: 'Standby power', ckb: 'وزە لە دۆخی چاوەڕوانیدا' },
};

/**
 * WATTS TO AMPS, the real relationship and not W ÷ V.
 *
 *   P (W) = V × I × PF   ⟹   I = P / (V × PF)
 *
 * Dropping the power factor would understate the current by however far the
 * supply is from unity — 11% at PF 0.9, 40% at PF 0.7 — and the current is the
 * figure a customer sizes a cable and a breaker from. The PF used is always
 * reported in `assumptions`.
 */
export function ampsFromWatts(watts: number, powerFactor: number, volts = IRAQ_MAINS_VOLTS): number {
  return round(watts / (volts * powerFactor), 2);
}

/**
 * WATTS TO VOLT-AMPS AT THE UPS.
 *
 * The UPS is rated in VA and delivers VA × its own output power factor in
 * watts, so the VA a load needs is watts ÷ that factor. This is the step every
 * "1 kVA will do" mistake skips.
 */
export function vaFromWatts(watts: number, upsPowerFactor = UPS_OUTPUT_POWER_FACTOR): number {
  return Math.ceil(watts / upsPowerFactor);
}

/** Up to the next size the shop can sell, never down. null when even the
 *  largest standard size cannot carry it.
 *
 *  THIS IS ARITHMETIC ONLY — it rounds a kVA figure and knows nothing about
 *  headroom. The recommendation the customer is shown goes through
 *  `carries()`/`recommendKva()` below, which de-rate; this stays as it is so a
 *  caller that genuinely wants "which size is this number in" still has it. */
export function roundUpToStandardKva(kva: number): StandardKva | null {
  for (const size of STANDARD_UPS_KVA) if (kva <= size + 1e-9) return size;
  return null;
}

/**
 * Can a UPS of this size actually carry this load, with the headroom above?
 *
 * Watts a box delivers = VA x its output power factor; we will put the printer
 * on 80% of that and no more. ONE predicate for both questions — "which size
 * do we recommend" and "does this size fit" — because a version of this rule
 * written twice is a version that answers the two differently, and the shape
 * of that defect is a recommendation the runtime table marks as not fitting.
 */
export function carries(sizeKva: StandardKva, watts: number): boolean {
  return watts <= sizeKva * 1000 * UPS_OUTPUT_POWER_FACTOR * UPS_LOAD_HEADROOM;
}

/** The smallest size the shop sells that carries this load with headroom, or
 *  null when none of them does — «راجعنا حتى نحسبها على حالتك», never a 3. */
export function recommendKva(watts: number): StandardKva | null {
  for (const size of STANDARD_UPS_KVA) if (carries(size, watts)) return size;
  return null;
}

function suggestedBreaker(amps: number): number | null {
  const needed = amps * BREAKER_DERATING;
  for (const size of STANDARD_BREAKERS_A) if (needed <= size) return size;
  return null;
}

/** Every number a free-text spec value contains, ASCII-folded by the shared
 *  reader so «٥٠/٦٠ Hz» reads the same as "50/60 Hz". */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const piece of text.split(/[^0-9٠-٩۰-۹.,]+/)) {
    const n = readNumber(piece);
    if (n !== null && n > 0) out.push(n);
  }
  return out;
}

/**
 * Does the declared input range overlap the Iraqi band (220–230 V)?
 *
 * Overlap rather than "contains 220": a unit sold as «230 V» is perfectly
 * usable here and a test for 220 exactly would reject it, while a «110 V»
 * unit fails both tests as it should.
 */
function acceptsIraqMains(text: string): 'yes' | 'no' | 'unknown' {
  const trimmed = text.trim();
  if (trimmed === '') return 'unknown';
  const range = readRange(trimmed, 'V');
  if (range) return range.min <= 230 && range.max >= 220 ? 'yes' : 'no';
  const nums = numbersIn(trimmed);
  if (nums.length === 0) return 'unknown';
  return nums.some((n) => n >= 200 && n <= 245) ? 'yes' : 'no';
}

function accepts50Hz(text: string): 'yes' | 'no' | 'unknown' {
  const trimmed = text.trim();
  if (trimmed === '') return 'unknown';
  const nums = numbersIn(trimmed);
  if (nums.length === 0) return 'unknown';
  if (nums.some((n) => Math.abs(n - IRAQ_MAINS_HZ) < 1e-9)) return 'yes';
  // "50-60" written as a range still covers 50.
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min <= IRAQ_MAINS_HZ && max >= IRAQ_MAINS_HZ ? 'yes' : 'no';
}

// ------------------------------------------------- reading a stored sheet

/**
 * The bridge from `spec_fields` — whatever an admin actually typed — to the
 * numbers this module multiplies. Kept here, beside the arithmetic, so no
 * route grows its own idea of which column the wattage lives in.
 *
 * `power` is read ONLY as a fallback for the rated wattage, and only when the
 * dedicated numeric column is empty: it is the legacy free-text «الطاقة» box
 * and it holds everything from "350" to "AC 100-240V 350W". `readNumber`
 * refuses the ambiguous shapes rather than guessing, which is exactly what
 * should happen — an unreadable value becomes "unknown", not a sizing.
 */
export function powerInputFromSpecs(specs: Record<string, unknown> | null | undefined): PowerInput {
  const raw = (id: string): string => {
    const v = specs ? specs[id] : undefined;
    if (v === null || v === undefined || typeof v === 'object') return '';
    return String(v).trim();
  };
  const watt = (id: string, floor = PLAUSIBLE_WATTS_MIN): number | null => wattsFrom(raw(id), floor);
  return {
    rated_w: watt(POWER_FIELD_IDS.rated) ?? watt(POWER_FIELD_IDS.legacyPower),
    printing_w: watt(POWER_FIELD_IDS.printing),
    bed_w: watt(POWER_FIELD_IDS.bed),
    standby_w: watt(POWER_FIELD_IDS.standby, PLAUSIBLE_STANDBY_WATTS_MIN),
    power_factor: positive(readNumber(raw(POWER_FIELD_IDS.powerFactor))),
    voltage_text: raw(POWER_FIELD_IDS.voltage),
    frequency_text: raw(POWER_FIELD_IDS.frequency),
  };
}

// ------------------------------------------------------------------ public

const UNKNOWN_READING = (label: Trilingual): PowerReading => ({
  known: false,
  watts: null,
  amps: null,
  label,
});

/**
 * THE WHOLE ANSWER. Pure: same input, same output, no clock and no database.
 *
 * Returns `known: false` and empty points when there is no wattage to work
 * from — see the header. The caller renders nothing rather than a paragraph of
 * «غير مذكور», because a power section made of absences reads as a statement
 * about the machine and it is a statement about our data entry.
 */
export function advise(input: PowerInput): PowerAdvice {
  const rated = positive(input.rated_w);
  const printing = positive(input.printing_w);
  const bed = positive(input.bed_w);
  const standby = positive(input.standby_w);

  /**
   * A power factor out of range is a typo, not a measurement: PF is a ratio
   * between 0 and 1, and a sheet reading "90" means 90%, which is a value this
   * module refuses to infer. Anything outside (0, 1] falls back to the stated
   * assumption rather than producing a current that is an order of magnitude
   * wrong.
   */
  const declaredPf = positive(input.power_factor);
  const pfIsUsable = declaredPf !== null && declaredPf <= 1;
  const pf = pfIsUsable ? (declaredPf as number) : ASSUMED_INPUT_POWER_FACTOR;
  /**
   * ASSUMED MEANS ASSUMED, INCLUDING WHEN WE REFUSED WHAT WAS TYPED.
   *
   * The previous spelling — `pf === ASSUMED && declaredPf === null` — read a
   * REFUSED value as a stated one: a sheet holding "90" left `declaredPf` at
   * 90, so the fallback to 0.9 happened but the sentence beside it still said
   * «كما ذكرته الشركة» / "as stated by the manufacturer". The shop would then
   * attribute to the manufacturer a number it had invented, on the figure a
   * customer sizes a cable and a breaker from. Anything we did not take from
   * the sheet is ours, and is labelled ours.
   */
  const pfIsAssumed = !pfIsUsable;
  /** Kept so the assumption can NAME the value it threw away: a refused entry
   *  is a data-entry error somebody should fix, not a silent default. */
  const pfRefused = declaredPf !== null && !pfIsUsable ? declaredPf : null;

  const reading = (watts: number | null, key: keyof typeof READING_LABELS): PowerReading =>
    watts === null
      ? UNKNOWN_READING(READING_LABELS[key])
      : {
          known: true,
          watts,
          amps: ampsFromWatts(watts, pf),
          label: READING_LABELS[key],
        };

  const draw = {
    rated: reading(rated, 'rated'),
    printing: reading(printing, 'printing'),
    bed: reading(bed, 'bed'),
    standby: reading(standby, 'standby'),
  };

  // SIZE ON THE PEAK, TIME ON THE AVERAGE, and say which is which.
  //
  // A UPS has to survive the worst moment — the bed and the hotend heating
  // together at the start of a print — so the SIZING uses the nameplate
  // rating. Runtime is a different question: the machine spends the next ten
  // hours at its printing average, and sizing the runtime on the nameplate
  // would understate it by half. Each falls back to the other when its own
  // figure was never entered, and `sizing_basis` / `runtime_basis` say so.
  const sizingWatts = rated ?? printing;
  const sizing_basis: PowerAdvice['sizing_basis'] = rated !== null ? 'rated' : printing !== null ? 'printing' : null;
  const runtimeWatts = printing ?? rated;
  const runtime_basis: PowerAdvice['runtime_basis'] = printing !== null ? 'printing' : rated !== null ? 'rated' : null;

  const va = sizingWatts === null ? null : vaFromWatts(sizingWatts);
  const kva = va === null ? null : round(va / 1000, 3);
  // The RECOMMENDATION goes through `carries()`, not through a bare round-up:
  // landing exactly on a standard size is not headroom (see UPS_LOAD_HEADROOM).
  const recommended = sizingWatts === null ? null : recommendKva(sizingWatts);

  const runtimes: UpsRuntime[] = STANDARD_UPS_KVA.map((size) => {
    // Can this box carry the load at all? Watts it can deliver = VA × its
    // output power factor. A 1 kVA unit at 0.6 delivers 600 W, so a 900 W
    // machine on it is not "a short runtime", it is a UPS that refuses.
    // ONE predicate, shared with the recommendation above, so the size we tell
    // the customer to buy can never be a size this table marks as not fitting.
    const fits = sizingWatts !== null && carries(size, sizingWatts);
    if (!fits || runtimeWatts === null) return { kva: size, fits, minutes_min: null, minutes_max: null };
    const whMin = size * UPS_BATTERY_WH_PER_KVA_MIN * BATTERY_DEPTH_OF_DISCHARGE_MIN * INVERTER_EFFICIENCY;
    const whMax = size * UPS_BATTERY_WH_PER_KVA_MAX * BATTERY_DEPTH_OF_DISCHARGE_MAX * INVERTER_EFFICIENCY;
    return {
      kva: size,
      fits: true,
      minutes_min: Math.floor((whMin / runtimeWatts) * 60),
      minutes_max: Math.ceil((whMax / runtimeWatts) * 60),
    };
  });

  const supply = {
    accepts_iraq_mains: acceptsIraqMains(input.voltage_text ?? ''),
    accepts_50hz: accepts50Hz(input.frequency_text ?? ''),
    voltage_text: (input.voltage_text ?? '').trim(),
    frequency_text: (input.frequency_text ?? '').trim(),
  };

  const known = sizingWatts !== null;

  const assumptions: Assumption[] = [];
  if (known) {
    assumptions.push({
      id: 'mains_voltage',
      value: `${IRAQ_MAINS_VOLTS} V / ${IRAQ_MAINS_HZ} Hz`,
      text: {
        ar: `الحساب على كهرباء العراق 220 فولت و50 هرتز. الشبكة عندنا بين 220 و230 فولت، وأخذنا الأقل لأن الأمبير يطلع أعلى عليه — يعني الحساب في صالح الأمان.`,
        en: `Computed at the Iraqi mains: 220 V, 50 Hz. The grid here sits between 220 V and 230 V and the lower figure is used because it yields the higher current, so the sizing errs on the safe side.`,
        ckb: `ژمێردراوە لەسەر کارەبای عێراق: 220 ڤۆڵت و 50 هێرتز. تۆڕەکە لە نێوان 220 و 230 ڤۆڵتدایە و کەمترین ژمارە بەکارهێنراوە چونکە ئەمپێری زیاتر دەداتەوە، واتە ژمێرەکە لە بەرژەوەندی سەلامەتیدایە.`,
      },
    });
    assumptions.push({
      id: 'input_power_factor',
      value: String(pf),
      text: pfIsAssumed
        ? {
            ar: `معامل قدرة الطابعة مفترض ${pf} لأن الشركة ما ذكرته. الأمبير = واط ÷ (فولت × معامل القدرة)، فإذا كان معامل القدرة الحقيقي أقل يصير الأمبير أعلى.`,
            en: `The printer's power factor is ASSUMED to be ${pf} because the manufacturer does not state it. Amps = watts ÷ (volts × power factor), so a lower real power factor means more amps.`,
            ckb: `فاکتەری وزەی پرینتەرەکە بە ${pf} دانراوە چونکە کۆمپانیاکە باسی نەکردووە. ئەمپێر = وات ÷ (ڤۆڵت × فاکتەری وزە)، کەواتە فاکتەری کەمتر ئەمپێری زیاتر دەداتەوە.`,
          }
        : {
            ar: `معامل قدرة الطابعة ${pf} كما ذكرته الشركة. الأمبير = واط ÷ (فولت × معامل القدرة).`,
            en: `The printer's power factor is ${pf} as stated by the manufacturer. Amps = watts ÷ (volts × power factor).`,
            ckb: `فاکتەری وزەی پرینتەرەکە ${pf}ە وەک کۆمپانیاکە ناوی هێناوە. ئەمپێر = وات ÷ (ڤۆڵت × فاکتەری وزە).`,
          },
    });
    assumptions.push({
      id: 'ups_output_power_factor',
      value: String(UPS_OUTPUT_POWER_FACTOR),
      text: {
        ar: `الـ UPS يُباع بالـ VA مو بالواط: جهاز 1 kVA يعطي عملياً حوالي ${num(UPS_OUTPUT_POWER_FACTOR * 1000)} واط فقط (معامل خرج ${UPS_OUTPUT_POWER_FACTOR}). لذلك الـ VA المطلوب = الواط ÷ ${UPS_OUTPUT_POWER_FACTOR}.`,
        en: `A UPS is sold in VA, not watts: a 1 kVA unit really delivers about ${num(UPS_OUTPUT_POWER_FACTOR * 1000)} W (output power factor ${UPS_OUTPUT_POWER_FACTOR}). So the VA needed = watts ÷ ${UPS_OUTPUT_POWER_FACTOR}.`,
        ckb: `UPS بە VA دەفرۆشرێت نەک بە وات: ئامێرێکی 1 kVA بە کردەوە نزیکەی ${num(UPS_OUTPUT_POWER_FACTOR * 1000)} وات دەدات (فاکتەری دەرچوون ${UPS_OUTPUT_POWER_FACTOR}). کەواتە VAی پێویست = وات ÷ ${UPS_OUTPUT_POWER_FACTOR}.`,
      },
    });
    assumptions.push({
      id: 'battery_pack',
      value: `${UPS_BATTERY_WH_PER_KVA_MIN}–${UPS_BATTERY_WH_PER_KVA_MAX} Wh/kVA`,
      text: {
        ar: `مدة التشغيل محسوبة على بطارية داخلية تقريبية ${UPS_BATTERY_WH_PER_KVA_MIN}–${UPS_BATTERY_WH_PER_KVA_MAX} واط‑ساعة لكل 1 kVA. جهاز ببطاريات خارجية يطلع أطول بكثير، وهذا غير معروف من ورقة المواصفات.`,
        en: `Runtime assumes the internal battery of a tower unit, roughly ${UPS_BATTERY_WH_PER_KVA_MIN}–${UPS_BATTERY_WH_PER_KVA_MAX} Wh per 1 kVA. A model built for external battery banks lasts far longer, and a product sheet cannot know which you buy.`,
        ckb: `ماوەی کارکردن لەسەر باتریی ناوەوەی ئامێرێکی ستوونی ژمێردراوە، نزیکەی ${UPS_BATTERY_WH_PER_KVA_MIN}–${UPS_BATTERY_WH_PER_KVA_MAX} وات‑کاتژمێر بۆ هەر 1 kVA. مۆدێلی باتری دەرەکی زۆر درێژتر دەخایەنێت.`,
      },
    });
    assumptions.push({
      id: 'battery_condition',
      value: `${num(BATTERY_DEPTH_OF_DISCHARGE_MIN * 100)}–${num(BATTERY_DEPTH_OF_DISCHARGE_MAX * 100)}% · ${num(INVERTER_EFFICIENCY * 100)}%`,
      text: {
        ar: `الطرف الأوطأ لمدة التشغيل يفترض بطارية مستعملة تُفرَّغ ${num(BATTERY_DEPTH_OF_DISCHARGE_MIN * 100)}% فقط، والأعلى بطارية جديدة تُفرَّغ ${num(BATTERY_DEPTH_OF_DISCHARGE_MAX * 100)}%، وكفاءة الإنفرتر ${num(INVERTER_EFFICIENCY * 100)}%. عمر البطارية هو أكبر سبب للفرق.`,
        en: `The low end of the runtime assumes an aged pack discharged only ${num(BATTERY_DEPTH_OF_DISCHARGE_MIN * 100)}%, the high end a new pack discharged ${num(BATTERY_DEPTH_OF_DISCHARGE_MAX * 100)}%, with ${num(INVERTER_EFFICIENCY * 100)}% inverter efficiency. Battery age is the single biggest reason the two ends differ.`,
        ckb: `کەمترین ماوە باتریێکی کۆن دادەنێت کە تەنها ${num(BATTERY_DEPTH_OF_DISCHARGE_MIN * 100)}% بەتاڵ دەبێت، زۆرترینیش باتریێکی نوێ بە ${num(BATTERY_DEPTH_OF_DISCHARGE_MAX * 100)}%، لەگەڵ کارایی ئینڤێرتەر ${num(INVERTER_EFFICIENCY * 100)}%. تەمەنی باتری گەورەترین هۆکاری جیاوازییە.`,
      },
    });
    /** A refused power factor is named rather than swallowed. PF is a ratio in
     *  (0, 1]; a sheet holding "90" means 90% and this module will not infer
     *  that, because reading it literally gives 0.018 A — wrong by two orders
     *  of magnitude on the figure a cable is sized from. Saying which value
     *  was dropped is how it gets corrected instead of retyped identically. */
    if (pfRefused !== null) {
      assumptions.push({
        id: 'input_power_factor_refused',
        value: String(pfRefused),
        text: {
          ar: `المسجّل بورقة المواصفات معامل قدرة ${num(pfRefused)} وهذا مستحيل — معامل القدرة نسبة بين 0 و1، ويبدو أن المقصود ${num(pfRefused)}%. ما اعتمدناه، واشتغلنا على ${pf} المفترض.`,
          en: `The sheet records a power factor of ${num(pfRefused)}, which cannot be right — power factor is a ratio between 0 and 1, so ${num(pfRefused)}% was probably meant. It was not used; the assumed ${pf} was used instead.`,
          ckb: `لە پەڕەی تایبەتمەندیدا فاکتەری وزە ${num(pfRefused)} تۆمارکراوە، کە ناکرێت ڕاست بێت — فاکتەری وزە ڕێژەیەکە لە نێوان 0 و 1، وا دیارە ${num(pfRefused)}% مەبەست بووە. بەکارنەهێنرا، لەبری ئەو ${pf}ی دانراو بەکارهێنرا.`,
        },
      });
    }
    assumptions.push({
      id: 'ups_load_headroom',
      value: `${num(UPS_LOAD_HEADROOM * 100)}%`,
      text: {
        ar: `المقاس المقترح ما يحمّل الـ UPS أكثر من ${num(UPS_LOAD_HEADROOM * 100)}% من طاقته. جهاز واكف على 100% من حمله يطلق الإنذار ويفصل الحمل خلال ثوانٍ، وبالضبط بلحظة ما يسخّن السرير والرأس سوية ببداية الطبعة.`,
        en: `The recommended size never loads the UPS past ${num(UPS_LOAD_HEADROOM * 100)}% of its watt rating. A unit sitting at 100% of its load alarms and drops the load within seconds — and the moment it would be asked to is exactly the start of a print, when the bed and the hotend heat together.`,
        ckb: `قەبارەی پێشنیارکراو UPS لە ${num(UPS_LOAD_HEADROOM * 100)}%ی وزەکەی زیاتر بار ناکات. ئامێرێک لەسەر 100%ی بارەکەی بێت ئاگادارکەرەوە لێدەدات و بارەکە بەردەدات لە چەند چرکەیەکدا — ئەویش لە سەرەتای چاپدا کە بێد و هۆت ئێند پێکەوە گەرم دەبن.`,
      },
    });
    if (sizing_basis === 'printing') {
      assumptions.push({
        id: 'sizing_fallback',
        value: 'printing',
        text: {
          ar: 'القدرة القصوى للجهاز غير مسجلة، فحُسب حجم الـ UPS على قدرة الطباعة. عند بداية الطبعة يسخّن السرير والرأس سوية والسحب يطلع أعلى من هذا.',
          en: 'The nameplate rating is not recorded, so the UPS was sized on the printing power instead. At the start of a print the bed and the hotend heat together and the real draw is higher than this.',
          ckb: 'وزەی ناوزەدی ئامێرەکە تۆمار نەکراوە، بۆیە قەبارەی UPS لەسەر وزەی چاپکردن ژمێردراوە. لە سەرەتای چاپدا بێد و هۆت ئێند پێکەوە گەرم دەبن و ڕاکێشانی ڕاستەقینە زیاترە.',
        },
      });
    }
  }

  const topologyPoints: PowerPoint[] = [
    {
      id: 'ups_online',
      text: {
        ar: 'الأونلاين (تحويل مزدوج) يشغّل الطابعة من البطارية طول الوقت والكهرباء تشحن البطارية فقط، فلحظة القطع ما بيها أي فجوة ولا أي هبوط.',
        en: 'An online (double-conversion) UPS runs the printer from the battery all the time and the mains only charges it, so at the moment of a cut there is no transfer gap at all.',
        ckb: 'UPSی ئۆنلاین (گۆڕینی دووجارە) هەموو کاتێک پرینتەرەکە لە باتریەوە کار دەخات و کارەبا تەنها باتری بارگاوی دەکات، بۆیە لە کاتی بڕاندا هیچ کەلێنێکی گواستنەوە نییە.',
      },
    },
    {
      id: 'ups_offline',
      text: {
        ar: 'الأوفلاين (ستاندباي) يمرّر كهرباء الشبكة كما هي وما ينقل الحمل للبطارية إلا بعد ما تنقطع.',
        en: 'An offline (standby) UPS passes the mains through as it is and only switches to the battery once the mains actually fails.',
        ckb: 'UPSی ئۆفلاین (ستاندبای) کارەبای تۆڕ وەک خۆی تێدەپەڕێنێت و تەنها دوای بڕانی ڕاستەقینە دەگوازێتەوە بۆ باتری.',
      },
    },
    {
      id: 'ups_line_interactive',
      text: {
        // THESE TWO ARE NOT THE SAME BOX, and the difference is the one an
        // Iraqi customer is paying the premium for. A line-interactive unit
        // has an AVR autotransformer that bucks and boosts the sag and the
        // surge WITHOUT going to battery — which is most of what our grid does
        // all day. Calling it "straight through", as this point used to, told
        // the customer the two are equivalent on the single axis where they
        // differ most, one sentence before a buying recommendation.
        ar: 'اللاين‑إنتراكتف أحسن من الأوفلاين: بيه منظّم جهد (AVR) يرفع الهبوط وينزّل الارتفاع بدون ما ينزل على البطارية، وهذا نصف مشكلة كهربتنا. بس ساعة القطع الفعلي يبقى مثل الأوفلاين — ينقل الحمل بعد 4–10 مللي ثانية، وهذه الفجوة كافية تعيد تشغيل لوحة الطابعة وتضيّع طبعة عشر ساعات.',
        en: 'Line-interactive is a step up from offline: it has an AVR that bucks and boosts the sag and the surge without going to battery at all, which is most of what our grid does. But on an actual cut it behaves like the offline unit — it transfers the load 4–10 ms later, and that gap is long enough to reset a printer’s board and lose a ten-hour print.',
        ckb: 'لاین‑ئینتەراکتیڤ باشترە لە ئۆفلاین: AVRی هەیە کە نزمبوونەوە و بەرزبوونەوەی ڤۆڵتاژ ڕاست دەکاتەوە بێ ئەوەی بچێتە سەر باتری، کە زۆربەی کێشەی تۆڕەکەمانە. بەڵام لە کاتی بڕانی ڕاستەقینەدا وەک ئۆفلاین وایە — دوای 4–10 میلی چرکە بارەکە دەگوازێتەوە، و ئەو کەلێنە بەسە بۆ ڕیسێتکردنی بۆردی پرینتەر و لەدەستدانی چاپێکی دە کاتژمێری.',
      },
    },
    {
      id: 'ups_recommendation',
      text: {
        ar: 'لذلك توصية ليفونس للطابعة ثلاثية الأبعاد: UPS أونلاين. الأوفلاين ينفع للراوتر والكومبيوتر، أما الطبعة الطويلة فما تتحمل فجوة التحويل ولا تذبذب كهرباء العراق.',
        en: 'So LEVONIS recommends an ONLINE UPS for a 3D printer. Line-interactive is fine for a router or a PC, but a long print tolerates neither the transfer gap nor the swings of the Iraqi grid.',
        ckb: 'بۆیە لێڤۆنیس بۆ پرینتەری سێ ڕەهەندی UPSی ئۆنلاین پێشنیار دەکات. لاین‑ئینتەراکتیڤ بۆ ڕاوتەر و کۆمپیوتەر باشە، بەڵام چاپی درێژ نە کەلێنی گواستنەوە نە شڵەژانی کارەبای عێراق هەڵناگرێت.',
      },
    },
  ];

  const sizingAmps = sizing_basis === 'printing' ? draw.printing.amps : draw.rated.amps;
  const breakerA = sizingAmps === null ? null : suggestedBreaker(sizingAmps);

  const points: PowerPoint[] = [];
  if (known) {
    const basis = runtime_basis === 'printing' ? draw.printing : draw.rated;
    if (basis.known && basis.watts !== null && basis.amps !== null) {
      const when = runtime_basis === 'printing'
        ? { ar: 'أثناء الطباعة', en: 'while printing', ckb: 'لە کاتی چاپدا' }
        : { ar: 'على القدرة القصوى', en: 'at its rated power', ckb: 'لەسەر وزەی ناوزەد' };
      points.push({
        id: 'draw',
        text: {
          ar: `تسحب ${num(basis.watts)} واط ${when.ar}، يعني حوالي ${num(basis.amps)} أمبير على كهرباء ${IRAQ_MAINS_VOLTS} فولت.`,
          en: `It draws ${num(basis.watts)} W ${when.en}, which is about ${num(basis.amps)} A on ${IRAQ_MAINS_VOLTS} V mains.`,
          ckb: `${num(basis.watts)} وات ڕادەکێشێت ${when.ckb}، واتە نزیکەی ${num(basis.amps)} ئەمپێر لەسەر کارەبای ${IRAQ_MAINS_VOLTS} ڤۆڵت.`,
        },
      });
    }
    if (draw.bed.known && draw.bed.watts !== null) {
      points.push({
        id: 'bed',
        text: {
          ar: `السرير الساخن لوحده ${num(draw.bed.watts)} واط، وهو أكبر حمل بالجهاز ويشتغل ويطفي طول الطبعة — لذلك السحب ما يكون ثابت.`,
          en: `The heated bed alone is ${num(draw.bed.watts)} W — the largest load in the machine, and it cycles on and off throughout the print, so the draw is not steady.`,
          ckb: `بێدی گەرم بە تەنها ${num(draw.bed.watts)} واتە — گەورەترین بارە لە ئامێرەکەدا و بە درێژایی چاپ دەکوژێتەوە و داگیرسێتەوە، بۆیە ڕاکێشان جێگیر نییە.`,
        },
      });
    }
    if (draw.standby.known && draw.standby.watts !== null) {
      points.push({
        id: 'standby',
        text: {
          ar: `وهي واكفة بلا طباعة تسحب ${num(draw.standby.watts)} واط فقط.`,
          en: `Idle, with nothing printing, it draws only ${num(draw.standby.watts)} W.`,
          ckb: `بێکار و بێ چاپکردن تەنها ${num(draw.standby.watts)} وات ڕادەکێشێت.`,
        },
      });
    }
    if (va !== null && kva !== null) {
      const sized = sizing_basis === 'printing' ? draw.printing.watts : draw.rated.watts;
      points.push({
        id: 'ups_size',
        text: {
          ar: recommended
            ? `تحتاج UPS لا يقل عن ${num(va)} VA (${num(kva)} kVA) — من المقاسات الموجودة يعني ${num(recommended)} kVA. الحساب: ${num(sized ?? 0)} واط ÷ ${UPS_OUTPUT_POWER_FACTOR} معامل خرج الـ UPS.`
            : `تحتاج UPS بحدود ${num(va)} VA (${num(kva)} kVA) — أكبر من 3 kVA، فراجعنا حتى نحسبها على حالتك.`,
          en: recommended
            ? `It needs a UPS of at least ${num(va)} VA (${num(kva)} kVA) — of the sizes on sale, a ${num(recommended)} kVA unit. The arithmetic: ${num(sized ?? 0)} W ÷ ${UPS_OUTPUT_POWER_FACTOR} UPS output power factor.`
            : `It needs about ${num(va)} VA (${num(kva)} kVA), which is beyond 3 kVA — talk to us and we will size it for your setup.`,
          ckb: recommended
            ? `پێویستی بە UPSێکە کە لە ${num(va)} VA (${num(kva)} kVA) کەمتر نەبێت — لە قەبارە بەردەستەکاندا ${num(recommended)} kVA. ژمێرەکە: ${num(sized ?? 0)} وات ÷ ${UPS_OUTPUT_POWER_FACTOR} فاکتەری دەرچوونی UPS.`
            : `پێویستی بە نزیکەی ${num(va)} VA (${num(kva)} kVA) هەیە، کە لە 3 kVA زیاترە — پەیوەندیمان پێوە بکە.`,
        },
      });
    }
    const usable = runtimes.filter((r) => r.fits && r.minutes_min !== null && r.minutes_max !== null);
    if (usable.length) {
      const join = (sep: string) =>
        usable.map((r) => `${num(r.kva)} kVA ${sep} ${num(r.minutes_min as number)}–${num(r.minutes_max as number)}`);
      points.push({
        id: 'runtime',
        text: {
          ar: `مدة التشغيل التقريبية على البطارية عند هذا السحب: ${join('≈').join('، ')} دقيقة.`,
          en: `Approximate runtime at this draw: ${join('≈').join(', ')} minutes.`,
          ckb: `ماوەی نزیکەی کارکردن لەسەر ئەم ڕاکێشانە: ${join('≈').join('، ')} خولەک.`,
        },
      });
      points.push({
        id: 'runtime_caveat',
        text: {
          ar: 'هذه مديات وليست رقماً مضموناً: المدة تعتمد على أمبيرية البطارية وعمرها وكم تسمح تُفرَّغ وكفاءة الإنفرتر، ولا واحدة منها مكتوبة بورقة مواصفات الطابعة.',
          en: 'These are ranges, not a promise: runtime depends on the battery’s amp-hours, its age, how deeply it is discharged and the inverter’s efficiency — none of which a printer’s spec sheet knows.',
          ckb: 'ئەمانە مەودان نەک بەڵێن: ماوەکە بە ئەمپێر‑کاتژمێری باتری، تەمەنی، ئاستی بەتاڵبوونی و کارایی ئینڤێرتەرەوە بەندە — هیچیان لە پەڕەی تایبەتمەندی پرینتەردا نین.',
        },
      });
    }
    /**
     * THE BREAKER, AS A SENTENCE AND NOT AS A BARE NUMBER.
     *
     * `circuit.suggested_breaker_a` goes out on GET /api/compare with the rest
     * of this object, and whoever builds the storefront block will pick it off
     * and render «6 A» as shop advice. An under- or over-sized MCB is a
     * FIRE-SAFETY claim, not a spec-sheet claim, and the caveat that makes it
     * defensible — running current × 1.25, rounded up, a starting point for an
     * electrician and not an installation design — was sitting in a TypeScript
     * comment the customer cannot read. Every other number in this module
     * carries its caveat as a trilingual string in the payload; this one now
     * does too, so the framing travels with the figure.
     */
    if (breakerA !== null && sizingAmps !== null) {
      points.push({
        id: 'breaker',
        text: {
          ar: `على هذا السحب، الحساب يطلع قاطع ${num(breakerA)} أمبير كنقطة بداية (${num(sizingAmps)} أمبير × ${BREAKER_DERATING} لأن الطابعة تسخّن ساعات). هذا مو تصميم تمديدات: القاطع يعتمد على سلك بيتك وعلى شنو مشترك وياه على نفس الخط، فراجع كهربائي.`,
          en: `At this draw the arithmetic gives a ${num(breakerA)} A breaker as a STARTING POINT (${num(sizingAmps)} A × ${BREAKER_DERATING}, because a printer heats for hours). This is not an installation design: the right breaker depends on your cable and on what else shares the circuit, so have an electrician confirm it.`,
          ckb: `لەسەر ئەم ڕاکێشانە ژمێرەکە قاتعێکی ${num(breakerA)} ئەمپێر دەداتەوە وەک خاڵی دەستپێک (${num(sizingAmps)} ئەمپێر × ${BREAKER_DERATING}، چونکە پرینتەر بە کاتژمێر گەرم دەبێت). ئەمە دیزاینی وایەرکێشی نییە: قاتعی گونجاو بە وایەری ماڵەکەت و بەوەی چی تری لەسەر هەمان هێڵە بەندە — کارەباچییەک پشتڕاستی بکاتەوە.`,
        },
      });
    }
    points.push(...topologyPoints);
    if (supply.accepts_iraq_mains === 'no') {
      points.push({
        id: 'voltage_warning',
        text: {
          ar: `انتبه: الجهاز مكتوب عليه ${supply.voltage_text} وكهرباء العراق ${IRAQ_MAINS_VOLTS}–230 فولت، فيحتاج محوّل جهد مناسب لقدرته.`,
          en: `Note: the unit is marked ${supply.voltage_text} while the Iraqi mains is ${IRAQ_MAINS_VOLTS}–230 V, so it needs a step transformer rated for its power.`,
          ckb: `ئاگاداری: ئامێرەکە ${supply.voltage_text} نووسراوە بەڵام کارەبای عێراق ${IRAQ_MAINS_VOLTS}–230 ڤۆڵتە، بۆیە پێویستی بە گۆڕەری ڤۆڵتاژی گونجاو هەیە.`,
        },
      });
    }
    if (supply.accepts_50hz === 'no') {
      points.push({
        id: 'frequency_warning',
        text: {
          ar: `انتبه: التردد المذكور ${supply.frequency_text} وكهرباء العراق 50 هرتز.`,
          en: `Note: the stated frequency is ${supply.frequency_text} while the Iraqi mains is 50 Hz.`,
          ckb: `ئاگاداری: فرێکوێنسی نووسراو ${supply.frequency_text}ە بەڵام کارەبای عێراق 50 هێرتزە.`,
        },
      });
    }
  }

  return {
    known,
    mains: { volts: IRAQ_MAINS_VOLTS, hz: IRAQ_MAINS_HZ },
    supply,
    draw,
    sizing_basis,
    runtime_basis,
    circuit: { amps: sizingAmps, suggested_breaker_a: breakerA },
    ups: {
      known,
      va,
      kva,
      recommended_kva: recommended,
      above_range: kva !== null && recommended === null,
      runtimes,
    },
    topology: { recommended: 'online', points: topologyPoints },
    assumptions,
    points,
  };
}

/** The same answer straight from a stored spec sheet — the one call a route
 *  needs, so no caller has to know which columns the wattages live in. */
export function adviseFromSpecs(specs: Record<string, unknown> | null | undefined): PowerAdvice {
  return advise(powerInputFromSpecs(specs));
}
