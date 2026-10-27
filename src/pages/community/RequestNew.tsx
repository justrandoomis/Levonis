/**
 * THE REQUEST EDITOR ROUTES (community UI plan B4, §4), a placeholder until
 * C4 builds the four-step editor with P1-06 folded in:
 *
 *   /requests/new            a new request
 *   /requests/new/:id        a draft, continued («أكمل المسودة»; «أكمل
 *                            وانشر» opens it with `?step=4`, the review)
 *   /requests/:id/edit       a published request, edited
 *
 * Today each renders the wizard the board used to open in place
 * (requests/RequestWizard.tsx), full screen under its own section header.
 * The addresses land first so every door can name them: the board forwards
 * `?view=new`, `?link=`, `?project=` and the router state (`printLink`,
 * `project`) here (src/pages/Requests.tsx), and the request page sends its
 * edit and its draft here (src/pages/community/Request.tsx). The step in the
 * address and the project prefill are carried in the location for C4; the
 * wizard of today starts at its first step and has no project source.
 *
 * Behind ProtectedRoute and CommunityGate (src/App.tsx): writing a request
 * needs an account, and the community open to it.
 */
import { Suspense, lazy } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader from '../../components/community/kit/SectionPageHeader';
import { useRequestStrings } from '../../components/community/requests/strings';
import { Skeleton } from '../../components/ui/Skeleton';
import { useGoBack } from '../../lib/useGoBack';

// The wizard is its own chunk, as it was when the board and the request page
// opened it in place: the header paints first, and the entry stays small.
const RequestWizard = lazy(() => import('../../components/community/requests/RequestWizard'));

const requestPath = (id: string) => `/requests/${encodeURIComponent(id)}`;

/** The model link a door carried: the router state first (a signed-in tap), else `?link=` (it survives sign-in). */
function carriedPrintLink(state: unknown, params: URLSearchParams): string {
  const fromState = (state as { printLink?: unknown } | null)?.printLink;
  return typeof fromState === 'string' ? fromState : params.get('link') ?? '';
}

export default function RequestNew() {
  const { id = '' } = useParams();
  const location = useLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const s = useRequestStrings();
  const editing = !!id && location.pathname.endsWith('/edit');
  const carriedLink = id ? '' : carriedPrintLink(location.state, params);
  // Back: to the request this screen is about, else to the board.
  const goBack = useGoBack(id ? requestPath(id) : '/requests');

  /**
   * A request this person just PUBLISHED: its page asks about the
   * notification channels, once (the router state). A new request leaves
   * «طلباتي» behind it, where it now is; a draft or an edit goes back to its
   * page, replacing this screen when it was published, else as Back would.
   */
  const done = (rid: string, how: 'published' | 'saved') => {
    if (!id) {
      navigate('/requests?view=mine', { replace: true });
      navigate(requestPath(rid), how === 'published' ? { state: { published: true } } : undefined);
    } else if (how === 'published') navigate(requestPath(rid), { replace: true, state: { published: true } });
    else goBack();
  };

  return (
    <CommunitySurface className="min-h-screen w-full pb-28">
      <div className="mx-auto flex max-w-2xl flex-col gap-2 px-4" data-request-editor={editing ? 'edit' : id ? 'draft' : 'new'}>
        <SectionPageHeader title={editing ? s.editRequest : id ? s.continueDraft : s.kicker} backTo={id ? requestPath(id) : '/requests'} />
        <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
          <RequestWizard key={id || 'new'} requestId={id || undefined} initialLink={carriedLink || undefined} onDone={done} onCancel={goBack} />
        </Suspense>
      </div>
    </CommunitySurface>
  );
}
