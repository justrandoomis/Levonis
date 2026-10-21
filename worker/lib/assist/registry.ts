/**
 * THE TOOL REGISTRY (assistant plan 2.2, kept to what push A uses).
 *
 * Every capability the assistant has is a typed, read-only tool with a
 * parser and an audience. The deterministic orchestrator calls them today;
 * the model router of the next push will be able to emit only
 * `{ tool, args }`, which come back through the SAME `parse` and the same
 * audience check. So a model can never reach a capability, an argument shape
 * or another person's data that this table does not already allow.
 *
 *   - `public`: anyone, signed in or not.
 *   - `session`: the signed-in viewer's own data, by the SESSION's user id.
 *     There is no bypass for staff: an admin asking the support assistant is
 *     a customer here, and staff tools live in the admin console.
 */
import type { Viewer, ModelToken } from './types';
import { MODEL_TOKENS } from './types';
import {
  catalogByIds,
  catalogSearch,
  FITS_MAX,
  printerCards,
  printerModels,
  printerModelsOf,
  SEARCH_LIMIT_MAX,
  SEARCH_OFFSET_MAX,
  SEARCH_TEXT_MAX,
  type CatalogItem,
  type CatalogSearchArgs,
  type CatalogSearchResult,
} from './tools/catalog';
import { ownDevices, printersOf, type MyPrinter } from './tools/devices';
import { buildTicketDraft, type DraftInput } from './handoff';
import type { TicketDraft } from './types';
import { SYMPTOM_KEYS, type SymptomKey } from './types';
import { HMS_CODE_SHAPE, SHOWN_MAX } from './context';

export type ToolName =
  | 'catalog.search'
  | 'catalog.byIds'
  | 'catalog.printerModels'
  | 'catalog.printersOf'
  | 'catalog.printerModelsOf'
  | 'devices.mine'
  | 'cases.draft';

export type ToolResult<O> = { ok: true; data: O } | { ok: false; code: 'BAD_ARGS' | 'NEEDS_SESSION' | 'UNKNOWN_TOOL' };

interface ArgError {
  argError: string;
}
const bad = (argError: string): ArgError => ({ argError });
const isArgError = (v: unknown): v is ArgError => typeof v === 'object' && v !== null && 'argError' in v;

export interface ToolDef<I, O> {
  name: ToolName;
  audience: 'public' | 'session';
  effect: 'read';
  parse(raw: unknown): I | ArgError;
  run(db: D1Database, viewer: Viewer, input: I): Promise<O>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const asObject = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;

const catalogSearchTool: ToolDef<CatalogSearchArgs, CatalogSearchResult> = {
  name: 'catalog.search',
  audience: 'public',
  effect: 'read',
  parse(raw) {
    const o = asObject(raw);
    if (!o) return bad('object');
    const text = typeof o.text === 'string' ? o.text : '';
    if (text.length > SEARCH_TEXT_MAX) return bad('text');
    let fits: string[] | undefined;
    if (o.fits !== undefined) {
      if (!Array.isArray(o.fits) || o.fits.length > FITS_MAX || !o.fits.every((f) => typeof f === 'string' && SLUG.test(f))) return bad('fits');
      fits = o.fits as string[];
    }
    if (o.category !== undefined && o.category !== 'cat_maint') return bad('category');
    const limit = o.limit === undefined ? 6 : o.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) return bad('limit');
    if (!text.trim() && !fits?.length && o.category === undefined) return bad('empty');
    if (o.strong !== undefined && typeof o.strong !== 'boolean') return bad('strong');
    const offset = o.offset === undefined ? 0 : o.offset;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > SEARCH_OFFSET_MAX) return bad('offset');
    return {
      text,
      ...(fits ? { fits } : {}),
      ...(o.category === 'cat_maint' ? { category: 'cat_maint' as const } : {}),
      limit,
      ...(offset ? { offset } : {}),
      ...(o.strong === true ? { strong: true } : {}),
    };
  },
  run: (db, viewer, input) => catalogSearch(db, viewer, input),
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The products the conversation just showed, read again as cards («شكد سعره؟»). Ids only; nothing else is trusted. */
const catalogByIdsTool: ToolDef<{ ids: string[] }, CatalogItem[]> = {
  name: 'catalog.byIds',
  audience: 'public',
  effect: 'read',
  parse(raw) {
    const o = asObject(raw);
    if (!o || !Array.isArray(o.ids)) return bad('ids');
    if (o.ids.length === 0 || o.ids.length > SHOWN_MAX || !o.ids.every((id) => typeof id === 'string' && ID.test(id))) return bad('ids');
    return { ids: [...new Set(o.ids as string[])] };
  },
  run: (db, viewer, input) => catalogByIds(db, viewer, input.ids),
};

