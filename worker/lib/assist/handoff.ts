/**
 * «تحدث مع الفريق» — THE TICKET, PREFILLED (assistant plan 2.5, the part push A needs).
 *
 * The customer should not have to type again what the conversation already
 * established. The draft names the printer, the symptom, the code if one was
 * typed, and the steps that were shown and tried, each label taken from the
 * curated set in the customer's language. It is a DRAFT: the ticket form
 * shows it, the customer can edit every word, and nothing is sent until they
 * press send. The only thing besides the text is the same facts as closed-set
 * values (`HandoffSummary`), so the desk can read them without parsing prose;
 * no sentence of the customer's rides in it.
 */
import type { HandoffSummary, L3, Locale, ModelToken, SymptomKey, TicketDraft } from './types';
import { MODEL_TOKENS, SYMPTOM_KEYS } from './types';
import { tr } from './strings';
import { symptomDef } from './triage/symptoms';
import { HMS_CODE_SHAPE, SHOWN_MAX } from './context';

export interface DraftInput {
  /** The printer the customer chose or named; absent when none was, and then the draft names none. */
  model?: ModelToken | 'other';
  /** The symptom the customer named; absent when none was, and then the draft names none. */
  symptom?: SymptomKey;
  /**
   * The curated steps of `symptom` were SHOWN in the chat. Only then are they
   * listed as tried; a ticket asked for before any step was shown lists none.
   */
  tried?: boolean;
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
  const allowed = symptom ? symptomDef(symptom).steps.map((st) => st.key) : [];
  const asked = new Set(Array.isArray(h.tried) ? h.tried.filter((k): k is string => typeof k === 'string') : []);
  const tried = allowed.filter((k) => asked.has(k));
  const code = typeof h.code === 'string' && HMS_CODE_SHAPE.test(h.code) ? h.code.toUpperCase() : undefined;
  const shown = Array.isArray(h.shown)
    ? [...new Set(h.shown.filter((x): x is string => typeof x === 'string' && PRODUCT_ID_SHAPE.test(x)))].slice(0, SHOWN_MAX)
    : [];
  const count = Number(h.attachments);
  const attachments = Number.isInteger(count) && count >= 0 && count <= 6 ? count : 0;
  if (!model && !symptom) return null;
  return { v: 1, model, symptom, tried, ...(code ? { code } : {}), shown, attachments };
}

/** The summary as the desk shows it: every label from the curated set, in all three languages. */
export interface StaffHandoff {
  model: ModelToken | 'other' | null;
  symptom: { key: SymptomKey; label: L3 } | null;
  tried: Array<{ key: string; text: L3 }>;
  code: string | null;
  shown: string[];
  attachments: number;
}

export function handoffForStaff(raw: unknown): StaffHandoff | null {
  const h = readHandoff(raw);
  if (!h) return null;
  const def = h.symptom ? symptomDef(h.symptom) : null;
  return {
    model: h.model,
    symptom: def ? { key: def.key, label: def.label } : null,
    tried: def ? def.steps.filter((st) => h.tried.includes(st.key)).map((st) => ({ key: st.key, text: st.tried ?? st.text })) : [],
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
 * and of the summary (never «طابعة أخرى» / «أخرى» by default), and the steps
 * are listed as tried only when they were shown.
 */
export function buildTicketDraft(input: DraftInput, loc: Locale): TicketDraft {
  const def = input.symptom ? symptomDef(input.symptom) : null;
  const symptom = def ? def.label[loc] : '';
  const printer = input.model ? printerLabel(loc, input.model) : '';
  const named = input.model && input.model !== 'other' ? input.model : null;
  const subject = def
    ? named
      ? tr(loc, 'ticket_subject', { printer: named, symptom })
      : tr(loc, 'ticket_subject_other', { symptom })
    : named
      ? tr(loc, 'ticket_subject_printer', { printer: named })
      : tr(loc, 'ticket_subject_plain');
  const tried = def && input.symptom && input.tried ? shownStepKeys(input.symptom, input.code) : [];
  const lines: string[] = [];
  if (printer) lines.push(tr(loc, 'ticket_printer', { printer }));
  if (def) lines.push(tr(loc, 'ticket_problem', { symptom }));
  if (input.code) lines.push(tr(loc, 'ticket_code', { code: input.code }));
  if (def && tried.length) {
    lines.push(tr(loc, 'ticket_tried'));
    for (const key of tried) {
      const step = def.steps.find((s) => s.key === key);
      if (step) lines.push(`- ${(step.tried ?? step.text)[loc]}`);
    }
  }
  // A summary that names neither a printer nor a symptom is no summary (`readHandoff`).
  const handoff: HandoffSummary | null =
    input.model || input.symptom
      ? {
          v: 1,
          model: input.model ?? null,
          symptom: input.symptom ?? null,
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
