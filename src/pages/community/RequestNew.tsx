/**
 * THE REQUEST EDITOR ROUTES (community UI plan B4, §4), a placeholder until
 * C4 builds the four-step editor with P1-06 folded in:
 *
 *   /requests/new            a new request
 *   /requests/new/:id        a draft, continued («أكمل المسودة»; `?step=4`
 *                            will open it at its review once C4 reads it)
 *   /requests/:id/edit       a published request, edited
 *
 * Today each renders the wizard the board used to open in place
 * (requests/RequestWizard.tsx), full screen under its own section header.
 * The addresses land first so every door can name them: the board forwards
 * `?view=new`, `?link=`, `?project=` and the router state (`printLink`,
 * `project`) here (src/pages/Requests.tsx), and the request page sends its
 * edit and its draft here (src/pages/community/Request.tsx). The step in the
 * address and the project prefill are carried in the location for C4; the
 * wizard of today starts at its first step and has no project source, so
 * the request page offers no «أكمل وانشر» until the editor honours the step.
 *
 * Behind ProtectedRoute and CommunityGate (src/App.tsx): writing a request
 * needs an account, and the community open to it.
 *
 * AN ADDRESS FOR A REQUEST THIS PERSON CANNOT OPEN (B2R2-L10N-1): another
 * person request, a discarded draft, a stale or mistyped link. The server
 * answers each with 404 «NOT_FOUND», and the wizard alone drew its empty form
 * under the server English sentence. The page asks for the draft itself,
 * beside the wizard (two asks of one address in flight are one request,
 * lib/api.ts), and says a request it cannot open the way the request page
 * says it, in the reader language, with the way back to the board.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams, type NavigateFunction } from 'react-router-dom';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader from '../../components/community/kit/SectionPageHeader';
import { requestsApi } from '../../components/community/requests/api';
import { useRequestStrings } from '../../components/community/requests/strings';
import { NotFoundState } from '../../components/ui/AsyncStates';
import { Skeleton } from '../../components/ui/Skeleton';
import { ApiError } from '../../lib/api';
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

/**
 * BACK ONTO THE PAGE THAT OPENED THE EDITOR, MARKED PUBLISHED. The request page
 * is the one door to a draft or an edit, so the entry behind the editor is that
 * page: a publish steps back onto it and marks it there (`{ published: true }`,
 * read once by the page for the channel window). The history then holds one
 * request page, as the in-place wizard left it, and Back reaches what came
 * before it. With nothing of this app behind (the editor opened by its
 * address), the request page replaces the editor; with another page behind, it
 * follows that page. React Router stamps `idx` on every entry it makes (see
 * lib/useGoBack.ts).
 */
export function returnPublished(navigate: NavigateFunction, path: string, win: Window = window): void {
  const state = { published: true };
  let behind = false;
  try {
    const idx = (win.history.state as { idx?: unknown } | null)?.idx;
    behind = typeof idx === 'number' && idx > 0;
  } catch {
    behind = false;
  }
  if (!behind) {
    navigate(path, { replace: true, state });
    return;
  }
  // Once the browser has stepped back, the entry is marked: a replace, or a
  // push when another page is behind. The router hears the step back first,
  // so the page may arrive a moment before its mark; it reads the mark on
  // every arrival (src/pages/community/Request.tsx).
  win.addEventListener('popstate', () => navigate(path, { replace: win.location.pathname === path, state }), { once: true });
  navigate(-1);
}

/** Where a new request leaves «طلباتي», behind its own page. */
export const MY_REQUESTS = '/requests?view=mine';

/**
 * A NEW REQUEST LANDS ON ITS OWN PAGE, WITH «طلباتي» BEHIND IT (B2R2-REG-1).
 * The editor entry is rewritten in place as «طلباتي» with
 * `history.replaceState`, and never with `navigate`: a router replace draws the
 * board at once, while the push after it waits inside a view transition
 * (lib/stackNavigation.ts), and the board, mounting, strips its `?view` with a
 * replace of its own that lands on the request entry pushed meanwhile. The
 * page never arrived and its channel window never asked. The rewritten entry
 * keeps the place of the editor (`idx`), takes a key of its own (the scroll
 * the shell remembers per key is the editor one) and drops the router state
 * the editor arrived with (a carried model link would reopen the editor on
 * Back). The request page is then pushed, marked when it was published: Back
 * from it reaches «طلباتي», where the request now is, and the board mounts
 * only then. A window that refuses the rewrite gets the request page in place
 * of the editor: never the board in between.
 */
export function leaveNewRequest(navigate: NavigateFunction, path: string, published: boolean, win: Window = window): void {
  const state = published ? { published: true } : undefined;
  try {
    const held = (win.history.state ?? {}) as Record<string, unknown>;
    win.history.replaceState({ ...held, usr: null, key: Math.random().toString(36).slice(2, 10) }, '', MY_REQUESTS);
  } catch {
    navigate(path, { replace: true, state });
    return;
  }
  navigate(path, { state });
}

/** The draft read answered that this person has no such request (404 «NOT_FOUND»). */
export function requestMissing(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.code === 'NOT_FOUND');
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

  // The request behind a draft or edit address, asked beside the wizard: only
  // a 404 changes the page; anything else is the wizard own to say.
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setMissing(false);
    if (!id) return;
    let alive = true;
    requestsApi.draft(id).catch((e: unknown) => {
      if (alive && requestMissing(e)) setMissing(true);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  /**
   * A request this person just PUBLISHED: its page asks about the
   * notification channels, once (the router state). A new request leaves
   * «طلباتي» behind it, where it now is (leaveNewRequest); a draft or an edit
   * goes back to its page, the one entry that opened this screen
   * (returnPublished: never a second copy of it, so one Back leaves the
   * request), else as Back would.
   */
  const done = (rid: string, how: 'published' | 'saved') => {
    if (!id) leaveNewRequest(navigate, requestPath(rid), how === 'published');
    else if (how === 'published') returnPublished(navigate, requestPath(rid));
    else goBack();
  };

  if (missing) {
    return (
      <CommunitySurface className="min-h-screen w-full pb-28">
        <div className="mx-auto flex max-w-2xl flex-col gap-2 px-4" data-request-editor="missing">
          <SectionPageHeader title={s.kicker} backTo="/requests" />
          <div className="pt-6" data-request-missing>
            <NotFoundState title={s.notFoundTitle} description={s.notFoundBody} />
            <div className="mt-2 flex justify-center">
              <Link to="/requests" className="lv-button lv-button-secondary lv-button-sm">
                {s.toBoard}
              </Link>
            </div>
          </div>
        </div>
      </CommunitySurface>
    );
  }

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
