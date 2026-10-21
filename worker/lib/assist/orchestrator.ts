/**
 * ONE TURN OF THE SUPPORT ASSISTANT, DECIDED BY CODE (assistant plan 2.3).
 *
 * The route hands every free-text message and every «مشكلة بالطابعة» chip
 * here first. This returns a reply for what it owns — a part question, a
 * printer fault, the triage — and null for everything else, which the legacy
 * intent handlers in worker/routes/support.ts keep answering exactly as before.
 *
 * WHY THE OWNER'S SENTENCES FAILED. «نوزل مال اي ون اريده 0.2» matched no
 * intent and fell to a `LIKE '%<the whole sentence>%'` over product names;
 * «بحث عن منتج صيانه خلل بالنوزل» reached product search and ran the same
 * LIKE on the whole sentence. The search engine already knew «نوزل» is a
 * nozzle and «0.2» a size; the assistant never asked it. Now the sentence is
 * READ (./understand), and the catalogue is asked through the storefront's own
 * search (./tools/catalog.ts), with the printer as a catalogue link (`fits`).
 *
 * WHAT IT NEVER DOES. It prices nothing, states no stock and asserts no
 * compatibility of its own: cards are the storefront's, «linked to the A1» is
 * the owner's `product_printer_fits` link, and when no link exists the reply
 * says the product MENTIONS the printer and to check the product page. It
 * never shows another printer's part as a match.
 */
import { extractOrderId } from '../assistantNlu';
import type { AssistContext } from './context';
import { SHOWN_MAX, SIZE_SHAPE } from './context';
import { buildTicketDraft, shownStepKeys } from './handoff';
import { callTool } from './registry';
import { tr } from './strings';
import { FITS_MAX, type CatalogItem } from './tools/catalog';
import type { MyPrinter } from './tools/devices';
import { nextTriage, type TriageInput, type TriageStep } from './triage/flow';
import { SYMPTOMS, symptomDef, wikiFor } from './triage/symptoms';
import type { AssistCard, AssistChoice, AssistReply, CardRenderer, ModelToken, PartKey, Viewer } from './types';
import { MODEL_TOKENS, PART_KEYS, SYMPTOM_KEYS, type SymptomKey } from './types';
import { mentionsModel, understand, type Understood } from './understand';
import { PART_FIX_TERMS, PART_LABELS, PART_SYMPTOM, PART_TERMS } from './understand/lexicon';

export interface TurnInput {
  /** The customer's message, raw. */
  text?: string;
  /** A tapped «printer_problem» chip's params; `{}` for the menu chip itself. */
  chip?: Record<string, unknown>;
  context: AssistContext;
  /**
   * What the legacy scorer would call this text, so a part question asked as
   * a price question keeps its `price_question` label (and its follow-up chips).
   */
  intentHint?: string | null;
}

export interface TurnOutcome {
  reply: AssistReply;
  context: AssistContext;
}

const CARDS_MAX = 6;
const DEVICE_CHIPS_MAX = 3;
/** The order printer chips are offered in: the most asked-about first. */
const CHIP_ORDER: readonly ModelToken[] = ['A1', 'A1 mini', 'A2L', 'P1S', 'P1P', 'P2S', 'X1C', 'X1E', 'X2D', 'H2D', 'H2D Pro', 'H2S', 'H2C'];

/**
 * The legacy intents a text may carry and still be the ANSWER to the triage's
 * question. «طابعتي A1» reads as nothing else; «شكد سعر A1» reads as a price
 * question, and a new question beats a pending one (the route's own rule).
 */
const PRINTER_ANSWER_HINTS = new Set(['printer_problem', 'my_devices']);
const OUTCOME_ANSWER_HINTS = new Set(['printer_problem', 'open_ticket', 'human_handoff', 'thanks', 'greeting']);
const FOLLOWUP_HINTS = new Set(['price_question', 'stock_question']);

/**
 * A part question asked while the triage waits for «which printer?» or «which
 * symptom?» has changed the subject: the question is no longer pending, so a
 * later «A1» is not read as its answer. After the steps the triage stays, so
 * «بكم الهوت اند؟» and then «ما انحلت» still reach the ticket.
 */
function dropPendingQuestion(ctx: AssistContext): void {
  if (ctx.triage && (ctx.triage.stage === 'printer' || ctx.triage.stage === 'symptom')) delete ctx.triage;
}

