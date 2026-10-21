/**
 * «تحدث مع الفريق» — THE TICKET, PREFILLED (assistant plan 2.5, the part push A needs).
 *
 * The customer should not have to type again what the conversation already
 * established. The draft names the printer, the symptom (or the part a fault
 * was named in), the code if one was typed, and the steps: as tried when the
 * customer said they did not fix it, as shown when they were only shown, each
 * label taken from the curated set in the language of the customer. It is a
 * DRAFT: the ticket form shows it, the customer can edit every word, and
 * nothing is sent until they press send. The only thing besides the text is
 * the same facts as closed-set
 * values (`HandoffSummary`), so the desk can read them without parsing prose;
 * no sentence of the customer's rides in it.
 */
import type { HandoffSummary, L3, Locale, ModelToken, PartKey, SymptomKey, TicketDraft } from './types';
import { MODEL_TOKENS, PART_KEYS, SYMPTOM_KEYS } from './types';
import { tr } from './strings';
import { symptomDef } from './triage/symptoms';
import { HMS_CODE_SHAPE, SHOWN_MAX } from './context';
import { PART_LABELS, PART_SYMPTOM } from './understand/lexicon';

export interface DraftInput {
  /** The printer the customer chose or named; absent when none was, and then the draft names none. */
  model?: ModelToken | 'other';
  /** The symptom the customer named; absent when none was, and then the draft names none. */
  symptom?: SymptomKey;
  /**
   * The customer said the curated steps of `symptom` did not fix it. Only
   * then are they listed as tried (and in `tried` of the summary).
   */
  tried?: boolean;
  /**
   * The steps were SHOWN in the chat and nobody said they were tried
   * («تحدث مع الفريق» after the steps): listed as shown, never as tried.
   * A ticket asked for before any step was shown lists none.
   */
  shownSteps?: boolean;
  /**
   * `symptom` is the steps a fault in this part took («مشكلة بالنوزل» → the
   * clog steps), not a symptom the customer named: the draft and the summary
   * state the part, never that symptom.
   */
  faultIn?: PartKey;
  code?: string;
  /** Already checked against the viewer's own devices by the caller. */
  unit_id?: string;
  /** The product ids the conversation showed last (the context's `shown`). */
  shown?: readonly string[];
}

export type { HandoffSummary };

const PRODUCT_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The summary from a request body or a stored column, closed sets only:
 * unknown keys, foreign step keys, a code of the wrong shape and oversize
 * lists are dropped, and a summary that names neither a printer nor a
 * symptom is no summary (null).
 */
