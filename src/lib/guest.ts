/**
 * BROWSING WITHOUT AN ACCOUNT.
 *
 * A shop whose door is locked until you show ID has no visitors. Most of this
 * site is a catalogue and a community, and neither needs to know who is
 * looking. So the pages that only SHOW things are open, and only the things
 * that belong to a person — their orders, their wallet, their addresses,
 * their saved items — stay behind a sign-in.
 *
 * What this module gives those open pages is one consistent answer to "you
 * need an account for this":
 *
 *   useSignInPrompt()  — send someone to sign in and BRING THEM BACK. The
 *                        path they were on travels with them, the same way
 *                        ProtectedRoute already does it, so a guest who taps
 *                        "follow this shop" lands back on the shop.
 *
 * For the PANEL that stands in for a section a guest cannot have, use
 * UnauthorizedState from src/components/ui/AsyncStates.tsx — it already exists,
 * already takes the destination, and a second treatment of the same idea would
 * only make the site look like two sites.
 *
 * Nothing here is a security boundary. Every endpoint that matters is
 * authorised on the server; this is only about not wasting a visitor's time.
 */
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Where "sign in" should point from here, carrying the way back.
 *
 * Auth.tsx sanitises this with sanitizeNextPath (same-origin, relative only),
 * so it is safe to hand it whatever the router currently says.
 */
export function useSignInPrompt(): {
  /** Go to sign-in now, remembering this page. */
  signIn: () => void;
  /** The same destination as a link target, for a real anchor. */
  to: { pathname: string; state: { from: string } };
  /** Run the action if signed in; otherwise send them to sign in first. */
  guard: (isAuthenticated: boolean, action: () => void) => void;
} {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.pathname + location.search;
  const to = { pathname: '/auth', state: { from } };
  const signIn = () => navigate('/auth', { state: { from } });
  return {
    signIn,
    to,
    guard: (isAuthenticated, action) => {
      if (isAuthenticated) action();
      else signIn();
    },
  };
}