/** The context without the printer: a printer named and not read must not be answered for by the remembered one. */
function withoutPrinter(ctx: AssistContext): AssistContext {
  const out: AssistContext = { ...ctx };
  delete out.printer;
  return out;
}

/** A family whose printer this conversation already chose is that printer: «نوزل X1» after the X1C. */
function withRemembered(u: Understood, ctx: AssistContext): Understood {
  const chosen = ctx.printer?.model;
  if (!u.family || !chosen || chosen === 'other' || !u.family.members.includes(chosen)) return u;
  const out: Understood = { ...u, model: chosen, models: [chosen] };
  delete out.family;
  return out;
}

/** What a typed answer carries besides the printer: the symptom it names and the HMS code it holds. */
function triageExtras(symptom: SymptomKey | undefined, code: string | undefined): { symptom?: SymptomKey; code?: string } {
  return { ...(symptom ? { symptom } : {}), ...(code ? { code } : {}) };
}

export async function handleTurn(db: D1Database, viewer: Viewer, input: TurnInput, render: CardRenderer): Promise<TurnOutcome | null> {
  if (input.chip) {
    if (input.chip.step === 'part') {
      const asked = readPartChip(input.chip);
      return asked ? products(db, viewer, asked.u, input.context, render, null, { anyPrinter: asked.anyPrinter }) : null;
    }
    const triage = readChip(input.chip);
    if (!triage) return null;
    return runTriage(db, viewer, input.context, triage, render);
  }
  const text = input.text?.trim();
  if (!text) return null;
  // Account questions stay with the account handlers: «وين طلبي ORD-…».
  if (extractOrderId(text)) return null;

  const ctx = input.context;
  const hint = input.intentHint ?? null;
  const u = withRemembered(understand(text), ctx);
  const stage = ctx.triage?.stage;
  /** Nothing in the text but the answer: no shopping word, no size, no code. */
  const bare = !u.productCue && u.measures.length === 0 && u.codes.length === 0;
  // A printer named and not read, or a family named, is not the printer remembered from earlier.
  const known = (u.printerUnread || u.family) && !u.model ? withoutPrinter(ctx) : ctx;
  // «طابعتي X1»: the family's printers are the only chips.
  const among = u.family ? { among: u.family.members } : {};

  // ── The triage's pending question, answered. Only a text that carries
  //    nothing else is an answer: «شكد سعر A1» at «which printer?» is a price
  //    question, and «اكو خيوط PLA؟» at «which symptom?» a filament one. An
  //    HMS code typed with the answer («P1S وطلعلي رمز 0300-…») rides with it.
  if (stage === 'printer' && bare && (hint === null || PRINTER_ANSWER_HINTS.has(hint))) {
    const extras = triageExtras(u.symptom ?? partFault(u), u.hmsCode);
    if (u.model) return runTriage(db, viewer, ctx, { kind: 'printer', model: u.model, ...extras }, render);
    // «X1»: which of the family, holding what was already said.
    if (u.family) {
      const held = triageExtras(extras.symptom ?? ctx.triage?.symptom, extras.code ?? ctx.triage?.code);
      return runTriage(db, viewer, known, { kind: 'start', ...among, ...held }, render);
    }
    // «عندي طابعة كريالتي اندر 3», «طابعة أخرى»: a printer this shop does not list.
    if (u.otherPrinter || u.printerUnread) return runTriage(db, viewer, ctx, { kind: 'printer', model: 'other', ...extras }, render);
  }
  if (stage === 'symptom' && bare) {
    // While the triage asks for the symptom, «خيوط» alone is stringing, a
    // fault in a part is that part's symptom («مشكلة بالنوزل», or «النوزل»
    // alone → the clog path; «اريد نوزل» is a shopping question), and a fault
    // the steps do not cover (a leak) is «أخرى». A typed HMS code is the
    // symptom AND the code: «رمز خطأ 0300-…» is never asked for again.
    const ua = withRemembered(understand(text, { expectSymptom: true }), ctx);
    const partOnly = ua.part && (ua.problemCue || text.split(/\s+/).length === 1);
    const symptom: SymptomKey | undefined = ua.symptom ?? (ua.faultCue ? 'other' : partOnly ? PART_SYMPTOM[ua.part!] : undefined);
    if (symptom && (hint === null || hint === 'printer_problem' || ua.residual.length === 0)) {
      const code = ua.hmsCode ? { code: ua.hmsCode } : {};
      if (ua.model && ua.model !== ctx.printer?.model) {
        return runTriage(db, viewer, ctx, { kind: 'start', model: ua.model, symptom, ...code }, render);
      }
      if (ua.family) return runTriage(db, viewer, withoutPrinter(ctx), { kind: 'start', among: ua.family.members, symptom, ...code }, render);
      return runTriage(db, viewer, ctx, { kind: 'symptom', symptom, ...code }, render);
    }
  }
  // «جربتها وما انحلّت», "still not fixed", «انحلت»: the chip's outcome, typed.
  if (stage === 'steps' && u.outcome && bare && (hint === null || OUTCOME_ANSWER_HINTS.has(hint))) {
    return runTriage(db, viewer, ctx, { kind: 'outcome', outcome: u.outcome }, render);
  }

  // ── A printer fault, cold.
  const printer = u.model ? { model: u.model } : among;
  if (u.hmsCode) {
    if (u.model) return runTriage(db, viewer, ctx, { kind: 'start', symptom: 'hms', code: u.hmsCode, model: u.model }, render);
    if (known.printer) return runTriage(db, viewer, known, { kind: 'symptom', symptom: 'hms', code: u.hmsCode }, render);
    return runTriage(db, viewer, known, { kind: 'start', symptom: 'hms', code: u.hmsCode, ...among }, render);
  }
  if (u.symptom && !u.productCue) {
    return runTriage(db, viewer, known, { kind: 'start', symptom: u.symptom, ...printer }, render);
  }
  // «عندي مشكلة بالنوزل», «النوزل خربان»: a fault in a part is that part's
  // symptom, and the customer is asked which printer. A fault the curated
  // steps do not cover (a leak) starts the triage without one.
  if (u.part && u.problemCue && !u.productCue) {
    const symptom = partFault(u);
    return runTriage(db, viewer, known, { kind: 'start', ...(symptom ? { symptom } : {}), ...printer }, render);
  }
  if (u.problemCue && u.printerCue && !u.productCue && !u.part) {
    return runTriage(db, viewer, known, { kind: 'start', ...printer }, render);
  }

  // ── Follow-ups on the last answer. The context holds the part, the printer
  //    and what was shown; a short follow-up is read against them.
  if (ctx.part && !u.part && !u.symptom && !u.problemCue && u.residual.length === 0) {
    // «اكو 0.4؟» after «نوزل مال بي ون اس»: the same part, that size.
    if (u.measures.length > 0) return products(db, viewer, { ...u, part: ctx.part }, known, render, hint);
    // «لا قصدي بي ون اس», or the answer to «which printer is it for?»: the
    // same part, that printer, and the size the question carried (as the chip does).
    const answer: Understood = { ...u, part: ctx.part, measures: ctx.size ? [ctx.size] : [] };
    if ((u.model || u.family) && bare && (u.correction || !ctx.printer || ctx.printer.model === 'other')) {
      return products(db, viewer, answer, ctx, render, hint);
    }
    // «طابعة أخرى», «كريالتي»: the part, for a printer the shop does not list.
    if (u.otherPrinter && bare && !ctx.printer) return products(db, viewer, answer, ctx, render, hint, { anyPrinter: true });
  }
  // «شكد سعر الطابعة», "how much is the printer?" while the conversation is
  // about the A1: the A1 itself, as the storefront cards it. With no printer
  // remembered, the legacy price answer has the question.
  if (
    hint !== null &&
    FOLLOWUP_HINTS.has(hint) &&
    u.printerCue &&
    !u.model &&
    !u.family &&
    !u.part &&
    !u.printerUnread &&
    !u.otherPrinter &&
    u.measures.length === 0 &&
    u.codes.length === 0 &&
    u.residual.length === 0 &&
    ctx.printer &&
    ctx.printer.model !== 'other'
  ) {
    const itself = await printerItself(db, viewer, ctx, ctx.printer.model, hint, render);
    if (itself) return itself;
  }
  // «شكد سعره؟», «متوفر؟», «الاول بكم»: the products just shown, read again
  // through the card builder, so the price is still the grid's. Never when
  // the question names a printer: «شكد سعر الطابعة» after the A1 nozzles asks
  // about a printer, not about the nozzles.
  if (
    ctx.shown?.length &&
    hint !== null &&
    FOLLOWUP_HINTS.has(hint) &&
    !u.part &&
    !u.model &&
    !u.printerCue &&
    !u.printerUnread &&
    u.measures.length === 0 &&
    u.codes.length === 0 &&
    u.residual.length === 0
  ) {
    return shownAgain(db, viewer, ctx, u.ordinal, hint, render);
  }

  const printerNamed = !!u.model || !!u.family;
  if (u.part || (u.maintenance && (printerNamed || u.productCue)) || (u.measures.length > 0 && (printerNamed || u.productCue))) {
    return products(db, viewer, u, known, render, hint);
  }
  return null;
}

