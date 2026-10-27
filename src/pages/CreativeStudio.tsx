/**
 * /admin/creative-studio — «استوديو Levonis الإبداعي» (docs/CREATIVE_STUDIO.md).
 *
 * A FULL-SCREEN route of its own, not an admin tab: the canvas needs the
 * whole viewport, and the admin tabs sit inside a 1280 px column. Lazy, like
 * every admin page — Konva, the studio’s strings and its fonts arrive only
 * when this route does (tests/bundleBudget.test.ts keeps them out of the
 * first paint). The admin shell’s Toaster is not mounted on /admin/* paths
 * (App.tsx `shellHasToaster`), so the page mounts its own.
 */
import { Toaster } from '../components/ui/Toast';
import StudioShell from '../components/creativeStudio/StudioShell';

export default function CreativeStudio() {
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <Toaster />
      <StudioShell />
    </div>
  );
}
