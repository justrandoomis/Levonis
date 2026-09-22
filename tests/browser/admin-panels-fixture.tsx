/**
 * Local fixture that MOUNTS real admin panels.
 *
 * «في التحقق والعناوين في لوحة الإدارة عند الضغط عليها يصبح الموقع بالكامل أسود
 *  شاشة سوداء.»
 *
 * AdminKyc threw on its very first render — `{detail.user_email}` inside the
 * children of `<Overlay open={!!detail}>`, with `detail` still null, because
 * JSX children are an eager argument built before the Overlay is ever called.
 * Nothing in the suite noticed: `strictNullChecks` is off so the compiler saw
 * no error, and no test had ever rendered the component.
 *
 * That is the whole reason this file exists. A source-text assertion about a
 * guard proves the guard is written; only a MOUNT proves the panel opens. Any
 * panel that gains a window should be added to the list below.
 *
 * The fixture owns an error boundary of its own rather than relying on the
 * app's: the boundary is what turned this crash into a black screen, so the
 * test has to see the ERROR, not the fallback.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/LanguageContext';
import AdminKyc from '../../src/components/AdminKyc';
import '../../src/index.css';

/**
 * The admin queues, answered empty — which is the owner's real store and the
 * state the panel must survive. Everything else 404s loudly rather than
 * silently resolving, so a panel that starts calling a new endpoint fails
 * here instead of passing on a stub that says yes to everything.
 */
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/kyc/admin/queue')) {
    return new Response(JSON.stringify({ success: true, cases: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('/api/kyc/admin/address-queue')) {
    return new Response(JSON.stringify({ success: true, requests: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.startsWith('/api/')) {
    return new Response(JSON.stringify({ success: false, error: 'not stubbed' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof window.fetch;

class Catch extends React.Component<{ name: string; children: React.ReactNode }, { err: string }> {
  state = { err: '' };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  render() {
    if (this.state.err) {
      return (
        <div data-panel={this.props.name} data-threw={this.state.err}>
          {this.state.err}
        </div>
      );
    }
    return <div data-panel={this.props.name} data-threw="">{this.props.children}</div>;
  }
}

function Fixture() {
  return (
    <div style={{ background: '#000', minHeight: '100vh' }}>
      <Catch name="kyc">
        <AdminKyc />
      </Catch>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <Fixture />
    </LanguageProvider>
  </React.StrictMode>
);