/** The symptom a fault in the named part is: «مشكلة بالنوزل» is a clog. Never for a fault the steps do not cover. */
function partFault(u: Understood): SymptomKey | undefined {
  return u.part && u.problemCue && !u.faultCue ? PART_SYMPTOM[u.part] : undefined;
}

/** The printer the conversation is about, as the shop lists it. Null when the shop lists none of that model. */
async function printerItself(
  db: D1Database,
  viewer: Viewer,
  ctx: AssistContext,
  model: ModelToken,
  hint: string,
  render: CardRenderer
): Promise<TurnOutcome | null> {
  const loc = viewer.locale;
  const r = await callTool('catalog.printersOf', db, viewer, { model });
  const items = r.ok ? r.data : [];
  if (items.length === 0) return null;
  const cards = items.slice(0, CARDS_MAX).map((i) => render.card(loc, i.card, i.row));
  const next: AssistContext = { ...ctx, shown: items.slice(0, SHOWN_MAX).map((i) => i.id) };
  dropPendingQuestion(next);
  return { reply: { intent: hint, text: tr(loc, 'printer_itself', { printer: model }), cards }, context: next };
}

/** The products the last answer showed, read again. A product no longer listed is simply absent. */
async function shownAgain(
  db: D1Database,
  viewer: Viewer,
  ctx: AssistContext,
  ordinal: number | undefined,
  hint: string,
  render: CardRenderer
): Promise<TurnOutcome> {
  const loc = viewer.locale;
  const shown = ctx.shown ?? [];
  const wanted = ordinal !== undefined && ordinal < shown.length ? [shown[ordinal]] : shown;
  const r = await callTool('catalog.byIds', db, viewer, { ids: wanted });
  const items = r.ok ? r.data : [];
  const cards = items.slice(0, CARDS_MAX).map((i) => render.card(loc, i.card, i.row));
  const text = cards.length === 0 ? tr(loc, 'shown_gone') : tr(loc, wanted.length === 1 ? 'shown_one' : 'shown_again');
  return { reply: { intent: hint, text, ...(cards.length ? { cards } : {}) }, context: ctx };
}

