/**
 * THE TRIAGE, AS PURE STATE TRANSITIONS.
 *
 * «صارت عندي مشكله بالطابعه» → which printer → which symptom → the curated
 * steps → fixed, or «تحدث مع الفريق» with a prefilled ticket. «كلوب» enters
 * the same path with the symptom already known, and a printer already chosen
 * in this conversation is not asked for again.
 *
 * No I/O here: the orchestrator turns a `TriageStep` into a reply (chips from
 * the catalogue, cards from the search engine). Every value that enters the
 * context is from a closed set.
 */
import type { AssistContext } from '../context';
import type { ModelToken, SymptomKey } from '../types';

export type PrinterChoice = ModelToken | 'other';

export type TriageInput =
  | { kind: 'start'; model?: ModelToken; symptom?: SymptomKey; code?: string }
  | { kind: 'printer'; model: PrinterChoice; unit_id?: string; symptom?: SymptomKey }
  | { kind: 'symptom'; symptom: SymptomKey; code?: string }
  | { kind: 'outcome'; outcome: 'resolved' | 'not_fixed' }
  | { kind: 'talk' }
  | { kind: 'change_printer' };

export type TriageStep =
  | { kind: 'ask_printer'; symptom?: SymptomKey }
  | { kind: 'ask_symptom'; model: PrinterChoice }
  | { kind: 'steps'; model: PrinterChoice; symptom: SymptomKey; code?: string }
  | { kind: 'resolved' }
  | { kind: 'handoff'; model: PrinterChoice; symptom: SymptomKey; code?: string };

export interface TriageResult {
  step: TriageStep;
  context: AssistContext;
}

function withPrinter(ctx: AssistContext, model: PrinterChoice, unitId?: string): AssistContext {
  // A device chosen earlier stays attached only while the same model is meant.
  const keep = unitId ?? (ctx.printer?.model === model ? ctx.printer.unit_id : undefined);
  return { ...ctx, printer: { model, ...(keep ? { unit_id: keep } : {}) } };
}

function toSteps(ctx: AssistContext, model: PrinterChoice, symptom: SymptomKey, code?: string): TriageResult {
  return {
    step: { kind: 'steps', model, symptom, ...(code ? { code } : {}) },
    context: { ...ctx, triage: { stage: 'steps', symptom, ...(code ? { code } : {}) } },
  };
}

function askPrinter(ctx: AssistContext, symptom?: SymptomKey, code?: string): TriageResult {
  const rest: AssistContext = { ...ctx };
  delete rest.printer;
  return {
    step: { kind: 'ask_printer', ...(symptom ? { symptom } : {}) },
    context: { ...rest, triage: { stage: 'printer', ...(symptom ? { symptom } : {}), ...(code ? { code } : {}) } },
  };
}

export function nextTriage(ctx: AssistContext, input: TriageInput): TriageResult {
  const held = ctx.triage;
  switch (input.kind) {
    case 'start': {
      const model: PrinterChoice | undefined = input.model ?? ctx.printer?.model;
      if (!model) {
        return {
          step: { kind: 'ask_printer', ...(input.symptom ? { symptom: input.symptom } : {}) },
          context: { ...ctx, triage: { stage: 'printer', ...(input.symptom ? { symptom: input.symptom } : {}), ...(input.code ? { code: input.code } : {}) } },
        };
      }
      const next = withPrinter(ctx, model);
      if (!input.symptom) return { step: { kind: 'ask_symptom', model }, context: { ...next, triage: { stage: 'symptom' } } };
      return toSteps(next, model, input.symptom, input.code);
    }
    case 'printer': {
      const next = withPrinter(ctx, input.model, input.unit_id);
      const symptom = input.symptom ?? held?.symptom;
      if (!symptom) return { step: { kind: 'ask_symptom', model: input.model }, context: { ...next, triage: { stage: 'symptom' } } };
      return toSteps(next, input.model, symptom, held?.code);
    }
    case 'symptom': {
      const code = input.code ?? (input.symptom === held?.symptom ? held?.code : undefined);
      const model = ctx.printer?.model;
      if (!model) return askPrinter(ctx, input.symptom, code);
      return toSteps(ctx, model, input.symptom, code);
    }
    case 'outcome':
      if (input.outcome === 'resolved') return { step: { kind: 'resolved' }, context: { ...ctx, triage: { stage: 'done' } } };
      return handoff(ctx);
    case 'talk':
      return handoff(ctx);
    case 'change_printer':
      return askPrinter(ctx, held?.symptom, held?.code);
  }
}

function handoff(ctx: AssistContext): TriageResult {
  const symptom = ctx.triage?.symptom ?? 'other';
  const model = ctx.printer?.model ?? 'other';
  const code = ctx.triage?.code;
  return {
    step: { kind: 'handoff', model, symptom, ...(code ? { code } : {}) },
    context: { ...ctx, triage: { stage: 'done', symptom, ...(code ? { code } : {}) } },
  };
}