export function readHandoff(raw: unknown): HandoffSummary | null {
  let value = raw;
  if (typeof value === 'string') {
    if (value.length > 4096) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const h = value as Record<string, unknown>;
  if (h.v !== 1) return null;
  const model =
    h.model === 'other' ? 'other' : typeof h.model === 'string' && (MODEL_TOKENS as readonly string[]).includes(h.model) ? (h.model as ModelToken) : null;
  const symptom = typeof h.symptom === 'string' && (SYMPTOM_KEYS as readonly string[]).includes(h.symptom) ? (h.symptom as SymptomKey) : null;
  // The part a fault was named in stands only where no symptom was named; its steps are those it took.
  const part = !symptom && typeof h.part === 'string' && (PART_KEYS as readonly string[]).includes(h.part) ? (h.part as PartKey) : null;
  const stepsOf = symptom ?? (part ? PART_SYMPTOM[part] : null);
  const allowed = stepsOf ? symptomDef(stepsOf).steps.map((st) => st.key) : [];
  const asked = new Set(Array.isArray(h.tried) ? h.tried.filter((k): k is string => typeof k === 'string') : []);
  const tried = allowed.filter((k) => asked.has(k));
  const code = typeof h.code === 'string' && HMS_CODE_SHAPE.test(h.code) ? h.code.toUpperCase() : undefined;
  const shown = Array.isArray(h.shown)
    ? [...new Set(h.shown.filter((x): x is string => typeof x === 'string' && PRODUCT_ID_SHAPE.test(x)))].slice(0, SHOWN_MAX)
    : [];
  const count = Number(h.attachments);
  const attachments = Number.isInteger(count) && count >= 0 && count <= 6 ? count : 0;
  if (!model && !symptom && !part) return null;
  return { v: 1, model, symptom, ...(part ? { part } : {}), tried, ...(code ? { code } : {}), shown, attachments };
}

/** The summary as the desk shows it: every label from the curated set, in all three languages. */
export interface StaffHandoff {
  model: ModelToken | 'other' | null;
  symptom: { key: SymptomKey; label: L3 } | null;
  /** The part a fault was named in, when no symptom was («مشكلة بالنوزل»). */
  part: { key: PartKey; label: L3 } | null;
  tried: Array<{ key: string; text: L3 }>;
  code: string | null;
  shown: string[];
  attachments: number;
}

export function handoffForStaff(raw: unknown): StaffHandoff | null {
  const h = readHandoff(raw);
  if (!h) return null;
  const def = h.symptom ? symptomDef(h.symptom) : null;
  const steps = def ?? (h.part ? symptomDef(PART_SYMPTOM[h.part]) : null);
  return {
    model: h.model,
    symptom: def ? { key: def.key, label: def.label } : null,
    part: h.part ? { key: h.part, label: PART_LABELS[h.part] } : null,
    tried: steps ? steps.steps.filter((st) => h.tried.includes(st.key)).map((st) => ({ key: st.key, text: st.tried ?? st.text })) : [],
    code: h.code ?? null,
    shown: h.shown,
    attachments: h.attachments,
  };
}

/** The step keys a customer saw for this symptom: an HMS code already typed is not asked for again. */
export function shownStepKeys(symptom: SymptomKey, code?: string): string[] {
  return symptomDef(symptom)
    .steps.filter((s) => !(code && s.key === 'type_code'))
    .map((s) => s.key);
}

export function printerLabel(loc: Locale, model: ModelToken | 'other'): string {
  return model === 'other' ? tr(loc, 'printer_other') : model;
}

/**
 * The draft states what the conversation established and nothing more: a
 * printer nobody chose and a symptom nobody named are left out of the text
 * and of the summary (never «طابعة أخرى» / «أخرى» by default); a fault named
 * in a part is that part («موضع المشكلة: النوزل»), never the symptom its steps
 * are for; and the steps are listed as tried only when the customer said they
 * did not fix it, as shown when they were only shown.
 */
export function buildTicketDraft(input: DraftInput, loc: Locale): TicketDraft {
  const def = input.symptom ? symptomDef(input.symptom) : null;
  const faultIn = def && input.faultIn && PART_SYMPTOM[input.faultIn] === input.symptom ? input.faultIn : undefined;
  // What the subject says the problem is: the symptom named, or the part the fault was named in.
  const problem = faultIn ? PART_LABELS[faultIn][loc] : def ? def.label[loc] : '';
  const printer = input.model ? printerLabel(loc, input.model) : '';
  const named = input.model && input.model !== 'other' ? input.model : null;
  const subject = def
    ? named
      ? tr(loc, 'ticket_subject', { printer: named, symptom: problem })
      : tr(loc, 'ticket_subject_other', { symptom: problem })
    : named
      ? tr(loc, 'ticket_subject_printer', { printer: named })
      : tr(loc, 'ticket_subject_plain');
  const steps = def && input.symptom ? shownStepKeys(input.symptom, input.code) : [];
  const tried = input.tried ? steps : [];
  const listed = tried.length ? tried : input.shownSteps ? steps : [];
  const lines: string[] = [];
  if (printer) lines.push(tr(loc, 'ticket_printer', { printer }));
  if (faultIn) lines.push(tr(loc, 'ticket_part', { part: problem }));
  else if (def) lines.push(tr(loc, 'ticket_problem', { symptom: problem }));
  if (input.code) lines.push(tr(loc, 'ticket_code', { code: input.code }));
  if (def && listed.length) {
    lines.push(tr(loc, tried.length ? 'ticket_tried' : 'ticket_shown'));
    for (const key of listed) {
      const step = def.steps.find((s) => s.key === key);
      if (step) lines.push(`- ${(step.tried ?? step.text)[loc]}`);
    }
  }
  // A summary that names neither a printer nor a symptom (nor the part of a fault) is no summary (`readHandoff`).
  const handoff: HandoffSummary | null =
    input.model || input.symptom
      ? {
          v: 1,
          model: input.model ?? null,
          symptom: faultIn ? null : (input.symptom ?? null),
          ...(faultIn ? { part: faultIn } : {}),
          tried,
          ...(input.code ? { code: input.code } : {}),
          shown: [...(input.shown ?? [])].slice(0, SHOWN_MAX),
          attachments: 0,
        }
      : null;
  return {
    subject: subject.slice(0, 200),
    body: lines.join('\n'),
    ...(input.unit_id ? { unit_id: input.unit_id } : {}),
    ...(handoff ? { handoff } : {}),
  };
}