// ═════════════════════════════════════════════════════════════ chips

const CHIP_STEPS = new Set(['printer', 'symptom', 'outcome', 'talk', 'change_printer']);
const UNIT_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * «لأي طابعة تريد النوزل؟» answered by a chip: `{ step: 'part', part, model, size? }`,
 * from the closed sets only. The question it answers is read again as if typed.
 * `model: 'other'` («طابعة أخرى») is the part for a printer the shop does not list.
 */
function readPartChip(params: Record<string, unknown>): { u: Understood; anyPrinter: boolean } | null {
  const part = (PART_KEYS as readonly string[]).includes(String(params.part)) ? (params.part as PartKey) : null;
  const anyPrinter = params.model === 'other';
  const model = (MODEL_TOKENS as readonly string[]).includes(String(params.model)) ? (params.model as ModelToken) : null;
  if (!part || (!model && !anyPrinter)) return null;
  const size = typeof params.size === 'string' && SIZE_SHAPE.test(params.size) ? params.size : undefined;
  const u: Understood = {
    ...(model ? { model } : {}),
    models: model ? [model] : [],
    part,
    maintenance: false,
    measures: size ? [size] : [],
    codes: [],
    productCue: false,
    problemCue: false,
    faultCue: false,
    printerCue: true,
    printerUnread: false,
    otherBrand: false,
    otherPrinter: false,
    correction: false,
    residual: [],
  };
  return { u, anyPrinter };
}

