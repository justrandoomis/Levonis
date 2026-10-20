/**
 * THE SUPPORT ASSISTANT'S SHARED SHAPES (assistant plan, push A).
 *
 * Deterministic from end to end: nothing in `worker/lib/assist/**` calls a
 * model, fetches a URL or writes a sentence that is not in a reviewed
 * dictionary. Prices, stock and compatibility come from the storefront card
 * builders and the catalogue's own links, never from this layer.
 */
import type { PricingCtx } from '../catalog/cardsRead';

export type Locale = 'ar' | 'en' | 'ckb';
/** One string, written three times by hand. */
export type L3 = Readonly<Record<Locale, string>>;

/**
 * The printers the assistant can name. The canonical tokens are Bambu's own
 * (packages/catalog/src/bambuImport/registry/models.ts); a test fails on any
 * token here the registry does not know.
 */
export const MODEL_TOKENS = ['A1 mini', 'A1', 'A2L', 'P1P', 'P1S', 'P2S', 'X1C', 'X1E', 'X2D', 'H2D Pro', 'H2D', 'H2S', 'H2C'] as const;
export type ModelToken = (typeof MODEL_TOKENS)[number];

export const PART_KEYS = ['nozzle_hotend', 'plate', 'cleaning'] as const;
export type PartKey = (typeof PART_KEYS)[number];

export const SYMPTOM_KEYS = ['clog', 'adhesion', 'layer_shift', 'stringing', 'ams', 'hms', 'noise', 'other'] as const;
export type SymptomKey = (typeof SYMPTOM_KEYS)[number];

/** Who is asking. The user id comes from the SESSION only, never from a body. */
export interface Viewer {
  userId: string | null;
  locale: Locale;
  /** The storefront pricing context for this viewer, started once per turn. */
  pricing: Promise<PricingCtx>;
}

/** A chip the client sends back verbatim as `{ intent, params }`. */
export interface AssistChoice {
  label: string;
  intent: 'printer_problem' | 'product_search' | 'human_handoff';
  params?: Record<string, string>;
}

export interface AssistLink {
  label: string;
  to: string;
  external?: boolean;
}

/**
 * The product card exactly as the route's own card mapper builds it. Opaque
 * here on purpose: this layer passes cards through and never reads a figure.
 */
export interface AssistCard {
  title: string;
}

/** One step of a curated fix. `safety: 'hot'` draws the hot-surface warning. */
export interface AssistStep {
  key: string;
  text: string;
  safety?: 'hot';
}

/** What the ticket form opens with after a handoff. Visible and editable. */
export interface TicketDraft {
  subject: string;
  body: string;
  unit_id?: string;
}

export interface AssistReply {
  intent: string;
  text: string;
  cards?: AssistCard[];
  choices?: AssistChoice[];
  links?: AssistLink[];
  steps?: AssistStep[];
  handoff?: boolean;
  auth_required?: boolean;
  ticket_draft?: TicketDraft;
}

/**
 * THE CARD MAPPER, HANDED IN BY THE ROUTE.
 *
 * `worker/routes/support.ts` owns the one function that turns a storefront
 * card into an assistant card (figures read off the card, never computed).
 * The orchestrator receives it instead of importing it, so there is one
 * mapper and no import cycle.
 */
export interface CardRenderer {
  card(loc: Locale, card: Record<string, unknown>, row: Record<string, unknown>): AssistCard;
}
