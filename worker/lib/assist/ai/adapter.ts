/**
 * THE MODEL SEAM, EMPTY ON PURPOSE (assistant plan, push A).
 *
 * Push A is deterministic: nothing here calls anything. The next push plugs a
 * router in behind this interface, and the contract it must keep is already
 * fixed by the tool registry (./registry.ts): a router may only propose
 * `{ tool, args }`, which go back through the same parser and the same
 * audience check as the rules' own calls. A router never writes a price, a
 * stock level, a compatibility verdict or a Sorani sentence.
 */
import type { ToolName } from '../registry';

export interface ToolProposal {
  tool: ToolName;
  args: unknown;
}

export interface AssistRouter {
  /** False in push A: basic mode, the rules answer alone. */
  ready(): boolean;
  /** A proposal for text the rules could not place, or null. */
  route(text: string): Promise<ToolProposal | null>;
}

/** The only router push A ships. */
export const BASIC_ROUTER: AssistRouter = {
  ready: () => false,
  route: async () => null,
};