/** A chip's params, from the closed sets only. Anything else is ignored, never trusted. */
function readChip(params: Record<string, unknown>): TriageInput | null {
  const step = params.step;
  if (step === undefined) return { kind: 'start' };
  if (typeof step !== 'string' || !CHIP_STEPS.has(step)) return null;
  if (step === 'printer') {
    const model = params.model === 'other' ? 'other' : (MODEL_TOKENS as readonly string[]).includes(String(params.model)) ? (params.model as ModelToken) : null;
    if (!model) return null;
    const unit = typeof params.unit_id === 'string' && UNIT_SHAPE.test(params.unit_id) ? params.unit_id : undefined;
    return { kind: 'printer', model, ...(unit ? { unit_id: unit } : {}) };
  }
  if (step === 'symptom') {
    return (SYMPTOM_KEYS as readonly string[]).includes(String(params.symptom)) ? { kind: 'symptom', symptom: params.symptom as SymptomKey } : null;
  }
  if (step === 'outcome') {
    return params.outcome === 'resolved' || params.outcome === 'not_fixed' ? { kind: 'outcome', outcome: params.outcome } : null;
  }
  return step === 'talk' ? { kind: 'talk' } : { kind: 'change_printer' };
}

const chip = (label: string, params: Record<string, string>): AssistChoice => ({ label, intent: 'printer_problem', params });

// ═════════════════════════════════════════════════════════════ triage

/** The viewer's own printers, or none (anonymous, or a database without the tables). */
async function myPrinters(db: D1Database, viewer: Viewer): Promise<MyPrinter[]> {
  if (!viewer.userId) return [];
  try {
    const r = await callTool('devices.mine', db, viewer, {});
    return r.ok ? r.data : [];
  } catch {
    return [];
  }
}

async function runTriage(db: D1Database, viewer: Viewer, ctx: AssistContext, input: TriageInput, render: CardRenderer): Promise<TurnOutcome> {
  // A device id arrives from a chip or a carried context; it is kept only when
  // it is one of THIS viewer's printers, of the model it claims to be.
  let checked = input;
  if (input.kind === 'printer' && input.unit_id) {
    const mine = await myPrinters(db, viewer);
    const own = mine.find((p) => p.unit_id === input.unit_id && p.model === input.model);
    checked = own ? input : { kind: 'printer', model: input.model, ...(input.symptom ? { symptom: input.symptom } : {}) };
  }
  const { step, context } = nextTriage(ctx, checked);
  // A printer fault is not the answer to «which printer is the nozzle for?»: that size waits no longer.
  delete context.size;
  const reply = await replyFor(db, viewer, step, context, render);
  // The parts a step answer showed are what the team sees as «products shown».
  if (step.kind === 'steps') {
    const shown = (reply.cards ?? []).map((card) => card.product_id).filter((id): id is string => typeof id === 'string');
    if (shown.length) context.shown = shown.slice(0, SHOWN_MAX);
    else delete context.shown;
  }
  return { reply, context };
}

