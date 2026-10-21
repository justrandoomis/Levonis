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
import { SHOWN_MAX } from './context';
import { buildTicketDraft, shownStepKeys } from './handoff';
import { callTool } from './registry';
import { tr } from './strings';
import type { CatalogItem } from './tools/catalog';
import type { MyPrinter } from './tools/devices';
import { nextTriage, type TriageInput, type TriageStep } from './triage/flow';
import { SYMPTOMS, symptomDef, wikiFor } from './triage/symptoms';
import type { AssistCard, AssistChoice, AssistReply, CardRenderer, ModelToken, Viewer } from './types';
import { MODEL_TOKENS, SYMPTOM_KEYS, type SymptomKey } from './types';
import { mentionsModel, understand, type Understood } from './understand';
import { PART_FIX_TERMS, PART_LABELS, PART_TERMS } from './understand/lexicon';

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

export async function handleTurn(db: D1Database, viewer: Viewer, input: TurnInput, render: CardRenderer): Promise<TurnOutcome | null> {
  if (input.chip) {
    const triage = readChip(input.chip);
    if (!triage) return null;
    return runTriage(db, viewer, input.context, triage, render);
  }
  const text = input.text?.trim();
  if (!text) return null;
  // Account questions stay with the account handlers: «وين طلبي ORD-…».
  if (extractOrderId(text)) return null;

  const ctx = input.context;
  const u = understand(text, { expectSymptom: ctx.triage?.stage === 'symptom' });

  if (u.hmsCode) {
    if (ctx.printer) return runTriage(db, viewer, ctx, { kind: 'symptom', symptom: 'hms', code: u.hmsCode }, render);
    return runTriage(db, viewer, ctx, { kind: 'start', symptom: 'hms', code: u.hmsCode, ...(u.model ? { model: u.model } : {}) }, render);
  }
  if (ctx.triage?.stage === 'printer' && u.model) {
    return runTriage(db, viewer, ctx, { kind: 'printer', model: u.model, ...(u.symptom ? { symptom: u.symptom } : {}) }, render);
  }
  if (ctx.triage?.stage === 'symptom' && u.symptom) {
    if (u.model && u.model !== ctx.printer?.model) {
      return runTriage(db, viewer, ctx, { kind: 'start', model: u.model, symptom: u.symptom }, render);
    }
    return runTriage(db, viewer, ctx, { kind: 'symptom', symptom: u.symptom }, render);
  }
  if (u.symptom && !u.productCue) {
    return runTriage(db, viewer, ctx, { kind: 'start', symptom: u.symptom, ...(u.model ? { model: u.model } : {}) }, render);
  }
  if (u.problemCue && u.printerCue && !u.productCue && !u.part) {
    return runTriage(db, viewer, ctx, { kind: 'start', ...(u.model ? { model: u.model } : {}) }, render);
  }
  if (u.part || (u.maintenance && (u.model || u.productCue)) || (u.measures.length > 0 && (u.model || u.productCue))) {
    return products(db, viewer, u, ctx, render, input.intentHint ?? null);
  }
  return null;
}

// ═════════════════════════════════════════════════════════════ chips

const CHIP_STEPS = new Set(['printer', 'symptom', 'outcome', 'talk', 'change_printer']);
const UNIT_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

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
      const choices: AssistChoice[] = [];
      for (const p of mine.slice(0, DEVICE_CHIPS_MAX)) {
        choices.push(chip(tr(loc, 'printer_mine', { name: p.label }), { step: 'printer', model: p.model, unit_id: p.unit_id }));
      }
      for (const model of CHIP_ORDER) if (listed.has(model)) choices.push(chip(model, { step: 'printer', model }));
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
  const found = await forPrinter(db, viewer, model, fix.terms, fix.category);
  return found.items.slice(0, CARDS_MAX).map((i) => render.card(viewer.locale, i.card, i.row));
}

interface PrinterSearch {
  items: CatalogItem[];
  mode: 'linked' | 'named' | 'none';
  exactMiss: string[];
}

