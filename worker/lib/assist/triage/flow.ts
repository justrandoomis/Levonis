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
import type { ModelToken, PartKey, SymptomKey } from '../types';

export type PrinterChoice = ModelToken | 'other';

/**
 * `code`: an HMS code typed in the same message («P1S وطلعلي رمز 0300-…»),
 * kept for the steps and the ticket like one typed earlier. `among`: the
 * printers of a family the customer named («X1»), offered as the only chips.
 * `faultIn`: the symptom is the steps a fault in this part takes («مشكلة
 * بالنوزل» → the clog steps), not a symptom the customer named.
 */
export type TriageInput =
  | { kind: 'start'; model?: ModelToken; symptom?: SymptomKey; code?: string; among?: readonly ModelToken[]; faultIn?: PartKey }
  | { kind: 'printer'; model: PrinterChoice; unit_id?: string; symptom?: SymptomKey; code?: string; faultIn?: PartKey }
  | { kind: 'symptom'; symptom: SymptomKey; code?: string; faultIn?: PartKey }
  | { kind: 'outcome'; outcome: 'resolved' | 'not_fixed' }
  | { kind: 'talk' }
  | { kind: 'change_printer' };

/**
 * `handoff` carries only what the customer gave: no printer when none was
 * chosen (a printer a shopping answer only showed is not one), no symptom when
 * none was named (`faultIn`: the part the fault was named in, instead), and
 * `tried` only when the customer said the steps did not fix it. Steps only
 * shown are `shownSteps`: the ticket lists them as shown, never as tried.
 */
export type TriageStep =
  | { kind: 'ask_printer'; symptom?: SymptomKey; among?: readonly ModelToken[]; faultIn?: PartKey }
  | { kind: 'ask_symptom'; model: PrinterChoice }
  | { kind: 'steps'; model: PrinterChoice; symptom: SymptomKey; code?: string; faultIn?: PartKey }
  | { kind: 'resolved' }
  | { kind: 'handoff'; model?: PrinterChoice; symptom?: SymptomKey; code?: string; tried: boolean; shownSteps?: true; faultIn?: PartKey };

export interface TriageResult {
  step: TriageStep;
  context: AssistContext;
}

/**
 * The printer the triage may go on with unasked: one the customer chose or
 * named, never one a shopping answer only showed («اريد طابعة», «A1 combo»).
 */
export function triagePrinter(ctx: AssistContext): PrinterChoice | undefined {
  return ctx.printer && !ctx.printer.browsed ? ctx.printer.model : undefined;
}

function withPrinter(ctx: AssistContext, model: PrinterChoice, unitId?: string): AssistContext {
  // A device chosen earlier stays attached only while the same model is meant.
  const keep = unitId ?? (ctx.printer?.model === model ? ctx.printer.unit_id : undefined);
  return { ...ctx, printer: { model, ...(keep ? { unit_id: keep } : {}) } };
}

const faultOf = (faultIn?: PartKey): { faultIn?: PartKey } => (faultIn ? { faultIn } : {});

function toSteps(ctx: AssistContext, model: PrinterChoice, symptom: SymptomKey, code?: string, faultIn?: PartKey): TriageResult {
  return {
    step: { kind: 'steps', model, symptom, ...(code ? { code } : {}), ...faultOf(faultIn) },
    context: { ...ctx, triage: { stage: 'steps', symptom, ...(code ? { code } : {}), ...faultOf(faultIn) } },
  };
}

/**
 * True when the curated steps of the held symptom were shown in this
 * conversation: the triage is at them, or left them with `steps` set.
 */
function stepsShown(held: AssistContext['triage']): boolean {
  return !!held?.symptom && (held.stage === 'steps' || held.steps === true);
}

/**
 * `steps`: the steps of `symptom` were already shown (another printer is being
 * chosen for the same fault), and `tried`: the customer already said they did
 * not fix it.
 */
function askPrinter(ctx: AssistContext, symptom?: SymptomKey, code?: string, steps = false, faultIn?: PartKey, tried = false): TriageResult {
  const rest: AssistContext = { ...ctx };
  delete rest.printer;
  const fault = symptom ? faultOf(faultIn) : {};
  return {
    step: { kind: 'ask_printer', ...(symptom ? { symptom } : {}), ...fault },
    context: {
      ...rest,
      triage: {
        stage: 'printer',
        ...(symptom ? { symptom } : {}),
        ...(code ? { code } : {}),
        ...(symptom && steps ? { steps: true as const } : {}),
        ...(symptom && steps && tried ? { tried: true as const } : {}),
        ...fault,
      },
    },
  };
}

