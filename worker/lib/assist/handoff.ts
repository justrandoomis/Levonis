/**
 * «تحدث مع الفريق» — THE TICKET, PREFILLED (assistant plan 2.5, the part push A needs).
 *
 * The customer should not have to type again what the conversation already
 * established. The draft names the printer, the symptom, the code if one was
 * typed, and the steps that were shown and tried, each label taken from the
 * curated set in the customer's language. It is a DRAFT: the ticket form
 * shows it, the customer can edit every word, and nothing is sent until they
 * press send. Nothing hidden rides along.
 */
import type { Locale, ModelToken, SymptomKey, TicketDraft } from './types';
import { tr } from './strings';
import { symptomDef } from './triage/symptoms';

export interface DraftInput {
  model: ModelToken | 'other';
  symptom: SymptomKey;
  code?: string;
  /** Already checked against the viewer's own devices by the caller. */
  unit_id?: string;
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

export function buildTicketDraft(input: DraftInput, loc: Locale): TicketDraft {
  const def = symptomDef(input.symptom);
  const symptom = def.label[loc];
  const printer = printerLabel(loc, input.model);
  const subject =
    input.model === 'other' ? tr(loc, 'ticket_subject_other', { symptom }) : tr(loc, 'ticket_subject', { printer, symptom });
  const tried = shownStepKeys(input.symptom, input.code);
  const lines = [tr(loc, 'ticket_printer', { printer }), tr(loc, 'ticket_problem', { symptom })];
  if (input.code) lines.push(tr(loc, 'ticket_code', { code: input.code }));
  if (tried.length) {
    lines.push(tr(loc, 'ticket_tried'));
    for (const key of tried) {
      const step = def.steps.find((s) => s.key === key);
      if (step) lines.push(`- ${step.text[loc]}`);
    }
  }
  return { subject: subject.slice(0, 200), body: lines.join('\n'), ...(input.unit_id ? { unit_id: input.unit_id } : {}) };
}
