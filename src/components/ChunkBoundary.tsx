/**
 * WHEN A CODE-SPLIT CHUNK DOES NOT ARRIVE.
 *
 * Every `React.lazy` route in this application is a separate file fetched at
 * the moment it first renders, and on an Iraqi mobile connection that fetch
 * can fail: a handover between cells, a captive portal, a tunnel. React's
 * answer to a rejected lazy import is to throw during render, and a throw with
 * no boundary above it unmounts the WHOLE tree — the customer's black shop
 * becomes a blank white page with nothing on it and no way back.
 *
 * That has always been possible here; moving first-paint code behind
 * `React.lazy` makes it likelier, which is why this component landed BEFORE
 * any of those moves rather than after the first report.
 *
 * WHY IT RETRIES BY RELOADING RATHER THAN BY RE-RENDERING. A failed dynamic
 * import is CACHED by the module system: the same `import()` promise stays
 * rejected for the life of the document, so re-rendering the same lazy
 * component just throws again, instantly, forever. Only a fresh document can
 * ask for the chunk again. `location.reload()` is not a blunt instrument here
 * — it is the only thing that works.
 *
 * AND A STALE DEPLOY IS THE COMMON CASE, which is what makes the reload the
 * RIGHT answer rather than merely the working one: Vite content-hashes every
 * chunk, so after a deploy the names in an open tab's entry bundle no longer
 * exist. The customer is holding a document that references files which have
 * been replaced. Reloading fetches the new index.html and the new names.
 *
 * IT SAYS SO IN THE SHOP'S OWN LANGUAGES. A boundary that renders English at
 * an Arabic-first customer has replaced one broken screen with another.
 * `useLanguage` is not used: this renders when the tree below has already
 * failed, and reaching into a context from an error path is how a boundary
 * comes to throw inside its own fallback. The language is read from the
 * document element, which `LanguageContext` has already written.
 */
import React from 'react';

const COPY = {
  ar: {
    title: 'تعذّر تحميل هذا الجزء',
    body: 'قد يكون الاتصال انقطع، أو صدر تحديث للموقع بينما كانت الصفحة مفتوحة.',
    retry: 'إعادة التحميل',
  },
  en: {
    title: 'This part could not load',
    body: 'The connection may have dropped, or the site was updated while this page was open.',
    retry: 'Reload',
  },
  ckb: {
    title: 'نەتوانرا ئەم بەشە باربکرێت',
    body: 'لەوانەیە پەیوەندییەکە پچڕابێت، یان ماڵپەڕەکە نوێ کرابێتەوە.',
    retry: 'دووبارە باربکە',
  },
} as const;

function copyForDocument(): (typeof COPY)[keyof typeof COPY] {
  if (typeof document === 'undefined') return COPY.ar;
  const lang = document.documentElement.getAttribute('lang');
  return lang === 'en' ? COPY.en : lang === 'ckb' ? COPY.ckb : COPY.ar;
}

interface Props {
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

export default class ChunkBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // Logged, never swallowed: a chunk that fails for everyone is a broken
    // deploy, and the only trace of it is here.
    console.error('chunk load failed', error);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    const s = copyForDocument();
    return (
      <div
        role="alert"
        data-chunk-boundary
        className="min-h-dvh bg-black grid place-items-center px-6 text-center"
      >
        <div className="max-w-sm">
          <p className="text-white text-[15px] font-bold">{s.title}</p>
          <p className="mt-2 text-zinc-400 text-[13px] leading-relaxed">{s.body}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 min-h-[44px] px-5 rounded-xl bg-gold text-black font-bold text-[14px]"
          >
            {s.retry}
          </button>
        </div>
      </div>
    );
  }
}