async function forPrinter(db: D1Database, viewer: Viewer, model: ModelToken, text: string, category?: 'cat_maint'): Promise<PrinterSearch> {
  const slugs = (await printerModelsSafe(db, viewer)).get(model) ?? [];
  const scopes: Array<'cat_maint' | undefined> = category ? [category, undefined] : [undefined];
  let exactMiss: string[] = [];
  if (slugs.length) {
    for (const scope of scopes) {
      const r = await callTool('catalog.search', db, viewer, { text, fits: slugs, ...(scope ? { category: scope } : {}), limit: CARDS_MAX });
      if (r.ok && r.data.items.length) return { items: r.data.items, mode: 'linked', exactMiss: r.data.exactMiss };
      if (r.ok) exactMiss = r.data.exactMiss;
    }
  }
  for (const scope of scopes) {
    const r = await callTool('catalog.search', db, viewer, { text, ...(scope ? { category: scope } : {}), limit: 8 });
    if (!r.ok) continue;
    exactMiss = r.data.exactMiss;
    const named = r.data.items.filter((i) => mentionsModel(namedText(i.row), model));
    if (named.length) return { items: named, mode: 'named', exactMiss };
  }
  return { items: [], mode: 'none', exactMiss };
}

// ═════════════════════════════════════════════════════════════ products

const LABEL_INTENTS = new Set(['price_question', 'stock_question']);

async function products(
  db: D1Database,
  viewer: Viewer,
  u: Understood,
  ctx: AssistContext,
  render: CardRenderer,
  intentHint: string | null
): Promise<TurnOutcome> {
  const loc = viewer.locale;
  const remembered = ctx.printer && ctx.printer.model !== 'other' ? ctx.printer.model : undefined;
  // The printer chosen earlier in the conversation applies to PART questions only.
  const model: ModelToken | undefined = u.model ?? (u.part ? remembered : undefined);
  const fault = !!u.part && u.problemCue;
  const category = fault || u.maintenance ? ('cat_maint' as const) : undefined;
  const terms = u.part ? (fault ? PART_FIX_TERMS[u.part] : PART_TERMS[u.part]) : '';
  // The printer is a FILTER (the catalogue link, or the by-name check), not a
  // search word: «A1» in the query would rank every part that merely names the
  // A1 (the A1 hotend, for a question about plates) as an answer. It is a word
  // only when nothing else names what is wanted.
  const named = [terms, ...u.residual].filter(Boolean);
  const words = [...named, ...(model && named.length === 0 ? [model] : []), ...u.measures].join(' ').slice(0, 99);

  let items: CatalogItem[] = [];
  let mode: PrinterSearch['mode'] | 'plain' = 'none';
  let exactMiss: string[] = [];
  if (model) {
    const found = await forPrinter(db, viewer, model, words, category);
    items = found.items;
    mode = found.mode;
    exactMiss = found.exactMiss;
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
  if (mode === 'linked') sentences.push(fault ? tr(loc, 'maint_intro_printer', { part: partLabel, printer: model! }) : tr(loc, 'parts_for_printer', { printer: model! }));
  else if (mode === 'named') sentences.push(tr(loc, 'parts_by_name', { printer: model! }));
  else if (mode === 'plain') sentences.push(fault ? tr(loc, 'maint_intro', { part: partLabel }) : tr(loc, 'products_intro'));
  else sentences.push(model ? tr(loc, 'parts_none_for_printer', { printer: model }) : tr(loc, 'products_none'));
  if (items.length && u.measures.length) sentences.push(tr(loc, 'measure_note', { size: u.measures.join(' / ') }));

  const cards = items.slice(0, CARDS_MAX).map((i) => render.card(loc, i.card, i.row));
  const next: AssistContext = { ...ctx };
  if (u.part) {
    next.part = u.part;
    if (model) next.printer = { model, ...(ctx.printer?.model === model && ctx.printer.unit_id ? { unit_id: ctx.printer.unit_id } : {}) };
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