const printerModelsTool: ToolDef<Record<string, never>, Map<ModelToken, string[]>> = {
  name: 'catalog.printerModels',
  audience: 'public',
  effect: 'read',
  parse: (raw) => (raw === undefined || asObject(raw) ? {} : bad('object')),
  run: (db) => printerModels(db),
};

/** The printers the shop lists under one model, as cards («شكد سعر الطابعة» about the A1). */
const printersOfTool: ToolDef<{ model: ModelToken }, CatalogItem[]> = {
  name: 'catalog.printersOf',
  audience: 'public',
  effect: 'read',
  parse(raw) {
    const o = asObject(raw);
    if (!o || !(MODEL_TOKENS as readonly string[]).includes(String(o.model))) return bad('model');
    return { model: o.model as ModelToken };
  },
  run: (db, viewer, input) => printerCards(db, viewer, input.model, SHOWN_MAX),
};

/** Which listed printers' models a set of shown products are («A1 combo» showed the A1). Ids only. */
const printerModelsOfTool: ToolDef<{ ids: string[] }, ModelToken[]> = {
  name: 'catalog.printerModelsOf',
  audience: 'public',
  effect: 'read',
  parse(raw) {
    const o = asObject(raw);
    if (!o || !Array.isArray(o.ids)) return bad('ids');
    if (o.ids.length === 0 || o.ids.length > SHOWN_MAX || !o.ids.every((id) => typeof id === 'string' && ID.test(id))) return bad('ids');
    return { ids: [...new Set(o.ids as string[])] };
  },
  run: (db, _viewer, input) => printerModelsOf(db, input.ids),
};

const devicesMineTool: ToolDef<Record<string, never>, MyPrinter[]> = {
  name: 'devices.mine',
  audience: 'session',
  effect: 'read',
  parse: (raw) => (raw === undefined || asObject(raw) ? {} : bad('object')),
  run: async (db, viewer) => printersOf(await ownDevices(db, viewer.userId!), viewer.locale),
};

const casesDraftTool: ToolDef<DraftInput, TicketDraft> = {
  name: 'cases.draft',
  audience: 'public',
  effect: 'read',
  parse(raw) {
    const o = asObject(raw);
    if (!o) return bad('object');
    const model = o.model === 'other' ? 'other' : (MODEL_TOKENS as readonly string[]).includes(String(o.model)) ? (o.model as ModelToken) : null;
    if (!model) return bad('model');
    if (!(SYMPTOM_KEYS as readonly string[]).includes(String(o.symptom))) return bad('symptom');
    if (o.code !== undefined && (typeof o.code !== 'string' || !HMS_CODE_SHAPE.test(o.code))) return bad('code');
    if (o.unit_id !== undefined && (typeof o.unit_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.unit_id))) return bad('unit_id');
    return {
      model,
      symptom: o.symptom as SymptomKey,
      ...(typeof o.code === 'string' ? { code: o.code.toUpperCase() } : {}),
      ...(typeof o.unit_id === 'string' ? { unit_id: o.unit_id } : {}),
    };
  },
  run: async (_db, viewer, input) => buildTicketDraft(input, viewer.locale),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: Readonly<Record<ToolName, ToolDef<any, any>>> = {
  'catalog.search': catalogSearchTool,
  'catalog.byIds': catalogByIdsTool,
  'catalog.printerModels': printerModelsTool,
  'catalog.printersOf': printersOfTool,
  'catalog.printerModelsOf': printerModelsOfTool,
  'devices.mine': devicesMineTool,
  'cases.draft': casesDraftTool,
};

interface ToolOutputs {
  'catalog.search': CatalogSearchResult;
  'catalog.byIds': CatalogItem[];
  'catalog.printerModels': Map<ModelToken, string[]>;
  'catalog.printersOf': CatalogItem[];
  'catalog.printerModelsOf': ModelToken[];
  'devices.mine': MyPrinter[];
  'cases.draft': TicketDraft;
}

/** Parse, check the audience, run. Unknown names and bad arguments are refused, never guessed at. */
export async function callTool<N extends ToolName>(name: N, db: D1Database, viewer: Viewer, raw: unknown): Promise<ToolResult<ToolOutputs[N]>>;
export async function callTool(name: string, db: D1Database, viewer: Viewer, raw: unknown): Promise<ToolResult<unknown>>;
export async function callTool(name: string, db: D1Database, viewer: Viewer, raw: unknown): Promise<ToolResult<unknown>> {
  if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) return { ok: false, code: 'UNKNOWN_TOOL' };
  const tool = TOOLS[name as ToolName];
  const input = tool.parse(raw);
  if (isArgError(input)) return { ok: false, code: 'BAD_ARGS' };
  if (tool.audience === 'session' && !viewer.userId) return { ok: false, code: 'NEEDS_SESSION' };
  return { ok: true, data: await tool.run(db, viewer, input) };
}
