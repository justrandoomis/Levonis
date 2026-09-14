/** Local fixture: production SVG, controller, API adapter, Home navigation,
 * locale/auth providers and remote-typing hook. No production API or data. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { AuthProvider } from '../../src/AuthContext';
import BottomNav from '../../src/components/BottomNav';
import AppIntro from '../../src/components/bloub/AppIntro';
import { MotionCharacterFallbackHeader, MotionCharacterHome, useCharacterBusy } from '../../src/components/bloub/MotionCharacterAnchor';
import { api } from '../../src/lib/api';
import { mascot, createUnreadObserver } from '../../src/lib/mascot';
import { useChatPresence } from '../../src/lib/useChatPresence';
import '../../src/index.css';

let remoteTyping = false;
let resolveRequest: (() => void) | undefined;
const notify = createUnreadObserver(); notify.observe(0); let unread=0;
// This is installed before AuthProvider mounts, not in the shipped app.
window.fetch = async (input, init) => {
  const path = String(input instanceof Request ? input.url : input).split('?')[0];
  if (path.endsWith('/pending')) await new Promise<void>(r => { resolveRequest = r; });
  if (path.endsWith('/error')) return Response.json({error:'Fixture server failure'}, {status:503});
  if (path.endsWith('/warning')) return Response.json({error:'Fixture stock conflict'}, {status:409});
  if (path.endsWith('/typing')) {
    if (init?.method === 'POST') return Response.json({success:true}); // Own input is not remote typing.
    return Response.json({success:true,typing:remoteTyping,remainingMs:remoteTyping ? 7000 : 0});
  }
  return Response.json({success:true,user:null,items:[],chats:[]});
};
function PresenceProbe({ active }: { active: boolean }) {
  const presence = useChatPresence('fixture-chat', active);
  return active ? <div className="grid gap-2">
    <input id="own-message" aria-label="My message" className="bg-surface max-w-full" onChange={e=>presence.onEdit(e.target.value)} onBlur={presence.onStop} />
    <button id="remote-start" onClick={()=>{remoteTyping=true;}}>Other participant starts</button>
    <button id="remote-stop" onClick={()=>{remoteTyping=false;}}>Other participant stops</button>
    <span data-remote-state>{presence.typing ? 'typing' : 'idle'}</span>
  </div> : null;
}
function Fixture() {
  const location = useLocation();
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [showHeader, setShowHeader] = React.useState(true);
  useCharacterBusy(busy);
  const focused = location.pathname !== '/';
  return <>
    <div className="min-h-dvh bg-canvas text-text-primary pb-28">
      {focused && <MotionCharacterFallbackHeader />}
      {focused && showHeader && <header className="lv-character-header sticky top-0 px-4 py-3 items-center bg-canvas">
        <button type="button" aria-label="Back">Back</button>
        <MotionCharacterHome busy={busy} />
        <button type="button" aria-label="Cart">Cart</button>
      </header>}
      <main className="p-4 flex flex-col gap-3">
        <h1 data-route className="font-semibold">Levonis · {location.pathname}</h1>
        <button id="ready" type="button" onClick={() => setReady(true)}>Resolve actual loading</button>
        <div className="flex flex-wrap gap-4">
          <Link id="product" to="/product/test">Product</Link><Link id="checkout" to="/checkout">Checkout</Link>
          <Link id="chat" to="/chat/fixture">Chat</Link><Link id="home" to="/">Home</Link>
        </div>
        <button id="busy" type="button" onClick={() => setBusy(v => !v)}>Toggle page work</button>
        <button id="header" type="button" onClick={() => setShowHeader(v => !v)}>Toggle header</button>
        <input aria-label="Focus probe" className="max-w-full bg-surface" />
        <div className="flex flex-wrap gap-3">
          <button id="api-load" onClick={()=>void api.get('/api/fixture/pending')}>API loading</button>
          <button id="api-resolve" onClick={()=>resolveRequest?.()}>Resolve API</button>
          <button id="api-success" onClick={()=>void api.post('/api/fixture/success')}>Success</button>
          <button id="api-error" onClick={()=>void api.get('/api/fixture/error').catch(()=>{})}>Error</button>
          <button id="api-warning" onClick={()=>void api.post('/api/fixture/warning').catch(()=>{})}>Warning</button>
          <button id="notification" onClick={()=>notify.observe(++unread)}>New notification</button>
        </div>
        <PresenceProbe active={location.pathname.startsWith('/chat/')} />
        {/* THE THREE CLASSES OF CONTROL THE CHARACTER SORTS THE PAGE INTO.
            `interest.ts` decides what is worth noticing by a declared registry
            rather than by text or by being a button, so the fixture carries one
            of each kind: the design system's own primary token, an explicit
            opt-in stepper, an explicit opt-out, and a plain button that is
            invisible to the character on purpose. */}
        <div className="flex flex-wrap gap-3">
          <button id="cta-primary" className="lv-button lv-button-primary">Primary action</button>
          <button id="qty-inc" data-mascot="qty-inc">+</button>
          <button id="decoy-ignored" data-mascot="ignore">Explicitly ignored</button>
          <button id="decoy-plain">Plain button</button>
        </div>
        {/* Tall enough to scroll: the pointer listeners are passive, and the
            only way to prove that from outside is to scroll while they run. */}
        <div id="tall" style={{ height: '2400px' }} aria-hidden />
      </main>
      {!focused && <BottomNav />}
    </div>
    <AppIntro ready={ready} />
    <button id="force-rest" hidden onClick={()=>mascot.setVisible(false)}>Rest probe</button>
    <button id="force-wake" hidden onClick={()=>mascot.setVisible(true)}>Wake probe</button>
  </>;
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><LanguageProvider><AuthProvider><MemoryRouter><Fixture /></MemoryRouter></AuthProvider></LanguageProvider></React.StrictMode>
);
