/**
 * THE REQUEST EDITOR ROUTES (community UI plan B4 and C4, §4): the four-step
 * editor of P1-06 (src/components/community/requests/editor/RequestEditor.tsx)
 * under its own address:
 *
 *   /requests/new                   a new request; its draft is born on the
 *                                   first act and the address becomes
 *                                   /requests/new/:id?step=1 in place
 *   /requests/new/:id?step=1..4     a draft, at its step («أكمل وانشر» opens
 *                                   it at its review, `?step=4`)
 *   /requests/:id/edit?step=1..4    a published request, edited, saved with
 *                                   «احفظ التعديلات»
 *
 * Every old door lands here with what it carried: the board forwards
 * `?view=new`, `?link=`, `?project=` and the router state (`printLink`,
 * `project`) here (src/pages/Requests.tsx), the request page sends its edit
 * and its draft here (src/pages/community/Request.tsx), «اطلب طباعة مثلها»
 * names the project, and the store and product doors name the store
 * (`?store=`, `?product=&store=`). The editor reads them once, on arrival.
 *
 * Behind ProtectedRoute and CommunityGate (src/App.tsx): writing a request
 * needs an account, and the community open to it.
 *
 * AN ADDRESS FOR A REQUEST THIS PERSON CANNOT OPEN (B2R2-L10N-1): another
 * person request, a discarded draft, a stale or mistyped link. The server
 * answers each with 404 «NOT_FOUND»; the page asks for the draft itself,
 * beside the editor (two asks of one address in flight are one request,
 * lib/api.ts), and says a request it cannot open the way the request page
 * says it, in the reader language, with the way back to the board.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams, type NavigateFunction } from 'react-router-dom';
import CommunitySurface from '../../components/community/CommunitySurface';
import SectionPageHeader from '../../components/community/kit/SectionPageHeader';
import { requestsApi } from '../../components/community/requests/api';
import RequestEditor, { type EditorDone } from '../../components/community/requests/editor/RequestEditor';
import { useRequestStrings } from '../../components/community/requests/strings';
import { NotFoundState } from '../../components/ui/AsyncStates';
import { ApiError } from '../../lib/api';
import { useGoBack } from '../../lib/useGoBack';

// The editor rides in this page chunk, which the board already loads lazily
// (src/pages/Requests.tsx): a chunk of its own split the modules it shares
// with the request page into new chunks, and their names landed in the entry
// preload map, which the storefront payload has no room for
// (tests/bundleBudget.test.ts).

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

/** The router state the board «طلب جديد» pushes the editor with: the entry behind the editor is the board. */
export function cameFromBoard(state: unknown): boolean {
  return (state as { from?: unknown } | null)?.from === 'board';
}

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
 *
 * OPENED FROM THE BOARD «طلب جديد» (B2R3-REG-1), the entry behind the editor is
 * the board itself. Rewriting the editor entry would leave the board behind
 * «طلباتي», and the board is not remounted between two /requests entries, so
 * the Back from «طلباتي» onto it changed nothing on screen and leaving took
 * three Backs. So the editor steps back onto the board, as returnPublished
 * does, and once the browser is there that entry is rewritten as «طلباتي» and
 * the request page pushed after it: «طلباتي», then the request, and two Backs
 * leave, as when the board opened the wizard in place. A step back that lands
 * anywhere else rewrites nothing and only pushes the request page.
 */
export function leaveNewRequest(navigate: NavigateFunction, path: string, published: boolean, win: Window = window, fromBoard = false): void {
  const state = published ? { published: true } : undefined;
  const asMine = () => {
    const held = (win.history.state ?? {}) as Record<string, unknown>;
    win.history.replaceState({ ...held, usr: null, key: Math.random().toString(36).slice(2, 10) }, '', MY_REQUESTS);
  };
  let boardBehind = false;
  if (fromBoard) {
    try {
      const idx = (win.history.state as { idx?: unknown } | null)?.idx;
      boardBehind = typeof idx === 'number' && idx > 0;
    } catch {
      boardBehind = false;
    }
  }
  if (boardBehind) {
    win.addEventListener(
      'popstate',
      () => {
        try {
          if (win.location.pathname === '/requests') asMine();
        } catch {
          // A window that refuses the rewrite keeps the board as it was.
        }
        navigate(path, { state });
      },
      { once: true }
    );
    navigate(-1);
    return;
  }
  try {
    asMine();
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
  // The id this screen was OPENED with: a new request keeps being one after
  // its draft is born and the address takes its id (the route is one element
  // for /requests/new and /requests/new/:id, so this page stays mounted).
  const opened = useRef(id);
  const editing = !!id && location.pathname.endsWith('/edit');
  // A model link a door carried to a new request, read once on arrival.
  const [carriedLink] = useState(() => (id ? '' : carriedPrintLink(location.state, params)));
  // Opened from the board «طلب جديد» (B2R3-REG-1), read once: the draft address replaces the state.
  const [fromBoard] = useState(() => !id && cameFromBoard(location.state));
  // Back: to the request this screen was opened for, else to the board.
  const goBack = useGoBack(opened.current ? requestPath(opened.current) : '/requests');

  // The request behind a draft or edit address, asked beside the editor: only
  // a 404 changes the page; anything else is the editor own to say.
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
   * request), else as Back would. The editor has walked back its own steps
   * first, so this runs on the entry the editor was opened on.
   */
  const done = (rid: string, how: 'published' | 'saved') => {
    const id = opened.current;
    if (!id) leaveNewRequest(navigate, requestPath(rid), how === 'published', window, fromBoard);
    else if (how === 'published') returnPublished(navigate, requestPath(rid));
    else goBack();
  };

  /** A request for one store, SENT: its conversation, with «طلباتي» behind it. */
  const finish = (d: EditorDone) => {
    if (d.how === 'sent') leaveNewRequest(navigate, `/chat/${encodeURIComponent(d.chatId)}`, false, window, fromBoard);
    else done(d.id, d.how);
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
    <CommunitySurface className="min-h-screen w-full">
      <div className="mx-auto flex max-w-2xl flex-col px-4 lg:max-w-3xl" data-request-editor={editing ? 'edit' : id ? 'draft' : 'new'}>
        <RequestEditor requestId={id} carriedLink={carriedLink} onDone={finish} onLeave={goBack} />
      </div>
    </CommunitySurface>
  );
}
