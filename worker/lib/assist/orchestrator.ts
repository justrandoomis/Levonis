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
import { extractOrderId, normalizeText } from '../assistantNlu';
import type { AssistContext } from './context';
import { ROWS_MAX, SEEN_MAX, SHOWN_MAX, SIZE_SHAPE } from './context';
import { buildTicketDraft, shownStepKeys } from './handoff';
import { callTool } from './registry';
import { tr } from './strings';
import { FITS_MAX, SEARCH_LIMIT_MAX, SEARCH_OFFSET_MAX, type CatalogItem, type CatalogSearchArgs } from './tools/catalog';
import type { MyPrinter } from './tools/devices';
import { nextTriage, ownedOnly, triagePrinter, type TriageInput, type TriageStep } from './triage/flow';
import { SYMPTOMS, symptomDef, wikiFor } from './triage/symptoms';
import type { AssistCard, AssistChoice, AssistReply, CardRenderer, ModelToken, PartKey, Viewer } from './types';
import { MODEL_TOKENS, PART_KEYS, SYMPTOM_KEYS, type SymptomKey } from './types';
import { mentionsModel, understand, type Understood } from './understand';
import { MODEL_NAME_WORDS } from './understand/models';
import { LINE_WORDS, PART_FIX_TERMS, PART_LABELS, PART_SYMPTOM, PART_TERMS } from './understand/lexicon';

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
  /**
   * A legacy question is waiting for this text («أي منتج تريد تقارنه؟», the
   * `expects` of the client): a text the scorer names no intent for is its answer,
   * so a bare «P1S» is left to it.
   */
  awaiting?: boolean;
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
/** The legacy intents a question about a printer by name may carry: «شكد سعر A1», «A1 متوفر؟», «ابحث عن A1». */
const NAMED_PRINTER_HINTS = new Set(['price_question', 'stock_question', 'product_search']);
/** The legacy intents «عندي اي ون», "I have an A1" or «A1م هەیە» may carry: a printer named, or the customer's own. */
const OWNED_PRINTER_HINTS = new Set([...NAMED_PRINTER_HINTS, ...PRINTER_ANSWER_HINTS]);

/**
 * A part question asked while the triage waits for «which printer?» or «which
 * symptom?» has changed the subject: the question is no longer pending, so a
 * later «A1» is not read as its answer. After the steps the triage stays, so
 * «بكم الهوت اند؟» and then «ما انحلت» still reach the ticket.
 */
function dropPendingQuestion(ctx: AssistContext): void {
  if (ctx.triage && (ctx.triage.stage === 'printer' || ctx.triage.stage === 'symptom')) delete ctx.triage;
  delete ctx.asking;
}

/** The context without the printer: a printer named and not read must not be answered for by the remembered one. */
function withoutPrinter(ctx: AssistContext): AssistContext {
  const out: AssistContext = { ...ctx };
  delete out.printer;
  return out;
}

/** The context with its triage no longer only the printer owned (`TriageState.owned`). */
function disowned(ctx: AssistContext): AssistContext {
  if (!ctx.triage?.owned) return ctx;
  const triage = { ...ctx.triage };
  delete triage.owned;
  return { ...ctx, triage };
}

/** A family whose printer this conversation already chose is that printer: «نوزل X1» after the X1C. */
function withRemembered(u: Understood, ctx: AssistContext): Understood {
  const chosen = ctx.printer?.model;
  if (!u.family || !chosen || chosen === 'other' || !u.family.members.includes(chosen)) return u;
  const out: Understood = { ...u, model: chosen, models: [chosen] };
  delete out.family;
  return out;
}

/**
 * What a typed answer carries besides the printer: the symptom it names, the
 * HMS code it holds, and the part a fault was named in when the symptom is
 * only the steps that part takes («مشكلة بالنوزل»).
 */
function triageExtras(
  symptom: SymptomKey | undefined,
  code: string | undefined,
  faultIn?: PartKey
): { symptom?: SymptomKey; code?: string; faultIn?: PartKey } {
  return { ...(symptom ? { symptom } : {}), ...(code ? { code } : {}), ...(symptom && faultIn ? { faultIn } : {}) };
}

