/**
 * WHAT A CARD MAY ASK OF ITS CONVERSATION — refresh the thread after an action,
 * open the store's quote composer (a new quote on a print request, or an edit
 * of its own quote), open the private-product composer (from a quote). The
 * thread screen provides it; a card outside a thread (a preview) gets none and
 * shows no buttons that would need it.
 */
import { createContext, useContext } from 'react';
import type { ChatThreadInfo } from '../../../lib/chatCards';

export interface QuotePrefill {
  requestId?: string;
  /** Editing this quote: its offer id and what its latest card froze. */
  edit?: { offerId: string; snapshot: Record<string, unknown> };
}

export interface CustomProductPrefill {
  quoteId?: string;
  name?: string;
  description?: string;
  price_iqd?: number;
  prep_days?: number;
}

export interface ChatCardActions {
  chatId: string;
  role: ChatThreadInfo['role'];
  refresh: () => Promise<void> | void;
  openQuote: (p: QuotePrefill) => void;
  openCustomProduct: (p: CustomProductPrefill) => void;
}

export const ChatCardActionsContext = createContext<ChatCardActions | null>(null);

export function useCardActions(): ChatCardActions | null {
  return useContext(ChatCardActionsContext);
}