async function replyFor(db: D1Database, viewer: Viewer, step: TriageStep, ctx: AssistContext, render: CardRenderer): Promise<AssistReply> {
  const loc = viewer.locale;
  switch (step.kind) {
    case 'ask_printer': {
      const [mine, listed] = await Promise.all([myPrinters(db, viewer), printerModelsSafe(db, viewer)]);
      // A family named («X1»): its printers only, the listed ones when the shop lists any.
      const among = step.among;
      const sold = CHIP_ORDER.filter((m) => listed.has(m) && (!among || among.includes(m)));
      const offered = among && sold.length === 0 ? among : sold;
      const choices: AssistChoice[] = [];
      for (const p of mine.filter((d) => !among || among.includes(d.model)).slice(0, DEVICE_CHIPS_MAX)) {
        choices.push(chip(tr(loc, 'printer_mine', { name: p.label }), { step: 'printer', model: p.model, unit_id: p.unit_id }));
      }
      for (const model of offered) choices.push(chip(model, { step: 'printer', model }));
      choices.push(chip(tr(loc, 'printer_other'), { step: 'printer', model: 'other' }));
      const text = step.symptom ? tr(loc, 'printer_which_symptom', { symptom: symptomDef(step.symptom).label[loc] }) : tr(loc, 'printer_which');
      return { intent: 'printer_problem', text, choices };
    }
    case 'ask_symptom': {
      const text = step.model === 'other' ? tr(loc, 'symptom_which_other') : tr(loc, 'symptom_which', { printer: step.model });
      const choices = SYMPTOMS.map((s) => chip(s.label[loc], { step: 'symptom', symptom: s.key }));
      choices.push(chip(tr(loc, 'change_printer'), { step: 'change_printer' }));
      return { intent: 'printer_problem', text, choices };
    }
    case 'steps': {
      const def = symptomDef(step.symptom);
      const label = def.label[loc];
      let text = step.model === 'other' ? tr(loc, 'steps_intro_other', { symptom: label }) : tr(loc, 'steps_intro', { symptom: label, printer: step.model });
      if (step.code) text = `${text} ${tr(loc, 'hms_code_noted', { code: step.code })}`;
      const keys = new Set(shownStepKeys(step.symptom, step.code));
      const steps = def.steps.filter((s) => keys.has(s.key)).map((s) => ({ key: s.key, text: s.text[loc], ...(s.safety ? { safety: s.safety } : {}) }));
      const cards = def.fix && step.model !== 'other' ? await fixCards(db, viewer, step.model, def.fix, render) : [];
      const wiki = wikiFor(def, step.model);
      return {
        intent: 'printer_problem',
        text,
        steps,
        ...(cards.length ? { cards } : {}),
        ...(wiki ? { links: [{ label: tr(loc, 'wiki_link'), to: wiki, external: true }] } : {}),
        choices: [
          chip(tr(loc, 'outcome_resolved'), { step: 'outcome', outcome: 'resolved' }),
          chip(tr(loc, 'outcome_not_fixed'), { step: 'outcome', outcome: 'not_fixed' }),
          chip(tr(loc, 'talk_team'), { step: 'talk' }),
          chip(tr(loc, 'change_printer'), { step: 'change_printer' }),
        ],
      };
    }
    case 'resolved':
      return { intent: 'printer_problem', text: tr(loc, 'resolved_reply') };
    case 'handoff': {
      // The device rides along only when it is still this viewer's own.
      const unit = ctx.printer?.unit_id;
      const mine = unit ? await myPrinters(db, viewer) : [];
      const ownUnit = unit && mine.some((p) => p.unit_id === unit) ? unit : undefined;
      const draft = buildTicketDraft(
        {
          model: step.model,
          symptom: step.symptom,
          ...(step.code ? { code: step.code } : {}),
          ...(ownUnit ? { unit_id: ownUnit } : {}),
          ...(ctx.shown ? { shown: ctx.shown } : {}),
        },
        loc
      );
      if (!viewer.userId) {
        return {
          intent: 'printer_problem',
          text: `${tr(loc, 'handoff_reply')} ${tr(loc, 'handoff_sign_in')}`,
          handoff: true,
          auth_required: true,
          ticket_draft: draft,
          links: [{ label: tr(loc, 'sign_in'), to: '/auth' }],
        };
      }
      return { intent: 'printer_problem', text: tr(loc, 'handoff_reply'), handoff: true, ticket_draft: draft };
    }
  }
}

async function printerModelsSafe(db: D1Database, viewer: Viewer): Promise<Map<ModelToken, string[]>> {
  try {
    const r = await callTool('catalog.printerModels', db, viewer, {});
    return r.ok ? r.data : new Map();
  } catch {
    return new Map();
  }
}

/** The text a product carries for the by-name check: its names and its option and colour names. */
function namedText(row: Record<string, unknown>): string {
  const parts = [row.name, row.name_ar, row.name_ku].map((v) => String(v ?? ''));
  for (const field of [row.options, row.colors]) {
    let list: unknown = field;
    if (typeof field === 'string') {
      try {
        list = JSON.parse(field);
      } catch {
        list = [];
      }
    }
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      if (typeof o !== 'object' || o === null) continue;
      const r = o as Record<string, unknown>;
      parts.push(String(r.name_en ?? r.name ?? ''), String(r.name_ar ?? ''), String(r.name_ckb ?? r.name_ku ?? ''));
    }
  }
  return parts.join(' ');
}

/**
 * The products that fix a symptom on a printer: linked to it first; failing a
 * link, those that name it. Nothing when neither, and never another printer's.
 */
async function fixCards(
  db: D1Database,
  viewer: Viewer,
  model: ModelToken,
  fix: { terms: string; category?: 'cat_maint' },
  render: CardRenderer
): Promise<AssistCard[]> {
  const found = await forPrinters(db, viewer, [model], fix.terms, fix.category);
  return found.items.slice(0, CARDS_MAX).map((i) => render.card(viewer.locale, i.card, i.row));
}