export async function handleTurn(db: D1Database, viewer: Viewer, input: TurnInput, render: CardRenderer): Promise<TurnOutcome | null> {
  if (input.chip) {
    if (input.chip.step === 'part') {
      const asked = readPartChip(input.chip);
      return asked ? products(db, viewer, asked.u, input.context, render, null, { anyPrinter: asked.anyPrinter }) : null;
    }
    const triage = readChip(input.chip);
    if (!triage) return null;
    // «عندي اي ون» and then «تحدث مع الفريق»: no fault was ever named, so no
    // ticket says there is one. The plain handoff answers (review round 5).
    if (triage.kind === 'talk' && ownedOnly(input.context.triage)) return null;
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
  /** Nothing in the text but the answer: no shopping word, no account word, no size, no code. */
  const bare = !u.productCue && !u.accountCue && u.measures.length === 0 && u.codes.length === 0;
  // A printer named and not read, or a family named, is not the printer remembered from earlier.
  const known = (u.printerUnread || u.family) && !u.model ? withoutPrinter(ctx) : ctx;
  // «طابعتي X1»: the family's printers are the only chips.
  const among = u.family ? { among: u.family.members } : {};

  // ── The triage's pending question, answered. Only a text that carries
  //    nothing else is an answer: «شكد سعر A1» at «which printer?» is a price
  //    question, and «اكو خيوط PLA؟» at «which symptom?» a filament one. An
  //    HMS code typed with the answer («P1S وطلعلي رمز 0300-…») rides with it.
  // «نوزل مال اي ون» at «أي طابعة عندك؟» is a part question, not the answer: the parts are shown (below).
  const partQuestion = !!u.part && !u.problemCue && !u.symptom;
  if (stage === 'printer' && bare && !partQuestion && (hint === null || PRINTER_ANSWER_HINTS.has(hint))) {
    // «A1 بيها مشكلة» after «عندي طابعة»: a problem is now said, so the triage is no longer only the printer owned.
    const said = u.problemCue ? disowned(ctx) : ctx;
    const owned = said.triage?.owned ? { owned: true as const } : {};
    const extras = triageExtras(u.symptom ?? partFault(u), u.hmsCode, faultPart(u));
    // What was already said is held: the symptom, the code, and the part a fault was named in.
    const holding = () =>
      extras.symptom
        ? triageExtras(extras.symptom, extras.code ?? said.triage?.code, extras.faultIn)
        : triageExtras(said.triage?.symptom, extras.code ?? said.triage?.code, said.triage?.faultIn);
    if (u.model) return runTriage(db, viewer, said, { kind: 'printer', model: u.model, ...extras }, render);
    // «X1»: which of the family, holding what was already said.
    if (u.family) return runTriage(db, viewer, known, { kind: 'start', ...among, ...holding(), ...owned }, render);
    // «طابعتي», "my own printer": the one printer of this account; with several, or none
    // (a guest), the same question again, holding what was already said.
    if (u.ownPrinter) {
      const mine = await myPrinters(db, viewer);
      if (mine.length === 1) return runTriage(db, viewer, said, { kind: 'printer', model: mine[0].model, unit_id: mine[0].unit_id, ...extras }, render);
      return runTriage(db, viewer, said, { kind: 'start', ...holding(), ...owned }, render);
    }
    // «عندي طابعة كريالتي اندر 3», «طابعة أخرى»: a printer this shop does not list.
    if (u.otherPrinter || u.printerUnread) return runTriage(db, viewer, said, { kind: 'printer', model: 'other', ...extras }, render);
  }
  if (stage === 'symptom' && bare) {
    // While the triage asks for the symptom, «خيوط» alone is stringing, a
    // fault in a part is that part's symptom («مشكلة بالنوزل», or «النوزل»
    // alone → the clog path; «اريد نوزل» is a shopping question), and a fault
    // the steps do not cover (a leak) is «أخرى». A typed HMS code is the
    // symptom AND the code: «رمز خطأ 0300-…» is never asked for again.
    const ua = withRemembered(understand(text, { expectSymptom: true }), ctx);
    const partOnly = ua.part && (ua.problemCue || text.split(/\s+/).length === 1);
    const byPart = !ua.symptom && !ua.faultCue && partOnly ? ua.part : undefined;
    const symptom: SymptomKey | undefined = ua.symptom ?? (ua.faultCue ? 'other' : byPart ? PART_SYMPTOM[byPart] : undefined);
    if (symptom && (hint === null || hint === 'printer_problem' || ua.residual.length === 0)) {
      const code = ua.hmsCode ? { code: ua.hmsCode } : {};
      // «النوزل», «مشكلة بالنوزل»: the clog steps, and the part, never «انسداد النوزل», on the ticket.
      const fault = byPart ? { faultIn: byPart } : {};
      if (ua.model && ua.model !== ctx.printer?.model) {
        return runTriage(db, viewer, ctx, { kind: 'start', model: ua.model, symptom, ...code, ...fault }, render);
      }
      if (ua.family) return runTriage(db, viewer, withoutPrinter(ctx), { kind: 'start', among: ua.family.members, symptom, ...code, ...fault }, render);
      return runTriage(db, viewer, ctx, { kind: 'symptom', symptom, ...code, ...fault }, render);
    }
  }
  // «جربتها وما انحلّت», "still not fixed", «انحلت»: the chip's outcome, typed.
  // Typed, the steps are tried only when the customer says so («جربتها»), not by «نفس المشكله» alone (review round 5).
  if (stage === 'steps' && u.outcome && bare && (hint === null || OUTCOME_ANSWER_HINTS.has(hint))) {
    return runTriage(db, viewer, ctx, { kind: 'outcome', outcome: u.outcome, tried: u.triedSaid }, render);
  }

  // ── An HMS code typed after the steps, naming no other fault and no other
  //    printer: it joins the fault in hand («انسداد النوزل» and the code go to
  //    the team together), it does not replace it with a new HMS triage.
  const held = ctx.triage;
  if (
    u.hmsCode &&
    (stage === 'steps' || stage === 'done') &&
    held?.symptom &&
    held.symptom !== 'hms' &&
    ctx.printer &&
    !u.model &&
    !u.family &&
    (!u.wordSymptom || u.wordSymptom === 'hms' || u.wordSymptom === held.symptom)
  ) {
    return codeJoined(ctx, held.symptom, u.hmsCode, viewer.locale);
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
  // «عندي مشكلة بطلبية الاي ون», "something is wrong with my A1 order", "the
  // delivery of my P1S has stopped": the fault word is about an order, a
  // delivery, a return, a warranty or a payment. The account handlers answer
  // it; the printer triage never starts on it (review round 4.2).
  if (u.accountCue && u.problemCue && !u.productCue) return null;
  // «عندي مشكلة بالنوزل», «النوزل خربان»: a fault in a part takes the steps of
  // that part, and the customer is asked which printer. The part, not a symptom,
  // is what they said (`faultIn`). A fault the curated steps do not cover (a
  // leak) starts the triage without one.
  if (u.part && u.problemCue && !u.productCue) {
    const symptom = partFault(u);
    return runTriage(db, viewer, known, { kind: 'start', ...(symptom ? { symptom, faultIn: u.part } : {}), ...printer }, render);
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
    // Only as the answer to «لأي طابعة؟», or when a printer is named: after an
    // ordinary part search a bare «اكو غيرها؟» is "any others?", never a printer.
    if (u.otherPrinter && bare && !ctx.printer && (ctx.asking === 'part_printer' || u.printerCue || u.otherBrand)) {
      return products(db, viewer, answer, ctx, render, hint, { anyPrinter: true });
    }
    // «اكو غيرها؟», «اريد غيرها», "any other?" after the part cards: more of the same part,
    // for the same printer (or none), never «another printer».
    if (u.otherPrinter && bare && !u.otherBrand && !u.printerCue && ctx.shown?.length) {
      return moreOfPart(db, viewer, ctx, ctx.part, render);
    }
  }
  // "how much?", «شكد؟»: a price asked of the cards just shown, though the scorer named no intent.
  const followHint = hint ?? (u.priceAsk ? 'price_question' : null);
  // «شكد سعر الطابعة», "how much is the printer?" while the conversation is
  // about the A1: the A1 itself, as the storefront cards it. With no printer
  // remembered, the printer among the cards just shown when they show the
  // printers of one model ("how much is the first printer?" after «printers»);
  // otherwise the legacy price answer has the question. Asked about, that
  // printer is not remembered: it was only shown.
  if (
    followHint !== null &&
    FOLLOWUP_HINTS.has(followHint) &&
    u.printerCue &&
    !u.model &&
    !u.family &&
    !u.part &&
    !u.printerUnread &&
    !u.otherPrinter &&
    u.measures.length === 0 &&
    u.codes.length === 0 &&
    u.residual.length === 0
  ) {
    const model = ctx.printer && ctx.printer.model !== 'other' ? ctx.printer.model : await onePrinterShown(db, viewer, ctx.shown);
    const itself = model ? await printerItself(db, viewer, ctx, model, followHint, render) : null;
    if (itself) return itself;
  }
  // «شكد سعره؟», «متوفر؟», «الاول بكم»: the products just shown, read again
  // through the card builder, so the price is still the grid's. Never when
  // the question names a printer: «شكد سعر الطابعة» after the A1 nozzles asks
  // about a printer, not about the nozzles.
  if (
    ctx.shown?.length &&
    followHint !== null &&
    FOLLOWUP_HINTS.has(followHint) &&
    !u.part &&
    !u.model &&
    !u.printerCue &&
    !u.printerUnread &&
    u.measures.length === 0 &&
    u.codes.length === 0 &&
    u.residual.length === 0
  ) {
    return shownAgain(db, viewer, ctx, u.ordinal, followHint, render);
  }

  // «شكد سعر A1», "how much is the A1?", «A1» or «طابعة» alone: a printer, and
  // nothing else. The printer itself leads, then what the search box finds by
  // its name; the parts alone never answer a question about the printer. A
  // text that may answer a pending question («أي طابعة عندك؟», a legacy
  // `expects`) is left to that question.
  const triageAsking = stage === 'printer' || stage === 'symptom';
  // "how much is my A1", "is my A1 in stock": a price or a stock ask is a shopping question, whoever owns the printer (review round 5).
  const shopping = u.priceAsk || (hint !== null && FOLLOWUP_HINTS.has(hint));
  if (printerOnly(u, shopping) && (hint === null ? !input.awaiting && !triageAsking : NAMED_PRINTER_HINTS.has(hint))) {
    const answer = await printerNamed(db, viewer, ctx, u, hint, render);
    if (answer) return answer;
  }
  // «عندي اي ون», «طابعتي A1», "I have an A1", «A1م هەیە», «پرینتەرێکم هەیە»: the
  // customer says which printer is theirs. Never that printer for sale (review
  // round 4.3): the triage asks what is wrong with it («ما المشكلة في طابعة
  // A1؟»), or which printer it is, and holds it as theirs. Only with no triage
  // in hand and no legacy question pending; otherwise the legacy answer has it.
  if (printerOwned(u, shopping) && (!stage || stage === 'done') && !input.awaiting && (hint === null || OWNED_PRINTER_HINTS.has(hint))) {
    return runTriage(db, viewer, known, { kind: 'start', ...printer, owned: true }, render);
  }

  const named = !!u.model || !!u.family;
  if (u.part || (u.maintenance && (named || u.productCue)) || (u.measures.length > 0 && (named || u.productCue))) {
    return products(db, viewer, u, known, render, hint);
  }
  return null;
}

/** The steps a fault in the named part takes: «مشكلة بالنوزل», the clog steps. Never for a fault the steps do not cover. */
function partFault(u: Understood): SymptomKey | undefined {
  return u.part && u.problemCue && !u.faultCue ? PART_SYMPTOM[u.part] : undefined;
}

/** The part a fault was named in, when no symptom was: the symptom is then only the steps it takes (`partFault`). */
function faultPart(u: Understood): PartKey | undefined {
  return !u.symptom && partFault(u) ? u.part : undefined;
}

/**
 * A printer named and nothing else: a model or a series («A1», «X1»), or the
 * printer word alone («طابعة», "printers"), with at most the words of a price
 * or stock question around it. No part, size, code, fault, account word,
 * bundle («A1 combo» is its own card) or second printer; and never a printer
 * the customer says is theirs («طابعتي A1», «عندي اي ون», "I have an A1",
 * «A1م هەیە»): that tells which printer they own, it does not ask to buy one
 * (review round 4.3, `printerOwned`). A price or stock ask (`shopping`: "how
 * much is my A1", "is my A1 in stock") is still about the printer itself,
 * whatever word of owning it carries (review round 5).
 */
function printerOnly(u: Understood, shopping: boolean): boolean {
  return printerAlone(u) && (!u.ownsPrinter || shopping);
}

/**
 * «عندي اي ون», "I have an A1", «پرینتەرێکم هەیە»: a printer, said to be the
 * customer's own, and nothing else. Never a price or stock ask: that is never
 * answered with «what is the problem?» (review round 5).
 */
function printerOwned(u: Understood, shopping: boolean): boolean {
  return printerAlone(u) && u.ownsPrinter && !u.productCue && !shopping;
}

/** The shape `printerOnly` and `printerOwned` share: a printer, or the printer word, and nothing else. */
function printerAlone(u: Understood): boolean {
  return (
    u.printerCue &&
    u.models.length <= 1 &&
    !u.part &&
    !u.symptom &&
    !u.hmsCode &&
    !u.problemCue &&
    !u.accountCue &&
    !u.maintenance &&
    !u.printerUnread &&
    !u.otherPrinter &&
    !u.ownPrinter &&
    !u.correction &&
    !u.bundle &&
    u.ordinal === undefined &&
    u.measures.length === 0 &&
    u.codes.length === 0 &&
    u.residual.length === 0
  );
}

/**
 * «شكد سعر A1», "price of the A1", «A1» (review round 4.2). The storefront
 * search for «A1» ranks five A1 parts above the A1 itself, so the answer was
 * spare parts and never the printer. The printer comes first, as the shop
 * lists it (new before refurbished, `catalog.printersOf`), and what the search
 * finds by the same name follows. A series («X1») is its listed printers, one
 * of each; the printer word alone («طابعة») one of each printer the shop
 * lists. Null when the shop lists none: the legacy answer stands. Shown, the
 * printer is remembered as browsed, as a shopping answer that names it is.
 */
async function printerNamed(
  db: D1Database,
  viewer: Viewer,
  ctx: AssistContext,
  u: Understood,
  hint: string | null,
  render: CardRenderer
): Promise<TurnOutcome | null> {
  const loc = viewer.locale;
  const model = u.model;
  let label: string = model ?? '';
  let printers: CatalogItem[] = [];
  if (model) {
    const r = await callTool('catalog.printersOf', db, viewer, { model });
    printers = r.ok ? r.data : [];
  } else {
    const listed = await printerModelsSafe(db, viewer);
    const models = CHIP_ORDER.filter((m) => listed.has(m) && (!u.family || u.family.members.includes(m)));
    if (u.family) label = models.join(' / ');
    if (models.length) {
      const r = await callTool('catalog.printerLineup', db, viewer, { models });
      printers = r.ok ? r.data : [];
    }
  }
  if (printers.length === 0) return null;
  // What the search box finds by the own name of the printer follows; the printer is never shown twice.
  const words = model ?? u.family?.name;
  let rows: CatalogItem[] = [];
  if (words && printers.length < CARDS_MAX) {
    const r = await callTool('catalog.search', db, viewer, { text: words, limit: CARDS_MAX });
    rows = r.ok ? r.data.items.filter((i) => !printers.some((p) => p.id === i.id)) : [];
  }
  const items = [...printers, ...rows].slice(0, CARDS_MAX);
  const text = !words
    ? tr(loc, 'printers_listed')
    : items.length > printers.length
      ? tr(loc, 'printer_named', { printer: label })
      : tr(loc, 'printer_itself', { printer: label });
  // A shopping answer, as the legacy answers are (`send` in the route): it ends the triage, so a printer
  // only browsed never stands in a ticket for the one the customer chose.
  const next: AssistContext = { ...ctx, shown: items.slice(0, SHOWN_MAX).map((i) => i.id) };
  delete next.triage;
  delete next.asking;
  delete next.size;
  if (model && ctx.printer?.model !== model) next.printer = { model, browsed: true };
  const intent = hint && LABEL_INTENTS.has(hint) ? hint : 'product_search';
  return { reply: { intent, text, cards: items.map((i) => render.card(loc, i.card, i.row)) }, context: next };
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
  delete next.size;
  return { reply: { intent: hint, text: tr(loc, 'printer_itself', { printer: model }), cards }, context: next };
}

/** The one model whose listed printers the last answer showed, if exactly one; none on any failure. */
async function onePrinterShown(db: D1Database, viewer: Viewer, shown: readonly string[] | undefined): Promise<ModelToken | undefined> {
  if (!shown?.length) return undefined;
  try {
    const r = await callTool('catalog.printerModelsOf', db, viewer, { ids: [...shown] });
    return r.ok && r.data.length === 1 ? r.data[0] : undefined;
  } catch {
    return undefined;
  }
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
  const next: AssistContext = { ...ctx };
  delete next.asking;
  delete next.size;
  return { reply: { intent: hint, text, ...(cards.length ? { cards } : {}) }, context: next };
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
    accountCue: false,
    faultCue: false,
    printerCue: true,
    printerUnread: false,
    otherBrand: false,
    otherPrinter: false,
    correction: false,
    ownPrinter: false,
    ownsPrinter: false,
    triedSaid: false,
    priceAsk: false,
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

/** What the customer can say after the steps: fixed, not fixed, the team, another printer. */
const stepsChoices = (loc: Viewer['locale']): AssistChoice[] => [
  chip(tr(loc, 'outcome_resolved'), { step: 'outcome', outcome: 'resolved' }),
  chip(tr(loc, 'outcome_not_fixed'), { step: 'outcome', outcome: 'not_fixed' }),
  chip(tr(loc, 'talk_team'), { step: 'talk' }),
  chip(tr(loc, 'change_printer'), { step: 'change_printer' }),
];

/**
 * «وطلعلي رمز 0300-…» after the clog steps: the code is added to the fault in
 * hand. The symptom, the printer and the parts shown stay as they were, so the
 * ticket says both «انسداد النوزل» and the code.
 */
function codeJoined(ctx: AssistContext, symptom: SymptomKey, code: string, loc: Viewer['locale']): TurnOutcome {
  const next: AssistContext = { ...ctx, triage: { ...ctx.triage!, symptom, code } };
  delete next.asking;
  delete next.size;
  // The fault as the customer gave it: «النوزل», when a part was named and no symptom.
  const faultIn = ctx.triage?.faultIn;
  const said = faultIn ? PART_LABELS[faultIn][loc] : symptomDef(symptom).label[loc];
  return {
    reply: { intent: 'printer_problem', text: tr(loc, 'hms_code_joined', { code, symptom: said }), choices: stepsChoices(loc) },
    context: next,
  };
}

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
  // «مشكلة بالنوزل بطابعة X1» where the shop lists one printer of the series
  // (and the customer owns no other of it): that printer, not a question with
  // one chip in it. The A2 series is read the same way, as the A2L.
  if (input.kind === 'start' && !input.model && input.among?.length && !triagePrinter(ctx)) {
    const [mine, listed] = await Promise.all([myPrinters(db, viewer), printerModelsSafe(db, viewer)]);
    const among = input.among;
    const candidates = [...new Set([...among.filter((m) => listed.has(m)), ...mine.map((p) => p.model).filter((m) => among.includes(m))])];
    if (candidates.length === 1) {
      const only: TriageInput = { ...input, model: candidates[0] };
      delete only.among;
      checked = only;
    }
  }
  const { step, context } = nextTriage(ctx, checked);
  // A printer fault is not the answer to «which printer is the nozzle for?»: that size waits no longer.
  delete context.size;
  delete context.asking;
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
      // «مشكلة بالنوزل»: the echo says the part the customer named, never the symptom its steps are for.
      const text = step.faultIn
        ? tr(loc, 'printer_which_part', { part: PART_LABELS[step.faultIn][loc] })
        : step.symptom
          ? tr(loc, 'printer_which_symptom', { symptom: symptomDef(step.symptom).label[loc] })
          : tr(loc, 'printer_which');
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
      const part = step.faultIn ? PART_LABELS[step.faultIn][loc] : '';
      let text = part
        ? step.model === 'other'
          ? tr(loc, 'steps_intro_part_other', { part })
          : tr(loc, 'steps_intro_part', { part, printer: step.model })
        : step.model === 'other'
          ? tr(loc, 'steps_intro_other', { symptom: label })
          : tr(loc, 'steps_intro', { symptom: label, printer: step.model });
      // The note first: the intro ends with «بالترتيب:», and what follows the colon is the steps.
      if (step.code) text = `${tr(loc, 'hms_code_noted', { code: step.code })} ${text}`;
      const keys = new Set(shownStepKeys(step.symptom, step.code));
      const steps = def.steps.filter((s) => keys.has(s.key)).map((s) => ({ key: s.key, text: s.text[loc], ...(s.safety ? { safety: s.safety } : {}) }));
      const cards = def.fix && step.model !== 'other' ? await fixCards(db, viewer, step.model, def.fix, render, SYMPTOM_HEAD[step.symptom]) : [];
      const wiki = wikiFor(def, step.model);
      return {
        intent: 'printer_problem',
        text,
        steps,
        ...(cards.length ? { cards } : {}),
        ...(wiki ? { links: [{ label: tr(loc, 'wiki_link'), to: wiki, external: true }] } : {}),
        choices: stepsChoices(loc),
      };
    }
    case 'resolved':
      return { intent: 'printer_problem', text: tr(loc, 'resolved_reply') };
    case 'handoff': {
      // The device rides along only with the printer the triage chose, and only while it is still this viewer's own.
      const unit = step.model && ctx.printer?.model === step.model && !ctx.printer.browsed ? ctx.printer.unit_id : undefined;
      const mine = unit ? await myPrinters(db, viewer) : [];
      const ownUnit = unit && mine.some((p) => p.unit_id === unit) ? unit : undefined;
      const draft = buildTicketDraft(
        {
          ...(step.model ? { model: step.model } : {}),
          ...(step.symptom ? { symptom: step.symptom } : {}),
          ...(step.faultIn ? { faultIn: step.faultIn } : {}),
          tried: step.tried,
          ...(step.shownSteps ? { shownSteps: true } : {}),
          ...(step.code ? { code: step.code } : {}),
          ...(ownUnit ? { unit_id: ownUnit } : {}),
          ...(ctx.shown ? { shown: ctx.shown } : {}),
        },
        loc
      );
      // «فيها الطابعة والمشكلة والخطوات التي جربتها» only when all three are in it: steps only shown are not tried.
      const full = step.tried && !!step.model && !!step.symptom;
      if (!viewer.userId) {
        return {
          intent: 'printer_problem',
          text: tr(loc, full ? 'handoff_reply_guest' : 'handoff_reply_said_guest'),
          handoff: true,
          auth_required: true,
          ticket_draft: draft,
          links: [{ label: tr(loc, 'sign_in'), to: '/auth' }],
        };
      }
      return { intent: 'printer_problem', text: tr(loc, full ? 'handoff_reply' : 'handoff_reply_said'), handoff: true, ticket_draft: draft };
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
  render: CardRenderer,
  head?: Head
): Promise<AssistCard[]> {
  const found = await forPrinters(db, viewer, [model], fix.terms, fix.category, head);
  return found.items.slice(0, CARDS_MAX).map((i) => render.card(viewer.locale, i.card, i.row));
}

/**
 * THE PART ITSELF FIRST. «نوزل مال اي ون» listed the A1 hotend sixth, after a
 * sponge, a sock and a fan, and the clog steps («استبدل الهوت إند، القطع
 * المناسبة أدناه») showed six cleaning items and no hotend at all: the search
 * ranks every word of «hotend nozzle cleaning needle» alike. A product whose
 * own name is the part comes first, and when none made the page, the part is
 * asked for alone, under the same printer link, and put first.
 */
interface Head {
  /**
   * The catalogue words for the part, each searched alone in turn until one
   * finds the part itself. «hotend» alone ranks eight accessories named after
   * it («Induction Hotend Rack Frame», «Cooling Fan for Hotend») above every
   * hotend of the live catalogue; the Arabic name the hotends carry («هوت إند
   * Bambu Lab - …») and the plural reach them.
   */
  terms: readonly string[];
  /**
   * The part as the HEAD of a product's own (source) name: the last word, or
   * followed only by a size, a dash or «Kit» («Bambu Hotend - A1/A2», «E3D …
   * Hotend», «Hardened Steel Nozzle 0.4mm»), never by what it is a part of
   * («Hotend Cooling Fan», «Nozzle Wiper», «Induction Hotend Rack Frame»).
   */
  name: RegExp;
  /** The part named as what an accessory is FOR: «Cooling Fan for Hotend - A2L», «Silicone Sock for Hotend». */
  accessory: RegExp;
}
const HOTEND_HEAD: Head = {
  terms: ['hotend', 'هوت إند', 'hotends'],
  name: /\b(?:hot\s?ends?|nozzles?)(?=\s*(?:$|[-\u2013\u2014(|/,:]|\d|kits?\b|sets?\b))/i,
  accessory: /\b(?:for|of|with|to)\b[^-\u2013\u2014(|/]*\b(?:hot\s?ends?|nozzles?)\b/i,
};
const PART_HEAD: Readonly<Partial<Record<PartKey, Head>>> = { nozzle_hotend: HOTEND_HEAD };
const SYMPTOM_HEAD: Readonly<Partial<Record<SymptomKey, Head>>> = { clog: HOTEND_HEAD };

/** True for a product whose own name is the part (not an accessory named after it). */
function headTest(head: Head): (i: CatalogItem) => boolean {
  return (i) => {
    const name = String(i.row.name ?? i.card.name ?? '');
    return head.name.test(name) && !head.accessory.test(name);
  };
}

/** `items` with the products named as the part first; failing one, the part searched alone, first. */
async function headFirst(
  db: D1Database,
  viewer: Viewer,
  items: CatalogItem[],
  head: Head,
  scope: { fits: string[]; category?: 'cat_maint' }
): Promise<CatalogItem[]> {
  const isHead = headTest(head);
  const heads = items.filter(isHead);
  if (heads.length) return [...heads, ...items.filter((i) => !isHead(i))];
  // The accessories named after the part («Hotend Cooling Fan») rank with it: a full page, then the part itself.
  for (const text of head.terms) {
    const r = await callTool('catalog.search', db, viewer, { text, fits: scope.fits, ...(scope.category ? { category: scope.category } : {}), limit: SEARCH_LIMIT_MAX });
    const found = r.ok ? r.data.items.filter((i) => isHead(i) && !items.some((x) => x.id === i.id)).slice(0, 2) : [];
    if (found.length) return [...found, ...items].slice(0, CARDS_MAX);
  }
  return items;
}

/** A product name, its options and colours, as words: normalised like the text, so «إند» is «اند». */
function nameWords(row: Record<string, unknown>): string[] {
  return normalizeText(namedText(row)).split(' ').filter(Boolean);
}

/**
 * The words of a query that say WHAT is wanted («hotend», «dryer», «فولاذ»):
 * not a printer name, not a size. A product a printer-name retry found must
 * carry one of them in its own name, or it was found by the printer word alone.
 */
function termWords(query: string): string[] {
  const printerWords = new Set(MODEL_TOKENS.flatMap((m) => [m.toLowerCase().replace(/\s+/g, ''), ...MODEL_NAME_WORDS[m].flat()]));
  return normalizeText(query)
    .split(' ')
    .filter((w) => w.length >= 3 && !/^\d/.test(w) && !printerWords.has(w));
}

/** True when the product's own name carries one of `terms` (a prefix: «hotend» reaches «hotends»). */
function namesTerm(item: CatalogItem, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const words = nameWords(item.row);
  return terms.some((t) => words.some((w) => w.startsWith(t) || (/[\u0600-\u06FF]/.test(t) && w.includes(t))));
}

/**
 * The words a product's name carries for a printer: «p1p», «p1». The by-name
 * fallback adds them to its query, so «Bambu Hotend - P1 Series» is among
 * the eight a general search returns for «نوزل P1P», not crowded out by them.
 */
function modelNameWords(models: readonly ModelToken[]): string {
  return [...new Set(models.flatMap((m) => MODEL_NAME_WORDS[m].filter((g) => g.length === 1).map((g) => g[0])))].join(' ');
}

interface PrinterSearch {
  items: CatalogItem[];
  mode: 'linked' | 'named' | 'none';
  exactMiss: string[];
  /** The printers the answer names: «A1», or a family's listed printers «X1C / X1E». */
  label: string;
  /** With a page asked for: the listing row the page after this one starts at. */
  next?: number;
}

/** «اكو غيرها؟»: where the next page starts in the part's own listing, and every card already shown. */
interface NextPage {
  offset: number;
  exclude: ReadonlySet<string>;
}

/** The windows one «اكو غيرها؟» reads at most: enough to fill a page past three pages already shown. */
const PAGE_WINDOWS = 3;

/**
 * ONE PAGE OF A LISTING, past what was already shown. Read from `page.offset`
 * in windows of SEARCH_LIMIT_MAX until a page of cards is full or the listing
 * ends; a row already shown (or one `keep` refuses) is skipped, never shown
 * again. `next` is the row after the last one gone through, so the following
 * page starts there and no row is left behind: the cards a page put first from
 * another search («the part itself first») push no listing row off every page.
 */
async function pageOf(
  db: D1Database,
  viewer: Viewer,
  args: Pick<CatalogSearchArgs, 'text' | 'fits' | 'category'>,
  page: NextPage,
  keep: (i: CatalogItem) => boolean = () => true
): Promise<{ items: CatalogItem[]; next: number; exactMiss: string[] }> {
  const items: CatalogItem[] = [];
  let at = page.offset;
  let exactMiss: string[] = [];
  for (let window = 0; window < PAGE_WINDOWS && items.length < CARDS_MAX && at <= SEARCH_OFFSET_MAX; window++) {
    const r = await callTool('catalog.search', db, viewer, { ...args, limit: SEARCH_LIMIT_MAX, ...(at ? { offset: at } : {}) });
    if (!r.ok) break;
    if (window === 0) exactMiss = r.data.exactMiss;
    const rows = r.data.items;
    let used = 0;
    for (const item of rows) {
      used++;
      if (!page.exclude.has(item.id) && keep(item) && !items.some((x) => x.id === item.id)) items.push(item);
      if (items.length === CARDS_MAX) break;
    }
    at += used;
    if (rows.length < SEARCH_LIMIT_MAX) break;
  }
  return { items, next: Math.min(at, ROWS_MAX), exactMiss };
}

/**
 * The parts for one printer, or for any printer of a family («X1»): linked
 * to one of them first; failing a link, those that name one of them. With
 * `page`, the next page of the same, without the cards already shown.
 */
async function forPrinters(
  db: D1Database,
  viewer: Viewer,
  models: readonly ModelToken[],
  text: string,
  category?: 'cat_maint',
  head?: Head,
  page?: NextPage
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
    // The next page of linked parts; none, and no by-name guess stands in for it.
    if (page) {
      const next = await pageOf(db, viewer, { text, fits: slugs, ...(category ? { category } : {}) }, page);
      return { items: next.items, mode: next.items.length ? 'linked' : 'none', exactMiss: next.exactMiss, label, next: next.next };
    }
    for (const scope of scopes) {
      const r = await callTool('catalog.search', db, viewer, { text, fits: slugs, ...(scope ? { category: scope } : {}), limit: CARDS_MAX });
      const linked = r.ok ? r.data.items : [];
      if (linked.length) {
        const items = head ? await headFirst(db, viewer, linked, head, { fits: slugs, ...(scope ? { category: scope } : {}) }) : linked;
        return { items, mode: 'linked', exactMiss: r.ok ? r.data.exactMiss : [], label };
      }
      if (r.ok) exactMiss = r.data.exactMiss;
    }
  }
  // No link: the products that NAME one of the printers. Asked twice at most:
  // as typed, then with the printer's own name words added («p1p p1»). The
  // second query is the printer's words AND the part: what it finds by the
  // printer word alone («P1S Heatsink for MC Board» for «dryer p1s p1») is
  // not the part, and only a product whose name carries one of the asked
  // words is kept from it.
  const wanted = termWords(text);
  const queries = [text, `${text} ${modelNameWords(models)}`.trim().slice(0, 99)].filter((q, i, all) => q && all.indexOf(q) === i);
  const names = (words: string) => (i: CatalogItem) => models.some((m) => mentionsModel(namedText(i.row), m)) && (words === text || namesTerm(i, wanted));
  if (page) {
    // The next page of the products that name the printer, as the first page was read.
    for (const words of queries) {
      const next = await pageOf(db, viewer, { text: words }, page, names(words));
      if (next.items.length) return { items: next.items, mode: 'named', exactMiss: next.exactMiss, label, next: next.next };
    }
    return { items: [], mode: 'none', exactMiss, label };
  }
  for (const words of queries) {
    for (const scope of scopes) {
      const r = await callTool('catalog.search', db, viewer, { text: words, ...(scope ? { category: scope } : {}), limit: 8 });
      if (!r.ok) continue;
      if (words === text) exactMiss = r.data.exactMiss;
      const named = r.data.items.filter(names(words));
      if (named.length) {
        // The part itself first here too: «Bambu Hotend - P1 Series» before the wiper that names the P1.
        const isHead = head ? headTest(head) : () => false;
        return { items: [...named.filter(isHead), ...named.filter((i) => !isHead(i))], mode: 'named', exactMiss, label };
      }
    }
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
  let model: ModelToken | undefined = u.model ?? (u.part && !u.printerUnread && !u.family && !opts.anyPrinter ? remembered : undefined);
  if (!model && u.part && u.printerUnread && !u.otherBrand && !opts.anyPrinter) return askPartPrinter(db, viewer, u, u.part, ctx);
  // «نوزل مال نبتون فور»: a part for another maker's printer is any printer's part, with the check-the-page caveat.
  const anyPrinter = !!opts.anyPrinter || (!!u.part && u.otherBrand && !u.model);
  /**
   * «اكو نوزل E3D؟» after the A1 parts: a word that names a product LINE
   * (a maker or a line, «E3D», «V6», never a describing word like «جديد»,
   * «ستيل» or "high flow") decides before the remembered printer does. Those
   * products of the line linked to the printer come first; none linked, the
   * line's own products of this kind are shown, said to be not linked to the
   * printer. The printer stays remembered for the next question.
   */
  const lineWords = model && !u.model ? u.residual.filter(isLineWord) : [];
  const lineIds = lineWords.length ? await strongIds(db, viewer, lineWords.join(' ')) : new Set<string>();
  let printers: readonly ModelToken[] = model ? [model] : (u.family?.members ?? []);
  const fault = !!u.part && u.problemCue;
  const category = fault || u.maintenance ? ('cat_maint' as const) : undefined;
  // «ابرة تنظيف», «اسفنجة تنظيف النوزل»: the cleaning tool named is searched with the part.
  const base = u.part ? (fault ? PART_FIX_TERMS[u.part] : PART_TERMS[u.part]) : '';
  const terms = u.part === 'cleaning' && u.tool && !base.split(' ').includes(u.tool) ? `${base} ${u.tool}` : base;
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
  // The part itself first, when the question names nothing more particular
  // (no other word, and no size: «0.2» already narrows the answer to the parts that have it).
  const head = u.part && u.residual.length === 0 && u.measures.length === 0 && !fault ? PART_HEAD[u.part] : undefined;
  let found = printers.length ? await forPrinters(db, viewer, printers, words, category, head) : null;
  let lineAlone = '';
  if (found && lineIds.size) {
    const line = found.items.filter((i) => lineIds.has(i.id));
    if (line.length) found = { ...found, items: [...line, ...found.items.filter((i) => !lineIds.has(i.id))] };
    else {
      // None of the line is linked: the line's own products of this kind, and only those.
      const r = await callTool('catalog.search', db, viewer, { text: words, ...(category ? { category } : {}), limit: SEARCH_LIMIT_MAX });
      const kind = termWords(terms);
      const own = r.ok ? r.data.items.filter((i) => lineIds.has(i.id) && namesTerm(i, kind)) : [];
      if (own.length) {
        lineAlone = found.label;
        found = { items: own, mode: 'linked', exactMiss: r.ok ? r.data.exactMiss : [], label: found.label };
        model = undefined;
        printers = [];
      }
    }
  }
  /**
   * «اكو نوزل سنابميكر؟»: another maker, named. The shop sells parts of some
   * («Snapmaker U1 Hot End Nozzle»): that maker's own parts of the kind asked
   * come first, under the same check-the-page caveat. A maker the shop has no
   * product of is dropped from the search as before.
   */
  const makerItems = anyPrinter && u.part && u.makers?.length ? await makerParts(db, viewer, u.makers, terms) : [];
  if (found) {
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
        items = head ? await headFirst(db, viewer, r.data.items, head, { fits: [], ...(scope ? { category: scope } : {}) }) : r.data.items;
        mode = 'plain';
        break;
      }
    }
  }
  if (makerItems.length) {
    items = [...makerItems, ...items.filter((i) => !makerItems.some((m) => m.id === i.id))].slice(0, CARDS_MAX);
    if (mode === 'none') mode = 'plain';
  }

  const intent = intentHint && LABEL_INTENTS.has(intentHint) ? intentHint : 'product_search';
  const partLabel = u.part ? PART_LABELS[u.part][loc] : '';
  const sentences: string[] = [];
  for (const code of exactMiss.slice(0, 2)) sentences.push(tr(loc, 'exact_miss', { code }));
  if (lineAlone) sentences.push(tr(loc, 'line_not_linked', { line: lineWords.map(lineLabel).join(' '), printer: lineAlone }));
  else if (mode === 'linked') sentences.push(fault ? tr(loc, 'maint_intro_printer', { part: partLabel, printer: label }) : tr(loc, 'parts_for_printer', { printer: label }));
  else if (mode === 'named') sentences.push(tr(loc, 'parts_by_name', { printer: label }));
  else if (mode === 'plain' && fault) sentences.push(tr(loc, 'maint_intro', { part: partLabel }));
  else if (mode === 'plain' && anyPrinter && partLabel) sentences.push(tr(loc, 'parts_any_printer', { part: partLabel }));
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
    // A printer only browsed stays only browsed when this question did not name it.
    const same = ctx.printer?.model === model ? ctx.printer : undefined;
    if (model) next.printer = { model, ...(same?.unit_id ? { unit_id: same.unit_id } : {}), ...(same?.browsed && !u.model ? { browsed: true as const } : {}) };
    else if (opts.anyPrinter) next.printer = { model: 'other' };
  }
  const shown = items.slice(0, SHOWN_MAX).map((i) => i.id);
  if (shown.length) next.shown = shown;
  else delete next.shown;
  // A new part answer starts the «اكو غيرها؟» paging again: from the top of the part's own listing, past these cards.
  if (u.part && shown.length) next.more = { rows: 0, seen: shown };
  else delete next.more;

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

/** «e3d», «v6», «mk8»: a maker or a line, by its shape (letters and a digit) or by name (LINE_WORDS). */
const LINE_SET = new Set(LINE_WORDS);
const LINE_SHAPE = /^(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{2,8}$/;
function isLineWord(word: string): boolean {
  return LINE_SET.has(word) || LINE_SHAPE.test(word);
}
/** «e3d» → «E3D», «revo» → «Revo»: the line as the answer names it. */
function lineLabel(word: string): string {
  return /\d/.test(word) ? word.toUpperCase() : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/**
 * «اكو غيرها؟», "any other?" after the part cards: the next page of the same
 * part, for the printer the conversation is about (linked, or named when the
 * shop links none), or for none. It goes on from where the last page stopped
 * in the part's own listing (`ctx.more`), and no card shown for this part
 * before is shown again; a page that brings nothing new says so plainly, with
 * the full search one tap away. The printer is never turned into «another
 * printer».
 */
async function moreOfPart(db: D1Database, viewer: Viewer, ctx: AssistContext, part: PartKey, render: CardRenderer): Promise<TurnOutcome> {
  const loc = viewer.locale;
  const cursor = ctx.more ?? { rows: 0, seen: [] };
  const seen = [...new Set([...cursor.seen, ...(ctx.shown ?? [])])];
  const page: NextPage = { offset: cursor.rows, exclude: new Set(seen) };
  const model = ctx.printer && ctx.printer.model !== 'other' ? ctx.printer.model : undefined;
  const words = PART_TERMS[part];
  let items: CatalogItem[] = [];
  let next = cursor.rows;
  let text = '';
  if (model) {
    const found = await forPrinters(db, viewer, [model], words, undefined, undefined, page);
    items = found.items;
    next = found.next ?? next;
    if (found.mode === 'linked') text = tr(loc, 'more_for_printer', { printer: found.label });
    else if (found.mode === 'named') text = tr(loc, 'parts_by_name', { printer: found.label });
  } else {
    const found = await pageOf(db, viewer, { text: words }, page);
    items = found.items;
    next = found.next;
    text = tr(loc, 'more_results');
  }
  const cards = items.slice(0, CARDS_MAX).map((i) => render.card(loc, i.card, i.row));
  const nextCtx: AssistContext = { ...ctx };
  dropPendingQuestion(nextCtx);
  delete nextCtx.size;
  const shownNow = items.slice(0, SHOWN_MAX).map((i) => i.id);
  nextCtx.more = { rows: next, seen: [...seen, ...shownNow].slice(-SEEN_MAX) };
  if (!cards.length) {
    // Nothing new: the cards on screen stay the ones a «شكد سعره؟» reads again.
    return {
      reply: {
        intent: 'product_search',
        text: tr(loc, 'more_none'),
        choices: [
          { label: tr(loc, 'all_results'), intent: 'product_search', params: { q: words } },
          { label: tr(loc, 'talk_team'), intent: 'human_handoff' },
        ],
      },
      context: nextCtx,
    };
  }
  nextCtx.shown = shownNow;
  return { reply: { intent: 'product_search', text, cards }, context: nextCtx };
}

/** The parts of the kind `terms` names among the products of these makers (the strong lookup); none on any failure. */
async function makerParts(db: D1Database, viewer: Viewer, makers: readonly string[], terms: string): Promise<CatalogItem[]> {
  const kind = termWords(terms);
  const out: CatalogItem[] = [];
  // The maker's name alone, searched strictly: every product it reaches carries it.
  for (const words of makers.slice(0, 2)) {
    try {
      const r = await callTool('catalog.search', db, viewer, { text: words, limit: SEARCH_LIMIT_MAX, strong: true });
      for (const i of r.ok ? r.data.items : []) if (namesTerm(i, kind) && !out.some((x) => x.id === i.id)) out.push(i);
    } catch {
      /* the plain answer stands */
    }
  }
  return out.slice(0, CARDS_MAX);
}

/** The products every one of these words reaches (the strong lookup); none on any failure. */
async function strongIds(db: D1Database, viewer: Viewer, words: string): Promise<Set<string>> {
  try {
    const r = await callTool('catalog.search', db, viewer, { text: words, limit: 8, strong: true });
    return new Set(r.ok ? r.data.items.map((i) => i.id) : []);
  } catch {
    return new Set();
  }
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
  // The question is now pending: a typed «طابعة أخرى» answers it (handleTurn).
  next.asking = 'part_printer';
  return { reply: { intent: 'product_search', text: tr(loc, 'part_printer_which', { part: PART_LABELS[part][loc] }), choices }, context: next };
}
