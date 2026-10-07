import { Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

/** Both old route trees land in the unified ledger; no legacy forecast is
 * converted into a withdrawable balance by navigating here.
 *
 * Investor contracts are COST (owner decision 2): only the owner is sent to
 * the investors section, on the server hint compared with `=== true` so a
 * missing hint sends everyone else to their own earnings. The investor router
 * refuses non-owners regardless (COST_ACCESS_DENIED). */
export default function LegacyInvestmentRedirect({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  const ownerCost = user?.role === 'admin' && user.can_view_cost === true;
  return <Navigate replace to={admin && ownerCost ? '/admin?tab=finance&finance=investors' : '/earnings'} />;
}