interface PrinterSearch {
  items: CatalogItem[];
  mode: 'linked' | 'named' | 'none';
  exactMiss: string[];
  /** The printers the answer names: «A1», or a family's listed printers «X1C / X1E». */
  label: string;
}

/**
 * The parts for one printer, or for any printer of a family («X1»): linked
 * to one of them first; failing a link, those that name one of them.
 */
async function forPrinters(
  db: D1Database,
  viewer: Viewer,
  models: readonly ModelToken[],
  text: string,
  category?: 'cat_maint'
): Promise<PrinterSearch> {
  const listed = await printerModelsSafe(db, viewer);
  const sold = models.filter((m) => listed.has(m));
  const label = (sold.length ? sold : models).join(' / ');
  // Every printer of the family keeps a slug under the cap: taken in turns, not the first printer's all.
  const lists = sold.map((m) => listed.get(m) ?? []);
  const slugs: string[] = [];
  for (let i = 0; slugs.length < FITS_MAX && lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length && slugs.length < FITS_MAX && !slugs.includes(l[i])) slugs.push(l[i]);
  }
  const scopes: Array<'cat_maint' | undefined> = category ? [category, undefined] : [undefined];
  let exactMiss: string[] = [];
  if (slugs.length) {
    for (const scope of scopes) {
      const r = await callTool('catalog.search', db, viewer, { text, fits: slugs, ...(scope ? { category: scope } : {}), limit: CARDS_MAX });
      if (r.ok && r.data.items.length) return { items: r.data.items, mode: 'linked', exactMiss: r.data.exactMiss, label };
      if (r.ok) exactMiss = r.data.exactMiss;
    }
  }
  for (const scope of scopes) {
    const r = await callTool('catalog.search', db, viewer, { text, ...(scope ? { category: scope } : {}), limit: 8 });
    if (!r.ok) continue;
    exactMiss = r.data.exactMiss;
    const named = r.data.items.filter((i) => models.some((m) => mentionsModel(namedText(i.row), m)));
    if (named.length) return { items: named, mode: 'named', exactMiss, label };
  }
  return { items: [], mode: 'none', exactMiss, label };
}

// ═════════════════════════════════════════════════════════════ products

const LABEL_INTENTS = new Set(['price_question', 'stock_question']);

