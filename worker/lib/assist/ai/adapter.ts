/**
 * THE MODEL SEAM (assistant plan push B, §6.1). PURE: nothing here calls
 * anything, and nothing here may name a provider. The provider code lives in
 * worker/lib/ai; this file only fixes the closed sets a model may answer in
 * and the shape the validators turn that answer into.
 *
 * A model chooses an ACTION and, for `intent`, one READ-ONLY legacy intent.
 * It never writes a price, a stock level, a compatibility verdict, an HMS
 * meaning, an id, a URL or a sentence: every reply is still built by push A's
 * own handlers and templates from real data. No write intent is routable
 * (no cancel_order, no open_ticket), so a model can never act for a customer.
 */
import type { ModelToken, PartKey, SymptomKey } from '../types';

/** Read-only legacy intents a model may route to. Never a write: no cancel_order, open_ticket,
 *  product_search, compare_products, printer_problem (use action 'triage'), price_question, stock_question. */
export const ROUTABLE_INTENTS = [
  'order_status',
  'delivery_estimate',
  'my_devices',
  'warranty_status',
  'points_balance',
  'membership_status',
  'return_help',
  'password_help',
  'power_usage',
  'policy_question',
  'human_handoff',
  'greeting',
  'thanks',
  'bot_identity',
  'choose_printer',
  'materials_help',
  'shipping_cost',
  'payment_methods',
  'offers_help',
  'wallet_help',
  'studio_help',
  'account_help',
  'contact_info',
] as const;
export type RoutableIntent = (typeof ROUTABLE_INTENTS)[number];

export type Reading =
  | { action: 'products'; model?: ModelToken | 'other'; part?: PartKey; maintenance: boolean; terms: string[] }
  | { action: 'triage'; model?: ModelToken | 'other'; symptom?: SymptomKey }
  | { action: 'outcome'; outcome: 'resolved' | 'not_fixed' }
  | { action: 'intent'; intent: RoutableIntent }
  | { action: 'none' };

export const READING_ACTIONS = ['products', 'triage', 'outcome', 'intent', 'none'] as const;
export const READING_OUTCOMES = ['resolved', 'not_fixed'] as const;

export const PHOTO_SUBJECTS = ['printer_screen', 'printer', 'print_result', 'part', 'label', 'other', 'unclear'] as const;
export interface PhotoReading {
  subject: (typeof PHOTO_SUBJECTS)[number];
  /** Kept only with confidence 'high'. */
  model?: ModelToken;
  symptom?: SymptomKey;
  part?: PartKey;
  /** At most 3, each canonical through readHmsCode. */
  hmsCodes: string[];
  /** At most 4; NEVER rendered, used only by the identifier lane. */
  labelCodes: string[];
  confidence: 'high' | 'low';
}

/** Implemented in worker/lib/ai/run.ts (`aiReady`); BASIC_SEAM here. */
export interface ModelSeam {
  ready(task: 'understand' | 'vision' | 'speech'): Promise<boolean>;
}
export const BASIC_SEAM: ModelSeam = { ready: async () => false };
