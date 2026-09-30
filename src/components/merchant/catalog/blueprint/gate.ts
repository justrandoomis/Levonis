/**
 * «التخصيص» SHIPS DARK (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md
 * §B.8): the builder's door, the part door and «من ليفونيس» appear only when
 * the server's own answer says so — /api/merchant/me `can.customize` (the
 * switch or a pilot list for this store, and the owner's
 * `customizableProducts` entitlement; worker/lib/personalize/access.ts
 * `canCustomize`). The workspace already holds that answer
 * (src/components/merchant/shell/context.ts), so asking costs nothing;
 * outside the workspace nobody asked the server, and the doors stay shut.
 *
 * Static in ProductEditorSheet and CatalogManager — a few bytes, no chunk.
 */
import { useContext } from 'react';
import { WorkspaceContext } from '../../shell/context';

export function useCanCustomize(): boolean {
  return (useContext(WorkspaceContext)?.me.can as { customize?: boolean } | undefined)?.customize === true;
}
