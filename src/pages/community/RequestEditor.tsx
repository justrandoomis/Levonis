/**
 * /requests/new, /requests/new/:id and /requests/:id/edit — the request
 * editor’s route (plan P1-06, docs/DECISIONS.md row 268). A lazy chunk of its
 * own (`RequestEditor`), behind the sign-in and the community gate in
 * src/App.tsx: nothing of it reaches the entry, the board or a store page.
 * It is fetched through the request page’s module (Request.tsx
 * `loadRequestEditor`), whose modules it reuses.
 *
 *   /requests/new           a new request; the draft is born on the first change
 *   /requests/new/:id       a draft, resumed
 *   /requests/:id/edit      a published request, edited
 *
 * The editor moves a request to the address that fits it (a draft opened at
 * /edit, a published request at /new/:id) with a history replace.
 */
import { useParams } from 'react-router-dom';
import RequestEditor from '../../components/community/requests/editor/RequestEditor';

export default function RequestEditorPage() {
  const { id = '' } = useParams<{ id?: string }>();
  // One instance across the address change a new draft makes (/requests/new →
  // /requests/new/:id, one optional-segment route): the editor keeps its state.
  return <RequestEditor requestId={id} />;
}