async function products(
  db: D1Database,
  viewer: Viewer,
  u: Understood,
  ctx: AssistContext,
  render: CardRenderer,
  intentHint: string | null,
  opts: { anyPrinter?: boolean } = {}
): Promise<TurnOutcome> {
  const loc = viewer.locale;
  const remembered = ctx.printer && ctx.printer.model !== 'other' ? ctx.printer.model : undefined;
  // The printer chosen earlier in the conversation applies to PART questions
  // only, and never when this sentence named a printer that could not be read
  // («نوزل مال زد ون»): that is asked, not guessed. A family named («X1») is
  // all of its printers; «another printer» is none of the shop's.
  const model: ModelToken | undefined = u.model ?? (u.part && !u.printerUnread && !u.family && !opts.anyPrinter ? remembered : undefined);
  if (!model && u.part && u.printerUnread && !u.otherBrand && !opts.anyPrinter) return askPartPrinter(db, viewer, u, u.part, ctx);
  const printers: readonly ModelToken[] = model ? [model] : (u.family?.members ?? []);
  const fault = !!u.part && u.problemCue;
  const category = fault || u.maintenance ? ('cat_maint' as const) : undefined;
  const terms = u.part ? (fault ? PART_FIX_TERMS[u.part] : PART_TERMS[u.part]) : '';
  // The printer is a FILTER (the catalogue link, or the by-name check), not a
  // search word: «A1» in the query would rank every part that merely names the
  // A1 (the A1 hotend, for a question about plates) as an answer. It is a word
  // only when nothing else names what is wanted.
  const named = [terms, ...u.residual].filter(Boolean);
  const printerWord = model ?? u.family?.name;
  const words = [...named, ...(printerWord && named.length === 0 ? [printerWord] : []), ...u.measures].join(' ').slice(0, 99);

  let items: CatalogItem[] = [];
  let mode: PrinterSearch['mode'] | 'plain' = 'none';
  let exactMiss: string[] = [];
  let label = '';
  if (printers.length) {
    const found = await forPrinters(db, viewer, printers, words, category);
    items = found.items;
    mode = found.mode;
    exactMiss = found.exactMiss;
    label = found.label;
  } else {
    for (const scope of category ? [category, undefined] : [undefined]) {
      if (!words && !scope) break;
      const r = await callTool('catalog.search', db, viewer, { text: words, ...(scope ? { category: scope } : {}), limit: CARDS_MAX });
      if (!r.ok) continue;
      exactMiss = r.data.exactMiss;
      if (r.data.items.length) {
        items = r.data.items;
        mode = 'plain';
        break;
      }
    }
  }

  const intent = intentHint && LABEL_INTENTS.has(intentHint) ? intentHint : 'product_search';
  const partLabel = u.part ? PART_LABELS[u.part][loc] : '';
  const sentences: string[] = [];
  for (const code of exactMiss.slice(0, 2)) sentences.push(tr(loc, 'exact_miss', { code }));
  if (mode === 'linked') sentences.push(fault ? tr(loc, 'maint_intro_printer', { part: partLabel, printer: label }) : tr(loc, 'parts_for_printer', { printer: label }));
  else if (mode === 'named') sentences.push(tr(loc, 'parts_by_name', { printer: label }));
  else if (mode === 'plain' && fault) sentences.push(tr(loc, 'maint_intro', { part: partLabel }));
  else if (mode === 'plain' && opts.anyPrinter && partLabel) sentences.push(tr(loc, 'parts_any_printer', { part: partLabel }));
  else if (mode === 'plain') sentences.push(tr(loc, 'products_intro'));
  else if (printers.length) sentences.push(tr(loc, 'parts_none_for_printer', { printer: label }));
  else sentences.push(tr(loc, 'products_none'));
  if (items.length && u.measures.length) sentences.push(tr(loc, 'measure_note', { size: u.measures.join(' / ') }));

  const cards = items.slice(0, CARDS_MAX).map((i) => render.card(loc, i.card, i.row));
  const next: AssistContext = { ...ctx };
  dropPendingQuestion(next);
  delete next.size;
  if ((u.printerUnread || u.family) && !u.model) delete next.printer;
  if (u.part) {
    next.part = u.part;
    if (model) next.printer = { model, ...(ctx.printer?.model === model && ctx.printer.unit_id ? { unit_id: ctx.printer.unit_id } : {}) };
    else if (opts.anyPrinter) next.printer = { model: 'other' };
  }
  const shown = items.slice(0, SHOWN_MAX).map((i) => i.id);
  if (shown.length) next.shown = shown;
  else delete next.shown;

  const reply: AssistReply = { intent, text: sentences.join(' '), ...(cards.length ? { cards } : {}) };
  if (!cards.length) {
    const q = [terms, ...u.measures].filter(Boolean).join(' ');
    reply.choices = [
      ...(q ? [{ label: tr(loc, 'all_results'), intent: 'product_search' as const, params: { q } }] : []),
      { label: tr(loc, 'talk_team'), intent: 'human_handoff' as const },
    ];
  }
  return { reply, context: next };
}

/**
 * «لأي طابعة تريد النوزل؟» — a part question whose printer was named and not
 * read. The chips are the printers the shop lists and «طابعة أخرى»; each
 * carries the part and the size back, so the answer is the question asked
 * again with that printer. The context keeps the part and the size and drops
 * the printer, so a typed «A1» answers it too, with the same size.
 */
async function askPartPrinter(db: D1Database, viewer: Viewer, u: Understood, part: PartKey, ctx: AssistContext): Promise<TurnOutcome> {
  const loc = viewer.locale;
  const listed = await printerModelsSafe(db, viewer);
  const size = u.measures.find((m) => SIZE_SHAPE.test(m));
  const carried: Record<string, string> = size ? { size } : {};
  const choices: AssistChoice[] = [];
  for (const model of CHIP_ORDER) if (listed.has(model)) choices.push(chip(model, { step: 'part', part, model, ...carried }));
  choices.push(chip(tr(loc, 'printer_other'), { step: 'part', part, model: 'other', ...carried }));
  const next: AssistContext = { ...withoutPrinter(ctx), part, ...carried };
  if (!size) delete next.size;
  dropPendingQuestion(next);
  return { reply: { intent: 'product_search', text: tr(loc, 'part_printer_which', { part: PART_LABELS[part][loc] }), choices }, context: next };
}
