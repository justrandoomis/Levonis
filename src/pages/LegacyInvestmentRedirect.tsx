import { Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

/** Both old route trees land in the unified ledger; no legacy forecast is
 * converted into a withdrawable balance by navigating here. */
export default function LegacyInvestmentRedirect({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth();
  const financial = user?.role === 'admin' && user.can_view_financials !== false && user.admin_scope !== 'assistant';
  return <Navigate replace to={admin && financial ? '/admin?tab=finance&finance=investors' : '/earnings'} />;
}