export function nextTriage(ctx: AssistContext, input: TriageInput): TriageResult {
  const held = ctx.triage;
  switch (input.kind) {
    case 'start': {
      const model: PrinterChoice | undefined = input.model ?? triagePrinter(ctx);
      const fault = input.symptom ? faultOf(input.faultIn) : {};
      if (!model) {
        return {
          step: {
            kind: 'ask_printer',
            ...(input.symptom ? { symptom: input.symptom } : {}),
            ...(input.among?.length ? { among: input.among } : {}),
            ...fault,
          },
          context: {
            ...ctx,
            triage: { stage: 'printer', ...(input.symptom ? { symptom: input.symptom } : {}), ...(input.code ? { code: input.code } : {}), ...fault },
          },
        };
      }
      const next = withPrinter(ctx, model);
      if (!input.symptom) return { step: { kind: 'ask_symptom', model }, context: { ...next, triage: { stage: 'symptom' } } };
      return toSteps(next, model, input.symptom, input.code, input.faultIn);
    }
    case 'printer': {
      const next = withPrinter(ctx, input.model, input.unit_id);
      const symptom = input.symptom ?? held?.symptom;
      if (!symptom) return { step: { kind: 'ask_symptom', model: input.model }, context: { ...next, triage: { stage: 'symptom' } } };
      // A symptom typed with the printer replaces the part the fault was named in; none typed keeps it.
      return toSteps(next, input.model, symptom, input.code ?? held?.code, input.symptom ? input.faultIn : held?.faultIn);
    }
    case 'symptom': {
      const code = input.code ?? (input.symptom === held?.symptom ? held?.code : undefined);
      const model = triagePrinter(ctx);
      if (!model) return askPrinter(ctx, input.symptom, code, false, input.faultIn);
      return toSteps(ctx, model, input.symptom, code, input.faultIn);
    }
    case 'outcome':
      if (input.outcome === 'resolved') return { step: { kind: 'resolved' }, context: { ...ctx, triage: { stage: 'done' } } };
      return handoff(ctx, true);
    case 'talk':
      return handoff(ctx, false);
    case 'change_printer':
      return askPrinter(ctx, held?.symptom, held?.code, stepsShown(held), held?.faultIn, held?.tried === true);
  }
}

/**
 * «تحدث مع الفريق»: the ticket says what the customer gave and nothing else.
 * The printer is the one chosen or named in the triage (`triagePrinter`), never
 * one a shopping answer only showed; a printer or a symptom nobody gave is
 * left out, not written as «أخرى»; a fault named in a part stays that part.
 *
 * SHOWN IS NOT TRIED (review round 4.2). The steps are listed as tried only
 * when the customer said they did not fix it (`notFixed`: the chip, or «جربتها
 * وما انحلّت», "still not fixed", «هێشتا چارەسەر نەبووە» typed), now or
 * earlier in this triage. «تحدث مع الفريق» after the steps lists them as
 * shown; before them it lists none.
 */
function handoff(ctx: AssistContext, notFixed: boolean): TriageResult {
  const held = ctx.triage;
  const symptom = held?.symptom;
  const model = triagePrinter(ctx);
  const code = held?.code;
  const shown = stepsShown(held);
  const tried = shown && (notFixed || held?.tried === true);
  const fault = symptom ? faultOf(held?.faultIn) : {};
  return {
    step: {
      kind: 'handoff',
      ...(model ? { model } : {}),
      ...(symptom ? { symptom } : {}),
      ...(code ? { code } : {}),
      tried,
      ...(shown && !tried ? { shownSteps: true as const } : {}),
      ...fault,
    },
    context: {
      ...ctx,
      triage: {
        stage: 'done',
        ...(symptom ? { symptom } : {}),
        ...(code ? { code } : {}),
        ...(shown ? { steps: true as const } : {}),
        ...(tried ? { tried: true as const } : {}),
        ...fault,
      },
    },
  };
}
