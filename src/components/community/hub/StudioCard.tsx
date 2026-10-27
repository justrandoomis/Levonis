/**
 * LEVO STUDIO ON THE HOME (community UI plan C1 R11 and D3 (g); IMG_8487,
 * IMG_8462): the gold cube, «Levo Studio», «جهّز ملفاتك للطباعة» (plan R9:
 * the Studio prepares and slices models; it does not turn an idea into a
 * design), and the «دخول الاستوديو ‹» affordance, all inside ONE plain
 * external anchor to STUDIO_URL in a new tab, said aloud. No iframe, no
 * prefetch, no 3D (BASE 6, tests/store-isolation.test.ts): the cube is an
 * inline SVG.
 *
 * A phone draws the affordance as a raised key at the inline end; the desktop
 * aside draws a hairline after the cube and the onward chevron at the end.
 */
import { STUDIO_URL } from '../../../translations';
import { OnwardChevron, kitButtonClass } from '../kit/buttons';
import { useHubStrings } from './strings';

/** The isometric cube, in the gold ink. */
export function CubeGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-gold">
      <path d="M24 4 42 14v20L24 44 6 34V14z" />
      <path d="M6 14l18 10 18-10M24 24v20" />
    </svg>
  );
}

export default function StudioCard({ wide = false }: { wide?: boolean }) {
  const s = useHubStrings();
  return (
    <a
      href={STUDIO_URL}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="community-studio-link"
      data-community-studio
      className={`cm-card flex items-center rounded-xl shadow-sm active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${wide ? 'min-h-24 gap-4 p-5' : 'min-h-20 flex-wrap gap-3 p-4'}`}
    >
      <CubeGlyph size={wide ? 56 : 40} />
      {wide && <span aria-hidden="true" className="h-12 w-px shrink-0 bg-border-subtle" />}
      <span className="min-w-0 flex-1">
        <span className="block text-base font-bold text-text-primary">
          <bdi>Levo Studio</bdi>
        </span>
        <span className="block text-[13px] text-text-secondary">{s.studioLine}</span>
      </span>
      {wide ? (
        <OnwardChevron className="h-5 w-5 shrink-0 text-text-secondary" />
      ) : (
        <span className={`${kitButtonClass('secondary', 'sm')} ms-auto`}>
          {s.enterStudio}
          <OnwardChevron className="h-4 w-4" />
        </span>
      )}
      <span className="sr-only">{s.opensNewTab}</span>
    </a>
  );
}
