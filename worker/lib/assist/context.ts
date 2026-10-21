/**
 * THE CONVERSATION'S CONTEXT, CARRIED BY THE CLIENT (assistant plan 2.4, as
 * far as push A needs it).
 *
 * «نوزل مال اي ون» and then «واكو بليت؟» is one conversation about one
 * printer. The reply hands back a small context object; the client returns it
 * with the next message (in this browser session, anonymous or signed in);
 * the route reads it here. Nothing is stored on the server.
 *
 * IT IS INPUT, AND IT GRANTS NOTHING. A browser can put anything in it, so
 * this reader keeps only closed-set values and id shapes and drops everything
 * else, the way `readPending` treats `expects`. A `unit_id` here is a hint the
 * triage re-checks against the signed-in viewer's own devices; account data
 * still comes from the session alone.
 */
import { MODEL_TOKENS, PART_KEYS, SYMPTOM_KEYS, type ModelToken, type PartKey, type SymptomKey } from './types';
import { PART_SYMPTOM } from './understand/lexicon';

export const TRIAGE_STAGES = ['printer', 'symptom', 'steps', 'done'] as const;
export type TriageStage = (typeof TRIAGE_STAGES)[number];

export interface TriageState {
  stage: TriageStage;
  symptom?: SymptomKey;
  /** An HMS code as typed (shape-checked), held for the ticket. */
  code?: string;
  /**
   * The curated steps of `symptom` were shown: «تحدث مع الفريق» at «which
   * printer?» showed none. Shown is not tried: the ticket lists them as shown.
   */
  steps?: true;
  /**
   * The customer said the steps did not fix it («جربتها وما انحلّت», "still
   * not fixed"): only then does the ticket list them as tried. Kept, so the
   * draft after the sign-in trip says it too. Never without `steps`.
   */
  tried?: true;
  /**
   * The fault was named in this part («مشكلة بالنوزل») and `symptom` is the
   * steps it takes (./understand/lexicon.ts `PART_SYMPTOM`), not a symptom the
   * customer named: the chat and the ticket say the part. Never beside a
   * symptom it does not lead to.
   */
  faultIn?: PartKey;
  /**
   * Opened only by a printer the customer says is theirs («عندي اي ون», "I
   * have an A1"), and no fault named since: «تحدث مع الفريق» then drafts no
   * ticket that claims a problem (review round 5). Never beside a symptom.
   */
  owned?: true;
}

export interface AssistContext {
  v: 1;
  /**
   * `browsed`: the printer was only SHOWN in a shopping answer («A1 combo»,
   * «طابعة A1»). It answers «شكد سعر الطابعة؟» and a part question, but the
   * printer-problem triage still asks which printer the customer has.
   */
  printer?: { model: ModelToken | 'other'; unit_id?: string; browsed?: true };
  part?: PartKey;
  /**
   * The size the part question carried while the assistant asks which
   * printer it is for («نوزل 0.4 مال زد ون» → «لأي طابعة؟»), so a typed «A1»
   * keeps the 0.4 exactly as the tapped chip does.
   */
  size?: string;
  /**
   * «لأي طابعة تريد النوزل؟» is waiting for its answer. Only then is a bare
   * «طابعة أخرى» / «غيرها» that answer: after an ordinary part search the
   * same «اكو غيرها؟» means "any others?", not "another printer".
   */
  asking?: 'part_printer';
  triage?: TriageState;
  /** The product ids the last answer showed, newest answer only. */
  shown?: string[];
  /**
   * «اكو غيرها؟» PAGING of `part`, across answers: `rows`, the rows of the
   * part's own listing already gone through, and `seen`, every product shown
   * for it so far (the newest SEEN_MAX). A second «اكو غيرها؟» goes on from
   * where the first stopped and never shows a card again.
   */
  more?: { rows: number; seen: string[] };
}

/** A context bigger than this is not a context; it is ignored whole. */
export const CONTEXT_MAX_BYTES = 2048;
export const SHOWN_MAX = 6;
/** Three pages of cards: the paging cursor stays well inside CONTEXT_MAX_BYTES. */
export const SEEN_MAX = 18;
/** Past this many rows, the listing offset is capped (tools/catalog.ts SEARCH_OFFSET_MAX plus a page). */
export const ROWS_MAX = 64;

const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** A nozzle or plate size as the search engine reads it: «0.4», «0.25», «256». */
export const SIZE_SHAPE = /^\d{1,3}(?:\.\d{1,3})?$/;
export const HMS_CODE_SHAPE = /^[0-9A-F]{4}(?:[-_ ][0-9A-F]{4}){1,3}$/i;

const oneOf = <T extends string>(set: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : undefined;

export const emptyContext = (): AssistContext => ({ v: 1 });

export function readContext(raw: unknown): AssistContext {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyContext();
  let size = 0;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    return emptyContext();
  }
  if (size > CONTEXT_MAX_BYTES) return emptyContext();
  const c = raw as Record<string, unknown>;
  if (c.v !== 1) return emptyContext();
  const out: AssistContext = { v: 1 };

  if (typeof c.printer === 'object' && c.printer !== null) {
    const p = c.printer as Record<string, unknown>;
    const model = p.model === 'other' ? 'other' : oneOf(MODEL_TOKENS, p.model);
    if (model) {
      out.printer = { model };
      if (typeof p.unit_id === 'string' && ID_SHAPE.test(p.unit_id)) out.printer.unit_id = p.unit_id;
      if (p.browsed === true) out.printer.browsed = true;
    }
  }
  const part = oneOf(PART_KEYS, c.part);
  if (part) out.part = part;
  if (part && typeof c.size === 'string' && SIZE_SHAPE.test(c.size)) out.size = c.size;
  if (part && c.asking === 'part_printer') out.asking = 'part_printer';

  if (typeof c.triage === 'object' && c.triage !== null) {
    const t = c.triage as Record<string, unknown>;
    const stage = oneOf(TRIAGE_STAGES, t.stage);
    if (stage) {
      out.triage = { stage };
      const symptom = oneOf(SYMPTOM_KEYS, t.symptom);
      if (symptom) out.triage.symptom = symptom;
      if (typeof t.code === 'string' && HMS_CODE_SHAPE.test(t.code)) out.triage.code = t.code.toUpperCase();
      if (symptom && t.steps === true) out.triage.steps = true;
      if (out.triage.steps && t.tried === true) out.triage.tried = true;
      const faultIn = oneOf(PART_KEYS, t.faultIn);
      if (symptom && faultIn && PART_SYMPTOM[faultIn] === symptom) out.triage.faultIn = faultIn;
      if (!symptom && (stage === 'printer' || stage === 'symptom') && t.owned === true) out.triage.owned = true;
    }
  }
  if (Array.isArray(c.shown)) {
    const ids = c.shown.filter((x): x is string => typeof x === 'string' && ID_SHAPE.test(x)).slice(0, SHOWN_MAX);
    if (ids.length) out.shown = ids;
  }
  if (part && typeof c.more === 'object' && c.more !== null && !Array.isArray(c.more)) {
    const m = c.more as Record<string, unknown>;
    const rows = Number(m.rows);
    const seen = Array.isArray(m.seen) ? [...new Set(m.seen.filter((x): x is string => typeof x === 'string' && ID_SHAPE.test(x)))].slice(-SEEN_MAX) : [];
    if (Number.isInteger(rows) && rows >= 0 && rows <= ROWS_MAX) out.more = { rows, seen };
  }
  return out;
}
